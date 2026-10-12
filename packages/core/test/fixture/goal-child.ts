export * as GoalChildFixture from "./goal-child"

import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { Effect, Layer, LayerMap, Scope } from "effect"
import { Database } from "../../src/database/database"
import { EventV2 } from "../../src/event"
import { LocationServiceMap } from "../../src/location-layer"
import { AbsolutePath } from "../../src/schema"
import { SessionV2 } from "../../src/session"
import { SessionExecution } from "../../src/session/execution"
import { SessionExecutionLocal } from "../../src/session/execution/local"
import { SessionProjector } from "../../src/session/projector"
import { SessionRunner } from "../../src/session/runner"
import { SessionStore } from "../../src/session/store"
import { Delegation } from "../../src/tool/delegation"
import { GoalControl } from "../../src/deepagent/goal-control"
import { GoalControlFixture } from "./goal-control"
import { WorkAuthorityFixture } from "./work-authority"
import { projectLayer } from "./project-layer"

export type Services =
  | Database.Service
  | EventV2.Service
  | SessionV2.Service
  | SessionStore.Service
  | SessionExecution.Service
  | Scope.Scope
export type State = { locations: number; runs: number; shells: number; run?: SessionRunner.Interface["run"] }

export function layer(filename: string, state: State) {
  const database = WorkAuthorityFixture.database(filename)
  const events = EventV2.layer.pipe(Layer.provide(database))
  const store = SessionStore.layer.pipe(Layer.provide(database))
  // Only the external runner is a tripwire. Creation, EventV2 transactions, input admission,
  // SessionStore claims and the process-local coordinator are the actual implementation.
  const locations = Layer.effect(
    LocationServiceMap,
    LayerMap.make(() =>
      Layer.effect(
        SessionRunner.Service,
        Effect.sync(() => {
          state.locations++
          return SessionRunner.Service.of({
            run: (input) =>
              Effect.sync(() => {
                state.runs++
              }).pipe(Effect.andThen(() => state.run ? state.run(input) : Effect.void)),
          })
        }),
      ),
    ).pipe(Effect.map((value) => value as unknown as LocationServiceMap["Service"])),
  )
  const execution = SessionExecutionLocal.layer.pipe(
    Layer.provide(Layer.mergeAll(database, store, events, locations, Delegation.delegationSlotLayer)),
  )
  const sessions = SessionV2.layer.pipe(
    Layer.provide(Layer.mergeAll(database, store, events, execution, projectLayer(database))),
  )
  const projector = SessionProjector.layer.pipe(Layer.provide(Layer.mergeAll(database, events)))
  return Layer.mergeAll(database, events, store, execution, sessions, projector)
}

export async function isolated<A, E>(
  body: (input: { directory: string; filename: string; state: State }) => Effect.Effect<A, E, Services>,
) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dac-goal-child-")))
  const directory = path.join(root, "project")
  await fs.mkdir(directory)
  const filename = path.join(root, "authority.sqlite")
  await Effect.runPromise(
    WorkAuthorityFixture.initialize().pipe(Effect.provide(WorkAuthorityFixture.database(filename)), Effect.scoped),
  )
  const state = { locations: 0, runs: 0, shells: 0 }
  return await Effect.runPromise(
    body({ directory, filename, state }).pipe(
      Effect.provideService(SessionV2.CurrentManualShell, () =>
        Effect.sync(() => {
          state.shells++
        }),
      ),
      Effect.provide(layer(filename, state)),
      Effect.scoped,
    ),
  ).finally(() => fs.rm(root, { recursive: true, force: true }))
}

export const prepare = Effect.fn("GoalChildFixture.prepare")(function* (directory: string) {
  const sessions = yield* SessionV2.Service
  const db = (yield* Database.Service).db
  const parent = yield* sessions.create({
    location: { directory: AbsolutePath.make(directory) },
    permissions: [{ action: "task", resource: "*", effect: "deny" }],
  })
  const input = {
    sessionID: parent.id,
    requestID: `start-${parent.id}`,
    requestHash: GoalControl.fingerprint(parent.id),
    planDocId: "plan-goal",
    initialization: GoalControlFixture.initialization,
    driverMode: "event" as const,
  }
  const reserved = yield* GoalControl.reserveStart(db, input)
  yield* GoalControl.activate(db, { ...input, goalId: reserved.row.goal_id })
  const tick = {
    sessionID: parent.id,
    goalId: reserved.row.goal_id,
    planDocId: "plan-goal",
    revision: 1,
    seq: 0,
    expectedPlanVersion: 1,
    mode: "event" as const,
  }
  const started = yield* GoalControl.beginTick(db, tick)
  return {
    parent,
    goal: reserved.row,
    permit: started.permit,
    admission: {
      permitID: started.permit.permit_id,
      permitToken: started.permit.token,
      roleKey: "worker.0",
      agent: "build",
      mode: "plain" as const,
      steeringHash: "b".repeat(64),
      promptPolicyHash: "c".repeat(64),
      stage: "plain" as const,
      text: "A deterministic Goal child prompt",
    },
  }
})
