export * as RecoveryExecutor from "./recovery-executor"

import { Context, Effect, Layer } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@deepagent-code/core/database/database"
import { SessionProviderRecovery, SessionProviderRecoveryDurable } from "@deepagent-code/core/session/runner"
import * as Log from "@deepagent-code/core/util/log"

// W2.2 — production wiring of the C1B recovery executors.
//
// W2/W2.1 delivered the three W2 tables, the DB-backed durable store and the durable
// `SessionProviderRecovery` service (`durableLayerWith`), but the durable service was
// NEVER provided in a production composition and no code ran a recorded recovery
// command to its terminal state — after a kill-9 restart the `recovery`-class
// descriptors were classified by the startup inventory for UI/maintenance only
// (`StartupInventory.classifyStartup`, §10.7 recovery order) and their `pending`
// commands stayed unexecuted.
//
// This module closes that gap with the smallest real chain:
//   1. `recoveryDurableLayer` — the composition seam that provides the DB-backed
//      `SessionProviderRecovery.Service`, built over the `Database.Service` the
//      composition already owns. SINGLE-INSTANCE semantics: there is no clustering —
//      one local process owns the one business database, so the service semaphore +
//      SQLite immediate-transaction CAS are the write authority.
//   2. `layer` — the durable recovery-command executor. At composition build
//      (= process boot, after migration + the startup-inventory post-verify) it scans
//      the `pending` `recovery_command` rows and applies the exit the descriptor
//      class authorizes. The drain never fails the boot: a command that cannot be
//      applied stays `pending` and is logged (the next boot or an admin action
//      re-attempts it).
//
// Boundary (W2 scope, unchanged): C1B evidence status records, baseline repairs, fork
// fences and abandon receipts remain process-local (the `durableServiceWith` memory
// Ref); the DB persists descriptors, commands and evidence exports only. The
// `v2-provider-turn` turn-terminal descriptors carry NO command row — they are the
// audit record for settled/failed/indeterminate terminals and are never executed here
// (a `resolved`-kind command, if one ever existed, is kept pending by policy).

const log = Log.create({ service: "recovery-executor" })

type BusinessDb = Database.Interface["db"]

// ---------------------------------------------------------------------------
// Exit policy (descriptor class → what the durable executor may auto-apply)
// ---------------------------------------------------------------------------
//
// A `recovery_command` row records an exit decision (the maintenance surface records it
// with the actor who requested it); the executor APPLIES the committed decision — it
// never invents one. Only the `abandon` exit of a `resolvable_exact` descriptor is
// derivable from durable rows alone (actor / request hash / attempt identity) and has
// a purely local terminal effect (never touches the provider). The other classes need
// input the DB does not hold — C1B-05-verified baseline reconstruction (repair), the
// safe-boundary history window (fork), external provider evidence (confirm-settled) or
// an admin coordination action — so they are KEPT PENDING and surfaced, never
// fabricated (§9.1: never invent a committed baseline/evidence). The design's
// no-auto-replay rule (§2.2) is untouched: applying a recorded exit never dispatches a
// provider request.

const KeptPendingReason = {
  no_exit_resolved: "resolved_descriptor_no_exit",
  no_descriptor: "pending_command_without_descriptor",
  no_actor: "pending_command_without_actor",
  system_actor_refused: "system_actor_exit_refused",
  requires_admin: "requires_admin_coordination",
  requires_baseline: "requires_baseline_reconstruction",
  requires_history: "requires_safe_boundary_history",
} as const

export type PendingExitOutcome =
  | { readonly commandId: string; readonly status: "applied"; readonly to: string }
  | { readonly commandId: string; readonly status: "kept_pending"; readonly reason: string }
  | { readonly commandId: string; readonly status: "apply_failed"; readonly error: string }

export type DrainReport = {
  readonly scanned: number
  readonly applied: number
  readonly keptPending: ReadonlyArray<{ readonly commandId: string; readonly reason: string }>
  readonly failed: ReadonlyArray<{ readonly commandId: string; readonly error: string }>
}

