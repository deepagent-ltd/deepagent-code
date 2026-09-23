import { describe, expect } from "bun:test"
import { Cause, DateTime, Deferred, Effect, Exit, Fiber, Layer, Schema, Stream } from "effect"
import { EventV2 } from "@deepagent-code/core/event"
import { Database } from "@deepagent-code/core/database/database"
import {
  EventArtifactChunkTable,
  EventArtifactTable,
  EventAggregateTombstoneTable,
  EventDedupeTable,
  EventSequenceTable,
  EventSnapshotChunkTable,
  EventSnapshotRowTable,
  EventSyncIndexTable,
  EventSyncSequenceTable,
  EventSnapshotTable,
  EventTable,
} from "@deepagent-code/core/event/sql"
import { Location } from "@deepagent-code/core/location"
import { ProjectV2 } from "@deepagent-code/core/project"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { SessionSchema } from "@deepagent-code/core/session/schema"
import { SessionV1 } from "@deepagent-code/core/v1/session"
import { WorkspaceV2 } from "@deepagent-code/core/workspace"
import { V2Schema } from "@deepagent-code/core/v2-schema"
import { asc, eq, sql } from "drizzle-orm"
import { createHash } from "node:crypto"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"

const locationLayer = Layer.succeed(
  Location.Service,
  Location.Service.of(
    location({ directory: AbsolutePath.make("project"), workspaceID: WorkspaceV2.ID.make("wrk_test") }),
  ),
)
const database = Database.layerFromPath(":memory:")
const eventLayer = Layer.mergeAll(EventV2.layer.pipe(Layer.provide(database)), database)
const it = testEffect(eventLayer.pipe(Layer.provideMerge(locationLayer)))
const itWithoutLocation = testEffect(eventLayer)

const Message = EventV2.define({
  type: "test.message",
  schema: {
    text: Schema.String,
  },
})

const SyncMessage = EventV2.define({
  type: "test.sync",
  sync: {
    version: 1,
    aggregate: "id",
  },
  schema: {
    id: Schema.String,
    text: Schema.String,
  },
})

const SyncSent = EventV2.define({
  type: "test.sent",
  sync: {
    version: 1,
    aggregate: "messageID",
  },
  schema: {
    messageID: Schema.String,
    text: Schema.String,
  },
})

const GlobalMessage = EventV2.define({
  type: "test.global",
  schema: {
    text: Schema.String,
  },
})

const VersionedMessage = EventV2.define({
  type: "test.versioned",
  sync: {
    version: 2,
    aggregate: "id",
  },
  schema: {
    id: Schema.String,
    text: Schema.String,
  },
})

const LegacyVersionedMessage = EventV2.define({
  type: "test.versioned",
  sync: {
    version: 1,
    aggregate: "id",
  },
  schema: {
    id: Schema.String,
    legacy: Schema.Boolean,
  },
})

const SyncTimestamp = EventV2.define({
  type: "test.timestamp",
  sync: {
    version: 1,
    aggregate: "id",
  },
  schema: {
    id: Schema.String,
    timestamp: V2Schema.DateTimeUtcFromMillis,
  },
})

const SyncPayload = EventV2.define({
  type: "test.payload",
  sync: {
    version: 1,
    aggregate: "sessionID",
  },
  schema: {
    sessionID: Schema.String,
    kind: Schema.Literals(["session", "message"]),
    body: Schema.String,
  },
})

function payloadAtEncodedBytes(sessionID: string, kind: "session" | "message", bytes: number, suffix = "") {
  const input = { sessionID, kind, body: suffix }
  const remaining = bytes - Buffer.byteLength(JSON.stringify(input))
  if (remaining < 0) throw new Error(`Payload envelope exceeds requested size ${bytes}`)
  return { ...input, body: "x".repeat(remaining) + suffix }
}

