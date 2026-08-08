export * as SessionRestart from "./restart"

import { Context, Effect, Layer } from "effect"
import { SessionExecution } from "../execution"
import { SessionStore } from "../store"

export interface Interface {
  /** Marks execution active in this process for one resume attempt by the next managed process. */
  readonly suspendActiveSessions: Effect.Effect<void>
  /** Atomically consumes and resumes every suspended Session at most once. */
  readonly resumeSuspendedSessions: Effect.Effect<void>
}

/** Restart continuity actions. The host must invoke them explicitly. */
export class Service extends Context.Service<Service, Interface>()("@deepagent-code/v2/SessionRestart") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const store = yield* SessionStore.Service
    const execution = yield* SessionExecution.Service
    return Service.of({
      suspendActiveSessions: Effect.gen(function* () {
        yield* store.suspend(yield* execution.active)
      }),
      resumeSuspendedSessions: Effect.gen(function* () {
        yield* Effect.forEach(
          yield* store.listSuspended(),
          (sessionID) =>
            Effect.gen(function* () {
              if (!(yield* store.consumeSuspended(sessionID))) return
              yield* execution.resume(sessionID).pipe(Effect.ignore)
            }),
          { concurrency: "unbounded", discard: true },
        )
      }),
    })
  }),
)
