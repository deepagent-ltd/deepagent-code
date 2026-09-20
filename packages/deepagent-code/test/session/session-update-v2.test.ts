import { describe, expect } from "bun:test"
import { Effect, Layer, Ref } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@deepagent-code/core/database/database"
import { EventV2 } from "@deepagent-code/core/event"
import { EventAggregateTombstoneTable, EventTable } from "@deepagent-code/core/event/sql"
import { SessionTable } from "@deepagent-code/core/session/sql"
import { SessionProjector } from "@deepagent-code/core/session/projector"
import { CrossSpawnSpawner } from "@deepagent-code/core/cross-spawn-spawner"
import * as Log from "@deepagent-code/core/util/log"
import { Session as SessionNs } from "@/session/session"
import { MessageID } from "@/session/schema"
import { EventV2Bridge } from "@/event-v2-bridge"
import { V2OutboxWriter } from "@/event/v2-outbox-writer"
import { Storage } from "@/storage/storage"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { BackgroundJob } from "@/background/job"
import { testInstanceStoreLayer } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"

void Log.init({ print: false })

// RI-16 — all Session metadata, diff summary, and revert mutations now use native V2 authorities;
// EventV2Bridge rebuilds the legacy client shapes at the egress boundary.

const it = testEffect(
  Layer.mergeAll(
    SessionNs.layer.pipe(
      Layer.provide(Storage.defaultLayer),
      Layer.provide(Database.defaultLayer),
      Layer.provideMerge(EventV2Bridge.defaultLayer),
      Layer.provide(SessionProjector.defaultLayer),
      Layer.provide(RuntimeFlags.layer({ experimentalWorkspaces: false })),
      Layer.provide(BackgroundJob.defaultLayer),
    ),
    Database.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    testInstanceStoreLayer,
  ),
)

const eventTypes = (sessionID: string) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    return (yield* db
      .select({ type: EventTable.type })
      .from(EventTable)
      .where(eq(EventTable.aggregate_id, sessionID))
      .all()
      .pipe(Effect.orDie)).map((row) => row.type)
  })

type UpdatedPayload = { sessionID: string; info: Record<string, unknown> & { time: { archived?: number | null } } }

