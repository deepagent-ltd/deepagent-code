export * as ContextFederationProviderOwnerRuntime from "./provider-owner-runtime"

import { randomUUID } from "node:crypto"
import { SessionProviderOwner } from "@deepagent-code/core/context-federation/provider-owner"
import { Cause, Effect, Exit, Option, Ref } from "effect"

/**
 * Mutable process-level owner identity: the current lease token plus its generation counter.
 * Consumers must read this at use time — a startup-captured token constant can be fenced away
 * by lease expiry (e.g. macOS sleep) while the process keeps running.
 */
export type OwnerGeneration = {
  readonly ownerToken: string
  readonly generation: number
}

export function nextOwnerToken(input: { readonly ownerBase: string; readonly generation: number }) {
  return `${input.ownerBase}:gen-${input.generation}:${randomUUID()}`
}

type TickInput<R> = {
  readonly owners: Pick<SessionProviderOwner.Interface, "heartbeat" | "register">
  readonly owner: Ref.Ref<OwnerGeneration>
  readonly ownerBase: string
  readonly leaseMs: number
  readonly healthy: Ref.Ref<boolean>
  readonly label: string
  readonly recover?: Effect.Effect<unknown, unknown, R>
}

export function tick<R = never>(input: TickInput<R>) {
  return Effect.gen(function* () {
    const current = yield* Ref.get(input.owner)
    const heartbeat = yield* input.owners
      .heartbeat({ ownerToken: current.ownerToken, leaseMs: input.leaseMs })
      .pipe(Effect.exit)
    if (Exit.isFailure(heartbeat)) {
      const error = Option.getOrUndefined(Cause.findErrorOption(heartbeat.cause))
      // BUG-407-012 root cause A: an expired lease is correct fencing of the OLD token, not a
      // terminal fault. The fenced token is never revived or released; rotate to a successor
      // generation and keep the loop running so dispatch reopens before the next prompt.
      // `healthy` stays true throughout — only unrecoverable errors may latch it false.
      if (error instanceof SessionProviderOwner.ConflictError && error.reason === "provider_owner_lease_not_live")
        return yield* rotate(input)
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

function rotate<R>(input: TickInput<R>) {
  return Effect.gen(function* () {
    // Re-read under the Ref so concurrent rotators never double-increment the generation.
    const current = yield* Ref.get(input.owner)
    const generation = current.generation + 1
    const ownerToken = nextOwnerToken({ ownerBase: input.ownerBase, generation })
    const registered = yield* input.owners
      .register({ ownerToken, leaseMs: input.leaseMs, successor: true })
      .pipe(Effect.exit)
    if (Exit.isFailure(registered)) {
      yield* Effect.logError(
        `${input.label} owner generation rotation failed; retrying next tick: ${Cause.pretty(registered.cause)}`,
      )
      return true
    }
    yield* Ref.set(input.owner, { ownerToken, generation })
    yield* Effect.logInfo(`${input.label} owner generation rotated: generation=${generation}`)
    return true
  })
}
