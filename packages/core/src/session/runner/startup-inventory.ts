export * as StartupInventory from "./startup-inventory"

// C1B-10 — unified startup inventory (design §10.7 recovery order steps 3-7).
//
// After migration and BEFORE open admission, the boot must classify every durable
// recovery surface into a deterministic bucket and prove the inventory is TOTAL
// (`unclassified = 0`) before it may advance to `ready`. This module is the single
// in-process classification surface for the durable recovery categories:
//
//   provider_attempt (session_provider_attempt)
//   tool_effect      (session_v2_tool_effect_admission + terminal effect/grant evidence)
//   task_run         (task_run)
//   compaction       (event_snapshot_attempt + event_compaction_receipt
//                     + session_v2_compaction_request)
//   session_activity (session_facade_activity)
//   recovery_descriptor (session_provider_recovery_descriptor)
//   recovery_command (recovery_command plus exact provider authority)
//   session_input    (session_input durable admission queue)
//   provider_binding (session_v2_provider_turn_receipt ↔ session_provider_attempt)
//   event_outbox     (deepagent_event_outbox publisher ledger)
//   event_delivery   (deepagent_event_consumer_delivery consumer ledger)
//   sync_projection  (event_sync_backfill + event_sync_sequence authority)
//
// Vocabulary (design §10.7 / design §2.2):
//   safe_before_dispatch — provably pre-dispatch (requeue-eligible; NEVER auto-replayed
//                          without this proof; §2.2 "indeterminate is never auto-replayed").
//   recovery             — past dispatch with an unknown outcome (the C1B descriptor classes);
//                          requires explicit recovery treatment, never an automatic requeue.
//   resolved             — terminal evidence already exists (resolved; no action).
//   unclassified         — the category cannot be proven (unknown state / binding mismatch).
//                          This is the ONLY bucket that blocks `ready`.
//
// The readiness gate is deliberately minimal and total: `ready` ⇔ `unclassified === 0`
// (design §10.7 step 7). Recovery and safe_before_dispatch items are surfaced to the
// recovery phase (requeue the provably-safe, surface the rest) but do NOT block ready —
// only an unprovable item does.
//
// Classification is DURABLE-ONLY: every decision is derived from the DB rows, never from
// process-local state, so a restart re-derives the same inventory from the same rows.
//
// The post-verify hook that consumes this gate lives in db/post-verify.ts
// (`post_verify_unclassified_inventory`, C1A-11). That file is C1A read-only, so the
// real implementation is provided here and the MAIN AGENT wires the one-line call. See the
// module report for the exact wiring (this module is importable from database/post-verify.ts).

import { sql } from "drizzle-orm"
import { Effect } from "effect"
import type { EffectDrizzleSqlite } from "@deepagent-code/effect-drizzle-sqlite"
import { decodeDescriptorRow } from "./recovery-durable-store"
import { decodeCommandRow } from "./recovery-durable-store"
import type { DescriptorDbRow, DescriptorRow } from "./recovery-durable-store"

type Database = EffectDrizzleSqlite.EffectSQLiteDatabase

/** The durable recovery surfaces the startup inventory classifies. */
export type StartupCategory =
  | "provider_attempt"
  | "tool_effect"
  | "task_run"
  | "compaction"
  | "session_activity"
  | "recovery_descriptor"
  | "recovery_command"
  | "session_input"
  | "provider_binding"
  | "event_outbox"
  | "event_delivery"
  | "sync_projection"

export const StartupCategories: readonly StartupCategory[] = [
  "provider_attempt",
  "tool_effect",
  "task_run",
  "compaction",
  "session_activity",
  "recovery_descriptor",
  "recovery_command",
  "session_input",
  "provider_binding",
  "event_outbox",
  "event_delivery",
  "sync_projection",
]

/** The deterministic classification bucket for one durable item. */
export type InventoryClassification = "safe_before_dispatch" | "recovery" | "resolved" | "unclassified"

export const InventoryClassifications: readonly InventoryClassification[] = [
  "safe_before_dispatch",
  "recovery",
  "resolved",
  "unclassified",
]

/** One classified durable item. `reason` is the auditable why (never fuzzy). */
export type StartupInventoryItem = {
  readonly category: StartupCategory
  /**
   * Durable row id. For compaction (three tables) this is prefixed so the row is
   * unambiguous: `snapshot:<id>` | `receipt:<id>` | `request:<id>`.
   */
  readonly id: string
  readonly classification: InventoryClassification
  readonly reason: string
  /** Durable state the classification was derived from (audit trail). */
  readonly state: string
}

export type CategoryCounts = Readonly<Record<InventoryClassification, number>>

export type StartupInventory = {
  readonly total: number
  readonly byCategory: Readonly<Record<StartupCategory, CategoryCounts>>
  readonly unclassifiedItems: readonly StartupInventoryItem[]
  /** `true` ⇔ the inventory is total (`unclassified === 0`) ⇒ the boot may advance to ready. */
  readonly ready: boolean
}

/** Pure readiness gate: `ready` ⇔ no unclassified item. */
export function gateReady(inventory: Pick<StartupInventory, "unclassifiedItems">): boolean {
  return inventory.unclassifiedItems.length === 0
}

