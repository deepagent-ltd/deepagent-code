import { describe, expect } from "bun:test"
import path from "path"
import { Effect, Layer, Stream } from "effect"
import { AgentV2 } from "@deepagent-code/core/agent"
import { asc, eq } from "drizzle-orm"
import { Database } from "@deepagent-code/core/database/database"
import { EventV2 } from "@deepagent-code/core/event"
import { EventSequenceTable, EventTable } from "@deepagent-code/core/event/sql"
import { Location } from "@deepagent-code/core/location"
import { ModelV2 } from "@deepagent-code/core/model"
import { ProjectV2 } from "@deepagent-code/core/project"
import { ProjectTable } from "@deepagent-code/core/project/sql"
import { ProviderV2 } from "@deepagent-code/core/provider"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { SessionV2 } from "@deepagent-code/core/session"
import { SessionV1 } from "@deepagent-code/core/v1/session"
import { Prompt } from "@deepagent-code/core/session/prompt"
import { SessionProjector } from "@deepagent-code/core/session/projector"
import { SessionExecution } from "@deepagent-code/core/session/execution"
import { SessionInput } from "@deepagent-code/core/session/input"
import { SessionEvent } from "@deepagent-code/core/session/event"
import { SessionTable } from "@deepagent-code/core/session/sql"
import { SessionStore } from "@deepagent-code/core/session/store"
import { WorkspaceV2 } from "@deepagent-code/core/workspace"
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
const id = SessionV2.ID.create()

