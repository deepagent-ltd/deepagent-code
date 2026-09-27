import { describe, expect } from "bun:test"
import path from "path"
import { Effect, Layer } from "effect"
import { asc, eq } from "drizzle-orm"
import { Database } from "@deepagent-code/core/database/database"
import { EventV2 } from "@deepagent-code/core/event"
import { EventTable } from "@deepagent-code/core/event/sql"
import { Location } from "@deepagent-code/core/location"
import { ProjectV2 } from "@deepagent-code/core/project"
import { ProjectTable } from "@deepagent-code/core/project/sql"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { SessionV2 } from "@deepagent-code/core/session"
import { SessionV1 } from "@deepagent-code/core/v1/session"
import { SessionProjector } from "@deepagent-code/core/session/projector"
import { SessionExecution } from "@deepagent-code/core/session/execution"
import { SessionEvent } from "@deepagent-code/core/session/event"
import { SessionInfo } from "@deepagent-code/core/session/info"
import { SessionSchema } from "@deepagent-code/core/session/schema"
import { SessionTable } from "@deepagent-code/core/session/sql"
import { SessionInputTable } from "@deepagent-code/core/session/sql"
import { SessionStore } from "@deepagent-code/core/session/store"
import { DateTime } from "effect"
import { testEffect } from "./lib/effect"
import { tmpdir } from "./fixture/tmpdir"

const database = Database.layerFromPath(":memory:")
const events = EventV2.layer.pipe(Layer.provide(database))
const projects = Layer.succeed(
  ProjectV2.Service,
  ProjectV2.Service.of({
    resolve: (directory) => Effect.succeed({ id: ProjectV2.ID.global, directory }),
    directories: () => Effect.succeed([]),
    commit: () => Effect.void,
  }),
)
const projector = SessionProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
const store = SessionStore.layer.pipe(Layer.provide(database))
const sessions = SessionV2.layer.pipe(
  Layer.provide(events),
  Layer.provide(database),
  Layer.provide(store),
  Layer.provide(projects),
  Layer.provide(SessionExecution.noopLayer),
)
const it = testEffect(
  Layer.mergeAll(database, events, projects, projector, store, SessionExecution.noopLayer, sessions),
)
const location = Location.Ref.make({ directory: AbsolutePath.make("/project") })

const rowOf = (sessionID: SessionSchema.ID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const row = yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie)
    if (!row) return yield* Effect.die(`Session row missing: ${sessionID}`)
    return row
  })

const publishV2Update = (sessionID: SessionSchema.ID, apply: (info: SessionSchema.Info) => SessionSchema.Info) =>
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const row = yield* rowOf(sessionID)
    return yield* events.publish(SessionEvent.Updated, {
      sessionID,
      info: apply(SessionInfo.fromRow(row)),
      slug: row.slug,
      version: row.version,
    })
  })