/**
 * C1B-10 post-verify verdict: the runnable form of the inventory gate, consumed by the
 * bootstrap post-verify path (database/post-verify.ts `post_verify_unclassified_inventory`).
 * The stub in that file is C1A read-only, so the real implementation lives HERE and the
 * MAIN AGENT wires the one-line call:
 *
 *   yield* StartupInventory.verifyStartupInventory(db).pipe(Effect.flatMap((v) =>
 *     v.ok ? Effect.void : Effect.fail(new PostVerifyError({
 *       code: "post_verify_unclassified_inventory",
 *       detail: `${v.unclassifiedItems.length} unclassified startup item(s)`,
 *       rows: v.unclassifiedItems,
 *     }))))
 *
 * This module is importable from database/post-verify.ts without touching database/.
 */
export type StartupInventoryVerdict = {
  readonly ok: boolean
  readonly total: number
  readonly unclassifiedItems: readonly StartupInventoryItem[]
}

export const verifyStartupInventory = Effect.fn("StartupInventory.verifyStartupInventory")(function* (db: Database) {
  const inventory = yield* classifyStartup(db)
  return { ok: inventory.ready, total: inventory.total, unclassifiedItems: inventory.unclassifiedItems }
})

/** Pure: whether a boot must remain in `read_only_recovery` (unclassified>0). */
export function readOnlyRecoveryRequired(inventory: Pick<StartupInventory, "unclassifiedItems">): boolean {
  return !gateReady(inventory)
}

export type CategoryRow = { readonly id: string; readonly state: string }

// ---------------------------------------------------------------------------
// Per-category classifiers (pure; each maps every KNOWN state to a bucket; an
// out-of-vocabulary state is `unclassified` so the inventory stays TOTAL).
// ---------------------------------------------------------------------------

const providerAttempt: Readonly<Record<string, InventoryClassification>> = {
  prepared: "safe_before_dispatch",
  dispatching: "recovery",
  streaming: "recovery",
  indeterminate_after_crash: "recovery",
  settled: "resolved",
  failed: "resolved",
  resolved_abandoned: "resolved",
  resolved_settled: "resolved",
  resolved_replayed: "resolved",
}

type ProviderAttemptRow = CategoryRow & {
  readonly execution_claim_token: number
  readonly current_session_claim_token: number | null
  readonly resolution_decision: string | null
  readonly bridge_attempt_id: string | null
  readonly bridge_receipt_id: string | null
  readonly receipt_attempt_id: string | null
  readonly receipt_state: string | null
}

const taskRunTerminal = new Set(["completed", "error", "cancelled", "interrupted", "failed", "closed"])
const taskRunPredispatch = new Set(["admitted", "queued", "provisioning"])
const taskRunActive = new Set(["researching", "finalizing", "running", "recovery_required"])

function classifyProviderAttemptItem(row: ProviderAttemptRow): StartupInventoryItem {
  const classification = providerAttempt[row.state]
  if (classification === undefined)
    return {
      category: "provider_attempt",
      id: row.id,
      classification: "unclassified",
      state: row.state,
      reason: `unknown provider_attempt state '${row.state}'`,
    }
  // A live attempt (prepared/dispatching/streaming) is only provable while it still holds the
  // Session's current execution claim: a live state without that exact claim means an executor
  // vanished without settling. `indeterminate_after_crash` is already terminal quarantine
  // evidence — the attempt never executes again, so a claim released by interrupt settlement
  // (or superseded by a later drain) cannot change what the row is: past dispatch, unknown
  // outcome, never auto-replayed. Only a missing/zeroed claim token stays fail-closed there.
  const livePreQuarantine =
    row.state === "prepared" || row.state === "dispatching" || row.state === "streaming"
  if (
    (livePreQuarantine || row.state === "indeterminate_after_crash") &&
    (row.execution_claim_token <= 0 ||
      (livePreQuarantine && row.current_session_claim_token !== row.execution_claim_token))
  )
    return {
      category: "provider_attempt",
      id: row.id,
      classification: "unclassified",
      state: row.state,
      reason: "provider attempt lacks its exact current Session execution claim",
    }
  if (row.state.startsWith("resolved_")) {
    const decision = row.state.slice("resolved_".length)
    if (
      row.resolution_decision !== decision ||
      row.bridge_attempt_id !== row.id ||
      row.bridge_receipt_id === null ||
      row.receipt_attempt_id !== row.id ||
      row.receipt_state !== "indeterminate_after_crash"
    )
      return {
        category: "provider_attempt",
        id: row.id,
        classification: "unclassified",
        state: row.state,
        reason: "resolved provider attempt lacks its exact resolution, V2 bridge, and indeterminate receipt",
      }
  }
  return {
    category: "provider_attempt",
    id: row.id,
    classification,
    state: row.state,
    reason:
      classification === "safe_before_dispatch"
        ? "attempt prepared but never dispatched; provably pre-dispatch (requeue-eligible)"
        : classification === "recovery"
          ? "attempt past dispatch with unknown outcome; requires explicit recovery (never auto-requeued)"
          : "terminal evidence exists; resolved",
  }
}

