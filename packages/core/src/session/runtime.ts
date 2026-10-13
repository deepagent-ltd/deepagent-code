export * as SessionRuntime from "./runtime"

import { Effect, Layer, Option } from "effect"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import { LocationServiceMap } from "../location-layer"
import { ProjectV2 } from "../project"
import { SessionV2 } from "../session"
import { Delegation } from "../tool/delegation"
import { SessionExecutionLocal } from "./execution/local"
import { SessionRestart } from "./execution/restart"
import { SessionProjector } from "./projector"
import { SessionRuntimeStatus } from "./runtime-status"
import { WorkExecutionProfile } from "./work-execution-profile"
import { SessionStore } from "./store"

/**
 * One open Core V2 Session owner. Database, Event, Project and Location are explicit host
 * requirements; every derived service captures those exact values, so an inner default layer can
 * never hide a host override or split the runtime into separate registries/connections.
 */
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const installed = yield* Effect.serviceOption(WorkExecutionProfile.Services)
    const work = Option.isSome(installed) ? WorkExecutionProfile.servicesLayer(installed.value) : Layer.empty
    const database = yield* Database.Service
    const events = yield* EventV2.Service
    const locations = yield* LocationServiceMap
    const projects = yield* ProjectV2.Service
    // The per-root delegation holder rides the execution layer so drain fibers can reach the root
    // SessionV2 service from Location-scoped settles (see tool/delegation.ts).
    const delegation = yield* Delegation.DelegationSlot
    const databaseLayer = Layer.succeed(Database.Service, database)
    const eventLayer = Layer.succeed(EventV2.Service, events)
    const locationLayer = Layer.succeed(LocationServiceMap, locations)
    const projectLayer = Layer.succeed(ProjectV2.Service, projects)
    const storeLayer = SessionStore.layer.pipe(Layer.provide(databaseLayer))
    const projectorLayer = SessionProjector.layer.pipe(
      Layer.provide(eventLayer),
      Layer.provide(databaseLayer),
    )
    const executionLayer = SessionExecutionLocal.layer.pipe(
      Layer.provide(storeLayer),
      Layer.provide(eventLayer),
      Layer.provide(locationLayer),
      Layer.provide(Layer.succeed(Delegation.DelegationSlot, delegation)),
    )
    const restartLayer = SessionRestart.layer.pipe(
      Layer.provide(executionLayer),
      Layer.provide(storeLayer),
      Layer.provide(databaseLayer),
    )
    const statusLayer = SessionRuntimeStatus.layer.pipe(
      Layer.provide(executionLayer),
      Layer.provide(restartLayer),
      Layer.provide(databaseLayer),
    )
    const sessionLayer = SessionV2.layer.pipe(
      Layer.provide(executionLayer),
      Layer.provide(storeLayer),
      Layer.provide(projectorLayer),
      Layer.provide(eventLayer),
      Layer.provide(databaseLayer),
      Layer.provide(projectLayer),
      Layer.orDie,
    )
    return Layer.mergeAll(sessionLayer, executionLayer, restartLayer, statusLayer, storeLayer, projectorLayer).pipe(Layer.provideMerge(work))
  }),
)

/** Startup owner: redrive only work classified safe by the durable restart service. */
export const startup = Layer.effectDiscard(
  Effect.gen(function* () {
    const outcome = yield* (yield* SessionRestart.Service).redriveStartup
    if (outcome.blocked.length > 0)
      yield* Effect.logWarning("Core V2 startup recovery left fenced Sessions", outcome.blocked)
  }),
)

/** Runtime plus the one explicit startup redrive. */
export const productionLayer = Layer.mergeAll(layer, startup.pipe(Layer.provide(layer)))