describe("Session V2-native update authority (RI-16)", () => {
  it.instance("registers session.updated as a landed C5 lifecycle fact", () =>
    Effect.sync(() => {
      expect(
        V2OutboxWriter.registrationForEventType("session.updated", V2OutboxWriter.EVENT_V2_OUTBOX_REGISTRY),
      ).toBeDefined()
    }),
  )

  it.instance("setTitle publishes and projects session.updated.2; clients receive the legacy egress shape", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const events = yield* EventV2Bridge.Service
      const seen = yield* Ref.make<EventV2.Payload[]>([])
      const unsub = yield* events.listen((event) =>
        event.type === SessionNs.Event.Updated.type ? Ref.update(seen, (all) => [...all, event]) : Effect.void,
      )
      yield* Effect.addFinalizer(() => unsub)

      const info = yield* session.create({})
      yield* session.setTitle({ sessionID: info.id, title: "v2 native title" })

      expect((yield* session.get(info.id)).title).toBe("v2 native title")
      expect(yield* eventTypes(info.id)).toEqual(["session.created.1", "session.updated.2"])

      const converted = yield* pollWithTimeout(
        Ref.get(seen).pipe(Effect.map((all) => (all.length > 0 ? all : undefined))),
        "timed out waiting for the converted session.updated event",
      )
      const payload = converted[0].data as UpdatedPayload
      expect(payload.info).toMatchObject({
        id: info.id,
        slug: info.slug,
        version: info.version,
        directory: info.directory,
        title: "v2 native title",
      })
      expect("location" in payload.info).toBe(false)
      expect("permissions" in payload.info).toBe(false)
    }),
  )

  it.instance("archive and unarchive round-trip through the native authority with an explicit client clear", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const events = yield* EventV2Bridge.Service
      const seen = yield* Ref.make<EventV2.Payload[]>([])
      const unsub = yield* events.listen((event) =>
        event.type === SessionNs.Event.Updated.type ? Ref.update(seen, (all) => [...all, event]) : Effect.void,
      )
      yield* Effect.addFinalizer(() => unsub)

      const info = yield* session.create({})
      yield* session.setArchived({ sessionID: info.id, time: 123 })
      expect((yield* session.get(info.id)).time.archived).toBe(123)

      yield* session.setArchived({ sessionID: info.id, time: null })
      expect((yield* session.get(info.id)).time.archived).toBeUndefined()
      expect(yield* eventTypes(info.id)).toEqual(["session.created.1", "session.updated.2", "session.updated.2"])

      const converted = yield* pollWithTimeout(
        Ref.get(seen).pipe(Effect.map((all) => (all.length >= 2 ? all : undefined))),
        "timed out waiting for the converted archive events",
      )
      expect(converted.map((event) => (event.data as UpdatedPayload).info.time.archived)).toEqual([123, null])
    }),
  )

  it.instance("touch keeps metadata through the native V2 full-state mirror", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const info = yield* session.create({})
      yield* session.setMetadata({ sessionID: info.id, metadata: { origin: "keep" } })
      const before = (yield* session.get(info.id)).time.updated

      yield* session.touch(info.id)

      const after = yield* session.get(info.id)
      expect(after.metadata).toEqual({ origin: "keep" })
      expect(after.time.updated).toBeGreaterThanOrEqual(before)
      expect(yield* eventTypes(info.id)).toEqual(["session.created.1", "session.updated.2", "session.updated.2"])
    }),
  )

  it.instance("metadata, share, and preview use native V2 updates with explicit clear and write-once rules", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const info = yield* session.create({})

      yield* session.setMetadata({ sessionID: info.id, metadata: { source: "native", count: 1 } })
      yield* session.setShare({ sessionID: info.id, share: { url: "https://share.example/session" } })
      yield* session.setPreview({ sessionID: info.id, preview: "first preview" })
      yield* session.setMetadata({ sessionID: info.id, metadata: null })

      const current = yield* session.get(info.id)
      expect(current.metadata).toBeUndefined()
      expect(current.share).toEqual({ url: "https://share.example/session" })
      expect(current.preview).toBe("first preview")
      expect(yield* eventTypes(info.id)).toEqual([
        "session.created.1",
        "session.updated.2",
        "session.updated.2",
        "session.updated.2",
        "session.updated.2",
      ])
    }),
  )

  it.instance("summary/diff and revert use independent durable V2 events", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const { db } = yield* Database.Service
      const info = yield* session.create({})

      yield* session.setSummary({
        sessionID: info.id,
        summary: { additions: 2, deletions: 1, files: 1 },
        diff: [{ file: "src/a.ts", additions: 2, deletions: 1, status: "modified" }],
      })
      const target = MessageID.ascending()
      yield* session.setRevert({
        sessionID: info.id,
        revert: { messageID: target },
        summary: { additions: 2, deletions: 1, files: 1 },
      })

      const row = yield* db
        .select({
          additions: SessionTable.summary_additions,
          deletions: SessionTable.summary_deletions,
          files: SessionTable.summary_files,
          diffs: SessionTable.summary_diffs,
          revert: SessionTable.revert,
          mutationEpoch: SessionTable.mutation_epoch,
        })
        .from(SessionTable)
        .where(eq(SessionTable.id, info.id))
        .get()
        .pipe(Effect.orDie)
      expect(row).toMatchObject({ additions: 2, deletions: 1, files: 1, mutationEpoch: 1 })
      expect(row?.diffs).toEqual([{ file: "src/a.ts", additions: 2, deletions: 1, status: "modified" }])
      expect(row?.revert).toMatchObject({ messageID: target })
      expect(yield* eventTypes(info.id)).toEqual([
        "session.created.1",
        "session.diff.2",
        "session.revert.1",
      ])
    }),
  )

  it.instance("remove publishes native session.deleted.2, emits the V1 egress shape, and retains its fence", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const events = yield* EventV2Bridge.Service
      const { db } = yield* Database.Service
      const seen = yield* Ref.make<EventV2.Payload[]>([])
      const unsub = yield* events.listen((event) =>
        event.type === SessionNs.Event.Deleted.type ? Ref.update(seen, (all) => [...all, event]) : Effect.void,
      )
      yield* Effect.addFinalizer(() => unsub)

      const info = yield* session.create({})
      yield* session.remove(info.id)

      expect(
        yield* db
          .select()
          .from(EventAggregateTombstoneTable)
          .where(eq(EventAggregateTombstoneTable.aggregate_id, info.id))
          .get(),
      ).toMatchObject({ aggregate_id: info.id, reason: "aggregate_deleted" })
      const converted = yield* pollWithTimeout(
        Ref.get(seen).pipe(Effect.map((all) => (all.length > 0 ? all : undefined))),
        "timed out waiting for the converted session.deleted event",
      )
      expect(converted[0]).toMatchObject({
        type: "session.deleted",
        version: 2,
        data: { sessionID: info.id, info: { id: info.id, slug: info.slug, title: info.title } },
      })
    }),
  )
})