function classifyToolEffectItem(row: CategoryRow & { readonly grant_state: string | null }): StartupInventoryItem {
  if (row.state !== "admitted" && row.state !== "settled" && row.state !== "failed")
    return {
      category: "tool_effect",
      id: row.id,
      classification: "unclassified",
      state: row.state,
      reason: `unknown tool effect state '${row.state}'`,
    }
  if (row.state === "admitted")
    return {
      category: "tool_effect",
      id: row.id,
      classification: "recovery",
      state: row.state,
      reason: "tool effect admitted before execution but no terminal evidence exists; outcome unknown and never auto-replayed",
    }
  if (row.grant_state == null)
    return {
      category: "tool_effect",
      id: row.id,
      classification: "recovery",
      state: row.state,
      reason: "tool effect carried no permission grant evidence; permission incomplete (coordinator)",
    }
  if (row.grant_state === "settled")
    return {
      category: "tool_effect",
      id: row.id,
      classification: "resolved",
      state: row.state,
      reason: "permission grant settled; tool effect terminal",
    }
  if (row.grant_state === "started" || row.grant_state === "unknown")
    return {
      category: "tool_effect",
      id: row.id,
      classification: "recovery",
      state: row.state,
      reason: `permission grant '${row.grant_state}' (started/unknown) — quarantined; no auto-replay`,
    }
  return {
    category: "tool_effect",
    id: row.id,
    classification: "unclassified",
    state: row.state,
    reason: `unknown tool grant state '${row.grant_state}'`,
  }
}

function classifyTaskRunItem(
  row: CategoryRow & { readonly execution_owner: string | null; readonly lease_expires_at: number | null },
  observedAt: number,
): StartupInventoryItem {
  // A live lease means another owner holds the claim: never requeue, never recover here.
  if (row.execution_owner != null && (row.lease_expires_at ?? 0) > observedAt)
    return {
      category: "task_run",
      id: row.id,
      classification: "recovery",
      state: row.state,
      reason: "active execution lease held elsewhere; not requeueable, surfaced for explicit handling",
    }
  if (taskRunTerminal.has(row.state))
    return {
      category: "task_run",
      id: row.id,
      classification: "resolved",
      state: row.state,
      reason: "terminal task run; resolved",
    }
  if (taskRunPredispatch.has(row.state))
    return {
      category: "task_run",
      id: row.id,
      classification: "safe_before_dispatch",
      state: row.state,
      reason: "task run pre-dispatch with no live lease; requeue-eligible",
    }
  if (taskRunActive.has(row.state))
    return {
      category: "task_run",
      id: row.id,
      classification: "recovery",
      state: row.state,
      reason: "task run executing/finalizing with no live lease; unknown outcome — recovery",
    }
  return {
    category: "task_run",
    id: row.id,
    classification: "unclassified",
    state: row.state,
    reason: `unknown task_run state '${row.state}'`,
  }
}

const compactionSnapshot: Readonly<Record<string, InventoryClassification>> = {
  complete: "resolved",
  prepared: "safe_before_dispatch",
  staged: "safe_before_dispatch",
}

const compactionReceipt: Readonly<Record<string, InventoryClassification>> = {
  complete: "resolved",
  running: "recovery",
}

// RI-18 durable manual-compaction request. The runner drain is the only executor
// (pending → dispatched → settled/recovery_required/failed). A dispatched row observed at
// boot is orphaned — settleOrphaned flips it to recovery_required — so its outcome is unknown.
const compactionRequest: Readonly<Record<string, InventoryClassification>> = {
  pending: "safe_before_dispatch",
  dispatched: "recovery",
  settled: "resolved",
  recovery_required: "recovery",
  failed: "resolved",
}

function classifyCompactionItem(
  row: CategoryRow & { readonly table: "snapshot" | "receipt" | "request" },
): StartupInventoryItem {
  const map =
    row.table === "snapshot" ? compactionSnapshot : row.table === "receipt" ? compactionReceipt : compactionRequest
  const classification = map[row.state]
  if (classification === undefined)
    return {
      category: "compaction",
      id: `${row.table}:${row.id}`,
      classification: "unclassified",
      state: row.state,
      reason: `unknown ${row.table}_compaction state '${row.state}'`,
    }
  return {
    category: "compaction",
    id: `${row.table}:${row.id}`,
    classification,
    state: row.state,
    reason: compactionReason(row.table, classification),
  }
}

function compactionReason(
  table: "snapshot" | "receipt" | "request",
  classification: InventoryClassification,
): string {
  if (table === "request") {
    if (classification === "safe_before_dispatch")
      return "compaction request admitted but never dispatched; the drain owns execution"
    if (classification === "recovery")
      return "compaction request dispatched with unknown outcome; orphaned drains settle recovery_required"
    return "compaction request terminal (settled/failed); resolved"
  }
  return classification === "safe_before_dispatch"
    ? "snapshot built but not committed; provably pre-commit (requeue-eligible rebuild)"
    : classification === "recovery"
      ? "compaction in-flight with no committed receipt; recovery"
      : "compaction complete; resolved"
}

const sessionActivityState: Readonly<Record<string, InventoryClassification>> = {
  settled: "resolved",
  failed: "resolved",
  active: "recovery",
  interrupted: "recovery",
  recovery_required: "recovery",
}

function classifySessionActivityItem(row: CategoryRow): StartupInventoryItem {
  const classification = sessionActivityState[row.state]
  if (classification === undefined)
    return {
      category: "session_activity",
      id: row.id,
      classification: "unclassified",
      state: row.state,
      reason: `unknown session_activity state '${row.state}'`,
    }
  return {
    category: "session_activity",
    id: row.id,
    classification,
    state: row.state,
    reason:
      classification === "resolved"
        ? "session activity terminal; resolved"
        : "session activity active/interrupted/recovery_required; explicit recovery",
  }
}

