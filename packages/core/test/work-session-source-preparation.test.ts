import { expect, test } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Layer, LayerMap, Option, Semaphore } from "effect"
import { sql } from "drizzle-orm"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { Database } from "../src/database/database"
import { LocationServiceMap } from "../src/location-layer"
import { EventV2 } from "../src/event"
import { SessionV2 } from "../src/session"
import { SessionEvent } from "../src/session/event"
import { SessionExecution } from "../src/session/execution"
import { SessionExecutionLocal } from "../src/session/execution/local"
import { SessionProjector } from "../src/session/projector"
import { SessionRunner } from "../src/session/runner"
import { SessionStore } from "../src/session/store"
import { SessionSchema } from "../src/session/schema"
import { WorkAdmission } from "../src/session/work-admission"
import { WorkAuthority } from "../src/session/work-authority"
import { WorkAuthoritySchema } from "../src/session/work-authority.schema"
import { WorkExecutionProfile } from "../src/session/work-execution-profile"
import { WorkRoutePolicy } from "../src/session/work-route-policy"
import { SecurityNamespaceTable, ProjectScopeIdentityTable, LocationIdentityTable } from "../src/context-federation/sql"
import { Delegation } from "../src/tool/delegation"
import { WorkAuthorityFixture } from "./fixture/work-authority"
import { projectLayer } from "./fixture/project-layer"

