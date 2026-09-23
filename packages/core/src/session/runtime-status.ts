export * as SessionRuntimeStatus from "./runtime-status"

import { Context, Effect, Layer } from "effect"
import { Database } from "../database/database"
import { LocationServiceMap } from "../location-layer"
import { SessionExecution } from "./execution"
import { SessionExecutionLocal } from "./execution/local"
import { SessionRestart } from "./execution/restart"
import { SessionSchema } from "./schema"
import { SessionStore } from "./store"

/**
 * Why a startup redrive leaves a Session fenced. These are the durable restart dispositions
 * that NEVER exact-release: past-dispatch work with an unknown outcome, a live owner lease
 * held elsewhere, or an ownership conflict. (`claim_changed` is a redrive-race verdict, not a
 * durable classification, so it does not appear here.)
 */
export const StartupRedriveBlockedReasons = [
  "recovery_required",
  "owned_elsewhere",
  "authority_conflict",
] as const
export type StartupRedriveBlockedReason = (typeof StartupRedriveBlockedReasons)[number]

const blockedReasonOf = (
  disposition: SessionRestart.PendingRecovery["disposition"],
): StartupRedriveBlockedReason | undefined =>
  StartupRedriveBlockedReasons.find((reason) => reason === disposition)

/** The process status of one Session, with the typed reason a redrive left it fenced. */
export type State =
  | { readonly status: "busy" }
  | { readonly status: "recovery_required"; readonly blockedReason?: StartupRedriveBlockedReason }

/** One Session a startup redrive leaves fenced, with its typed blocked reason. */
export type BlockedRedrive = {
  readonly sessionID: SessionSchema.ID
  readonly blockedReason: StartupRedriveBlockedReason
}

export interface Interface {
  /** Non-idle V2 Sessions derived from the process owner and durable execution claim. */
  readonly list: Effect.Effect<ReadonlyMap<SessionSchema.ID, State>>
  /**
   * The Sessions a startup redrive leaves fenced, each with the typed blocked reason — the
   * structured surfacing of the redrive `blocked` outcome (formerly a log line only).
   */
  readonly blockedRedrives: Effect.Effect<ReadonlyArray<BlockedRedrive>>
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

    const classified = Effect.gen(function* () {
      const active = yield* execution.active
      const recovery = yield* restart.pendingRecovery
      return { active, recovery }
    })

    return Service.of({
      list: Effect.map(classified, ({ active, recovery }) => {
        const dispositionOf = new Map(recovery.map((item) => [item.sessionID, item.disposition]))
        const entries: [SessionSchema.ID, State][] = [
          ...new Set([...dispositionOf.keys(), ...active]),
        ].map((sessionID): [SessionSchema.ID, State] => {
          if (active.has(sessionID)) return [sessionID, { status: "busy" }]
          const blockedReason = blockedReasonOf(dispositionOf.get(sessionID) ?? "claim_only")
          return [sessionID, { status: "recovery_required", ...(blockedReason ? { blockedReason } : {}) }]
        })
        return new Map(entries)
      }),
      blockedRedrives: Effect.map(restart.pendingRecovery, (recovery) =>
        recovery.flatMap((item) => {
          const blockedReason = blockedReasonOf(item.disposition)
          return blockedReason ? [{ sessionID: item.sessionID, blockedReason }] : []
        }),
      ),
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
