export * as SessionRuntime from "./runtime"

import { Effect, Layer } from "effect"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import { LocationServiceMap } from "../location-layer"
import { ProjectV2 } from "../project"
import { SessionV2 } from "../session"
import { SessionExecutionLocal } from "./execution/local"
import { SessionRestart } from "./execution/restart"
import { SessionProjector } from "./projector"
import { SessionRuntimeStatus } from "./runtime-status"
import { SessionStore } from "./store"

/**
 * One open Core V2 Session owner. Database, Event, Project and Location are explicit host
 * requirements; every derived service captures those exact values, so an inner default layer can
 * never hide a host override or split the runtime into separate registries/connections.
 */
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const database = yield* Database.Service
    const events = yield* EventV2.Service
    const locations = yield* LocationServiceMap
    const projects = yield* ProjectV2.Service
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
    )
    const restartLayer = SessionRestart.layer.pipe(
      Layer.provide(executionLayer),
      Layer.provide(storeLayer),
      Layer.provide(databaseLayer),
    )
    const statusLayer = SessionRuntimeStatus.layer.pipe(
      Layer.provide(executionLayer),
      Layer.provide(restartLayer),
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
    return Layer.mergeAll(sessionLayer, executionLayer, restartLayer, statusLayer, storeLayer, projectorLayer)
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