type RecoveryCommandInventoryRow = {
  readonly command_id: string
  readonly descriptor_id: string | null
  readonly attempt: string
  readonly state: string
  readonly expected_owner_token: string | null
  readonly result_hash: string | null
  readonly actor_type: string | null
  readonly actor_id: string | null
  readonly created_at: number
  readonly updated_at: number
  readonly descriptor_session_id: string | null
  readonly descriptor_activity_id: string | null
  readonly descriptor_turn_id: string | null
  readonly descriptor_kind: string | null
  readonly descriptor_payload: string | null
  readonly descriptor_content_hash: string | null
  readonly descriptor_created_at: number | null
  readonly attempt_state: string | null
  readonly attempt_version: number | null
  readonly attempt_session_id: string | null
  readonly attempt_activity_id: string | null
  readonly attempt_turn_seq: number | null
  readonly attempt_selection_id: string | null
  readonly attempt_projection_hash: string | null
  readonly attempt_request_hash: string | null
  readonly attempt_provider_id: string | null
  readonly attempt_owner_token: string | null
  readonly attempt_execution_claim_token: number | null
  readonly current_session_claim_token: number | null
  readonly resolution_decision: string | null
  readonly bridge_command_id: string | null
}

function classifyRecoveryCommandItem(row: RecoveryCommandInventoryRow): StartupInventoryItem {
  const command = decodeCommandRow(row)
  const descriptor =
    row.descriptor_id !== null &&
    row.descriptor_session_id !== null &&
    row.descriptor_activity_id !== null &&
    row.descriptor_turn_id !== null &&
    row.descriptor_kind !== null &&
    row.descriptor_payload !== null &&
    row.descriptor_content_hash !== null &&
    row.descriptor_created_at !== null
      ? decodeDescriptorRow({
          descriptor_id: row.descriptor_id,
          session_id: row.descriptor_session_id,
          activity_id: row.descriptor_activity_id,
          turn_id: row.descriptor_turn_id,
          kind: row.descriptor_kind,
          payload: row.descriptor_payload,
          content_hash: row.descriptor_content_hash,
          created_at: row.descriptor_created_at,
        })
      : undefined
  const item = (classification: InventoryClassification, reason: string): StartupInventoryItem => ({
    category: "recovery_command",
    id: row.command_id,
    classification,
    state: row.state,
    reason,
  })
  if (!command) return item("unclassified", "recovery command payload or state is unverifiable")
  if (!descriptor) return item("unclassified", "recovery command has no verifiable bound descriptor")
  if (
    descriptor.sessionId !== command.attempt.sessionId ||
    descriptor.activityId !== command.attempt.activityId ||
    descriptor.payload.requestHash !== command.requestHash ||
    row.attempt_state === null ||
    row.attempt_version === null ||
    row.attempt_session_id !== command.attempt.sessionId ||
    row.attempt_activity_id !== command.attempt.activityId ||
    row.attempt_turn_seq !== command.attempt.providerTurnSeq ||
    row.attempt_selection_id !== command.attempt.selectionId ||
    row.attempt_projection_hash !== command.attempt.projectionHash ||
    row.attempt_request_hash !== command.requestHash ||
    row.attempt_provider_id !== command.attempt.providerId ||
    row.attempt_owner_token === null ||
    command.expectedOwnerToken !== row.attempt_owner_token ||
    row.attempt_execution_claim_token === null ||
    row.attempt_execution_claim_token <= 0
  )
    return item("unclassified", "recovery command exact provider-attempt binding is missing or mismatched")
  if (command.state === "pending") {
    if (
      row.current_session_claim_token !== row.attempt_execution_claim_token ||
      descriptor.payload.descriptorKind === "resolved" ||
      descriptor.payload.casTokens.expectedState !== row.attempt_state ||
      descriptor.payload.casTokens.expectedVersion !== row.attempt_version ||
      descriptor.payload.casTokens.ownerToken !== row.attempt_owner_token
    )
      return item("unclassified", "pending recovery command CAS authority is stale or already resolved")
    return item("recovery", "committed recovery command awaits exact authority application")
  }
  if (command.state === "abandoned") {
    if (
      row.attempt_state !== "resolved_abandoned" ||
      row.resolution_decision !== "abandoned" ||
      row.bridge_command_id !== command.commandId ||
      command.resultHash === undefined ||
      row.current_session_claim_token === row.attempt_execution_claim_token
    )
      return item("unclassified", "abandoned command lacks its exact terminal result, provider resolution, bridge, or claim release")
    return item("resolved", "abandoned command is bound to the exact terminal provider authority")
  }
  if (command.state === "settled" || command.state === "forked")
    return item("unclassified", `terminal '${command.state}' command has no durable V2 authority classifier`)
  return item("unclassified", `unknown recovery command state '${row.state}'`)
}

function classifySessionInputItem(
  row: CategoryRow & { readonly delivery: string; readonly promoted_seq: number | null },
): StartupInventoryItem {
  if (!['steer', 'queue', 'goal_steer'].includes(row.delivery))
    return {
      category: "session_input",
      id: row.id,
      classification: "unclassified",
      state: row.state,
      reason: `unknown session_input delivery '${row.delivery}'`,
    }
  return {
    category: "session_input",
    id: row.id,
    classification: row.promoted_seq === null ? "safe_before_dispatch" : "resolved",
    state: row.state,
    reason:
      row.promoted_seq === null
        ? "durable input admitted but not promoted; provably pending work"
        : "durable input already promoted into canonical history",
  }
}

