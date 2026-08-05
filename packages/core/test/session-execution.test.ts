import { describe, expect, test } from "bun:test"
import { asc, eq } from "drizzle-orm"
import { Context, Deferred, Effect, Exit, Layer, LayerMap, Scope } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { EventV2 } from "@deepagent-code/core/event"
import { EventTable } from "@deepagent-code/core/event/sql"
import { LocationServiceMap } from "@deepagent-code/core/location-layer"
import { Project } from "@deepagent-code/core/project"
import { ProjectTable } from "@deepagent-code/core/project/sql"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { SessionEvent } from "@deepagent-code/core/session/event"
import { SessionExecution } from "@deepagent-code/core/session/execution"
import { SessionExecutionLocal } from "@deepagent-code/core/session/execution/local"
import { SessionRestart } from "@deepagent-code/core/session/execution/restart"
import { SessionRunner } from "@deepagent-code/core/session/runner"
import { SessionSchema } from "@deepagent-code/core/session/schema"
import { SessionTable } from "@deepagent-code/core/session/sql"
import { SessionStore } from "@deepagent-code/core/session/store"
import { testEffect } from "./lib/effect"

const database = Database.layerFromPath(":memory:")
const events = EventV2.layer.pipe(Layer.provide(database))
const store = SessionStore.layer.pipe(Layer.provide(database))
const it = testEffect(Layer.mergeAll(database, events, store))

describe("SessionExecution lifecycle", () => {
  test("classifies success, failure, and interruption terminals", () => {
    expect(SessionExecution.terminal(Exit.succeed(undefined))).toEqual({ type: "succeeded" })
    expect(SessionExecution.terminal(Exit.die(new Error("failed")))).toEqual({
      type: "failed",
      error: { type: "unknown", message: "failed" },
    })
    const interrupted = Effect.runSyncExit(Effect.interrupt)
    expect(SessionExecution.terminal(interrupted)).toEqual({ type: "interrupted", reason: "shutdown" })
    expect(SessionExecution.terminal(interrupted, "user")).toEqual({ type: "interrupted", reason: "user" })
  })

  it.effect("atomically consumes each suspension at most once", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const store = yield* SessionStore.Service
      const first = SessionSchema.ID.make("ses_recover_first")
      const second = SessionSchema.ID.make("ses_recover_second")
      yield* seedSessions(database, [first, second], { time_suspended: Date.now() })

      expect(yield* store.consumeSuspended(first)).toBe(true)
      expect(yield* store.consumeSuspended(first)).toBe(false)
      expect(yield* store.consumeSuspended(second)).toBe(true)
      expect(yield* suspensions(database)).toEqual({ [first]: false, [second]: false })
    }),
  )

  it.effect("clears suspension and records one lifecycle when execution succeeds", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const sessionID = SessionSchema.ID.make("ses_suspend_completed")
      yield* seedSessions(database, [sessionID], { time_suspended: Date.now() })

      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const context = yield* buildExecution(scope, () => Effect.void)
      const execution = Context.get(context, SessionExecution.Service)

      yield* execution.resume(sessionID)
      yield* execution.awaitIdle(sessionID)

      expect(yield* suspensions(database)).toEqual({ [sessionID]: false })
      expect(yield* eventTypes(database, sessionID)).toEqual([
        EventV2.versionedType(SessionEvent.Execution.Started.type, 1),
        EventV2.versionedType(SessionEvent.Execution.Succeeded.type, 1),
      ])
    }),
  )

  it.effect("preserves suspension when orderly teardown interrupts execution", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const sessionID = SessionSchema.ID.make("ses_suspend_interrupted")
      yield* seedSessions(database, [sessionID])

      const started = yield* Deferred.make<void>()
      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const context = yield* buildExecution(scope, () =>
        Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
      )
      const execution = Context.get(context, SessionExecution.Service)
      const restart = Context.get(context, SessionRestart.Service)
      yield* execution.resume(sessionID).pipe(Effect.forkIn(scope))
      yield* Deferred.await(started)

      yield* restart.suspendActiveSessions
      expect(yield* suspensions(database)).toEqual({ [sessionID]: true })
      yield* Scope.close(scope, Exit.void)

      expect(yield* suspensions(database)).toEqual({ [sessionID]: true })
      expect(yield* eventTypes(database, sessionID)).toEqual([
        EventV2.versionedType(SessionEvent.Execution.Started.type, 1),
        EventV2.versionedType(SessionEvent.Execution.Interrupted.type, 1),
      ])
    }),
  )

  it.effect("resumes each suspended Session at most once", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const first = SessionSchema.ID.make("ses_resume_first")
      const second = SessionSchema.ID.make("ses_resume_second")
      yield* seedSessions(database, [first, second], { time_suspended: Date.now() })

      const resumed: SessionSchema.ID[] = []
      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const context = yield* buildExecution(scope, ({ sessionID }) =>
        Effect.sync(() => {
          resumed.push(sessionID)
        }),
      )
      const execution = Context.get(context, SessionExecution.Service)
      const restart = Context.get(context, SessionRestart.Service)

      yield* restart.resumeSuspendedSessions
      yield* Effect.forEach([first, second], execution.awaitIdle, { discard: true })
      yield* restart.resumeSuspendedSessions

      expect(resumed.toSorted()).toEqual([first, second])
      expect(yield* suspensions(database)).toEqual({ [first]: false, [second]: false })
    }),
  )

  it.effect("starts suspended Sessions concurrently", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const sessionIDs = Array.from({ length: 5 }, (_, index) =>
        SessionSchema.ID.make(`ses_resume_concurrent_${index}`),
      )
      yield* seedSessions(database, sessionIDs, { time_suspended: Date.now() })

      const allStarted = yield* Deferred.make<void>()
      const resumed: SessionSchema.ID[] = []
      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const context = yield* buildExecution(scope, ({ sessionID }) =>
        Effect.sync(() => {
          resumed.push(sessionID)
          if (resumed.length === sessionIDs.length) Deferred.doneUnsafe(allStarted, Effect.void)
        }).pipe(Effect.andThen(Effect.never)),
      )
      const execution = Context.get(context, SessionExecution.Service)
      const restart = Context.get(context, SessionRestart.Service)

      yield* restart.resumeSuspendedSessions.pipe(Effect.forkIn(scope))
      yield* Deferred.await(allStarted)

      expect(resumed.toSorted()).toEqual(sessionIDs.toSorted())
      expect(Array.from(yield* execution.active).toSorted()).toEqual(sessionIDs.toSorted())
    }),
  )
})

