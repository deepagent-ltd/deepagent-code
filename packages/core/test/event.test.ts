import { describe, expect } from "bun:test"
import { Cause, DateTime, Deferred, Effect, Exit, Fiber, Layer, Schema, Stream } from "effect"
import { EventV2 } from "@deepagent-code/core/event"
import { Database } from "@deepagent-code/core/database/database"
import {
  EventArtifactChunkTable,
  EventArtifactTable,
  EventDedupeTable,
  EventSequenceTable,
  EventSnapshotTable,
  EventTable,
} from "@deepagent-code/core/event/sql"
import { Location } from "@deepagent-code/core/location"
import { AbsolutePath } from "@deepagent-code/core/schema"
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
const eventLayer = Layer.mergeAll(EventV2.defaultLayer, Database.defaultLayer)
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

const LegacyMessageUpdated = EventV2.define({
  type: "message.updated",
  sync: {
    version: 1,
    aggregate: "sessionID",
  },
  schema: {
    sessionID: Schema.String,
    info: Schema.Any,
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
        .publish(
          SyncPayload,
          payloadAtEncodedBytes(aggregateID, "session", EventV2.MAX_ENCODED_PAYLOAD_BYTES + 1),
          { commit: () => Effect.sync(() => observed.push("commit")) },
        )
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
          Array.from(
            yield* events.aggregateEvents({ aggregateID }).pipe(Stream.take(count), Stream.runCollect),
          ).map((event) => event.cursor),
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
        expect(received.map((event) => event.cursor)).toEqual([
          EventV2.Cursor.make(0),
          EventV2.Cursor.make(1),
        ])
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

  it.effect(
    "fails with a typed defect when aggregate history is removed between metadata and body reads",
    () => {
      let events: EventV2.Interface
      const database = Database.layerFromPath(":memory:")
      const eventLayer = EventV2.layerWith({
        afterAggregateReadMetadata: (aggregateID) => events.remove(aggregateID),
      }).pipe(Layer.provide(database))

      return Effect.gen(function* () {
        events = yield* EventV2.Service
        const aggregateID = EventV2.ID.create()
        yield* events.publish(SyncMessage, { id: aggregateID, text: "removed during read" })
        const defect = yield* events.aggregateEvents({ aggregateID }).pipe(
          Stream.take(1),
          Stream.runCollect,
          Effect.catchDefect(Effect.succeed),
        )
        expect(defect).toBeInstanceOf(EventV2.InvalidSyncEventError)
        expect(defect).toMatchObject({
          _tag: "EventV2.InvalidSyncEvent",
          type: EventV2.versionedType(SyncMessage.type, 1),
        })
      }).pipe(Effect.provide(Layer.mergeAll(database, eventLayer)))
    },
  )

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
      const checkpoint = yield* events.checkpoint({
        aggregateID,
        throughSeq: EventV2.Cursor.make(0),
        expectedLatest: EventV2.Cursor.make(0),
        codec: "test.v1",
        schemaVersion: 1,
        body: { value: "zero" },
      }).pipe(Effect.catchDefect(Effect.succeed))
      expect(checkpoint).toBeInstanceOf(EventV2.InvalidSyncEventError)
      const compact = yield* events
        .compact({ aggregateID, throughSeq: EventV2.Cursor.make(0), limit: 1 })
        .pipe(Effect.catchDefect(Effect.succeed))
      expect(compact).toBeInstanceOf(EventV2.InvalidSyncEventError)
      expect(yield* events.snapshot(aggregateID)).toBeUndefined()
      expect(yield* db.select().from(EventDedupeTable).all().pipe(Effect.orDie)).toEqual([])
      expect(yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, aggregateID)).all().pipe(Effect.orDie)).toHaveLength(1)
    }),
  )

  it.effect("canonicalizes oversized legacy message diffs into deterministic BLOB chunks", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const aggregateID = EventV2.ID.create()
      yield* events.publish(SyncMessage, { id: aggregateID, text: "zero" })
      const id = EventV2.ID.make("evt_legacy_message_diff_artifact")
      const patch = "x".repeat(EventV2.MAX_ENCODED_PAYLOAD_BYTES + 1)
      const data = {
        sessionID: aggregateID,
        info: { summary: { diffs: [{ file: "large.patch", patch, additions: 1, deletions: 0 }] } },
      }
      yield* db.insert(EventTable).values({
        id,
        aggregate_id: aggregateID,
        seq: 1,
        type: EventV2.versionedType("message.updated", 1),
        data,
      }).run().pipe(Effect.orDie)
      yield* db.update(EventSequenceTable).set({ seq: 1 }).where(eq(EventSequenceTable.aggregate_id, aggregateID)).run().pipe(Effect.orDie)

      const first = yield* events.canonicalizeLegacyArtifacts({ limit: 1, now: 10 })
      expect(first).toEqual({ processed: 1, next: id })
      expect(yield* events.canonicalizeLegacyArtifacts({ afterID: id, limit: 1, now: 11 })).toEqual({ processed: 0 })
      const artifact = yield* db.select().from(EventArtifactTable).where(eq(EventArtifactTable.event_id, id)).get().pipe(Effect.orDie)
      expect(artifact?.kind).toBe("legacy_message_diff")
      expect(artifact?.body_bytes).toBeGreaterThan(EventV2.MAX_ENCODED_PAYLOAD_BYTES)
      expect(artifact?.chunk_count).toBeGreaterThan(1)
      const summary = (artifact?.canonical_data.info as {
        summary: {
          diffs: Array<{ patch?: string }>
          diffArtifact: { codec: string; hash: string }
        }
      }).summary
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
        type: EventV2.versionedType(LegacyMessageUpdated.type, 1),
        seq: 1,
        aggregateID,
        data: artifact!.canonical_data,
      })
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
})