describe("EventV2", () => {
  it.effect("routes same-name synchronized definitions by exact version", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const projected: string[] = []
      yield* events.project(LegacyVersionedMessage, () => Effect.sync(() => projected.push("v1")))
      yield* events.project(VersionedMessage, () => Effect.sync(() => projected.push("v2")))

      yield* events.publish(LegacyVersionedMessage, { id: "shared", legacy: true })
      yield* events.publish(VersionedMessage, { id: "shared", text: "current" })

      expect(projected).toEqual(["v1", "v2"])
      expect(
        (yield* db.select({ type: EventTable.type }).from(EventTable).orderBy(asc(EventTable.seq)).all()).map(
          (row) => row.type,
        ),
      ).toEqual(["test.versioned.1", "test.versioned.2"])
    }),
  )

  it.effect("derives stable namespaced external IDs", () =>
    Effect.sync(() => {
      const input = { namespace: "opencord.agent-input", key: "input-1" }

      expect(EventV2.ID.fromExternal(input)).toBe(EventV2.ID.fromExternal(input))
      expect(EventV2.ID.fromExternal(input)).toMatch(/^evt_[a-f0-9]{64}$/)
      expect(EventV2.ID.fromExternal({ ...input, namespace: "another-app" })).not.toBe(EventV2.ID.fromExternal(input))
      expect(EventV2.ID.fromExternal({ namespace: "a:b", key: "c" })).not.toBe(
        EventV2.ID.fromExternal({ namespace: "a", key: "b:c" }),
      )
    }),
  )

  it.effect("publishes events with the current location", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const fiber = yield* events.subscribe(Message).pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
      yield* Effect.yieldNow
      const event = yield* events.publish(Message, { text: "hello" })
      const received = Array.from(yield* Fiber.join(fiber))

      expect(received).toEqual([event])
      expect(event.type).toBe("test.message")
      expect(event).not.toHaveProperty("version")
      expect(event.data).toEqual({ text: "hello" })
      expect(event.location).toEqual({
        directory: AbsolutePath.make("project"),
        workspaceID: WorkspaceV2.ID.make("wrk_test"),
      })
    }),
  )

  itWithoutLocation.effect("omits location when no location is available", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const event = yield* events.publish(GlobalMessage, { text: "hello" })

      expect(event).not.toHaveProperty("location")
      expect(event.type).toBe("test.global")
    }),
  )

  it.effect("publishes definition version", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const event = yield* events.publish(VersionedMessage, { id: "one", text: "hello" })

      expect(event.type).toBe("test.versioned")
      expect(event.version).toBe(2)
    }),
  )

  it.effect("stores definitions in the exported registry", () =>
    Effect.sync(() => {
      expect(EventV2.registry.get(Message.type)).toBe(Message)
    }),
  )

  it.effect("keeps the latest sync definition in the registry", () =>
    Effect.sync(() => {
      const latest = EventV2.define({
        type: "test.out-of-order",
        sync: { version: 2, aggregate: "id" },
        schema: { id: Schema.String },
      })
      EventV2.define({
        type: "test.out-of-order",
        sync: { version: 1, aggregate: "id" },
        schema: { id: Schema.String },
      })

      expect(EventV2.registry.get("test.out-of-order")).toBe(latest)
    }),
  )

  it.effect("refuses exact definition collisions and exposes read-only registry views", () =>
    Effect.sync(() => {
      const local = EventV2.define({
        type: "test.definition-collision.local",
        schema: { value: Schema.String },
      })
      const sync = EventV2.define({
        type: "test.definition-collision.sync",
        sync: { version: 1, aggregate: "id" },
        schema: { id: Schema.String, value: Schema.String },
      })

      expect(() =>
        EventV2.define({
          type: "test.definition-collision.local",
          schema: { replacement: Schema.Boolean },
        }),
      ).toThrow("Duplicate EventV2 definition")
      expect(() =>
        EventV2.define({
          type: "test.definition-collision.sync",
          sync: { version: 1, aggregate: "id" },
          schema: { id: Schema.String, replacement: Schema.Boolean },
        }),
      ).toThrow("Duplicate EventV2 synchronized definition")
      expect(EventV2.registry.get(local.type)).toBe(local)
      expect(EventV2.syncRegistry.get(EventV2.versionedType(sync.type, sync.sync!.version))?.data).toBe(sync.data)
      expect("set" in EventV2.registry).toBe(false)
      expect("clear" in EventV2.syncRegistry).toBe(false)
    }),
  )

  it.effect("publishes to typed and wildcard subscriptions", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const typed = yield* events.subscribe(Message).pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
      const wildcard = yield* events.all().pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
      yield* Effect.yieldNow
      const event = yield* events.publish(Message, { text: "hello" })

      expect(Array.from(yield* Fiber.join(typed))).toEqual([event])
      expect(Array.from(yield* Fiber.join(wildcard))).toEqual([event])
    }),
  )

  it.effect("runs projectors inline", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const received = new Array<EventV2.Payload>()
      yield* events.project(SyncMessage, (event) =>
        Effect.sync(() => {
          received.push(event)
        }),
      )

      const event = yield* events.publish(SyncMessage, { id: "one", text: "hello" })
      yield* events.publish(SyncMessage, { id: "one", text: "after unsubscribe" })

      expect(received[0]).toEqual(event)
      expect(received[1]?.data).toEqual({ id: "one", text: "after unsubscribe" })
    }),
  )

  it.effect("commits local operational state inside a new synchronized event transaction", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const received = new Array<string>()
      const aggregateID = EventV2.ID.create()
      yield* events.project(SyncMessage, () => Effect.sync(() => received.push("projector")))

      yield* events.publish(
        SyncMessage,
        { id: aggregateID, text: "hello" },
        { commit: (seq) => Effect.sync(() => received.push(`commit:${seq}`)) },
      )

      expect(received).toEqual(["projector", "commit:0"])
    }),
  )

  it.effect("rejects oversized session-like publishes before every durable side effect", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const aggregateID = EventV2.ID.create()
      const observed: string[] = []
      yield* events.beforeCommit(() => Effect.sync(() => observed.push("guard")))
      yield* events.project(SyncPayload, () => Effect.sync(() => observed.push("projector")))

      yield* events.publish(SyncPayload, { sessionID: aggregateID, kind: "session", body: "baseline" })
      observed.length = 0
      const sequenceBefore = yield* db
        .select()
        .from(EventSequenceTable)
        .where(eq(EventSequenceTable.aggregate_id, aggregateID))
        .all()
      const eventsBefore = yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, aggregateID)).all()

      const defect = yield* events
        .publish(SyncPayload, payloadAtEncodedBytes(aggregateID, "session", EventV2.MAX_ENCODED_PAYLOAD_BYTES + 1), {
          commit: () => Effect.sync(() => observed.push("commit")),
        })
        .pipe(Effect.catchDefect(Effect.succeed))

      expect(defect).toBeInstanceOf(EventV2.EncodedPayloadTooLargeError)
      expect(defect).toMatchObject({
        _tag: "EventV2.EncodedPayloadTooLarge",
        type: SyncPayload.type,
        encodedBytes: EventV2.MAX_ENCODED_PAYLOAD_BYTES + 1,
        limitBytes: EventV2.MAX_ENCODED_PAYLOAD_BYTES,
      })
      expect(observed).toEqual([])
      expect(
        yield* db.select().from(EventSequenceTable).where(eq(EventSequenceTable.aggregate_id, aggregateID)).all(),
      ).toEqual(sequenceBefore)
      expect(yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, aggregateID)).all()).toEqual(
        eventsBefore,
      )
    }),
  )

  it.effect("rejects oversized message-like replay before every durable side effect", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const aggregateID = EventV2.ID.create()
      const observed: string[] = []
      yield* events.beforeCommit(() => Effect.sync(() => observed.push("guard")))
      yield* events.project(SyncPayload, () => Effect.sync(() => observed.push("projector")))

      const defect = yield* events
        .replay({
          id: EventV2.ID.create(),
          type: EventV2.versionedType(SyncPayload.type, 1),
          seq: 0,
          aggregateID,
          data: payloadAtEncodedBytes(aggregateID, "message", EventV2.MAX_ENCODED_PAYLOAD_BYTES + 1),
        })
        .pipe(Effect.catchDefect(Effect.succeed))

      expect(defect).toBeInstanceOf(EventV2.EncodedPayloadTooLargeError)
      expect(defect).toMatchObject({
        _tag: "EventV2.EncodedPayloadTooLarge",
        type: SyncPayload.type,
        encodedBytes: EventV2.MAX_ENCODED_PAYLOAD_BYTES + 1,
      })
      expect(observed).toEqual([])
      expect(
        yield* db.select().from(EventSequenceTable).where(eq(EventSequenceTable.aggregate_id, aggregateID)).all(),
      ).toEqual([])
      expect(yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, aggregateID)).all()).toEqual([])
    }),
  )

  it.effect("admits an exact UTF-8 byte boundary and preserves idempotent publish and replay", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const aggregateID = EventV2.ID.create()
      const eventID = EventV2.ID.create()
      const data = payloadAtEncodedBytes(aggregateID, "message", EventV2.MAX_ENCODED_PAYLOAD_BYTES, "\u{1F680}")
      expect(Buffer.byteLength(JSON.stringify(data))).toBe(EventV2.MAX_ENCODED_PAYLOAD_BYTES)
      let commits = 0

      const first = yield* events.publish(SyncPayload, data, {
        id: eventID,
        idempotent: true,
        commit: () => Effect.sync(() => commits++),
      })
      const retry = yield* events.publish(SyncPayload, data, {
        id: eventID,
        idempotent: true,
        commit: () => Effect.sync(() => commits++),
      })
      yield* events.replay({
        id: eventID,
        type: EventV2.versionedType(SyncPayload.type, 1),
        seq: first.seq!,
        aggregateID,
        data,
      })

      const rows = yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, aggregateID)).all()
      expect(first.seq).toBe(0)
      expect(retry.seq).toBe(0)
      expect(commits).toBe(2)
      expect(rows).toHaveLength(1)
      expect(rows[0]?.data).toEqual(data)
    }),
  )

  it.effect("preflights a replay batch before committing a valid prefix", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const aggregateID = EventV2.ID.create()
      const observed: string[] = []
      yield* events.beforeCommit(() => Effect.sync(() => observed.push("guard")))
      yield* events.project(SyncPayload, () => Effect.sync(() => observed.push("projector")))

      const error = yield* events
        .replayAll([
          {
            id: EventV2.ID.create(),
            type: EventV2.versionedType(SyncPayload.type, 1),
            seq: 0,
            aggregateID,
            data: { sessionID: aggregateID, kind: "message", body: "valid prefix" },
          },
          {
            id: EventV2.ID.create(),
            type: EventV2.versionedType(SyncPayload.type, 1),
            seq: 1,
            aggregateID,
            data: payloadAtEncodedBytes(aggregateID, "message", EventV2.MAX_ENCODED_PAYLOAD_BYTES + 1),
          },
        ])
        .pipe(Effect.catchDefect(Effect.succeed))

      expect(error).toBeInstanceOf(EventV2.EncodedPayloadTooLargeError)
      expect(observed).toEqual([])
      expect(
        yield* db.select().from(EventSequenceTable).where(eq(EventSequenceTable.aggregate_id, aggregateID)).all(),
      ).toEqual([])
      expect(yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, aggregateID)).all()).toEqual([])
    }),
  )

  it.effect("rolls back the synchronized event and projector when the local commit fails", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const aggregateID = EventV2.ID.create()
      yield* db.run("CREATE TABLE IF NOT EXISTS event_commit_probe (value text NOT NULL)")
      yield* db.run("DELETE FROM event_commit_probe")
      yield* events.project(SyncMessage, () =>
        db.run("INSERT INTO event_commit_probe (value) VALUES ('projected')").pipe(Effect.orDie, Effect.asVoid),
      )

      const exit = yield* events
        .publish(SyncMessage, { id: aggregateID, text: "hello" }, { commit: () => Effect.die("commit failed") })
        .pipe(Effect.exit)

      expect(String(exit)).toContain("commit failed")
      expect(yield* db.all("SELECT value FROM event_commit_probe")).toEqual([])
      expect(yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, aggregateID)).all()).toEqual([])
      expect(
        yield* db.select().from(EventSequenceTable).where(eq(EventSequenceTable.aggregate_id, aggregateID)).all(),
      ).toEqual([])
    }),
  )

  it.effect("reports a commit hook failure through the checked channel after rolling back, then retries exactly", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const aggregateID = EventV2.ID.create()
      const eventID = EventV2.ID.create()
      const delivered: EventV2.ID[] = []
      yield* db.run("CREATE TABLE IF NOT EXISTS event_checked_commit_probe (value text NOT NULL)")
      yield* db.run("DELETE FROM event_checked_commit_probe")
      yield* events.project(SyncMessage, () =>
        db.run("INSERT INTO event_checked_commit_probe (value) VALUES ('projected')").pipe(Effect.orDie, Effect.asVoid),
      )
      yield* events.listen((event) => Effect.sync(() => delivered.push(event.id)))

      const failed = yield* events.publishChecked(SyncMessage, { id: aggregateID, text: "hello" }, {
        id: eventID,
        idempotent: true,
        commit: () => Effect.fail(new Error("outbox unavailable")),
      }).pipe(Effect.catch(Effect.succeed))
      expect(failed).toBeInstanceOf(EventV2.CommitHookError)
      if (failed instanceof EventV2.CommitHookError) {
        expect(failed.eventID).toBe(eventID)
        expect(failed.message).toContain("outbox unavailable")
      }
      expect(yield* db.all("SELECT value FROM event_checked_commit_probe")).toEqual([])
      expect(yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, aggregateID)).all()).toEqual([])
      expect(delivered).toEqual([])

      const committed = yield* events.publishChecked(SyncMessage, { id: aggregateID, text: "hello" }, {
        id: eventID,
        idempotent: true,
        commit: () => Effect.void,
      })
      expect(committed.seq).toBe(0)
      expect(yield* db.all("SELECT value FROM event_checked_commit_probe")).toEqual([{ value: "projected" }])
      expect(delivered).toEqual([eventID])

      const legacy = yield* events.publish(SyncMessage, { id: EventV2.ID.create(), text: "legacy" }, {
        commit: () => Effect.fail(new Error("legacy hook failed")),
      }).pipe(Effect.exit)
      expect(Exit.isFailure(legacy) && Cause.hasDies(legacy.cause)).toBeTrue()
    }),
  )

  it.effect("rejects local commit hooks on live-only events", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const exit = yield* events.publish(Message, { text: "hello" }, { commit: () => Effect.void }).pipe(Effect.exit)

      expect(String(exit)).toContain("Local commit hooks require a synchronized event")
    }),
  )

  it.effect("runs projectors before publishing to streams", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const received = new Array<string>()
      const fiber = yield* events.all().pipe(
        Stream.take(1),
        Stream.runForEach(() => Effect.sync(() => received.push("stream"))),
        Effect.forkScoped,
      )
      yield* events.project(SyncMessage, (event) =>
        Effect.sync(() => {
          received.push(event.type)
        }),
      )

      yield* Effect.yieldNow
      yield* events.publish(SyncMessage, { id: "one", text: "hello" })
      yield* Fiber.join(fiber)

      expect(received).toEqual([SyncMessage.type, "stream"])
    }),
  )

  it.effect("runs listeners inline after projectors", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const received = new Array<string>()
      yield* events.project(SyncMessage, () =>
        Effect.sync(() => {
          received.push("projector")
        }),
      )
      const unsubscribe = yield* events.listen(() =>
        Effect.sync(() => {
          received.push("listener")
        }),
      )

      yield* events.publish(SyncMessage, { id: "one", text: "hello" })
      yield* unsubscribe
      yield* events.publish(SyncMessage, { id: "one", text: "after unsubscribe" })

      expect(received).toEqual(["projector", "listener", "projector"])
    }),
  )

  it.effect("isolates observer defects after durable events commit", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const received = new Array<string>()
      yield* events.sync(() => Effect.die("sync defect"))
      yield* events.listen(() => {
        throw new Error("listener defect")
      })
      yield* events.listen((event) =>
        Effect.sync(() => {
          received.push(event.type)
        }),
      )

      const event = yield* events.publish(SyncMessage, { id: "one", text: "hello" })

      expect(received).toEqual([SyncMessage.type])
      expect(event.seq).toBeNumber()
    }),
  )

  it.effect("preserves observer interruption", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      yield* events.listen(() => Effect.interrupt)

      const exit = yield* events.publish(SyncMessage, { id: "interrupted", text: "hello" }).pipe(Effect.exit)
      const committed = yield* db
        .select({ id: EventTable.id })
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, "interrupted"))
        .get()
        .pipe(Effect.orDie)

      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBeTrue()
      expect(committed).toBeDefined()
    }),
  )

  it.effect("keeps live-only listener defects fail-fast", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const defect = new Error("listener defect")
      yield* events.listen(() => Effect.die(defect))

      expect(yield* events.publish(Message, { text: "hello" }).pipe(Effect.catchDefect(Effect.succeed))).toBe(defect)
    }),
  )

  it.effect("does not synchronize live-only events", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const synchronized = new Array<string>()
      const unsubscribe = yield* events.sync((event) =>
        Effect.sync(() => {
          synchronized.push(event.type)
        }),
      )
      yield* Effect.addFinalizer(() => unsubscribe)

      yield* events.publish(Message, { text: "live only" })
      yield* events.publish(SyncMessage, { id: "one", text: "durable" })

      expect(synchronized).toEqual([SyncMessage.type])
    }),
  )

  it.effect("synchronizes only after the durable event commits", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const synchronized = new Array<boolean>()
      yield* events.sync((event) =>
        db
          .select({ id: EventTable.id })
          .from(EventTable)
          .where(eq(EventTable.id, event.id))
          .get()
          .pipe(
            Effect.orDie,
            Effect.map((row) => synchronized.push(row !== undefined)),
            Effect.asVoid,
          ),
      )

      yield* events.publish(SyncMessage, { id: EventV2.ID.create(), text: "durable" })

      expect(synchronized).toEqual([true])
    }),
  )

  it.effect("inserts sync event rows on publish", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const aggregateID = EventV2.ID.create()

      yield* events.publish(SyncMessage, { id: aggregateID, text: "first" })
      const rows = yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, aggregateID))
        .all()
        .pipe(Effect.orDie)

      expect(rows).toHaveLength(1)
      expect(rows[0]?.type).toBe(EventV2.versionedType(SyncMessage.type, 1))
      expect(rows[0]?.aggregate_id).toBe(aggregateID)
    }),
  )

  it.effect("increments sync event seq per aggregate", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const aggregateID = EventV2.ID.create()

      yield* events.publish(SyncMessage, { id: aggregateID, text: "first" })
      yield* events.publish(SyncMessage, { id: aggregateID, text: "second" })
      const rows = yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, aggregateID))
        .all()
        .pipe(Effect.orDie)

      expect(rows.map((row) => row.seq)).toEqual([0, 1])
    }),
  )

  it.effect("accepts only exact idempotent retries and replays their local commit hook", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const aggregateID = EventV2.ID.create()
      const eventID = EventV2.ID.create()
      const received = new Array<EventV2.Payload>()
      let commitCount = 0
      yield* events.listen((event) => Effect.sync(() => received.push(event)))

      const first = yield* events.publish(
        SyncMessage,
        { id: aggregateID, text: "durable" },
        {
          id: eventID,
          idempotent: true,
          commit: () => Effect.sync(() => commitCount++),
        },
      )
      const retry = yield* events.publish(
        SyncMessage,
        { id: aggregateID, text: "durable" },
        {
          id: eventID,
          idempotent: true,
          commit: () => Effect.sync(() => commitCount++),
        },
      )
      const divergent = yield* events
        .publish(SyncMessage, { id: aggregateID, text: "different" }, { id: eventID, idempotent: true })
        .pipe(Effect.exit)
      const rows = yield* db.select().from(EventTable).where(eq(EventTable.id, eventID)).all().pipe(Effect.orDie)

      expect(first.seq).toBe(0)
      expect(retry.seq).toBe(0)
      expect(rows).toHaveLength(1)
      expect(received).toHaveLength(1)
      expect(commitCount).toBe(2)
      expect(String(divergent)).toContain(`Event ${eventID} already exists`)
    }),
  )

  it.effect("rejects idempotent publish for local events", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const exit = yield* events
        .publish(Message, { text: "local" }, { id: EventV2.ID.create(), idempotent: true })
        .pipe(Effect.exit)

      expect(String(exit)).toContain("Idempotent publish requires a synchronized event")
    }),
  )

  it.effect("replays durable aggregate events after a cursor and tails new events", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const aggregateID = EventV2.ID.create()
      yield* events.publish(SyncMessage, { id: aggregateID, text: "zero" })
      yield* events.publish(SyncMessage, { id: aggregateID, text: "one" })
      const fiber = yield* events
        .aggregateEvents({ aggregateID, after: EventV2.Cursor.make(0) })
        .pipe(Stream.take(2), Stream.runCollect, Effect.forkScoped)
      yield* Effect.yieldNow

      yield* events.publish(SyncMessage, { id: aggregateID, text: "two" })

      expect(Array.from(yield* Fiber.join(fiber)).map((event) => [event.cursor, event.event.data])).toEqual([
        [EventV2.Cursor.make(1), { id: aggregateID, text: "one" }],
        [EventV2.Cursor.make(2), { id: aggregateID, text: "two" }],
      ])
    }),
  )

  it.effect("catches durable aggregate events published during replay handoff", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const aggregateID = EventV2.ID.create()
      yield* events.publish(SyncMessage, { id: aggregateID, text: "zero" })
      const fiber = yield* events
        .aggregateEvents({ aggregateID })
        .pipe(Stream.take(2), Stream.runCollect, Effect.forkScoped)

      yield* events.publish(SyncMessage, { id: aggregateID, text: "one" })

      expect(
        Array.from(yield* Fiber.join(fiber)).map((event) => [
          event.cursor,
          (event.event.data as { text: string }).text,
        ]),
      ).toEqual([
        [EventV2.Cursor.make(0), "zero"],
        [EventV2.Cursor.make(1), "one"],
      ])
    }),
  )

  it.effect("retains a durable wake committed while historical replay is paused", () =>
    Effect.gen(function* () {
      const readStarted = yield* Deferred.make<void>()
      const continueRead = yield* Deferred.make<void>()
      let pause = true
      const database = Database.layerFromPath(":memory:")
      const eventLayer = EventV2.layerWith({
        beforeAggregateRead: () =>
          pause
            ? Deferred.succeed(readStarted, undefined).pipe(Effect.andThen(Deferred.await(continueRead)))
            : Effect.void,
      }).pipe(Layer.provide(database))

      yield* Effect.gen(function* () {
        const events = yield* EventV2.Service
        const aggregateID = EventV2.ID.create()
        const fiber = yield* events
          .aggregateEvents({ aggregateID })
          .pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
        yield* Deferred.await(readStarted)

        pause = false
        yield* events.publish(SyncMessage, { id: aggregateID, text: "during handoff" })
        yield* Deferred.succeed(continueRead, undefined)

        expect(Array.from(yield* Fiber.join(fiber)).map((event) => [event.cursor, event.event.data])).toEqual([
          [EventV2.Cursor.make(0), { id: aggregateID, text: "during handoff" }],
        ])
      }).pipe(Effect.provide(Layer.mergeAll(database, eventLayer)))
    }),
  )

  it.effect("coalesces durable aggregate wakes while draining every committed event", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const aggregateID = EventV2.ID.create()
      const count = 64
      const fiber = yield* events
        .aggregateEvents({ aggregateID })
        .pipe(Stream.take(count), Stream.runCollect, Effect.forkScoped)
      yield* Effect.yieldNow

      for (let index = 0; index < count; index++) {
        yield* events.publish(SyncMessage, { id: aggregateID, text: String(index) })
      }

      expect(Array.from(yield* Fiber.join(fiber)).map((event) => [event.cursor, event.event.data])).toEqual(
        Array.from({ length: count }, (_, index) => [
          EventV2.Cursor.make(index),
          { id: aggregateID, text: String(index) },
        ]),
      )
    }),
  )

  it.effect(
    "pages aggregate history without gaps beyond the read batch limit",
    () =>
      Effect.gen(function* () {
        const events = yield* EventV2.Service
        const aggregateID = EventV2.ID.create()
        const count = EventV2.AGGREGATE_READ_BATCH_EVENTS + 28
        for (let index = 0; index < count; index++) {
          yield* events.publish(SyncMessage, { id: aggregateID, text: String(index) })
        }

        expect(
          Array.from(yield* events.aggregateEvents({ aggregateID }).pipe(Stream.take(count), Stream.runCollect)).map(
            (event) => event.cursor,
          ),
        ).toEqual(Array.from({ length: count }, (_, index) => EventV2.Cursor.make(index)))
      }),
    15_000,
  )

  it.effect(
    "drains aggregate history across byte-bounded pages without a live wake",
    () =>
      Effect.gen(function* () {
        const events = yield* EventV2.Service
        const aggregateID = EventV2.ID.create()
        const bytes = Math.floor(EventV2.AGGREGATE_READ_BATCH_BYTES * 0.625)
        yield* events.publish(SyncPayload, payloadAtEncodedBytes(aggregateID, "message", bytes, "first"))
        yield* events.publish(SyncPayload, payloadAtEncodedBytes(aggregateID, "message", bytes, "second"))

        const received = Array.from(
          yield* events.aggregateEvents({ aggregateID }).pipe(Stream.take(2), Stream.runCollect),
        )
        expect(received.map((event) => event.cursor)).toEqual([EventV2.Cursor.make(0), EventV2.Cursor.make(1)])
        expect(received.map((event) => (event.event.data as { body: string }).body.slice(-6))).toEqual([
          "xfirst",
          "second",
        ])
      }),
    15_000,
  )

  it.effect(
    "keeps byte-bounded cursors contiguous when an event commits before the next page read",
    () =>
      Effect.gen(function* () {
        const secondReadStarted = yield* Deferred.make<void>()
        const continueSecondRead = yield* Deferred.make<void>()
        let reads = 0
        const database = Database.layerFromPath(":memory:")
        const eventLayer = EventV2.layerWith({
          beforeAggregateRead: () => {
            reads++
            if (reads !== 2) return Effect.void
            return Deferred.succeed(secondReadStarted, undefined).pipe(
              Effect.andThen(Deferred.await(continueSecondRead)),
            )
          },
        }).pipe(Layer.provide(database))

        yield* Effect.gen(function* () {
          const events = yield* EventV2.Service
          const aggregateID = EventV2.ID.create()
          const bytes = Math.floor(EventV2.AGGREGATE_READ_BATCH_BYTES * 0.625)
          yield* events.publish(SyncPayload, payloadAtEncodedBytes(aggregateID, "message", bytes, "first"))
          yield* events.publish(SyncPayload, payloadAtEncodedBytes(aggregateID, "message", bytes, "second"))
          const fiber = yield* events
            .aggregateEvents({ aggregateID })
            .pipe(Stream.take(3), Stream.runCollect, Effect.forkScoped)
          yield* Deferred.await(secondReadStarted)

          yield* events.publish(SyncPayload, {
            sessionID: aggregateID,
            kind: "message",
            body: "committed-before-second-read",
          })
          yield* Deferred.succeed(continueSecondRead, undefined)

          expect(Array.from(yield* Fiber.join(fiber)).map((event) => event.cursor)).toEqual([
            EventV2.Cursor.make(0),
            EventV2.Cursor.make(1),
            EventV2.Cursor.make(2),
          ])
        }).pipe(Effect.provide(Layer.mergeAll(database, eventLayer)))
      }),
    15_000,
  )

  it.effect("fails with a typed defect when aggregate history is removed between metadata and body reads", () => {
    let events: EventV2.Interface
    const database = Database.layerFromPath(":memory:")
    const eventLayer = EventV2.layerWith({
      afterAggregateReadMetadata: (aggregateID) => events.remove(aggregateID),
    }).pipe(Layer.provide(database))

    return Effect.gen(function* () {
      events = yield* EventV2.Service
      const aggregateID = EventV2.ID.create()
      yield* events.publish(SyncMessage, { id: aggregateID, text: "removed during read" })
      const defect = yield* events
        .aggregateEvents({ aggregateID })
        .pipe(Stream.take(1), Stream.runCollect, Effect.catchDefect(Effect.succeed))
      expect(defect).toBeInstanceOf(EventV2.InvalidSyncEventError)
      expect(defect).toMatchObject({
        _tag: "EventV2.InvalidSyncEvent",
        type: EventV2.versionedType(SyncMessage.type, 1),
      })
    }).pipe(Effect.provide(Layer.mergeAll(database, eventLayer)))
  })

  it.effect("omits live-only events from durable aggregate streams", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const aggregateID = EventV2.ID.create()
      const fiber = yield* events
        .aggregateEvents({ aggregateID })
        .pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
      yield* Effect.yieldNow

      yield* events.publish(Message, { text: "live only" })
      yield* events.publish(SyncMessage, { id: aggregateID, text: "durable" })

      expect(Array.from(yield* Fiber.join(fiber)).map((event) => event.event.type)).toEqual([SyncMessage.type])
    }),
  )

  it.effect("refuses checkpoint and compaction while no canonical projection codec is registered", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const aggregateID = EventV2.ID.create()
      yield* events.publish(SyncMessage, { id: aggregateID, text: "zero" })
      const checkpoint = yield* events
        .checkpoint({
          aggregateID,
          throughSeq: EventV2.Cursor.make(0),
          expectedLatest: EventV2.Cursor.make(0),
          codec: "test.v1",
          schemaVersion: 1,
        })
        .pipe(Effect.catchDefect(Effect.succeed))
      expect(checkpoint).toBeInstanceOf(EventV2.InvalidSyncEventError)
      const compact = yield* events
        .compact({ aggregateID, throughSeq: EventV2.Cursor.make(0), limit: 1 })
        .pipe(Effect.catchDefect(Effect.succeed))
      expect(compact).toBeInstanceOf(EventV2.InvalidSyncEventError)
      expect(yield* events.snapshot(aggregateID)).toBeUndefined()
      expect(yield* db.select().from(EventDedupeTable).all().pipe(Effect.orDie)).toEqual([])
      expect(
        yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, aggregateID)).all().pipe(Effect.orDie),
      ).toHaveLength(1)
    }),
  )

  it.effect("canonicalizes oversized legacy message diffs into deterministic BLOB chunks", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const aggregateID = SessionSchema.ID.make("ses_legacy_diff_artifact")
      yield* events.publish(SyncMessage, { id: aggregateID, text: "zero" })
      const id = EventV2.ID.make("evt_legacy_message_diff_artifact")
      const patch = "x".repeat(EventV2.MAX_ENCODED_PAYLOAD_BYTES + 1)
      // Production-shaped legacy payload: the closing exact replay re-encodes the canonical data
      // with the real message.updated codec, so the fixture carries a full v1 user message info.
      const data = {
        sessionID: aggregateID,
        info: {
          id: "msg_legacy_diff_artifact",
          sessionID: aggregateID,
          role: "user",
          time: { created: 1 },
          agent: "agent-legacy-diff",
          model: { providerID: "provider-legacy-diff", modelID: "model-legacy-diff" },
          summary: { diffs: [{ file: "large.patch", patch, additions: 1, deletions: 0 }] },
        },
      }
      const syncSeq = yield* db
        .update(EventSyncSequenceTable)
        .set({ seq: sql`${EventSyncSequenceTable.seq} + 1` })
        .where(eq(EventSyncSequenceTable.id, 1))
        .returning({ seq: EventSyncSequenceTable.seq })
        .get()
        .pipe(Effect.orDie)
      yield* db
        .insert(EventTable)
        .values({
          id,
          aggregate_id: aggregateID,
          seq: 1,
          type: EventV2.versionedType("message.updated", 1),
          data,
          sync_seq: syncSeq!.seq,
        })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .update(EventSequenceTable)
        .set({ seq: 1 })
        .where(eq(EventSequenceTable.aggregate_id, aggregateID))
        .run()
        .pipe(Effect.orDie)
      expect(
        yield* db
          .select()
          .from(EventSyncIndexTable)
          .where(eq(EventSyncIndexTable.event_id, id))
          .get()
          .pipe(Effect.orDie),
      ).toMatchObject({
        sync_seq: syncSeq!.seq,
        aggregate_id: aggregateID,
        seq: 1,
      })

      const first = yield* events.canonicalizeLegacyArtifacts({ limit: 1, now: 10 })
      expect(first).toEqual({ processed: 1, next: id })
      expect(yield* events.canonicalizeLegacyArtifacts({ afterID: id, limit: 1, now: 11 })).toEqual({ processed: 0 })
      const artifact = yield* db
        .select()
        .from(EventArtifactTable)
        .where(eq(EventArtifactTable.event_id, id))
        .get()
        .pipe(Effect.orDie)
      expect(artifact?.kind).toBe("legacy_message_diff")
      expect(artifact?.body_bytes).toBeGreaterThan(EventV2.MAX_ENCODED_PAYLOAD_BYTES)
      expect(artifact?.chunk_count).toBeGreaterThan(1)
      const summary = (
        artifact?.canonical_data.info as {
          summary: {
            diffs: Array<{ patch?: string }>
            diffArtifact: { codec: string; hash: string }
          }
        }
      ).summary
      expect(summary.diffs[0]?.patch).toBeUndefined()
      expect(summary.diffArtifact.codec).toBe("legacy-message-diff.v2")
      expect(summary.diffArtifact.hash).toBe(artifact!.body_hash)
      const chunks = yield* db
        .select()
        .from(EventArtifactChunkTable)
        .where(eq(EventArtifactChunkTable.artifact_id, artifact!.artifact_id))
        .orderBy(asc(EventArtifactChunkTable.chunk_index))
        .all()
        .pipe(Effect.orDie)
      expect(chunks).toHaveLength(artifact?.chunk_count ?? 0)
      expect(artifact?.codec_version).toBe(2)
      const body = Buffer.concat(chunks.map((chunk) => chunk.data))
      expect(body.length).toBe(artifact!.body_bytes)
      expect(createHash("sha256").update(body).digest("hex")).toBe(artifact!.body_hash)
      for (const chunk of chunks) {
        expect(createHash("sha256").update(chunk.data).digest("hex")).toBe(chunk.chunk_hash)
      }
      const source = yield* db
        .select({ data: sql<string>`CAST(${EventTable.data} AS TEXT)` })
        .from(EventTable)
        .where(eq(EventTable.id, id))
        .get()
        .pipe(Effect.orDie)
      expect(createHash("sha256").update(source!.data).digest("hex")).toBe(artifact!.original_data_hash)
      expect(createHash("sha256").update(JSON.stringify(artifact!.canonical_data)).digest("hex")).toBe(
        artifact!.canonical_data_hash,
      )
      yield* events.replay({
        id,
        type: EventV2.versionedType(SessionV1.Event.MessageUpdated.type, 1),
        seq: 1,
        aggregateID,
        data: artifact!.canonical_data,
      })
    }),
  )

  it.effect("fails closed before writing an overlarge legacy diff manifest", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const aggregateID = EventV2.ID.create()
      yield* events.publish(SyncMessage, { id: aggregateID, text: "zero" })
      const id = EventV2.ID.make("evt_legacy_message_diff_overlarge_manifest")
      const diffs = Array.from({ length: EventV2.LEGACY_ARTIFACT_MAX_FILES + 1 }, (_, index) => ({
        file: `file-${index}.patch`,
        patch: "x".repeat(450),
        additions: 1,
        deletions: 0,
      }))
      const data = { sessionID: aggregateID, info: { summary: { diffs } } }
      const syncSeq = yield* db
        .update(EventSyncSequenceTable)
        .set({ seq: sql`${EventSyncSequenceTable.seq} + 1` })
        .where(eq(EventSyncSequenceTable.id, 1))
        .returning({ seq: EventSyncSequenceTable.seq })
        .get()
        .pipe(Effect.orDie)
      yield* db
        .insert(EventTable)
        .values({
          id,
          aggregate_id: aggregateID,
          seq: 1,
          type: EventV2.versionedType("message.updated", 1),
          data,
          sync_seq: syncSeq!.seq,
        })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .update(EventSequenceTable)
        .set({ seq: 1 })
        .where(eq(EventSequenceTable.aggregate_id, aggregateID))
        .run()
        .pipe(Effect.orDie)

      const result = yield* events.canonicalizeLegacyArtifacts({ limit: 1, now: 11 }).pipe(Effect.exit)
      expect(String(result)).toContain("EventV2.EncodedPayloadTooLarge")
      expect(yield* db.select().from(EventArtifactTable).where(eq(EventArtifactTable.event_id, id)).all()).toEqual([])
      expect(yield* db.select().from(EventArtifactChunkTable).all()).toEqual([])
    }),
  )

  it.effect("uses custom sync aggregate field", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const aggregateID = EventV2.ID.create()

      yield* events.publish(SyncSent, { messageID: aggregateID, text: "sent" })
      const rows = yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, aggregateID))
        .all()
        .pipe(Effect.orDie)

      expect(rows).toHaveLength(1)
      expect(rows[0]?.aggregate_id).toBe(aggregateID)
    }),
  )

  it.effect("replays sync events through projectors", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const received = new Array<EventV2.Payload>()
      yield* events.project(SyncMessage, (event) =>
        Effect.sync(() => {
          received.push(event)
        }),
      )
      const aggregateID = EventV2.ID.create()

      yield* events.replay({
        id: EventV2.ID.create(),
        type: EventV2.versionedType(SyncMessage.type, 1),
        seq: 0,
        aggregateID,
        data: { id: aggregateID, text: "hello" },
      })

      expect(received[0]?.type).toBe(SyncMessage.type)
      expect(received[0]?.data).toEqual({ id: aggregateID, text: "hello" })
    }),
  )

  it.effect("replay inserts external event rows", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const aggregateID = EventV2.ID.create()

      yield* events.replay({
        id: EventV2.ID.create(),
        type: EventV2.versionedType(SyncMessage.type, 1),
        seq: 0,
        aggregateID,
        data: { id: aggregateID, text: "replayed" },
      })
      const rows = yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, aggregateID))
        .all()
        .pipe(Effect.orDie)

      expect(rows).toHaveLength(1)
      expect(rows[0]?.aggregate_id).toBe(aggregateID)
    }),
  )

  it.effect(
    "replay rejects an envelope aggregate that differs from its payload without mutating the payload aggregate",
    () =>
      Effect.gen(function* () {
        const events = yield* EventV2.Service
        const { db } = yield* Database.Service
        const envelopeAggregateID = EventV2.ID.create()
        const payloadAggregateID = EventV2.ID.create()
        const received = new Array<EventV2.Payload>()
        yield* events.publish(SyncMessage, { id: payloadAggregateID, text: "seed" })
        yield* events.project(SyncMessage, (event) =>
          Effect.sync(() => {
            received.push(event)
          }),
        )

        const exit = yield* events
          .replay({
            id: EventV2.ID.create(),
            type: EventV2.versionedType(SyncMessage.type, 1),
            seq: 1,
            aggregateID: envelopeAggregateID,
            data: { id: payloadAggregateID, text: "replayed" },
          })
          .pipe(Effect.exit)
        const rows = yield* db
          .select()
          .from(EventTable)
          .where(eq(EventTable.aggregate_id, payloadAggregateID))
          .all()
          .pipe(Effect.orDie)
        const sequence = yield* db
          .select({ seq: EventSequenceTable.seq })
          .from(EventSequenceTable)
          .where(eq(EventSequenceTable.aggregate_id, payloadAggregateID))
          .get()
          .pipe(Effect.orDie)

        expect(String(exit)).toContain("Aggregate mismatch")
        expect(received).toHaveLength(0)
        expect(rows).toHaveLength(1)
        expect(sequence).toEqual({ seq: 0 })
      }),
  )

  it.effect("replay defects on sequence mismatch", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const aggregateID = EventV2.ID.create()

      yield* events.replay({
        id: EventV2.ID.create(),
        type: EventV2.versionedType(SyncMessage.type, 1),
        seq: 0,
        aggregateID,
        data: { id: aggregateID, text: "first" },
      })
      const exit = yield* events
        .replay({
          id: EventV2.ID.create(),
          type: EventV2.versionedType(SyncMessage.type, 1),
          seq: 5,
          aggregateID,
          data: { id: aggregateID, text: "bad" },
        })
        .pipe(Effect.exit)

      expect(String(exit)).toContain("Sequence mismatch")
    }),
  )

  it.effect("replay decodes synchronized transformed values before projection", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const aggregateID = EventV2.ID.create()
      const received = new Array<typeof SyncTimestamp.Type>()
      yield* events.project(SyncTimestamp, (event) =>
        Effect.sync(() => {
          received.push(event)
        }),
      )

      yield* events.replay({
        id: EventV2.ID.create(),
        type: EventV2.versionedType(SyncTimestamp.type, 1),
        seq: 0,
        aggregateID,
        data: { id: aggregateID, timestamp: 0 },
      })

      expect(received[0]?.data.timestamp).toEqual(DateTime.makeUnsafe(0))
    }),
  )

  it.effect("replay defects on unknown event type", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const exit = yield* events
        .replay({
          id: EventV2.ID.create(),
          type: "unknown.event.1",
          seq: 0,
          aggregateID: EventV2.ID.create(),
          data: {},
        })
        .pipe(Effect.exit)

      expect(String(exit)).toContain("Unknown sync event type")
    }),
  )

  it.effect("replayAll validates contiguous aggregate events", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const aggregateID = EventV2.ID.create()
      const source = yield* events.replayAll([
        {
          id: EventV2.ID.create(),
          type: EventV2.versionedType(SyncMessage.type, 1),
          seq: 0,
          aggregateID,
          data: { id: aggregateID, text: "one" },
        },
        {
          id: EventV2.ID.create(),
          type: EventV2.versionedType(SyncMessage.type, 1),
          seq: 1,
          aggregateID,
          data: { id: aggregateID, text: "two" },
        },
      ])

      expect(source).toBe(aggregateID)
    }),
  )

  it.effect("replayAll accepts later chunks after the first batch", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const aggregateID = EventV2.ID.create()

      const one = yield* events.replayAll([
        {
          id: EventV2.ID.create(),
          type: EventV2.versionedType(SyncMessage.type, 1),
          seq: 0,
          aggregateID,
          data: { id: aggregateID, text: "one" },
        },
        {
          id: EventV2.ID.create(),
          type: EventV2.versionedType(SyncMessage.type, 1),
          seq: 1,
          aggregateID,
          data: { id: aggregateID, text: "two" },
        },
      ])
      const two = yield* events.replayAll([
        {
          id: EventV2.ID.create(),
          type: EventV2.versionedType(SyncMessage.type, 1),
          seq: 2,
          aggregateID,
          data: { id: aggregateID, text: "three" },
        },
        {
          id: EventV2.ID.create(),
          type: EventV2.versionedType(SyncMessage.type, 1),
          seq: 3,
          aggregateID,
          data: { id: aggregateID, text: "four" },
        },
      ])
      const rows = yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, aggregateID))
        .all()
        .pipe(Effect.orDie)

      expect(one).toBe(aggregateID)
      expect(two).toBe(aggregateID)
      expect(rows.map((row) => row.seq)).toEqual([0, 1, 2, 3])
    }),
  )

  it.effect("wakes aggregate subscribers when replayAll is interrupted after commit", () => {
    const initialRead = Deferred.make<void>()
    const committed = Deferred.make<void>()
    const releaseCommit = Deferred.make<void>()
    return Effect.all({ initialRead, committed, releaseCommit }).pipe(
      Effect.flatMap((signals) => {
        const database = Database.layerFromPath(":memory:")
        const eventLayer = EventV2.layerWith({
          afterAggregateRead: () => Deferred.succeed(signals.initialRead, undefined),
          afterReplayAllCommit: () =>
            Deferred.succeed(signals.committed, undefined).pipe(Effect.andThen(Deferred.await(signals.releaseCommit))),
        }).pipe(Layer.provide(database))
        return Effect.gen(function* () {
          const events = yield* EventV2.Service
          const aggregateID = EventV2.ID.create()
          const event = {
            id: EventV2.ID.create(),
            type: EventV2.versionedType(SyncMessage.type, 1),
            seq: 0,
            aggregateID,
            data: { id: aggregateID, text: "committed before interruption" },
          }
          const subscriber = yield* events
            .aggregateEvents({ aggregateID })
            .pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
          yield* Deferred.await(signals.initialRead)
          const replay = yield* events.replayAll([event]).pipe(Effect.forkChild)
          yield* Deferred.await(signals.committed)
          const interruption = yield* Fiber.interrupt(replay).pipe(Effect.forkChild)
          yield* Deferred.succeed(signals.releaseCommit, undefined)
          yield* Fiber.join(interruption)

          expect(Array.from(yield* Fiber.join(subscriber)).map((item) => item.event.data)).toEqual([event.data])
        }).pipe(Effect.provide(Layer.mergeAll(database, eventLayer)))
      }),
    )
  })

  it.effect("publishes replayAll observers once across an exact retry", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const aggregateID = EventV2.ID.create()
      const received: EventV2.Payload[] = []
      const event = {
        id: EventV2.ID.create(),
        type: EventV2.versionedType(SyncMessage.type, 1),
        seq: 0,
        aggregateID,
        data: { id: aggregateID, text: "exact replay" },
      }
      yield* events.listen((payload) => Effect.sync(() => received.push(payload)))

      yield* events.replayAll([event], { publish: true })
      yield* events.replayAll([event], { publish: true })

      expect(received.map((payload) => payload.id)).toEqual([event.id])
    }),
  )

  it.effect("repairs an exact historical replay with its commit hook without notifying twice", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const aggregateID = EventV2.ID.create()
      const payload = yield* events.publish(SyncMessage, { id: aggregateID, text: "historical" })
      const replayed = {
        id: payload.id,
        type: EventV2.versionedType(SyncMessage.type, 1),
        seq: payload.seq!,
        aggregateID,
        data: payload.data,
      }
      const received: EventV2.Payload[] = []
      const repaired: number[] = []
      yield* events.listen((event) => Effect.sync(() => received.push(event)))

      yield* events.replay(replayed, { publish: true, onCommit: (seq) => Effect.sync(() => repaired.push(seq)) })
      expect(repaired).toEqual([payload.seq!])
      expect(received).toHaveLength(0)

      const divergent = yield* events.replay({ ...replayed, data: { ...replayed.data, text: "changed" } }, {
        onCommit: (seq) => Effect.sync(() => repaired.push(seq)),
      }).pipe(Effect.exit)
      expect(String(divergent)).toContain("Replay diverged")
      expect(repaired).toEqual([payload.seq!])

      const failedRepair = yield* events.replay(replayed, {
        ownerID: "owner-a",
        onCommit: () => Effect.fail(new Error("mirror unavailable")),
      }).pipe(Effect.exit)
      expect(String(failedRepair)).toContain("mirror unavailable")
      const { db } = yield* Database.Service
      expect((yield* db.select({ ownerID: EventSequenceTable.owner_id }).from(EventSequenceTable)
        .where(eq(EventSequenceTable.aggregate_id, aggregateID)).get())?.ownerID).toBeNull()

      yield* events.claim(aggregateID, "owner-a")
      yield* events.replay(replayed, {
        onCommit: (seq) => Effect.sync(() => repaired.push(seq)),
      })
      expect(repaired).toEqual([payload.seq!])
      yield* events.replay(replayed, {
        ownerID: "owner-b",
        onCommit: (seq) => Effect.sync(() => repaired.push(seq)),
      })
      expect(repaired).toEqual([payload.seq!])
    }),
  )

  it.effect("keeps replayAll checked hook failures typed and rolls back the entire batch", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const aggregateID = EventV2.ID.create()
      const batch = [0, 1].map((seq) => ({
        id: EventV2.ID.create(),
        type: EventV2.versionedType(SyncMessage.type, 1),
        seq,
        aggregateID,
        data: { id: aggregateID, text: `event ${seq}` },
      }))
      const delivered: EventV2.ID[] = []
      yield* events.listen((event) => Effect.sync(() => delivered.push(event.id)))

      const failed = yield* events.replayAllChecked(batch, {
        publish: true,
        onCommit: (seq) => seq === 1 ? Effect.fail(new Error("second mirror unavailable")) : Effect.void,
      }).pipe(Effect.catch(Effect.succeed))
      expect(failed).toBeInstanceOf(EventV2.CommitHookError)
      if (failed instanceof EventV2.CommitHookError) {
        expect(failed.eventID).toBe(batch[1]?.id)
        expect(failed.message).toContain("second mirror unavailable")
      }
      expect(yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, aggregateID)).all()).toEqual([])
      expect(yield* db.select().from(EventSequenceTable).where(eq(EventSequenceTable.aggregate_id, aggregateID)).all()).toEqual([])
      expect(delivered).toEqual([])

      expect(yield* events.replayAllChecked(batch, { publish: true, onCommit: () => Effect.void })).toBe(aggregateID)
      expect(delivered).toEqual(batch.map((event) => event.id))
      expect((yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, aggregateID)).all())).toHaveLength(2)

      const exactRepair = yield* events.replayChecked(batch[0]!, {
        onCommit: () => Effect.fail(new Error("repair unavailable")),
      }).pipe(Effect.catch(Effect.succeed))
      expect(exactRepair).toBeInstanceOf(EventV2.CommitHookError)
      expect((yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, aggregateID)).all())).toHaveLength(2)
    }),
  )

  it.effect("claim fences replay owners", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const received = new Array<EventV2.Payload>()
      const aggregateID = EventV2.ID.create()
      yield* events.publish(SyncMessage, { id: aggregateID, text: "seed" })
      yield* events.claim(aggregateID, "owner-a")
      yield* events.project(SyncMessage, (event) =>
        Effect.sync(() => {
          received.push(event)
        }),
      )

      yield* events.replay(
        {
          id: EventV2.ID.create(),
          type: EventV2.versionedType(SyncMessage.type, 1),
          seq: 1,
          aggregateID,
          data: { id: aggregateID, text: "ignored" },
        },
        { ownerID: "owner-b" },
      )

      expect(received).toHaveLength(0)
    }),
  )

  it.effect("strict owner fences exact replay", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const aggregateID = EventV2.ID.create()
      const id = EventV2.ID.create()
      const replayed = {
        id,
        type: EventV2.versionedType(SyncMessage.type, 1),
        seq: 0,
        aggregateID,
        data: { id: aggregateID, text: "owned" },
      }
      yield* events.replay(replayed, { ownerID: "owner-a" })

      const exit = yield* events.replay(replayed, { ownerID: "owner-b", strictOwner: true }).pipe(Effect.exit)

      expect(String(exit)).toContain("Replay owner mismatch")
    }),
  )

  it.effect("exact replay claims an unowned aggregate", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const aggregateID = EventV2.ID.create()
      const published = yield* events.publish(SyncMessage, { id: aggregateID, text: "owned" })
      const replayed = {
        id: published.id,
        type: EventV2.versionedType(SyncMessage.type, 1),
        seq: published.seq!,
        aggregateID,
        data: published.data,
      }

      yield* events.replay(replayed, { ownerID: "owner-a", strictOwner: true })
      const row = yield* db
        .select({ ownerID: EventSequenceTable.owner_id })
        .from(EventSequenceTable)
        .where(eq(EventSequenceTable.aggregate_id, aggregateID))
        .get()
        .pipe(Effect.orDie)

      expect(row?.ownerID).toBe("owner-a")
      const exit = yield* events
        .replay(
          { ...replayed, id: EventV2.ID.create(), seq: 1, data: { id: aggregateID, text: "conflict" } },
          { ownerID: "owner-b", strictOwner: true },
        )
        .pipe(Effect.exit)
      expect(String(exit)).toContain("Replay owner mismatch")
    }),
  )

  it.effect("replay with owner claims an unowned sequence", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const aggregateID = EventV2.ID.create()

      yield* events.replay(
        {
          id: EventV2.ID.create(),
          type: EventV2.versionedType(SyncMessage.type, 1),
          seq: 0,
          aggregateID,
          data: { id: aggregateID, text: "owned" },
        },
        { ownerID: "owner-1" },
      )
      const row = yield* db
        .select({ seq: EventSequenceTable.seq, ownerID: EventSequenceTable.owner_id })
        .from(EventSequenceTable)
        .where(eq(EventSequenceTable.aggregate_id, aggregateID))
        .get()
        .pipe(Effect.orDie)

      expect(row).toEqual({ seq: 0, ownerID: "owner-1" })
    }),
  )

  it.effect("replay claims an existing unowned sequence before fencing a different owner", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const aggregateID = EventV2.ID.create()
      yield* events.publish(SyncMessage, { id: aggregateID, text: "local" })

      yield* events.replay(
        {
          id: EventV2.ID.create(),
          type: EventV2.versionedType(SyncMessage.type, 1),
          seq: 1,
          aggregateID,
          data: { id: aggregateID, text: "claimed" },
        },
        { ownerID: "owner-1" },
      )
      yield* events.replay(
        {
          id: EventV2.ID.create(),
          type: EventV2.versionedType(SyncMessage.type, 1),
          seq: 2,
          aggregateID,
          data: { id: aggregateID, text: "fenced" },
        },
        { ownerID: "owner-2" },
      )
      const rows = yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, aggregateID))
        .all()
        .pipe(Effect.orDie)
      const sequence = yield* db
        .select({ seq: EventSequenceTable.seq, ownerID: EventSequenceTable.owner_id })
        .from(EventSequenceTable)
        .where(eq(EventSequenceTable.aggregate_id, aggregateID))
        .get()
        .pipe(Effect.orDie)

      expect(rows.map((row) => row.seq)).toEqual([0, 1])
      expect(sequence).toEqual({ seq: 1, ownerID: "owner-1" })
    }),
  )

  it.effect("strict replay rejects an owner conflict instead of silently skipping it", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const aggregateID = EventV2.ID.create()
      yield* events.replay(
        {
          id: EventV2.ID.create(),
          type: EventV2.versionedType(SyncMessage.type, 1),
          seq: 0,
          aggregateID,
          data: { id: aggregateID, text: "claimed" },
        },
        { ownerID: "owner-1" },
      )

      const exit = yield* events
        .replay(
          {
            id: EventV2.ID.create(),
            type: EventV2.versionedType(SyncMessage.type, 1),
            seq: 1,
            aggregateID,
            data: { id: aggregateID, text: "conflict" },
          },
          { ownerID: "owner-2", strictOwner: true },
        )
        .pipe(Effect.exit)

      expect(String(exit)).toContain("Replay owner mismatch")
    }),
  )

  it.effect("publishes accepted replay with its durable sequence and suppresses stale replay", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const received = new Array<EventV2.Payload>()
      const aggregateID = EventV2.ID.create()
      yield* events.listen((event) => Effect.sync(() => received.push(event)))
      const replayed = {
        id: EventV2.ID.create(),
        type: EventV2.versionedType(SyncMessage.type, 1),
        seq: 0,
        aggregateID,
        data: { id: aggregateID, text: "replayed" },
      }

      yield* events.replay(replayed, { publish: true })
      yield* events.replay(replayed, { publish: true })

      expect(received).toMatchObject([{ id: replayed.id, seq: 0, data: replayed.data }])
    }),
  )

  it.effect("rejects divergent stale replay without publishing it", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const received = new Array<EventV2.Payload>()
      const aggregateID = EventV2.ID.create()
      const replayed = {
        id: EventV2.ID.create(),
        type: EventV2.versionedType(SyncMessage.type, 1),
        seq: 0,
        aggregateID,
        data: { id: aggregateID, text: "original" },
      }
      yield* events.listen((event) => Effect.sync(() => received.push(event)))
      yield* events.replay(replayed, { publish: true })

      const exit = yield* events
        .replay({ ...replayed, data: { id: aggregateID, text: "divergent" } }, { publish: true })
        .pipe(Effect.exit)

      expect(String(exit)).toContain("Replay diverged")
      expect(received).toHaveLength(1)
    }),
  )

  it.effect("rejects an event ID reused at another aggregate position", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const aggregateID = EventV2.ID.create()
      const id = EventV2.ID.create()
      yield* events.replay({
        id,
        type: EventV2.versionedType(SyncMessage.type, 1),
        seq: 0,
        aggregateID,
        data: { id: aggregateID, text: "first" },
      })

      const exit = yield* events
        .replay({
          id,
          type: EventV2.versionedType(SyncMessage.type, 1),
          seq: 1,
          aggregateID,
          data: { id: aggregateID, text: "second" },
        })
        .pipe(Effect.exit)

      expect(String(exit)).toContain(`Event ${id} already exists`)
    }),
  )

  it.effect("replay from a different owner leaves claimed sequence unchanged", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const aggregateID = EventV2.ID.create()
      const received = new Array<EventV2.Payload>()
      yield* events.listen((event) => Effect.sync(() => received.push(event)))

      yield* events.replay(
        {
          id: EventV2.ID.create(),
          type: EventV2.versionedType(SyncMessage.type, 1),
          seq: 0,
          aggregateID,
          data: { id: aggregateID, text: "first" },
        },
        { ownerID: "owner-1" },
      )
      yield* events.replay(
        {
          id: EventV2.ID.create(),
          type: EventV2.versionedType(SyncMessage.type, 1),
          seq: 1,
          aggregateID,
          data: { id: aggregateID, text: "ignored" },
        },
        { ownerID: "owner-2", publish: true },
      )
      const rows = yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, aggregateID))
        .all()
        .pipe(Effect.orDie)
      const sequence = yield* db
        .select({ seq: EventSequenceTable.seq, ownerID: EventSequenceTable.owner_id })
        .from(EventSequenceTable)
        .where(eq(EventSequenceTable.aggregate_id, aggregateID))
        .get()
        .pipe(Effect.orDie)

      expect(rows).toHaveLength(1)
      expect(sequence).toEqual({ seq: 0, ownerID: "owner-1" })
      expect(received).toHaveLength(0)
    }),
  )

  it.effect("claim updates the event sequence owner", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const aggregateID = EventV2.ID.create()

      yield* events.publish(SyncMessage, { id: aggregateID, text: "claimed" })
      yield* events.claim(aggregateID, "owner-1")
      yield* events.claim(aggregateID, "owner-2")
      const row = yield* db
        .select({ seq: EventSequenceTable.seq, ownerID: EventSequenceTable.owner_id })
        .from(EventSequenceTable)
        .where(eq(EventSequenceTable.aggregate_id, aggregateID))
        .get()
        .pipe(Effect.orDie)

      expect(row).toEqual({ seq: 0, ownerID: "owner-2" })
    }),
  )

  it.effect("remove clears sync event sequence", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const received = new Array<EventV2.Payload>()
      const aggregateID = EventV2.ID.create()
      yield* events.publish(SyncMessage, { id: aggregateID, text: "seed" })
      yield* events.remove(aggregateID)
      yield* events.project(SyncMessage, (event) =>
        Effect.sync(() => {
          received.push(event)
        }),
      )

      yield* events.replay({
        id: EventV2.ID.create(),
        type: EventV2.versionedType(SyncMessage.type, 1),
        seq: 0,
        aggregateID,
        data: { id: aggregateID, text: "replayed" },
      })

      expect(received[0]?.data).toEqual({ id: aggregateID, text: "replayed" })
    }),
  )

  it.effect("fences deleted aggregates and removes snapshot sidecars without deleting the tombstone", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const aggregateID = SessionSchema.ID.make("ses_event_tombstone")
      const info = SessionV1.SessionInfo.make({
        id: aggregateID,
        slug: "tombstone",
        version: "test",
        projectID: ProjectV2.ID.global,
        directory: "/project",
        title: "tombstone",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: 1, updated: 1 },
      })
      const deletion = yield* events.publish(SessionV1.Event.Deleted, { sessionID: aggregateID, info })
      const retry = yield* events.publish(SessionV1.Event.Deleted, { sessionID: aggregateID, info }, {
        id: deletion.id,
        idempotent: true,
      })
      expect(retry.id).toBe(deletion.id)
      const divergent = yield* events
        .publish(SessionV1.Event.Deleted, {
          sessionID: aggregateID,
          info: SessionV1.SessionInfo.make({ ...info, title: "different" }),
        }, { id: deletion.id, idempotent: true })
        .pipe(Effect.catchDefect(Effect.succeed))
      expect(divergent).toBeInstanceOf(EventV2.InvalidSyncEventError)
      const rowHash = "a".repeat(64)
      yield* db
        .insert(EventSnapshotRowTable)
        .values({
          snapshot_id: "snapshot-tombstone",
          aggregate_id: aggregateID,
          row_index: 0,
          table_name: "session",
          row_key: aggregateID,
          row_hash: rowHash,
          row_bytes: 1,
          chunk_count: 1,
          chain_hash: "b".repeat(64),
        })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(EventSnapshotChunkTable)
        .values({ row_hash: rowHash, chunk_index: 0, data: Buffer.from("x"), chunk_hash: "c".repeat(64) })
        .run()
        .pipe(Effect.orDie)

      yield* events.remove(aggregateID)

      expect(yield* events.isDeleted!(aggregateID)).toBe(true)
      expect(
        yield* db.select().from(EventAggregateTombstoneTable).where(eq(EventAggregateTombstoneTable.aggregate_id, aggregateID)).all(),
      ).toHaveLength(1)
      expect(yield* db.select().from(EventSequenceTable).where(eq(EventSequenceTable.aggregate_id, aggregateID)).all()).toEqual([])
      expect(yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, aggregateID)).all()).toEqual([])
      expect(yield* db.select().from(EventSyncIndexTable).where(eq(EventSyncIndexTable.aggregate_id, aggregateID)).all()).toEqual([])
      expect(yield* db.select().from(EventSnapshotRowTable).where(eq(EventSnapshotRowTable.aggregate_id, aggregateID)).all()).toEqual([])
      expect(yield* db.select().from(EventSnapshotChunkTable).where(eq(EventSnapshotChunkTable.row_hash, rowHash)).all()).toEqual([])

      const rejected = yield* events
        .publish(SessionV1.Event.Updated, { sessionID: aggregateID, info })
        .pipe(Effect.catchDefect(Effect.succeed))
      expect(rejected).toBeInstanceOf(EventV2.InvalidSyncEventError)
      const replayRejected = yield* events
        .replay({
          id: EventV2.ID.create(),
          type: EventV2.versionedType(SessionV1.Event.Updated.type, 1),
          seq: 0,
          aggregateID,
          data: { sessionID: aggregateID, info },
        })
        .pipe(Effect.catchDefect(Effect.succeed))
      expect(replayRejected).toBeInstanceOf(EventV2.InvalidSyncEventError)
      expect((yield* db.select().from(EventAggregateTombstoneTable).where(eq(EventAggregateTombstoneTable.aggregate_id, aggregateID)).get())?.deletion_event_id).toBe(
        deletion.id,
      )
    }),
  )

  // event maintenance / REL-002: until the canonical owner handoff completes, a durable source fence
  // (`event_sequence.write_fence_transfer_id` backed by an admitted transfer operation) must fail
  // closed for both replay and local publish — no event may land on the fenced aggregate.
  it.effect("a durable transfer write fence fails closed for replay and publish before handoff completes", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const aggregateID = "session-transfer-fenced"
      // fixture-exempt: bare project/session rows exist only to satisfy the
      // session_transfer_operation FK so the fence authority trigger admits the transfer.
      yield* db.run(sql`
        INSERT INTO project (id, worktree, sandboxes, time_created, time_updated)
        VALUES ('project-transfer-fence', '/tmp/transfer-fence', '[]', 1, 1)
      `)
      // fixture-exempt: bare session row anchors the transfer fence aggregate (see above).
      yield* db.run(sql`
        INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
        VALUES (${aggregateID}, 'project-transfer-fence', 'transfer-fence', '/tmp/transfer-fence', 'Transfer fence', 'test', 1, 1)
      `)
      yield* events.publish(SyncMessage, { id: aggregateID, text: "before handoff" })
      // fixture-exempt: seeds an admitted (in-flight) transfer operation; the handoff never
      // advances, so the source fence must keep the aggregate fail closed.
      yield* db.run(sql`
        INSERT INTO session_transfer_operation (
          transfer_id, session_id, source_owner_id, target_owner_id,
          source_event_seq, source_mutation_epoch, state, request_hash, created_at, updated_at
        ) VALUES (
          'transfer-fence', ${aggregateID}, 'source-owner', 'target-owner',
          0, 0, 'admitted', ${"f".repeat(64)}, 1, 1
        )
      `)
      yield* db
        .update(EventSequenceTable)
        .set({ write_fence_transfer_id: "transfer-fence" })
        .where(eq(EventSequenceTable.aggregate_id, aggregateID))
        .run()
        .pipe(Effect.orDie)

      const replayExit = yield* events
        .replay(
          {
            id: EventV2.ID.create(),
            type: EventV2.versionedType(SyncMessage.type, 1),
            seq: 1,
            aggregateID,
            data: { id: aggregateID, text: "stolen" },
          },
          { ownerID: "target-owner", strictOwner: true },
        )
        .pipe(Effect.exit)
      expect(String(replayExit)).toContain("is fenced by transfer transfer-fence")

      const publishExit = yield* events
        .publish(SyncMessage, { id: aggregateID, text: "local write after fence" })
        .pipe(Effect.exit)
      expect(String(publishExit)).toContain("is fenced by transfer transfer-fence")

      const rows = yield* db
        .select({ seq: EventTable.seq })
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, aggregateID))
        .all()
        .pipe(Effect.orDie)
      expect(rows.map((row) => row.seq)).toEqual([0])
    }),
  )
})