function seedSessions(
  database: Database.Interface,
  sessionIDs: ReadonlyArray<SessionSchema.ID>,
  values: { time_suspended?: number } = {},
) {
  return Effect.gen(function* () {
    yield* database.db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* database.db
      .insert(SessionTable)
      .values(
        sessionIDs.map((id) => ({
          id,
          project_id: Project.ID.global,
          slug: id,
          directory: "/project",
          title: id,
          version: "test",
          ...values,
        })),
      )
      .run()
      .pipe(Effect.orDie)
  })
}

function suspensions(database: Database.Interface) {
  return database.db
    .select({ id: SessionTable.id, suspended: SessionTable.time_suspended })
    .from(SessionTable)
    .all()
    .pipe(
      Effect.orDie,
      Effect.map((rows) => Object.fromEntries(rows.map((row) => [row.id, row.suspended !== null]))),
    )
}

function eventTypes(database: Database.Interface, sessionID: SessionSchema.ID) {
  return database.db
    .select({ type: EventTable.type })
    .from(EventTable)
    .where(eq(EventTable.aggregate_id, sessionID))
    .orderBy(asc(EventTable.seq))
    .all()
    .pipe(
      Effect.orDie,
      Effect.map((rows) => rows.map((row) => row.type)),
    )
}

function buildExecution(scope: Scope.Closeable, run: SessionRunner.Interface["run"]) {
  return Effect.gen(function* () {
    const events = yield* EventV2.Service
    const store = yield* SessionStore.Service
    const runner = Layer.succeed(SessionRunner.Service, SessionRunner.Service.of({ run }))
    const locations = Layer.effect(
      LocationServiceMap,
      LayerMap.make(() => runner).pipe(
        // The lifecycle harness only needs the runner from the full Location graph.
        // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
        Effect.map((service) => service as unknown as LocationServiceMap["Service"]),
      ),
    )
    return yield* Layer.buildWithScope(
      SessionRestart.layer.pipe(
        Layer.provideMerge(SessionExecutionLocal.layer),
        Layer.provide(Layer.succeed(EventV2.Service, events)),
        Layer.provide(Layer.succeed(SessionStore.Service, store)),
        Layer.provide(locations),
      ),
      scope,
    )
  })
}