describe("SessionV2 native session.updated.2 authority", () => {
  it.effect("keeps a V1-only row readable while refusing every V2 prompt and update write", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const id = SessionV2.ID.make("ses_legacy_read_only")
      yield* db
        .insert(ProjectTable)
        .values({ id: ProjectV2.ID.global, worktree: location.directory, sandboxes: [] })
        .onConflictDoNothing()
        .run()
      yield* events.publish(SessionV1.Event.Created, {
        sessionID: id,
        info: SessionV1.SessionInfo.make({
          id,
          slug: "legacy",
          version: "test",
          projectID: ProjectV2.ID.global,
          directory: location.directory,
          title: "Historical",
          time: { created: 1, updated: 1 },
        }),
      })
      expect((yield* sessions.get(id)).title).toBe("Historical")
      expect((yield* rowOf(id)).v2_authority).toBe(false)
      const prompt = yield* sessions
        .prompt({ sessionID: id, prompt: { text: "must not admit" }, resume: false })
        .pipe(Effect.flip)
      expect(prompt).toBeInstanceOf(SessionV2.LegacySessionRequiresAdoption)
      expect(yield* sessions.update({ sessionID: id, title: "forbidden" }).pipe(Effect.flip)).toBeInstanceOf(
        SessionV2.LegacySessionRequiresAdoption,
      )
      expect(yield* sessions.setPermissions({ sessionID: id, permissions: [] }).pipe(Effect.flip)).toBeInstanceOf(
        SessionV2.LegacySessionRequiresAdoption,
      )
      expect(yield* sessions.interrupt(id).pipe(Effect.flip)).toBeInstanceOf(SessionV2.LegacySessionRequiresAdoption)
      expect(yield* sessions.resume(id).pipe(Effect.flip)).toBeInstanceOf(SessionV2.LegacySessionRequiresAdoption)
      expect((yield* rowOf(id)).title).toBe("Historical")
      expect(
        (yield* db.select().from(SessionInputTable).where(eq(SessionInputTable.session_id, id)).all()).length,
      ).toBe(0)
      expect(
        (yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, id)).all()).map((event) => event.type),
      ).toEqual(["session.created.1"])
    }),
  )

  it.effect("updates title, metadata, permissions and archive with one native V2 event", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      const { db } = yield* Database.Service
      const created = yield* sessions.create({ location })
      const updated = yield* sessions.update({
        sessionID: created.id,
        title: "Renamed",
        metadata: { source: "w3" },
        permissions: [{ action: "bash", resource: "*", effect: "deny" }],
        archived: 42,
      })
      expect(updated.title).toBe("Renamed")
      expect(updated.metadata).toEqual({ source: "w3" })
      expect(updated.permissions).toEqual([{ action: "bash", resource: "*", effect: "deny" }])
      expect((yield* rowOf(created.id)).time_archived).toBe(42)
      expect(
        (yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, created.id)).all()).map(
          (event) => event.type,
        ),
      ).toEqual(["session.created.2", "session.updated.2"])
    }),
  )
  it.effect("registers session.updated.2 as the canonical synchronized definition", () =>
    Effect.sync(() => {
      expect(EventV2.syncRegistry.get("session.updated.1")).toBeDefined()
      expect(EventV2.syncRegistry.get("session.updated.2")).toBeDefined()
      expect(EventV2.registry.get("session.updated")?.sync?.version).toBe(2)
    }),
  )

  it.effect("projects V2-modeled columns without touching V1-only columns", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      const created = yield* session.create({ location })
      yield* db
        .update(SessionTable)
        .set({ metadata: { origin: "v1-owned" }, preview: "first prompt" })
        .where(eq(SessionTable.id, created.id))
        .run()
        .pipe(Effect.orDie)

      yield* publishV2Update(created.id, (info) =>
        SessionSchema.Info.make({
          ...info,
          title: "renamed",
          time: { ...info.time, archived: DateTime.makeUnsafe(1234) },
        }),
      )

      const row = yield* rowOf(created.id)
      expect(row.title).toBe("renamed")
      expect(row.time_archived).toBe(1234)
      expect(row.metadata).toEqual({ origin: "v1-owned" })
      expect(row.preview).toBe("first prompt")
      expect(row.directory).toBe(location.directory)
      expect(
        yield* db
          .select({ type: EventTable.type })
          .from(EventTable)
          .where(eq(EventTable.aggregate_id, created.id))
          .all()
          .pipe(Effect.orDie),
      ).toEqual([{ type: "session.created.2" }, { type: "session.updated.2" }])
    }),
  )

  it.effect("clears the archived flag through the native update authority", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const created = yield* session.create({ location })

      yield* publishV2Update(created.id, (info) =>
        SessionSchema.Info.make({ ...info, time: { ...info.time, archived: DateTime.makeUnsafe(55) } }),
      )
      expect((yield* rowOf(created.id)).time_archived).toBe(55)

      yield* publishV2Update(created.id, (info) =>
        SessionSchema.Info.make({ ...info, time: { ...info.time, archived: undefined } }),
      )
      expect((yield* rowOf(created.id)).time_archived).toBeNull()
    }),
  )

  it.effect("sync ingress replays both the v1 import update and the v2 authority update", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const created = yield* session.create({ location })

      yield* events.publish(SessionV1.Event.Updated, {
        sessionID: created.id,
        info: SessionV1.SessionInfo.make({
          id: created.id,
          slug: "imported-legacy",
          version: "test",
          projectID: created.projectID,
          directory: created.location.directory,
          title: "legacy import title",
          agent: "build",
          time: { created: 0, updated: 1 },
        }),
      })
      yield* publishV2Update(created.id, (info) => SessionSchema.Info.make({ ...info, title: "native title" }))
      expect((yield* rowOf(created.id)).agent).toBe("build")

      const serialized = (yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, created.id))
        .orderBy(asc(EventTable.seq))
        .all()
        .pipe(Effect.orDie)).map((event) => ({
        id: event.id,
        aggregateID: event.aggregate_id,
        seq: event.seq,
        type: event.type,
        data: event.data,
      }))
      expect(serialized.map((event) => event.type)).toEqual([
        "session.created.2",
        "session.updated.1",
        "session.updated.2",
      ])

      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      const targetDatabase = Database.layerFromPath(path.join(tmp.path, "target.sqlite"))
      const targetEvents = EventV2.layer.pipe(Layer.provide(targetDatabase))
      const targetProjector = SessionProjector.layer.pipe(Layer.provide(targetEvents), Layer.provide(targetDatabase))
      const targetStore = SessionStore.layer.pipe(Layer.provide(targetDatabase))

      yield* Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const events = yield* EventV2.Service
        const store = yield* SessionStore.Service
        yield* db
          .insert(ProjectTable)
          .values({ id: ProjectV2.ID.global, worktree: location.directory, sandboxes: [] })
          .run()
          .pipe(Effect.orDie)

        yield* events.replayAll(serialized)
        const replayed = yield* store.get(created.id)
        expect(replayed).toMatchObject({ title: "native title", agent: "build" })
        expect(
          (yield* db
            .select({ authority: SessionTable.v2_authority })
            .from(SessionTable)
            .where(eq(SessionTable.id, created.id))
            .get())?.authority,
        ).toBe(true)
      }).pipe(Effect.provide(Layer.fresh(Layer.mergeAll(targetDatabase, targetEvents, targetProjector, targetStore))))
    }),
  )

  it.effect("rejects a replayed v2 update without an existing projected Session", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      const created = yield* session.create({ location })
      const stored = yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, created.id))
        .get()
        .pipe(Effect.orDie)

      const missingID = SessionV2.ID.make("ses_update_replay_missing")
      const data = stored!.data as Record<string, unknown>
      const info = data.info as Record<string, unknown>
      const defect = yield* events
        .replay({
          id: EventV2.ID.make("evt_update_replay_missing"),
          aggregateID: missingID,
          seq: 0,
          type: "session.updated.2",
          data: {
            ...data,
            sessionID: missingID,
            info: { ...info, id: missingID },
          },
        })
        .pipe(Effect.catchDefect(Effect.succeed))

      expect(defect).toBeInstanceOf(EventV2.InvalidSyncEventError)
      expect((defect as EventV2.InvalidSyncEventError).message).toContain("requires an existing projected Session")
    }),
  )

  it.effect("replays independent diff and revert authorities into a fresh projection", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const created = yield* session.create({ location })
      const row = yield* rowOf(created.id)
      yield* events.publish(SessionEvent.DiffUpdated, {
        sessionID: created.id,
        timestamp: DateTime.makeUnsafe(10),
        summary: { additions: 3, deletions: 1, files: 1 },
        diff: [{ file: "src/a.ts", additions: 3, deletions: 1, status: "modified" }],
      })
      yield* events.publish(SessionEvent.RevertChanged, {
        sessionID: created.id,
        timestamp: DateTime.makeUnsafe(11),
        info: SessionInfo.fromRow(row),
        slug: row.slug,
        version: row.version,
        mutationEpoch: 1,
        revert: { messageID: "msg_replay_target" },
      })

      const serialized = (yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, created.id))
        .orderBy(asc(EventTable.seq))
        .all()
        .pipe(Effect.orDie)).map((event) => ({
        id: event.id,
        aggregateID: event.aggregate_id,
        seq: event.seq,
        type: event.type,
        data: event.data,
      }))
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (value) => Effect.promise(() => value[Symbol.asyncDispose]()),
      )
      const targetDatabase = Database.layerFromPath(path.join(tmp.path, "target.sqlite"))
      const targetEvents = EventV2.layer.pipe(Layer.provide(targetDatabase))
      const targetProjector = SessionProjector.layer.pipe(Layer.provide(targetEvents), Layer.provide(targetDatabase))
      yield* Effect.gen(function* () {
        const targetDB = (yield* Database.Service).db
        const targetEvents = yield* EventV2.Service
        yield* targetDB
          .insert(ProjectTable)
          .values({ id: ProjectV2.ID.global, worktree: location.directory, sandboxes: [] })
          .run()
          .pipe(Effect.orDie)
        yield* targetEvents.replayAll(serialized)
        const projected = yield* targetDB
          .select()
          .from(SessionTable)
          .where(eq(SessionTable.id, created.id))
          .get()
          .pipe(Effect.orDie)
        expect(projected).toMatchObject({
          summary_additions: 3,
          summary_deletions: 1,
          summary_files: 1,
          mutation_epoch: 1,
          revert: { messageID: "msg_replay_target" },
        })
      }).pipe(Effect.provide(Layer.fresh(Layer.mergeAll(targetDatabase, targetEvents, targetProjector))))
    }),
  )

  it.effect("rejects replayed v2 update identity and placement changes", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      const created = yield* session.create({ location })
      const stored = yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, created.id))
        .get()
        .pipe(Effect.orDie)
      const data = stored!.data as Record<string, unknown>
      const info = data.info as Record<string, unknown>

      const identityDefect = yield* events
        .replay({
          id: EventV2.ID.make("evt_update_replay_identity"),
          aggregateID: created.id,
          seq: 1,
          type: "session.updated.2",
          data: { ...data, info: { ...info, id: "ses_update_replay_other_identity" } },
        })
        .pipe(Effect.catchDefect(Effect.succeed))
      expect(identityDefect).toBeInstanceOf(EventV2.InvalidSyncEventError)
      expect((identityDefect as EventV2.InvalidSyncEventError).message).toContain("identity does not match")

      const placementDefect = yield* events
        .replay({
          id: EventV2.ID.make("evt_update_replay_placement"),
          aggregateID: created.id,
          seq: 1,
          type: "session.updated.2",
          data: {
            ...data,
            info: {
              ...info,
              projectID: "prj_update_replay_other",
              location: { ...(info.location as Record<string, unknown>), directory: "/other" },
            },
          },
        })
        .pipe(Effect.catchDefect(Effect.succeed))
      expect(placementDefect).toBeInstanceOf(EventV2.InvalidSyncEventError)
      expect((placementDefect as EventV2.InvalidSyncEventError).message).toContain("cannot change project")

      expect((yield* rowOf(created.id)).title).toBe(created.title)
    }),
  )
})