describe("SessionV2.create", () => {
  it.effect("derives stable namespaced external IDs", () =>
    Effect.sync(() => {
      const input = { namespace: "opencord.agent-thread", key: "thread-1" }

      expect(SessionV2.ID.fromExternal(input)).toBe(SessionV2.ID.fromExternal(input))
      expect(SessionV2.ID.fromExternal(input)).toMatch(/^ses_[a-f0-9]{64}$/)
      expect(SessionV2.ID.fromExternal({ ...input, namespace: "another-app" })).not.toBe(
        SessionV2.ID.fromExternal(input),
      )
      expect(SessionV2.ID.fromExternal({ namespace: "a:b", key: "c" })).not.toBe(
        SessionV2.ID.fromExternal({ namespace: "a", key: "b:c" }),
      )
    }),
  )

  it.effect("creates a fresh projected session when the ID is omitted", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service

      const first = yield* session.create({ location })
      const second = yield* session.create({ location })

      expect(second.id).not.toBe(first.id)
      expect(yield* session.list()).toHaveLength(2)
    }),
  )

  it.effect("returns the original session when the ID is retried", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const input = { id, location }

      const first = yield* session.create(input)
      const retried = yield* session.create(input)

      expect(retried).toEqual(first)
      expect(yield* session.list()).toEqual([first])
    }),
  )

  it.effect("stores supplied immutable create attributes", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const workspaceID = WorkspaceV2.ID.make("wrk_test")
      const model = ModelV2.Ref.make({
        id: ModelV2.ID.make("sonnet"),
        providerID: ProviderV2.ID.anthropic,
        variant: ModelV2.VariantID.make("fast"),
      })

      expect(
        yield* session.create({
          location: Location.Ref.make({ directory: location.directory, workspaceID }),
          agent: AgentV2.ID.make("build"),
          model,
        }),
      ).toMatchObject({ location: { directory: location.directory, workspaceID }, agent: "build", model })
    }),
  )

  it.effect("returns the existing Session when one ID is reused with different create arguments", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const created = yield* session.create({ id, location })
      const changed = [
        { id, location: Location.Ref.make({ directory: AbsolutePath.make("/other") }) },
        { id, location, agent: AgentV2.ID.make("build") },
        {
          id,
          location,
          model: ModelV2.Ref.make({ id: ModelV2.ID.make("sonnet"), providerID: ProviderV2.ID.anthropic }),
        },
      ]

      for (const input of changed) {
        expect(yield* session.create(input)).toEqual(created)
      }
      expect(yield* session.list()).toHaveLength(1)
    }),
  )

  it.effect("returns one recorded session to concurrent exact retries", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const input = { id, location }

      const created = yield* Effect.all([session.create(input), session.create(input)], { concurrency: "unbounded" })

      expect(created[1]).toEqual(created[0])
      expect(yield* session.list()).toEqual([created[0]])
    }),
  )

  it.effect("returns the current Session projection after updates", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      const input = { id, location }
      const created = yield* session.create(input)

      yield* db.update(SessionTable).set({ agent: "build" }).where(eq(SessionTable.id, id)).run().pipe(Effect.orDie)

      expect(yield* session.create(input)).toMatchObject({ id: created.id, agent: "build" })
    }),
  )

  it.effect("returns the current Session projection after projected updates", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const input = { id, location }
      const created = yield* session.create(input)

      yield* events.publish(SessionV1.Event.Updated, {
        sessionID: id,
        info: SessionV1.SessionInfo.make({
          id,
          slug: "updated",
          version: "test",
          projectID: created.projectID,
          directory: created.location.directory,
          title: "updated",
          agent: "build",
          time: { created: 0, updated: 1 },
        }),
      })

      expect(yield* session.create(input)).toMatchObject({ id, agent: "build" })
    }),
  )

  it.effect("persists creation through the existing legacy created event", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      const created = yield* session.create({ location })

      expect(
        yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, created.id)).all().pipe(Effect.orDie),
      ).toMatchObject([{ type: EventV2.versionedType(SessionV1.Event.Created.type, 1) }])
    }),
  )

  it.effect("persists caller-ID creation through the existing created event", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      const created = yield* session.create({ id, location })

      expect(
        yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, created.id)).get().pipe(Effect.orDie),
      ).toMatchObject({
        data: { sessionID: id },
      })
    }),
  )

  it.effect("omits legacy creation rows from the V2 Session event stream", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const created = yield* session.create({ location })
      yield* session.prompt({ sessionID: created.id, prompt: new Prompt({ text: "Hello" }), resume: false })
      yield* SessionInput.promoteSteers(db, events, created.id, Number.MAX_SAFE_INTEGER)

      expect(
        Array.from(yield* session.events({ sessionID: created.id }).pipe(Stream.take(2), Stream.runCollect)),
      ).toMatchObject([
        { cursor: 1, event: { type: "session.next.prompt.admitted", data: { prompt: { text: "Hello" } } } },
        { cursor: 2, event: { type: "session.next.prompt.promoted" } },
      ])
    }),
  )

  it.effect("replays one prompt lifecycle into a fresh target database", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const sourceEvents = yield* EventV2.Service
      const sourceDb = (yield* Database.Service).db
      const created = yield* session.create({ id: SessionV2.ID.make("ses_fresh_target_replay"), location })
      const admitted = yield* session.prompt({
        sessionID: created.id,
        prompt: new Prompt({ text: "Replay lifecycle" }),
        resume: false,
      })
      yield* SessionInput.promoteSteers(sourceDb, sourceEvents, created.id, Number.MAX_SAFE_INTEGER)
      const serialized = (yield* sourceDb
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

        expect(yield* store.get(created.id)).toBeUndefined()
        expect(yield* events.replayAll(serialized.slice(0, 2))).toBe(created.id)
        expect(yield* SessionInput.find(db, admitted.id)).toMatchObject({
          id: admitted.id,
          sessionID: created.id,
          prompt: { text: "Replay lifecycle" },
          delivery: "steer",
          admittedSeq: 1,
        })
        expect(yield* store.context(created.id)).toEqual([])

        expect(yield* events.replayAll(serialized.slice(2))).toBe(created.id)
        expect(yield* SessionInput.find(db, admitted.id)).toMatchObject({
          id: admitted.id,
          sessionID: created.id,
          prompt: { text: "Replay lifecycle" },
          delivery: "steer",
          admittedSeq: 1,
          promotedSeq: 2,
        })
        expect(yield* store.context(created.id)).toMatchObject([
          { id: admitted.id, type: "user", text: "Replay lifecycle" },
        ])
        expect(
          (yield* db
            .select()
            .from(EventTable)
            .where(eq(EventTable.aggregate_id, created.id))
            .orderBy(asc(EventTable.seq))
            .all()
            .pipe(Effect.orDie)).map((event) => [event.seq, event.type]),
        ).toEqual([
          [0, EventV2.versionedType(SessionV1.Event.Created.type, 1)],
          [1, EventV2.versionedType(SessionEvent.PromptLifecycle.Admitted.type, 1)],
          [2, EventV2.versionedType(SessionEvent.PromptLifecycle.Promoted.type, 1)],
        ])
      }).pipe(Effect.provide(Layer.fresh(Layer.mergeAll(targetDatabase, targetEvents, targetProjector, targetStore))))
    }),
  )

  it.effect("rejects replayed Session identity and placement changes without committing partial state", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const created = yield* session.create({ location })
      const event = yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, created.id))
        .get()
        .pipe(Effect.orDie)
      const sequence = yield* db
        .select()
        .from(EventSequenceTable)
        .where(eq(EventSequenceTable.aggregate_id, created.id))
        .get()
        .pipe(Effect.orDie)
      expect(event).toBeDefined()
      expect(sequence).toBeDefined()
      const data = event!.data as { sessionID: string; info: Record<string, unknown> }
      const beforeSession = yield* db
        .select()
        .from(SessionTable)
        .where(eq(SessionTable.id, created.id))
        .get()
        .pipe(Effect.orDie)
      const beforeEvents = yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, created.id))
        .all()
        .pipe(Effect.orDie)

      const exactOwnerDefect = yield* events
        .replay(
          {
            id: event!.id,
            aggregateID: created.id,
            seq: event!.seq,
            type: event!.type,
            data: event!.data,
          },
          { ownerID: "wrk_other", strictOwner: true },
        )
        .pipe(Effect.catchDefect(Effect.succeed))
      expect(exactOwnerDefect).toBeInstanceOf(EventV2.InvalidSyncEventError)
      expect((exactOwnerDefect as EventV2.InvalidSyncEventError).message).toContain("current workspace authority")
      expect(
        yield* db
          .select()
          .from(EventSequenceTable)
          .where(eq(EventSequenceTable.aggregate_id, created.id))
          .get()
          .pipe(Effect.orDie),
      ).toEqual(sequence)

      const childOwnerDefect = yield* events
        .replay(
          {
            id: EventV2.ID.make("evt_replay_session_child_owner"),
            aggregateID: created.id,
            seq: sequence!.seq + 1,
            type: EventV2.versionedType(SessionEvent.AgentSwitched.type, 1),
            data: {
              sessionID: created.id,
              timestamp: 1,
              messageID: "msg_replay_session_child_owner",
              agent: "build",
            },
          },
          { ownerID: "wrk_other", strictOwner: true },
        )
        .pipe(Effect.catchDefect(Effect.succeed))
      expect(childOwnerDefect).toBeInstanceOf(EventV2.InvalidSyncEventError)
      expect((childOwnerDefect as EventV2.InvalidSyncEventError).message).toContain("current workspace authority")
      expect(
        yield* db
          .select()
          .from(EventSequenceTable)
          .where(eq(EventSequenceTable.aggregate_id, created.id))
          .get()
          .pipe(Effect.orDie),
      ).toEqual(sequence)
      expect(
        yield* db
          .select()
          .from(EventTable)
          .where(eq(EventTable.aggregate_id, created.id))
          .all()
          .pipe(Effect.orDie),
      ).toEqual(beforeEvents)

      yield* db
        .insert(ProjectTable)
        .values({
          id: ProjectV2.ID.make("prj_replay_other"),
          worktree: AbsolutePath.make("/other"),
          sandboxes: [],
        })
        .run()
        .pipe(Effect.orDie)

      const batchAggregateID = SessionV2.ID.make("ses_replay_atomic_batch")
      const batchDefect = yield* events
        .replayAll([
          {
            id: EventV2.ID.make("evt_replay_atomic_created"),
            aggregateID: batchAggregateID,
            seq: 0,
            type: EventV2.versionedType(SessionV1.Event.Created.type, 1),
            data: {
              ...data,
              sessionID: batchAggregateID,
              info: { ...data.info, id: batchAggregateID },
            },
          },
          {
            id: EventV2.ID.make("evt_replay_atomic_invalid_update"),
            aggregateID: batchAggregateID,
            seq: 1,
            type: EventV2.versionedType(SessionV1.Event.Updated.type, 1),
            data: {
              ...data,
              sessionID: batchAggregateID,
              info: {
                ...data.info,
                id: batchAggregateID,
                projectID: ProjectV2.ID.make("prj_replay_other"),
              },
            },
          },
        ])
        .pipe(Effect.catchDefect(Effect.succeed))
      expect(batchDefect).toBeInstanceOf(EventV2.InvalidSyncEventError)
      expect((batchDefect as EventV2.InvalidSyncEventError).message).toContain("cannot change project")
      expect(yield* db.select().from(SessionTable).where(eq(SessionTable.id, batchAggregateID)).get()).toBeUndefined()
      expect(
        yield* db.select().from(EventSequenceTable).where(eq(EventSequenceTable.aggregate_id, batchAggregateID)).get(),
      ).toBeUndefined()
      expect(yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, batchAggregateID)).all()).toEqual([])

      const invalid = [
        {
          id: EventV2.ID.make("evt_replay_session_identity"),
          type: EventV2.versionedType(SessionV1.Event.Updated.type, 1),
          data: { ...data, info: { ...data.info, id: SessionV2.ID.make("ses_replay_other") } },
          message: "identity does not match",
        },
        {
          id: EventV2.ID.make("evt_replay_session_project"),
          type: EventV2.versionedType(SessionV1.Event.Updated.type, 1),
          data: { ...data, info: { ...data.info, projectID: ProjectV2.ID.make("prj_replay_other") } },
          message: "cannot change project",
        },
        {
          id: EventV2.ID.make("evt_replay_session_moved"),
          type: EventV2.versionedType(SessionEvent.Moved.type, 1),
          data: {
            sessionID: created.id,
            timestamp: 1,
            location: { directory: "/other" },
          },
          message: "requires a durable transfer operation receipt",
        },
      ]

      for (const item of invalid) {
        const defect = yield* events
          .replay({
            id: item.id,
            aggregateID: created.id,
            seq: sequence!.seq + 1,
            type: item.type,
            data: item.data,
          })
          .pipe(Effect.catchDefect(Effect.succeed))
        expect(defect).toBeInstanceOf(EventV2.InvalidSyncEventError)
        expect((defect as EventV2.InvalidSyncEventError).message).toContain(item.message)
        expect(
          yield* db.select().from(SessionTable).where(eq(SessionTable.id, created.id)).get().pipe(Effect.orDie),
        ).toEqual(beforeSession)
        expect(
          yield* db
            .select()
            .from(EventSequenceTable)
            .where(eq(EventSequenceTable.aggregate_id, created.id))
            .get()
            .pipe(Effect.orDie),
        ).toEqual(sequence)
        expect(
          yield* db
            .select()
            .from(EventTable)
            .where(eq(EventTable.aggregate_id, created.id))
            .all()
            .pipe(Effect.orDie),
        ).toEqual(beforeEvents)
      }

      const aggregateID = SessionV2.ID.make("ses_replay_created_aggregate")
      const projectedID = SessionV2.ID.make("ses_replay_created_projection")
      const defect = yield* events
        .replay({
          id: EventV2.ID.make("evt_replay_created_identity"),
          aggregateID,
          seq: 0,
          type: EventV2.versionedType(SessionV1.Event.Created.type, 1),
          data: { ...data, sessionID: aggregateID, info: { ...data.info, id: projectedID } },
        })
        .pipe(Effect.catchDefect(Effect.succeed))
      expect(defect).toBeInstanceOf(EventV2.InvalidSyncEventError)
      expect((defect as EventV2.InvalidSyncEventError).message).toContain("identity does not match")
      expect(yield* db.select().from(SessionTable).where(eq(SessionTable.id, projectedID)).get()).toBeUndefined()
      expect(
        yield* db.select().from(EventSequenceTable).where(eq(EventSequenceTable.aggregate_id, aggregateID)).get(),
      ).toBeUndefined()
      expect(yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, aggregateID)).all()).toEqual([])

      const ownedAggregateID = SessionV2.ID.make("ses_replay_owned_created")
      const ownedDefect = yield* events
        .replay(
          {
            id: EventV2.ID.make("evt_replay_owned_created"),
            aggregateID: ownedAggregateID,
            seq: 0,
            type: EventV2.versionedType(SessionV1.Event.Created.type, 1),
            data: {
              ...data,
              sessionID: ownedAggregateID,
              info: { ...data.info, id: ownedAggregateID, workspaceID: "wrk_other" },
            },
          },
          { ownerID: "wrk_owner", strictOwner: true },
      )
        .pipe(Effect.catchDefect(Effect.succeed))
      expect(ownedDefect).toBeInstanceOf(EventV2.InvalidSyncEventError)
      expect((ownedDefect as EventV2.InvalidSyncEventError).message).toContain("current workspace authority")
      expect(yield* db.select().from(SessionTable).where(eq(SessionTable.id, ownedAggregateID)).get()).toBeUndefined()
      expect(
        yield* db.select().from(EventSequenceTable).where(eq(EventSequenceTable.aggregate_id, ownedAggregateID)).get(),
      ).toBeUndefined()
      expect(yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, ownedAggregateID)).all()).toEqual([])

      const owned = yield* session.create({
        location: Location.Ref.make({ directory: location.directory, workspaceID: WorkspaceV2.ID.make("wrk_owner") }),
      })
      const ownedEvent = yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, owned.id))
        .get()
        .pipe(Effect.orDie)
      yield* events.replay(
        {
          id: ownedEvent!.id,
          aggregateID: owned.id,
          seq: ownedEvent!.seq,
          type: ownedEvent!.type,
          data: ownedEvent!.data,
        },
        { ownerID: "wrk_owner", strictOwner: true },
      )
      expect(
        yield* db
          .select({ ownerID: EventSequenceTable.owner_id })
          .from(EventSequenceTable)
          .where(eq(EventSequenceTable.aggregate_id, owned.id))
          .get()
          .pipe(Effect.orDie),
      ).toEqual({ ownerID: "wrk_owner" })
    }),
  )

  it.effect("does not mask unrelated created projector defects", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const event = yield* EventV2.Service
      const defect = new Error("unrelated projector defect")
      yield* event.project(SessionV1.Event.Created, () => Effect.die(defect))

      expect(yield* session.create({ id, location }).pipe(Effect.catchDefect(Effect.succeed))).toBe(defect)
    }),
  )

  it.effect("reports unfinished Session operations as unavailable", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const created = yield* session.create({ location })
      const unavailable = (
        effect: Effect.Effect<void, SessionV2.NotFoundError | SessionV2.OperationUnavailableError>,
      ) =>
        effect.pipe(
          Effect.flip,
          Effect.map((error) => (error instanceof SessionV2.OperationUnavailableError ? error.operation : "not-found")),
        )

      expect(yield* unavailable(session.shell({ sessionID: created.id, command: "pwd" }))).toBe("shell")
      expect(yield* unavailable(session.skill({ sessionID: created.id, skill: "review" }))).toBe("skill")
      expect(yield* unavailable(session.switchAgent({ sessionID: created.id, agent: "build" }))).toBe("switchAgent")
      // §16.3 order 4 package E contract pin: manual compaction stays a TYPED refusal (not a
      // defect) until the legacy compaction state machine is ported; overflow-triggered
      // compaction is covered by the runner continuation suites.
      expect(yield* unavailable(session.compact({ sessionID: created.id }))).toBe("compact")
    }),
  )

  // §16.3 order 5 F1 — the project dual-writer contract: core owns CREATE-IF-ABSENT (this path),
  // the deepagent-code project service owns updates/migration/rebinding. Pin the core half: an
  // existing project row is never overwritten by session creation.
  it.effect("session create never overwrites an existing project row (create-if-absent contract)", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const projects = yield* ProjectV2.Service
      const { db } = yield* Database.Service
      const resolved = yield* projects.resolve(location.directory)
      yield* db
        .insert(ProjectTable)
        .values({ id: resolved.id, worktree: AbsolutePath.make("/sentinel-worktree"), sandboxes: [] })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      yield* session.create({ location })
      const row = yield* db
        .select()
        .from(ProjectTable)
        .where(eq(ProjectTable.id, resolved.id))
        .get()
        .pipe(Effect.orDie)
      expect(row?.worktree).toBe(AbsolutePath.make("/sentinel-worktree"))
    }),
  )

  it.effect("switches the selected model through the durable Session event", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const created = yield* session.create({ location })
      const model = ModelV2.Ref.make({
        id: ModelV2.ID.make("sonnet"),
        providerID: ProviderV2.ID.anthropic,
        variant: ModelV2.VariantID.make("high"),
      })

      yield* session.switchModel({ sessionID: created.id, model })

      expect(yield* session.get(created.id)).toMatchObject({ model })
      expect(
        Array.from(yield* session.events({ sessionID: created.id }).pipe(Stream.take(1), Stream.runCollect)),
      ).toMatchObject([{ event: { type: "session.next.model.switched", data: { model } } }])
    }),
  )

  it.effect("persists repeated switches as distinct durable Session events", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const created = yield* session.create({ location })
      const model = ModelV2.Ref.make({ id: ModelV2.ID.make("sonnet"), providerID: ProviderV2.ID.anthropic })

      yield* session.switchModel({ sessionID: created.id, model })
      yield* session.switchModel({ sessionID: created.id, model })

      const { db } = yield* Database.Service
      expect(
        yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, created.id)).all().pipe(Effect.orDie),
      ).toHaveLength(3)
      expect(yield* session.get(created.id)).toMatchObject({ model })
    }),
  )

  it.effect("rejects a model switch for a missing Session", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const missing = SessionV2.ID.make("ses_missing_model_switch")

      expect(
        yield* session
          .switchModel({
            sessionID: missing,
            model: ModelV2.Ref.make({ id: ModelV2.ID.make("sonnet"), providerID: ProviderV2.ID.anthropic }),
          })
          .pipe(
            Effect.flip,
            Effect.map((error) => error._tag),
          ),
      ).toBe("Session.NotFoundError")
    }),
  )
})