// SQL/event/claim/placement/authority services are real. Only the external reader observation
// and runner are controlled; the former has the same physical lock→SQL boundary as the Host.
async function isolated(lateChange: boolean) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dac-work-source-prepare-")))
  const directory = path.join(root, "project")
  await fs.mkdir(directory)
  const database = WorkAuthorityFixture.database(path.join(root, "authority.sqlite"))
  await Effect.runPromise(WorkAuthorityFixture.initialize().pipe(Effect.provide(database), Effect.scoped))
  const events = EventV2.layer.pipe(Layer.provide(database))
  const store = SessionStore.layer.pipe(Layer.provide(database))
  const state = {
    preparations: 0,
    inCommit: false,
    inCommitPreparations: 0,
    rescued: false,
    runs: 0,
    witnessDeadline: 0,
  }
  const lock = Semaphore.makeUnsafe(1)
  const trigger = Deferred.makeUnsafe<void>()
  const held = Deferred.makeUnsafe<void>()
  const finished = Deferred.makeUnsafe<void>()
  const profile = Layer.effect(
    WorkExecutionProfile.Service,
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      return WorkExecutionProfile.Service.of({
        prepareSource: () =>
          lock.withPermits(1)(
            Effect.gen(function* () {
              state.preparations++
              if (state.inCommit) state.inCommitPreparations++
              // The rescue is used only by the predecessor-call probe: after proving the
              // circular wait, do not introduce another root SQL wait under its held transaction.
              if (!state.rescued) yield* db.all("SELECT enabled FROM test_work_source").pipe(Effect.orDie)
              state.witnessDeadline = Date.now() + 1_000
            }),
          ),
        preflight: () =>
          Effect.suspend(() =>
            state.witnessDeadline > Date.now()
              ? Effect.void
              : Effect.fail(
                  new WorkAuthoritySchema.Error({ code: "PROFILE_UNAVAILABLE", message: "Original witness expired" }),
                ),
          ),
        observe: () => Effect.die("No model in source-preparation module"),
        bind: () => Effect.die("No provider in source-preparation module"),
        current: () => Effect.die("No provider in source-preparation module"),
        acquireCount: () => Effect.die("No provider in source-preparation module"),
      })
    }),
  ).pipe(Layer.provide(database))
  const evidence = Layer.succeed(WorkRoutePolicy.Evidence, {
    resolve: () => Effect.die("No provider route in source-preparation module"),
    readCount: () => Effect.die("No provider count in source-preparation module"),
  })
  const locations = Layer.effect(
    LocationServiceMap,
    LayerMap.make(() =>
      Layer.succeed(SessionRunner.Service, {
        run: () =>
          Effect.sync(() => {
            state.runs++
          }),
      }),
    ).pipe(Effect.map((value) => value as unknown as LocationServiceMap["Service"])),
  )
  const execution = SessionExecutionLocal.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        database,
        store,
        events,
        locations,
        Delegation.delegationSlotLayer,
        profile,
        evidence,
        WorkAuthorityFixture.verifier,
      ),
    ),
  )
  const sessions = SessionV2.layer.pipe(
    Layer.provide(Layer.mergeAll(database, store, events, execution, projectLayer(database))),
  )
  const projector = SessionProjector.layer.pipe(Layer.provide(Layer.mergeAll(events, database)))
  const services = Layer.mergeAll(
    database,
    store,
    events,
    execution,
    sessions,
    projector,
    profile,
    evidence,
    WorkAuthorityFixture.verifier,
  )
  try {
    return await Effect.runPromise(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const currentStore = yield* SessionStore.Service
        const binding = {
          ...WorkAuthorityFixture.binding("prepare-outside"),
          location: { directory },
          deadline: Date.now() + 100_000,
        }
        yield* WorkAdmission.admitOnly({ binding, auditedText: WorkAuthorityFixture.TEXT })
        const original = yield* currentStore.get(SessionSchema.ID.make(binding.sessionID))
        if (!original) throw new Error("Original Work Session was not admitted")
        yield* db
          .insert(SecurityNamespaceTable)
          .values({
            id: binding.scope.securityNamespaceID,
            kind: "implicit_local",
            binding_hash: "9".repeat(64),
            created_at: 1,
          })
          .run()
        yield* db
          .insert(ProjectScopeIdentityTable)
          .values({
            security_namespace_id: binding.scope.securityNamespaceID,
            project_scope_key: binding.scope.projectScopeKey,
            project_kind: "registered_root",
            project_identity_hash: "8".repeat(64),
            observed_project_id: original.projectID,
            created_at: 1,
          })
          .run()
        yield* db
          .insert(LocationIdentityTable)
          .values({
            security_namespace_id: binding.scope.securityNamespaceID,
            project_scope_key: binding.scope.projectScopeKey,
            location_key: "original-location",
            canonical_root: directory,
            observed_project_id: original.projectID,
            created_at: 1,
          })
          .run()

        // Fork before the transaction: this reader has no inherited SQL connection. It takes
        // its original semaphore, then really waits for the event's SQLite connection permit.
        const reader = yield* Effect.forkScoped(
          Deferred.await(trigger).pipe(
            Effect.andThen(
              Effect.gen(function* () {
                yield* lock.take(1)
                yield* Deferred.succeed(held, undefined)
                yield* db.all("SELECT enabled FROM test_work_source")
                if (!state.rescued) yield* lock.release(1)
                yield* Deferred.succeed(finished, undefined)
              }),
            ),
          ),
        )
        // A bounded test-only rescue exposes the previous circular wait without abandoning a
        // live transaction. The fixed caller must finish before this rescue ever releases a lock.
        yield* Effect.forkScoped(
          Deferred.await(held).pipe(
            Effect.andThen(Effect.sleep("200 millis")),
            Effect.andThen(
              Effect.gen(function* () {
                if (Option.isNone(yield* Deferred.poll(finished))) {
                  state.rescued = true
                  yield* lock.release(1)
                }
              }),
            ),
          ),
        )
        yield* (yield* EventV2.Service).project(SessionEvent.Execution.Started, () =>
          Effect.gen(function* () {
            state.inCommit = true
            yield* Deferred.succeed(trigger, undefined)
            yield* Deferred.await(held)
            // Optional negative probe replays the original Started commit's exact Store call,
            // rather than copying its guard or authorization logic into a test implementation.
            if (process.env.DAC_WORK_SOURCE_PREPARATION_PREDECESSOR_CALL === "1")
              yield* currentStore.requireExecution(SessionSchema.ID.make(binding.sessionID)).pipe(Effect.orDie)
            if (lateChange) yield* db.run("UPDATE test_work_source SET enabled=0").pipe(Effect.orDie)
          }),
        )
        // The sync event listener runs after commit; no native preparation may have occurred
        // between the projector's SQL-held marker and this actual durable notification.
        yield* Effect.acquireRelease(
          (yield* EventV2.Service).listen((event) =>
            Effect.sync(() => {
              if (event.type === SessionEvent.Execution.Started.type) state.inCommit = false
            }),
          ),
          (unsubscribe) => unsubscribe,
        )
        const result = yield* (yield* SessionExecution.Service)
          .resume(SessionSchema.ID.make(binding.sessionID))
          .pipe(Effect.exit)
        state.inCommit = false
        yield* Deferred.await(finished)
        yield* Fiber.join(reader)
        const work = yield* WorkAuthority.get(db, binding.workID)
        const recorded = yield* db.all<{ type: string }>(
          sql`SELECT type FROM event WHERE aggregate_id=${binding.sessionID} ORDER BY seq`,
        )
        if (process.env.DAC_WORK_SOURCE_PREPARATION_PREDECESSOR_CALL === "1")
          console.info("predecessor_probe", JSON.stringify(state))
        expect(state.rescued).toBe(false)
        expect(state.inCommitPreparations).toBe(0)
        expect(state.preparations).toBe(lateChange ? 2 : 3)
        expect(yield* currentStore.claimToken(SessionSchema.ID.make(binding.sessionID))).toBeUndefined()
        expect(work?.control_revision).toBe(1)
        expect((yield* db.all<{ enabled: number }>("SELECT enabled FROM test_work_source"))[0]?.enabled).toBe(1)
        if (lateChange) {
          expect(Exit.isFailure(result)).toBe(true)
          expect(state.runs).toBe(0)
          expect(recorded.some((item) => item.type === "session.execution.started.1")).toBe(false)
        }
        if (!lateChange) {
          expect(Exit.isSuccess(result)).toBe(true)
          expect(state.runs).toBe(1)
          expect(recorded.some((item) => item.type === "session.execution.started.1")).toBe(true)
          expect(recorded.some((item) => item.type === "session.execution.succeeded.1")).toBe(true)
        }
      }).pipe(Effect.provide(services), Effect.scoped),
    )
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}

test("Started commit consumes current source without acquiring reader lock under the real SQLite gate", () =>
  isolated(false))
test("late source change rejects Started and rolls back event/claim without refreshing native source", () =>
  isolated(true))