type ProviderBindingRow = CategoryRow & {
  readonly provider_attempt_id: string | null
  readonly receipt_session_id: string
  readonly receipt_activity_id: string
  readonly receipt_turn_seq: number
  readonly receipt_request_hash: string
  readonly receipt_provider_id: string
  readonly receipt_owner_token: string
  readonly attempt_state: string | null
  readonly attempt_session_id: string | null
  readonly attempt_activity_id: string | null
  readonly attempt_turn_seq: number | null
  readonly attempt_request_hash: string | null
  readonly attempt_provider_id: string | null
  readonly attempt_owner_token: string | null
  readonly bridge_receipt_id: string | null
}

function classifyProviderBindingItem(row: ProviderBindingRow): StartupInventoryItem {
  const receiptStates = ["preparing", "dispatching", "streaming", "settled", "failed", "indeterminate_after_crash"]
  if (!receiptStates.includes(row.state))
    return {
      category: "provider_binding",
      id: row.id,
      classification: "unclassified",
      state: row.state,
      reason: `unknown provider receipt state '${row.state}'`,
    }
  if (
    row.provider_attempt_id === null ||
    row.attempt_state === null ||
    row.attempt_session_id !== row.receipt_session_id ||
    row.attempt_activity_id !== row.receipt_activity_id ||
    row.attempt_turn_seq !== row.receipt_turn_seq ||
    row.attempt_request_hash !== row.receipt_request_hash ||
    row.attempt_provider_id !== row.receipt_provider_id ||
    row.attempt_owner_token !== row.receipt_owner_token
  )
    return {
      category: "provider_binding",
      id: row.id,
      classification: "unclassified",
      state: row.state,
      reason: "provider receipt/attempt exact binding missing or mismatched",
    }
  const compatible =
    (row.state === "preparing" && row.attempt_state === "prepared") ||
    row.state === row.attempt_state ||
    (row.state === "indeterminate_after_crash" &&
      ["resolved_abandoned", "resolved_settled", "resolved_replayed"].includes(row.attempt_state) &&
      row.bridge_receipt_id === row.id)
  if (!compatible)
    return {
      category: "provider_binding",
      id: row.id,
      classification: "unclassified",
      state: `${row.state}:${row.attempt_state}`,
      reason: "provider receipt/attempt states are not a valid atomic pair",
    }
  const classification =
    ["settled", "failed"].includes(row.state) || row.attempt_state.startsWith("resolved_")
      ? "resolved"
      : row.state === "preparing"
        ? "safe_before_dispatch"
        : "recovery"
  return {
    category: "provider_binding",
    id: row.id,
    classification,
    state: `${row.state}:${row.attempt_state}`,
    reason:
      classification === "resolved"
        ? "receipt and attempt have matching terminal evidence"
        : classification === "safe_before_dispatch"
          ? "receipt and attempt are atomically bound before dispatch"
          : "receipt and attempt are atomically bound past dispatch; explicit recovery required",
  }
}

function classifyEventOutboxItem(
  row: CategoryRow & {
    readonly claim_token: string | null
    readonly claimant_id: string | null
    readonly lease_expires_at: number | null
    readonly published_at: number | null
    readonly registered_consumers: number
    readonly assigned_consumers: number
  },
): StartupInventoryItem {
  if (!['pending', 'publishing', 'published', 'dead'].includes(row.state))
    return {
      category: "event_outbox",
      id: row.id,
      classification: "unclassified",
      state: row.state,
      reason: `unknown event outbox state '${row.state}'`,
    }
  const publishingBindingValid =
    row.state !== "publishing" ||
    (row.claim_token !== null && row.claimant_id !== null && row.lease_expires_at !== null)
  const publishedEvidenceValid = row.state !== "published" || row.published_at !== null
  if (!publishingBindingValid || !publishedEvidenceValid)
    return {
      category: "event_outbox",
      id: row.id,
      classification: "unclassified",
      state: row.state,
      reason: !publishingBindingValid
        ? "publishing outbox row lacks a complete claim/lease"
        : "published outbox row lacks publication evidence",
    }
  if (row.state === "published" && row.assigned_consumers !== row.registered_consumers)
    return {
      category: "event_outbox",
      id: row.id,
      classification: "recovery",
      state: row.state,
      reason: "published outbox row requires deterministic consumer-assignment repair",
    }
  return {
    category: "event_outbox",
    id: row.id,
    classification: row.state === "pending" ? "safe_before_dispatch" : row.state === "publishing" ? "recovery" : "resolved",
    state: row.state,
    reason:
      row.state === "pending"
        ? "committed outbox event is pending physical publication"
        : row.state === "publishing"
          ? "outbox event may have crossed dispatch; lease-fenced recovery required"
          : "outbox event is terminal",
  }
}

