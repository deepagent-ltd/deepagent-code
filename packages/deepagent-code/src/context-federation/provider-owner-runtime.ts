export * as ContextFederationProviderOwnerRuntime from "./provider-owner-runtime"

import { SessionProviderOwner } from "@deepagent-code/core/context-federation/provider-owner"
import { Cause, Effect, Exit, Option, Ref } from "effect"

export function tick<R = never>(input: {
  readonly owners: Pick<SessionProviderOwner.Interface, "heartbeat">
  readonly ownerToken: string
  readonly leaseMs: number
  readonly healthy: Ref.Ref<boolean>
  readonly label: string
  readonly recover?: Effect.Effect<unknown, unknown, R>
}) {
  return Effect.gen(function* () {
    const heartbeat = yield* input.owners
      .heartbeat({ ownerToken: input.ownerToken, leaseMs: input.leaseMs })
      .pipe(Effect.exit)
    if (Exit.isFailure(heartbeat)) {
      const error = Option.getOrUndefined(Cause.findErrorOption(heartbeat.cause))
      if (error instanceof SessionProviderOwner.ConflictError && error.reason === "provider_owner_lease_not_live") {
        yield* Ref.set(input.healthy, false)
        yield* Effect.logError(`${input.label} owner lease expired; stopping provider mutations`)
        return false
      }
      yield* Effect.logError(`${input.label} owner heartbeat failed; retrying: ${Cause.pretty(heartbeat.cause)}`)
      return true
    }
    if (!input.recover) return true
    const recovery = yield* input.recover.pipe(Effect.exit)
    if (Exit.isFailure(recovery))
      yield* Effect.logError(`${input.label} recovery failed; retrying: ${Cause.pretty(recovery.cause)}`)
    return true
  })
}
