export * as SessionRuntimeStatus from "./runtime-status"

import { Context, Effect, Layer } from "effect"
import { SessionExecution } from "./execution"
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
    const store = yield* SessionStore.Service

    return Service.of({
      list: Effect.gen(function* () {
        const active = yield* execution.active
        const suspended = yield* store.listSuspended()
        return new Map(
          [...new Set([...suspended, ...active])].map((sessionID) => [
            sessionID,
            active.has(sessionID) ? "busy" : "recovery_required",
          ]),
        )
      }),
    })
  }),
)