function classifyEventDeliveryItem(
  row: CategoryRow & {
    readonly claim_token: string | null
    readonly claimant_id: string | null
    readonly lease_expires_at: number | null
    readonly resolved_at: number | null
  },
): StartupInventoryItem {
  if (!['pending', 'claimed', 'resolved', 'dead'].includes(row.state))
    return {
      category: "event_delivery",
      id: row.id,
      classification: "unclassified",
      state: row.state,
      reason: `unknown event delivery state '${row.state}'`,
    }
  if (
    (row.state === "claimed" &&
      (row.claim_token === null || row.claimant_id === null || row.lease_expires_at === null)) ||
    (row.state === "resolved" && row.resolved_at === null)
  )
    return {
      category: "event_delivery",
      id: row.id,
      classification: "unclassified",
      state: row.state,
      reason: row.state === "claimed" ? "claimed delivery lacks a complete claim/lease" : "resolved delivery lacks terminal evidence",
    }
  return {
    category: "event_delivery",
    id: row.id,
    classification: row.state === "pending" ? "safe_before_dispatch" : row.state === "claimed" ? "recovery" : "resolved",
    state: row.state,
    reason:
      row.state === "pending"
        ? "consumer delivery is pending dispatch"
        : row.state === "claimed"
          ? "consumer delivery may have crossed dispatch; lease-fenced recovery required"
          : "consumer delivery is terminal",
  }
}

function classifySyncProjectionItem(
  row: CategoryRow & {
    readonly cursor_rowid: number | null
    readonly high_water_rowid: number | null
    readonly completed_at: number | null
    readonly backfill_complete: number | null
  },
): StartupInventoryItem {
  if (
    !['pending', 'complete'].includes(row.state) ||
    row.cursor_rowid === null ||
    row.high_water_rowid === null ||
    row.backfill_complete === null ||
    row.cursor_rowid < 0 ||
    row.cursor_rowid > row.high_water_rowid ||
    (row.state === "pending" && row.backfill_complete !== 0) ||
    (row.state === "complete" &&
      (row.backfill_complete !== 1 || row.cursor_rowid !== row.high_water_rowid || row.completed_at === null))
  )
    return {
      category: "sync_projection",
      id: row.id,
      classification: "unclassified",
      state: row.state,
      reason: "event sync backfill/cursor authority is missing or inconsistent",
    }
  return {
    category: "sync_projection",
    id: row.id,
    classification: row.state === "pending" ? "safe_before_dispatch" : "resolved",
    state: row.state,
    reason: row.state === "pending" ? "event sync projection has bounded pending repair work" : "event sync projection authority is complete",
  }
}

// W2 — the durable C1B recovery descriptor surface (design §W2). Every row of the
// descriptor table is a classified five-class object; kind `resolved` is terminal
// (resolved), the other four classes are past-dispatch recoveries (never an automatic
// requeue — §2.2), and an unverifiable row is `unclassified` (blocks ready). The
// classification is driven by the DECODED payload (kind binding AND content_hash
// verified against the recomputed descriptor digest — see decodeDescriptorRow), never
// by the raw `kind` column alone: a tampered/partial row can never be classified as a
// trusted recovery fact.
function classifyRecoveryDescriptorItem(row: DescriptorRow): StartupInventoryItem {
  const classification =
    row.kind === "resolved"
      ? "resolved"
      : ["resolvable_exact", "repairable_exact", "fork_only", "coordination_required"].includes(row.kind)
        ? "recovery"
        : undefined
  if (classification === undefined)
    return {
      category: "recovery_descriptor",
      id: row.descriptorId,
      classification: "unclassified",
      state: row.kind,
      reason: `unknown recovery descriptor kind '${row.kind}'`,
    }
  return {
    category: "recovery_descriptor",
    id: row.descriptorId,
    classification,
    state: row.kind,
    reason:
      classification === "resolved"
        ? "recovery descriptor resolved; terminal evidence exists"
        : "recovery descriptor past dispatch; explicit recovery (never auto-requeued)",
  }
}

// ---------------------------------------------------------------------------
// Inventory assembly
// ---------------------------------------------------------------------------

/** Number of items per classification for a category, initialized to zero. */
function emptyCounts(): Record<InventoryClassification, number> {
  return { safe_before_dispatch: 0, recovery: 0, resolved: 0, unclassified: 0 }
}

function tallyCounts(
  byCategory: Record<StartupCategory, Record<InventoryClassification, number>>,
  category: StartupCategory,
  item: StartupInventoryItem,
): void {
  byCategory[category]![item.classification] = byCategory[category]![item.classification] + 1
}

/**
 * C1B-10 — classify the STARTUP recovery inventory over the five durable categories.
 *
 * Deterministic and TOTAL by construction: every row that is read is classified; an
 * out-of-vocabulary state/binding becomes `unclassified` (reported, blocks `ready`) so a
 * surprise never silently slips through. Read-only (no writes, no requeue, no replay).
 */