export interface Interface {
  /**
   * Apply the durable `pending` recovery commands the descriptor classes authorize.
   * Idempotent: the command-state CAS in the durable store ensures exactly one
   * application wins and every re-run converges on terminal rows. Never fails: a
   * command that cannot be applied stays `pending` and is logged.
   */
  readonly drain: Effect.Effect<DrainReport>
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/recovery/RecoveryExecutor") {}

/** Raw `recovery_command` row shape (decoded through the durable-store decoder). */
type CommandDbRow = {
  command_id: string
  descriptor_id: string | null
  attempt: string
  state: string
  expected_owner_token: string | null
  result_hash: string | null
  actor_type: string | null
  actor_id: string | null
  created_at: number
  updated_at: number
}

const storeOf = (db: BusinessDb) => SessionProviderRecoveryDurable.makeDurableRecoveryStore(db)

const pendingCommands = Effect.fn("RecoveryExecutor.pendingCommands")(function* (db: BusinessDb) {
  const rows = yield* db.all<CommandDbRow>(sql`
    SELECT command_id, descriptor_id, attempt, state, expected_owner_token, result_hash,
           actor_type, actor_id, created_at, updated_at
    FROM recovery_command WHERE state = 'pending'
  `).pipe(Effect.orDie)
  return rows.flatMap((row) => {
    const decoded = SessionProviderRecoveryDurable.decodeCommandRow(row)
    return decoded ? [decoded] : []
  })
})

/**
 * Apply ONE pending command. The dispatch mirrors the startup-inventory descriptor
 * vocabulary (`classifyRecoveryDescriptorItem`: `resolved` → resolved, the other four
 * classes → recovery); an unverifiable descriptor row decodes to `undefined` here
 * (content-hash verified in `getDescriptor`) and matches the inventory's unclassified
 * posture — never executed. Per-row failures are caught into `apply_failed` — the row
 * stays `pending`, the drain continues.
 */
const applyOne = Effect.fn("RecoveryExecutor.applyOne")(function* (
  db: BusinessDb,
  recovery: SessionProviderRecovery.Interface,
  row: SessionProviderRecoveryDurable.CommandRow,
) {
  const kept = (reason: string): PendingExitOutcome => ({ commandId: row.commandId, status: "kept_pending", reason })
  const descriptor = row.descriptorId ? yield* storeOf(db).getDescriptor(row.descriptorId) : undefined
  if (!descriptor) return kept(KeptPendingReason.no_descriptor)
  if (descriptor.payload.descriptorKind === "resolved") return kept(KeptPendingReason.no_exit_resolved)
  if (descriptor.payload.descriptorKind === "repairable_exact") return kept(KeptPendingReason.requires_baseline)
  if (descriptor.payload.descriptorKind === "fork_only") return kept(KeptPendingReason.requires_history)
  if (descriptor.payload.descriptorKind === "coordination_required") return kept(KeptPendingReason.requires_admin)
  // resolvable_exact — the abandon exit. The recorded command row carries the actor
  // whose exit decision was committed; the executor REPLAYS that decision (crash
  // resume), never invents one: a row without an actor, or with a system actor (the
  // permission model never grants a system actor an exit), stays pending.
  if (row.actorType === undefined || row.actorId === undefined) return kept(KeptPendingReason.no_actor)
  if (row.actorType === "system") return kept(KeptPendingReason.system_actor_refused)
  return yield* recovery
    .abandonExact({
      actor: { type: row.actorType, id: row.actorId },
      requestHash: row.requestHash,
      attemptIdentity: row.attempt,
      // Deterministic authority reason for the network-unknown recovery flow (the
      // frozen contract's bounded reason code; the recorded row carries no reason).
      reasonCode: "network_unknown",
    })
    .pipe(
      Effect.map((outcome): PendingExitOutcome =>
        outcome.status === "conflict"
          ? kept(`abandon_conflict:${outcome.reason}`)
          : { commandId: row.commandId, status: "applied", to: "abandoned" },
      ),
      Effect.catchCause((cause): Effect.Effect<PendingExitOutcome, never> =>
        Effect.succeed({ commandId: row.commandId, status: "apply_failed", error: causeLabel(cause) }),
      ),
    )
})

const causeLabel = (cause: unknown): string => {
  try {
    return String(cause)
  } catch {
    return "unknown"
  }
}

/** The executor over a composition-owned database + the durable recovery service. */
export const makeRecoveryExecutor = (db: BusinessDb, recovery: SessionProviderRecovery.Interface): Interface => {
  const runDrain = Effect.fn("RecoveryExecutor.drain")(function* () {
    const rows = yield* pendingCommands(db)
    if (rows.length === 0) return { scanned: 0, applied: 0, keptPending: [], failed: [] } satisfies DrainReport
    const outcomes = yield* Effect.forEach(
      rows,
      (row) => applyOne(db, recovery, row),
      { concurrency: 1 },
    )
    const applied = outcomes.filter((outcome): outcome is Extract<PendingExitOutcome, { status: "applied" }> => outcome.status === "applied")
    const keptPending = outcomes.filter((outcome): outcome is Extract<PendingExitOutcome, { status: "kept_pending" }> => outcome.status === "kept_pending")
    const failed = outcomes.filter((outcome): outcome is Extract<PendingExitOutcome, { status: "apply_failed" }> => outcome.status === "apply_failed")
    const report: DrainReport = { scanned: rows.length, applied: applied.length, keptPending, failed }
    log.info("recovery_executor_drain", { scanned: report.scanned, applied: report.applied, keptPending: report.keptPending.length, failed: report.failed.length })
    for (const pending of report.keptPending) {
      log.warn("recovery_command_kept_pending", { commandId: pending.commandId, reason: pending.reason })
    }
    for (const failure of report.failed) {
      log.error("recovery_command_apply_failed", { commandId: failure.commandId, error: failure.error })
    }
    return report
  })
  return {
    // The drain NEVER fails: a defect (e.g. a broken DB read) is reported as a drain-level
    // failure, never propagated — a boot-time drain cannot take the process down.
    drain: runDrain().pipe(
      Effect.catchCause((cause): Effect.Effect<DrainReport, never> =>
        Effect.succeed({ scanned: 0, applied: 0, keptPending: [], failed: [{ commandId: "drain", error: causeLabel(cause) }] }),
      ),
    ),
  }
}

/**
 * The composition seam: `SessionProviderRecovery.Service` bound to the DB-backed
 * durable service over the composition's `Database.Service` — the same connection the
 * rest of the graph uses (single-instance local process; no clustering).
 */
export const recoveryDurableLayer: Layer.Layer<SessionProviderRecovery.Service, never, Database.Service> = Layer.effect(
  SessionProviderRecovery.Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    return yield* Effect.scoped(
      Effect.gen(function* () {
        // The durable service holds no scoped resources (it wraps the shared db
        // handle); the build scope closes immediately and is not part of the seam.
        const built = yield* Layer.build(SessionProviderRecovery.durableLayerWith(database.db))
        return Context.get(built, SessionProviderRecovery.Service)
      }),
    )
  }),
)

/**
 * The production executor layer. Building it = process boot after a (possibly) crash:
 * the startup drain applies the committed-but-unapplied recovery commands. It runs
 * after the Database layer (migration + startup-inventory post-verify) and NEVER
 * fails the boot — per-command failures leave the row `pending` for the next boot.
 */
export const layer: Layer.Layer<Service, never, Database.Service | SessionProviderRecovery.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const recovery = yield* SessionProviderRecovery.Service
    const executor = makeRecoveryExecutor(database.db, recovery)
    const report: DrainReport = yield* executor.drain.pipe(
      Effect.catchCause((cause): Effect.Effect<DrainReport, never> =>
        Effect.succeed({ scanned: 0, applied: 0, keptPending: [], failed: [{ commandId: "drain", error: causeLabel(cause) }] }),
      ),
    )
    if (report.failed.length > 0) log.error("recovery_executor_drain_failed", { failed: report.failed.length })
    return Service.of(executor)
  }),
)
