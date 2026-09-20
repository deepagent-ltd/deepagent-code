export * as SessionRuntimeStatus from "./runtime-status"

import { Context, Effect, Layer } from "effect"
import { Database } from "../database/database"
import { LocationServiceMap } from "../location-layer"
import { SessionExecution } from "./execution"
import { SessionExecutionLocal } from "./execution/local"
import { SessionRestart } from "./execution/restart"
import { SessionSchema } from "./schema"
import { SessionStore } from "./store"

export type State = "busy" | "recovery_required"

export interface Interface {
  /** Non-idle V2 Sessions derived from the process owner and durable execution claim. */
  readonly list: Effect.Effect<ReadonlyMap<SessionSchema.ID, State>>
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/v2/SessionRuntimeStatus") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const execution = yield* SessionExecution.Service
    const restart = yield* SessionRestart.Service

    // Building the runtime service is the production startup audit seam. It never starts provider
    // work; it proves every orphaned execution claim can be classified before routes admit work.
    yield* restart.pendingRecovery

    return Service.of({
      list: Effect.gen(function* () {
        const active = yield* execution.active
        const recovery = yield* restart.pendingRecovery
        return new Map(
          [...new Set([...recovery.map((item) => item.sessionID), ...active])].map((sessionID) => [
            sessionID,
            active.has(sessionID) ? "busy" : "recovery_required",
          ]),
        )
      }),
    })
  }),
)

export const restartRuntimeLayer = SessionRestart.layer.pipe(
  Layer.provide(SessionExecutionLocal.defaultLayer),
  Layer.provide(SessionStore.defaultLayer),
  Layer.provide(Database.defaultLayer),
)

/** Production startup/status wiring with an explicitly supplied Location map. */
export const runtimeLayer = layer.pipe(
  Layer.provide(SessionExecutionLocal.defaultLayer),
  Layer.provide(restartRuntimeLayer),
)

/** Standalone production default. Hosts with application Location services must use runtimeLayer. */
export const liveLayer = runtimeLayer.pipe(Layer.provide(LocationServiceMap.layer))