export const classifyStartup = Effect.fn("StartupInventory.classifyStartup")(function* (db: Database) {
  const byCategory: Record<StartupCategory, Record<InventoryClassification, number>> = {
    provider_attempt: emptyCounts(),
    tool_effect: emptyCounts(),
    task_run: emptyCounts(),
    compaction: emptyCounts(),
    session_activity: emptyCounts(),
    recovery_descriptor: emptyCounts(),
    recovery_command: emptyCounts(),
    session_input: emptyCounts(),
    provider_binding: emptyCounts(),
    event_outbox: emptyCounts(),
    event_delivery: emptyCounts(),
    sync_projection: emptyCounts(),
  }
  const unclassifiedItems: StartupInventoryItem[] = []
  const clock = yield* db.get<{ observed_at: number }>(sql`
    SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS observed_at
  `)
  if (!clock) return yield* Effect.die("startup inventory database clock unavailable")
  const observedAt = clock.observed_at

  const accept = (item: StartupInventoryItem): void => {
    tallyCounts(byCategory, item.category, item)
    if (item.classification === "unclassified") unclassifiedItems.push(item)
  }

  // Provider attempts.
  const attempts = yield* db.all<ProviderAttemptRow>(sql`
    SELECT attempt.attempt_id AS id, attempt.state, attempt.execution_claim_token,
           session.execution_claim_token AS current_session_claim_token,
           resolution.decision AS resolution_decision,
           bridge.attempt_id AS bridge_attempt_id,
           bridge.receipt_id AS bridge_receipt_id,
           receipt.provider_attempt_id AS receipt_attempt_id,
           receipt.state AS receipt_state
    FROM session_provider_attempt attempt
    LEFT JOIN session ON session.id = attempt.session_id
    LEFT JOIN session_provider_attempt_resolution resolution
      ON resolution.attempt_id = attempt.attempt_id
    LEFT JOIN session_v2_provider_recovery_bridge bridge
      ON bridge.attempt_id = attempt.attempt_id
     AND bridge.resolution_id = resolution.resolution_id
    LEFT JOIN session_v2_provider_turn_receipt receipt
      ON receipt.receipt_id = bridge.receipt_id
  `)
  attempts.forEach((row) => accept(classifyProviderAttemptItem(row)))

  // V2 tool effects. Admission is the authoritative pre-execution inventory row; absence of a
  // matching terminal effect is an unknown outcome, not proof that the tool never ran.
  const effects = yield* db.all<{ id: string; state: string; grant_state: string | null }>(
    sql`
      SELECT admission.admission_id AS id,
             COALESCE(effect.state, 'admitted') AS state,
             effect.grant_state
      FROM session_v2_tool_effect_admission admission
      LEFT JOIN session_v2_tool_effect effect
        ON effect.receipt_id = admission.receipt_id
       AND effect.tool_call_id = admission.tool_call_id
    `,
  )
  effects.forEach((row) => accept(classifyToolEffectItem(row)))

  // Task runs.
  const tasks = yield* db.all<{ id: string; state: string; execution_owner: string | null; lease_expires_at: number | null }>(
    sql`SELECT run_id AS id, state, execution_owner, lease_expires_at FROM task_run`,
  )
  tasks.forEach((row) => accept(classifyTaskRunItem(row, observedAt)))

  // Compaction (snapshot attempt + compaction receipt + RI-18 compaction request).
  const snapshots = yield* db.all<CategoryRow>(sql`SELECT snapshot_id AS id, state FROM event_snapshot_attempt`)
  snapshots.forEach((row) => accept(classifyCompactionItem({ ...row, table: "snapshot" })))
  const receipts = yield* db.all<CategoryRow>(
    sql`SELECT aggregate_id AS id, state FROM event_compaction_receipt`,
  )
  receipts.forEach((row) => accept(classifyCompactionItem({ ...row, table: "receipt" })))
  const requests = yield* db.all<CategoryRow>(
    sql`SELECT request_id AS id, status AS state FROM session_v2_compaction_request`,
  )
  requests.forEach((row) => accept(classifyCompactionItem({ ...row, table: "request" })))

  // Session activity.
  const activities = yield* db.all<CategoryRow>(sql`
    SELECT 'core:' || activity_id AS id, state FROM session_activity
    UNION ALL
    SELECT 'facade:' || activity_id AS id, state FROM session_facade_activity
  `)
  activities.forEach((row) => accept(classifySessionActivityItem(row)))

  // W2 recovery descriptors: one item per durable descriptor row (append-only
  // classification log; the five C1B classes map onto the inventory buckets). The
  // row is DECODED (kind binding + content_hash verified) — a row that fails decode
  // is unclassified (blocks ready), never classified from the raw kind column.
  const descriptorRows = yield* db.all<DescriptorDbRow>(
    sql`SELECT descriptor_id, session_id, activity_id, turn_id, kind, payload, content_hash, created_at
        FROM session_provider_recovery_descriptor`,
  )
  for (const row of descriptorRows) {
    const decoded = decodeDescriptorRow(row)
    if (!decoded) {
      accept({
        category: "recovery_descriptor",
        id: row.descriptor_id,
        classification: "unclassified",
        state: row.kind,
        reason: "recovery descriptor payload unverifiable (decode failure or content_hash mismatch)",
      })
      continue
    }
    accept(classifyRecoveryDescriptorItem(decoded))
  }

  const commands = yield* db.all<RecoveryCommandInventoryRow>(sql`
    SELECT command.command_id, command.descriptor_id, command.attempt, command.state,
           command.expected_owner_token, command.result_hash, command.actor_type,
           command.actor_id, command.created_at, command.updated_at,
           descriptor.session_id AS descriptor_session_id,
           descriptor.activity_id AS descriptor_activity_id,
           descriptor.turn_id AS descriptor_turn_id,
           descriptor.kind AS descriptor_kind,
           descriptor.payload AS descriptor_payload,
           descriptor.content_hash AS descriptor_content_hash,
           descriptor.created_at AS descriptor_created_at,
           attempt.state AS attempt_state,
           attempt.attempt_version,
           attempt.session_id AS attempt_session_id,
           attempt.activity_id AS attempt_activity_id,
           attempt.provider_turn_seq AS attempt_turn_seq,
           attempt.selection_id AS attempt_selection_id,
           attempt.projection_hash AS attempt_projection_hash,
           attempt.request_hash AS attempt_request_hash,
           attempt.provider_id AS attempt_provider_id,
           attempt.owner_token AS attempt_owner_token,
           attempt.execution_claim_token AS attempt_execution_claim_token,
           session.execution_claim_token AS current_session_claim_token,
           resolution.decision AS resolution_decision,
           bridge.command_id AS bridge_command_id
    FROM recovery_command command
    LEFT JOIN session_provider_recovery_descriptor descriptor
      ON descriptor.descriptor_id = command.descriptor_id
    LEFT JOIN session_provider_attempt attempt
      ON attempt.attempt_id = json_extract(command.attempt, '$.attemptId')
    LEFT JOIN session ON session.id = attempt.session_id
    LEFT JOIN session_provider_attempt_resolution resolution
      ON resolution.attempt_id = attempt.attempt_id
    LEFT JOIN session_v2_provider_recovery_bridge bridge
      ON bridge.attempt_id = attempt.attempt_id
     AND bridge.resolution_id = resolution.resolution_id
  `)
  commands.forEach((row) => accept(classifyRecoveryCommandItem(row)))

  const inputs = yield* db.all<CategoryRow & { delivery: string; promoted_seq: number | null }>(sql`
    SELECT id, delivery, promoted_seq,
           delivery || ':' || CASE WHEN promoted_seq IS NULL THEN 'pending' ELSE 'promoted' END AS state
    FROM session_input
  `)
  inputs.forEach((row) => accept(classifySessionInputItem(row)))

  const bindings = yield* db.all<ProviderBindingRow>(sql`
    SELECT receipt.receipt_id AS id, receipt.state,
           receipt.provider_attempt_id,
           receipt.session_id AS receipt_session_id,
           receipt.activity_id AS receipt_activity_id,
           receipt.provider_turn_seq AS receipt_turn_seq,
           receipt.request_input_hash AS receipt_request_hash,
           receipt.provider_id AS receipt_provider_id,
           receipt.owner_token AS receipt_owner_token,
           attempt.state AS attempt_state,
           attempt.session_id AS attempt_session_id,
           attempt.activity_id AS attempt_activity_id,
           attempt.provider_turn_seq AS attempt_turn_seq,
           attempt.request_hash AS attempt_request_hash,
           attempt.provider_id AS attempt_provider_id,
           attempt.owner_token AS attempt_owner_token,
           bridge.receipt_id AS bridge_receipt_id
    FROM session_v2_provider_turn_receipt receipt
    LEFT JOIN session_provider_attempt attempt
      ON attempt.attempt_id = receipt.provider_attempt_id
    LEFT JOIN session_v2_provider_recovery_bridge bridge
      ON bridge.attempt_id = attempt.attempt_id
     AND bridge.receipt_id = receipt.receipt_id
  `)
  bindings.forEach((row) => accept(classifyProviderBindingItem(row)))

  const outbox = yield* db.all<
    CategoryRow & {
      claim_token: string | null
      claimant_id: string | null
      lease_expires_at: number | null
      published_at: number | null
      registered_consumers: number
      assigned_consumers: number
    }
  >(sql`
    SELECT outbox.outbox_id AS id, outbox.status AS state,
           outbox.claim_token, outbox.claimant_id, outbox.lease_expires_at, outbox.published_at,
           (SELECT COUNT(*) FROM deepagent_event_consumer) AS registered_consumers,
           (SELECT COUNT(*) FROM deepagent_event_consumer_delivery delivery
              WHERE delivery.outbox_id = outbox.outbox_id) AS assigned_consumers
    FROM deepagent_event_outbox outbox
  `)
  outbox.forEach((row) => accept(classifyEventOutboxItem(row)))

  const deliveries = yield* db.all<
    CategoryRow & {
      claim_token: string | null
      claimant_id: string | null
      lease_expires_at: number | null
      resolved_at: number | null
    }
  >(sql`
    SELECT outbox_id || ':' || consumer_key AS id, status AS state,
           claim_token, claimant_id, lease_expires_at, resolved_at
    FROM deepagent_event_consumer_delivery
  `)
  deliveries.forEach((row) => accept(classifyEventDeliveryItem(row)))

  const projections = yield* db.all<
    CategoryRow & {
      cursor_rowid: number | null
      high_water_rowid: number | null
      completed_at: number | null
      backfill_complete: number | null
    }
  >(sql`
    SELECT 'authority:1' AS id, COALESCE(backfill.state, 'missing') AS state,
           backfill.cursor_rowid, backfill.high_water_rowid, backfill.completed_at,
           sequence.backfill_complete
    FROM (SELECT 1 AS id) authority
    LEFT JOIN event_sync_backfill backfill ON backfill.id = authority.id
    LEFT JOIN event_sync_sequence sequence ON sequence.id = authority.id
  `)
  projections.forEach((row) => accept(classifySyncProjectionItem(row)))

  const total = StartupCategories.reduce(
    (sum, category) => sum + InventoryClassifications.reduce((categorySum, classification) => categorySum + byCategory[category][classification], 0),
    0,
  )

  return { total, byCategory, unclassifiedItems, ready: gateReady({ unclassifiedItems }) } satisfies StartupInventory
})
