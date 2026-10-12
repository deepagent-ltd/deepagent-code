export * as SessionRuntimeStatus from "./runtime-status"

import { and, inArray, isNull, sql } from "drizzle-orm"
import { Array, Context, Effect, Layer } from "effect"
import { Database } from "../database/database"
import { LocationServiceMap } from "../location-layer"
import { SessionExecution } from "./execution"
import { SessionExecutionLocal } from "./execution/local"
import { SessionRestart } from "./execution/restart"
import { SessionSchema } from "./schema"
import { SessionStore } from "./store"
import { SessionTable } from "./sql"
import { V2ToolEffectAdmissionTable, V2ToolEffectTable } from "./runner/v2-tool-effect.sql"

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
  /** Non-idle V2 Sessions derived from process owners, claims and unresolved tool admissions. */
  readonly list: Effect.Effect<ReadonlyMap<SessionSchema.ID, State>>
  /** Production single-Session projection; omitted only by older compatibility services. */
  readonly get?: (sessionID: SessionSchema.ID) => Effect.Effect<State | undefined>
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
    const database = yield* Database.Service

    // Building the runtime service is the production startup audit seam. It never starts provider
    // work; it proves every orphaned execution claim can be classified before routes admit work.
    yield* restart.pendingRecovery

    const classified = (sessionIDs?: readonly SessionSchema.ID[]) => Effect.gen(function* () {
      if (sessionIDs?.length === 0) return new Map<SessionSchema.ID, State>()
      const active = yield* execution.active
      const recovery = yield* (sessionIDs === undefined ? restart.pendingRecovery : restart.pendingRecoveryFor(sessionIDs))
      const candidates = yield* database.db.select({ id: SessionTable.id }).from(SessionTable).where(and(
        isNull(SessionTable.execution_claim_token),
        ...(sessionIDs === undefined ? [] : [inArray(SessionTable.id, sessionIDs)]),
        sql`EXISTS (SELECT 1 FROM ${V2ToolEffectAdmissionTable} LEFT JOIN ${V2ToolEffectTable}
          ON ${V2ToolEffectTable.receipt_id}=${V2ToolEffectAdmissionTable.receipt_id}
          AND ${V2ToolEffectTable.tool_call_id}=${V2ToolEffectAdmissionTable.tool_call_id}
          WHERE ${V2ToolEffectAdmissionTable.session_id}=${SessionTable.id} AND ${V2ToolEffectTable.effect_id} IS NULL)`,
      )).all().pipe(Effect.orDie)
      // Claim release does not settle a tool outcome. Discovery reuses the original
      // exact owner/receipt/attempt joins, with bounded SQLite parameter batches.
      const effects = (yield* Effect.forEach(Array.chunksOf(candidates.map((row) => row.id), 256),
        (sessionIDs) => restart.pendingToolEffectsFor(sessionIDs), { concurrency: 1 })).flat()
      const dispositionOf = new Map(recovery.map((item) => [item.sessionID, item.disposition]))
      const pendingEffects = new Set(effects.map((effect) => effect.sessionID))
      const entries: [SessionSchema.ID, State][] = [
        ...new Set([...dispositionOf.keys(), ...pendingEffects,
          ...(sessionIDs === undefined ? active : sessionIDs.filter((id) => active.has(id)))]),
      ].map((sessionID): [SessionSchema.ID, State] => {
        if (active.has(sessionID)) return [sessionID, { status: "busy" }]
        const blockedReason = pendingEffects.has(sessionID) ? "recovery_required" as const :
          blockedReasonOf(dispositionOf.get(sessionID) ?? "claim_only")
        return [sessionID, { status: "recovery_required", ...(blockedReason ? { blockedReason } : {}) }]
      })
      return new Map(entries)
    })

    return Service.of({
      list: classified(),
      get: (sessionID) => Effect.map(classified([sessionID]), (states) => states.get(sessionID)),
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
  Layer.provide(Database.defaultLayer),
  Layer.provide(SessionExecutionLocal.defaultLayer),
  Layer.provide(restartRuntimeLayer),
)

/** Standalone production default. Hosts with application Location services must use runtimeLayer. */
export const liveLayer = runtimeLayer.pipe(Layer.provide(LocationServiceMap.layer))
