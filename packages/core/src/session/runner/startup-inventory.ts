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
//   work_execution   (work_execution source/profile/input binding)
//   work_dispatch    (work_dispatch_reservation escrow and exact provider binding)
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

import { eq, sql } from "drizzle-orm"
import { Effect, Option, Schema } from "effect"
import type { EffectDrizzleSqlite } from "@deepagent-code/effect-drizzle-sqlite"
import { decodeDescriptorRow } from "./recovery-durable-store"
import { decodeCommandRow } from "./recovery-durable-store"
import type { DescriptorDbRow, DescriptorRow } from "./recovery-durable-store"

import { EventTaskWorkspaceTable, SessionInputTable, SessionTable } from "../sql"
import { WorkAuthorityPolicy } from "../work-authority-policy"
import { WorkAuthoritySchema } from "../work-authority.schema"
import { WorkExecutionTable, WorkDispatchReservationTable } from "../work-authority.sql"
import { WorkChildAuthorityTable } from "../work-child-authority.sql"
import { WorkChildAuthoritySchema } from "../work-child-authority.schema"
import { V2ProviderTurnReceiptTable } from "./v2-provider-turn.sql"
import { SessionContextSelectionTable, SessionProviderAttemptTable } from "../../context-federation/session-sql"
import { Hash } from "../../util/hash"
import { CanonicalJson } from "../../util/canonical-json"
import { McpAppEffectTable, McpAppInvocationTable } from "../mcp-app-invocation.sql"
import { McpAppInvocationSchema } from "../mcp-app-invocation.schema"
import { EventWorkDagPolicy } from "../../deepagent/event-work-dag.policy"
import { EventWorkDagSchema } from "../../deepagent/event-work-dag.schema"
import { EventWorkRuleSchema } from "../../deepagent/event-work-rule.schema"
import { EventWorkControllerTable } from "../../deepagent/event-work-controller.sql"
import { EventWorkNodeAuthorityTable, EventWorkReceiptTable } from "../../deepagent/event-work-rule.sql"

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
  | "work_execution"
  | "work_dispatch"
  | "mcp_app"

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
  "work_execution",
  "work_dispatch",
  "mcp_app",
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
  readonly session_id: string
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
  readonly command_kind: string | null
  readonly evidence: string | null
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

type WorkInventoryRow = {
  work: typeof WorkExecutionTable.$inferSelect
  session: typeof SessionTable.$inferSelect | null
  input: typeof SessionInputTable.$inferSelect | null
  derived?: typeof WorkChildAuthorityTable.$inferSelect | null
  parent?: typeof WorkExecutionTable.$inferSelect
  event?: {
    authority: typeof EventWorkNodeAuthorityTable.$inferSelect
    controller?: typeof EventWorkControllerTable.$inferSelect
    receipt?: typeof EventWorkReceiptTable.$inferSelect
    workspace?: typeof EventTaskWorkspaceTable.$inferSelect
  }
  controller?: {
    record: typeof EventWorkControllerTable.$inferSelect
    receipt?: typeof EventWorkReceiptTable.$inferSelect
    authorities: readonly typeof EventWorkNodeAuthorityTable.$inferSelect[]
    children: readonly WorkInventoryRow[]
    providers: ReadonlyMap<string, number>
    dispatches: ReadonlyMap<string, readonly StartupInventoryItem[]>
  }
}

type WorkDispatchInventoryRow = WorkInventoryRow & {
  dispatch: typeof WorkDispatchReservationTable.$inferSelect
  receipt: typeof V2ProviderTurnReceiptTable.$inferSelect | null
  attempt: typeof SessionProviderAttemptTable.$inferSelect | null
  selection: typeof SessionContextSelectionTable.$inferSelect | null
}

function workBindingProblem(row: WorkInventoryRow): string | undefined {
  const validation = WorkAuthorityPolicy.validateBinding(row.work.binding, {
    allowLoopbackHTTP: row.work.loopback_http,
  })
  if (!validation.ok) return "work binding schema or frozen profile is invalid"
  const binding = validation.value
  if (row.work.parent_work_id !== null) {
    const problem = binding.profile.id === WorkAuthorityPolicy.EVENT_DAG_PROFILE.id
      ? eventBindingProblem(row) : derivedBindingProblem(row)
    if (problem) return problem
    if (binding.profile.id !== WorkAuthorityPolicy.EVENT_DAG_PROFILE.id && row.event)
      return "ordinary derived work mixes event and shared authority domains"
  }
  if (row.work.parent_work_id === null && row.event)
    return "event node authority cannot classify a root Work"
  if (
    WorkAuthorityPolicy.fingerprint(binding) !== row.work.binding_hash ||
    binding.workID !== row.work.work_id ||
    binding.rootWorkID !== row.work.root_work_id ||
    (row.work.parent_work_id === null ? binding.parentWorkID !== undefined : binding.parentWorkID !== row.work.parent_work_id) ||
    binding.sessionID !== row.work.session_id ||
    binding.inputID !== row.work.input_id ||
    binding.agentID !== row.work.agent_id ||
    binding.scope.securityNamespaceID !== row.work.security_namespace_id ||
    binding.source.kind !== row.work.source_kind ||
    binding.source.authorityID !== row.work.authority_id ||
    binding.source.authorityRevision !== row.work.source_revision ||
    binding.source.requestID !== row.work.source_request_id ||
    !Schema.is(WorkAuthoritySchema.Digest)(row.work.source_record_hash) ||
    row.work.route_evidence_hash !== binding.provider.evidenceHash ||
    !Number.isSafeInteger(row.work.control_revision) ||
    row.work.control_revision < 1 ||
    !Schema.is(WorkAuthoritySchema.AdmissionState)(row.work.admission_state) ||
    !Schema.is(WorkAuthoritySchema.ControlState)(row.work.control_state) ||
    !Schema.is(WorkAuthoritySchema.Outcome)(row.work.outcome)
  )
    return "work fingerprint, proof identity or durable state is inconsistent"
  if (
    row.session &&
    (!row.session.v2_authority ||
      row.session.agent !== binding.agentID ||
      row.session.directory !== binding.location.directory ||
      row.session.workspace_id !== (binding.location.workspaceID ?? null) ||
      row.session.model?.providerID !== binding.provider.providerID ||
      row.session.model.id !== binding.provider.modelID ||
      row.session.model.variant !== undefined)
  )
    return "work Session placement, Agent or model differs from its binding"
  if (row.work.admission_state !== "ready")
    return row.input || row.work.admitted_seq !== null
      ? "non-ready work has a committed input without its atomic ready binding"
      : undefined
  if (
    !row.session ||
    !row.input ||
    row.input.session_id !== row.work.session_id ||
    row.input.admitted_seq !== row.work.admitted_seq ||
    row.input.delivery !== "queue" ||
    !row.input.prompt ||
    typeof row.input.prompt.text !== "string" ||
    Hash.sha256(row.input.prompt.text) !== binding.auditedText.hash ||
    Buffer.byteLength(row.input.prompt.text, "utf8") !== binding.auditedText.utf8Bytes ||
    Object.keys(row.input.prompt).some((key) => !["text", "agent", "model"].includes(key)) ||
    (row.input.prompt.agent !== undefined && row.input.prompt.agent !== binding.agentID) ||
    (row.input.prompt.model !== undefined &&
      (row.input.prompt.model.providerID !== binding.provider.providerID ||
        row.input.prompt.model.id !== binding.provider.modelID ||
        row.input.prompt.model.variant !== undefined))
  )
    return "ready work lacks its exact restricted Session and queue input"
}

/** Startup reads historical lineage only. It neither renews a child deadline nor turns
 * a grant/proof record into permission to claim or wake the original task. */
function derivedBindingProblem(row: WorkInventoryRow): string | undefined {
  const decoded = row.derived && Schema.decodeUnknownOption(WorkChildAuthoritySchema.Record, { onExcessProperty: "error" })(row.derived.record)
  if (!row.derived || !row.parent || !decoded || Option.isNone(decoded)) return "derived work lacks its exact durable parent grant"
  const grant = decoded.value
  const parent = row.parent
  const hash = (value: unknown) => Hash.sha256(CanonicalJson.stringify(value))
  if (hash(grant)!==row.derived.record_hash || row.derived.child_work_id!==grant.childWorkID || row.derived.root_work_id!==grant.rootWorkID ||
    row.derived.parent_work_id!==grant.parentWorkID || row.derived.task_run_id!==grant.taskRunID || row.derived.admission_id!==grant.admissionID ||
    row.derived.child_session_id!==grant.childSessionID || row.derived.child_input_id!==grant.childInputID ||
    row.derived.child_binding_hash!==grant.childBindingHash || row.derived.parent_binding_hash!==grant.parentBindingHash ||
    row.derived.root_binding_hash!==grant.rootBindingHash || row.derived.parent_revision!==grant.parentRevision ||
    row.derived.root_revision!==grant.rootRevision || row.derived.expires_at!==grant.expiresAt || row.derived.created_at!==grant.createdAt ||
    grant.childWorkID!==row.work.work_id || grant.childSessionID!==row.work.session_id || grant.childInputID!==row.work.input_id ||
    grant.childBindingHash!==row.work.binding_hash || grant.parentWorkID!==parent.work_id || grant.rootWorkID!==parent.root_work_id ||
    parent.work_id!==parent.root_work_id || parent.parent_work_id!==null || grant.parentSessionID!==parent.session_id ||
    grant.parentBindingHash!==parent.binding_hash || grant.rootBindingHash!==parent.binding_hash ||
    hash(grant.parentBinding)!==parent.binding_hash || hash(grant.rootBinding)!==parent.binding_hash ||
    grant.parentRevision<1 || grant.rootRevision<1 || grant.parentRevision>parent.control_revision || grant.rootRevision>parent.control_revision ||
    row.work.root_work_id!==parent.root_work_id || row.work.parent_work_id!==parent.work_id ||
    row.work.source_record_hash!==parent.source_record_hash || row.work.route_evidence_hash!==parent.route_evidence_hash ||
    row.work.binding.schemaVersion!=="work-execution.v2" || parent.binding.schemaVersion!=="work-execution.v2" ||
    parent.binding.profile.id!==WorkAuthorityPolicy.SHARED_ROOT_PROFILE.id || row.work.binding.childPolicy!=="deny_all" ||
    row.work.binding.budget.maxChildren!==0 || row.work.binding.location.directory!==parent.binding.location.directory ||
    row.work.binding.location.workspaceID!==parent.binding.location.workspaceID ||
    !WorkAuthorityPolicy.validateBinding(parent.binding,{allowLoopbackHTTP:parent.loopback_http}).ok ||
    !WorkAuthorityPolicy.checkChild(parent.binding,row.work.binding).ok)
    return "derived work lineage, immutable binding or depth-one scope is inconsistent"
}

/** Durable lineage classification is not a live permission, placement witness or dispatch
 * permit. Historical revisions may precede current control; no deadline is renewed and no
 * Native/configuration producer or Session wake is invoked by this read-only inventory. */
function eventBindingProblem(row: WorkInventoryRow): string | undefined {
  const facts = row.event
  if (row.derived || !row.parent || !facts?.controller || !facts.receipt)
    return "event node lacks its separate durable lineage or mixes shared authority"
  const hash = EventWorkDagPolicy.hash
  const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(EventWorkDagSchema.Authority), { onExcessProperty: "error" })(facts.authority.record)
  const controllerDecoded = Schema.decodeUnknownOption(Schema.fromJsonString(EventWorkDagSchema.Controller), { onExcessProperty: "error" })(facts.controller.record)
  const receiptDecoded = Schema.decodeUnknownOption(Schema.fromJsonString(EventWorkRuleSchema.Receipt), { onExcessProperty: "error" })(facts.receipt.record)
  if (Option.isNone(decoded) || Option.isNone(controllerDecoded) || Option.isNone(receiptDecoded))
    return "event lineage has an invalid exact record schema"
  const authority = decoded.value
  const controller = controllerDecoded.value
  const receipt = receiptDecoded.value
  const root = row.parent
  const child = row.work
  const ids = EventWorkDagPolicy.identities(authority.receiptID, authority.nodeID)
  if (!("authorityID" in ids) || hash(authority) !== facts.authority.record_hash ||
    Buffer.byteLength(facts.authority.record, "utf8") !== facts.authority.record_bytes ||
    authority.authorityID !== facts.authority.authority_id || authority.childWorkID !== facts.authority.work_id ||
    authority.receiptID !== facts.authority.receipt_id || authority.nodeID !== facts.authority.node_id ||
    authority.authorityID !== ids.authorityID || authority.childWorkID !== ids.workID ||
    authority.childSessionID !== ids.sessionID || authority.childInputID !== ids.inputID ||
    !["pending", "bound", "terminal"].includes(facts.authority.state) ||
    (facts.authority.state === "terminal") !== (authority.terminal !== undefined) ||
    hash(authority.rootBinding) !== authority.rootBindingHash || hash(authority.childBinding) !== authority.childBindingHash ||
    hash(controller) !== facts.controller.record_hash || Buffer.byteLength(facts.controller.record, "utf8") !== facts.controller.record_bytes ||
    controller.controllerID !== facts.controller.controller_id || controller.receiptID !== facts.controller.receipt_id ||
    controller.rootWorkID !== facts.controller.root_work_id || controller.revision !== facts.controller.revision ||
    controller.state !== facts.controller.state || hash(controller.plan) !== controller.planHash ||
    EventWorkDagPolicy.identities(controller.receiptID).controllerID !== controller.controllerID)
    return "event authority/controller stable identity, hash or mirrors differ"
  const occurrence = hash(["event-work-occurrence.v1", receipt.ruleID, receipt.source.sessionID, receipt.source.activityID, receipt.source.activityOrdinal])
  if (hash(receipt) !== facts.receipt.record_hash || Buffer.byteLength(facts.receipt.record, "utf8") !== facts.receipt.record_bytes ||
    receipt.receiptID !== facts.receipt.receipt_id || receipt.ruleID !== facts.receipt.rule_id || receipt.instanceID !== facts.receipt.instance_id ||
    receipt.occurrenceKey !== facts.receipt.occurrence_key || receipt.eventID !== facts.receipt.event_id ||
    receipt.workID !== facts.receipt.work_id || receipt.sessionID !== facts.receipt.session_id || receipt.inputID !== facts.receipt.input_id ||
    receipt.occurrenceKey !== occurrence || receipt.receiptID !== `evwork_${occurrence}` || receipt.eventID !== `dae_evwork_${occurrence}` ||
    receipt.workID !== `work_ev_${occurrence.slice(0, 40)}` || receipt.sessionID !== `ses_ev_${occurrence.slice(0, 40)}` ||
    receipt.inputID !== `msg_ev_${occurrence.slice(0, 40)}` || receipt.sourceHash !== hash(receipt.source) ||
    receipt.auditedTextHash !== Hash.sha256(receipt.auditedText) ||
    receipt.authorityHash !== hash(Object.fromEntries(Object.entries(receipt).filter(([key]) => key !== "authorityHash"))) ||
    facts.receipt.phase !== "ready" || facts.receipt.binding_hash !== root.binding_hash)
    return "event receipt identity, source or original binding differs"
  const node = controller.plan.nodes.find((value) => value.id === authority.nodeID)
  if (!node || root.parent_work_id !== null || root.work_id !== root.root_work_id || root.execution_role !== "dag_controller" ||
    root.binding.schemaVersion !== "work-execution.v2" || child.binding.schemaVersion !== "work-execution.v2" ||
    !EventWorkDagPolicy.profileMatches(root.binding.profile) || !EventWorkDagPolicy.profileMatches(child.binding.profile) ||
    !WorkAuthorityPolicy.validateBinding(root.binding, { allowLoopbackHTTP: root.loopback_http }).ok ||
    !EventWorkDagPolicy.validatePlan(controller.plan, root.binding).ok || hash(root.binding) !== root.binding_hash ||
    controller.rootWorkID !== root.work_id || controller.rootSessionID !== root.session_id || controller.rootInputID !== root.input_id ||
    controller.rootBindingHash !== root.binding_hash || controller.receiptID !== receipt.receiptID || controller.ruleHash !== receipt.ruleHash ||
    controller.epoch !== receipt.epoch || controller.createdAt !== receipt.createdAt || controller.expiresAt !== receipt.deadline ||
    receipt.workID !== root.work_id || receipt.sessionID !== root.session_id || receipt.inputID !== root.input_id ||
    root.source_record_hash !== receipt.authorityHash || root.binding.source.authorityID !== receipt.receiptID ||
    root.binding.source.authorityRevision !== receipt.epoch || root.binding.source.requestID !== occurrence ||
    root.binding.source.requestHash !== receipt.authorityHash || root.binding.auditedText.hash !== receipt.auditedTextHash ||
    root.binding.deadline !== receipt.deadline || authority.controllerID !== controller.controllerID ||
    authority.receiptID !== receipt.receiptID || authority.planHash !== controller.planHash ||
    authority.rootWorkID !== root.work_id || authority.parentWorkID !== root.work_id || authority.rootSessionID !== root.session_id ||
    authority.parentSessionID !== root.session_id || authority.rootBindingHash !== root.binding_hash ||
    authority.rootRevision > root.control_revision || authority.createdAt < controller.createdAt || authority.expiresAt !== root.binding.deadline ||
    authority.childWorkID !== child.work_id || authority.childSessionID !== child.session_id || authority.childInputID !== child.input_id ||
    authority.childBindingHash !== child.binding_hash || child.parent_work_id !== root.work_id || child.root_work_id !== root.work_id ||
    child.execution_role !== "agent" || child.source_record_hash !== root.source_record_hash || child.route_evidence_hash !== root.route_evidence_hash ||
    node.agentID !== child.agent_id || hash(node.budget) !== hash(child.binding.budget) ||
    Hash.sha256(authority.inputText) !== child.binding.auditedText.hash || Buffer.byteLength(authority.inputText, "utf8") !== child.binding.auditedText.utf8Bytes ||
    child.binding.source.requestID !== ids.requestID || child.binding.source.requestHash !== hash([controller.planHash, node.id, child.binding.auditedText.hash]) ||
    hash(child.binding.toolPolicy.capabilities) !== hash(root.binding.toolPolicy.capabilities.filter((capability) => node.toolIDs.includes(capability.toolID))) ||
    authority.predecessorRefs.length !== node.dependencies.length || authority.predecessorRefs.some((terminal, index) =>
      terminal.nodeID !== node.dependencies[index] || terminal.controllerID !== controller.controllerID || terminal.outcome !== "succeeded") ||
    EventWorkDagPolicy.requiresPlacement(controller.plan, node) !== (authority.placement !== undefined))
    return "event root, child, approved node or shared ceiling is inconsistent"
  const placement = authority.placement
  if (placement) {
    const workspace = facts.workspace
    if (!workspace || workspace.generation !== 0 || placement.controllerID !== controller.controllerID ||
      placement.receiptID !== receipt.receiptID || placement.eventID !== receipt.eventID || placement.nodeID !== node.id ||
      placement.rootWorkID !== root.work_id || placement.rootBindingHash !== root.binding_hash || placement.planHash !== controller.planHash ||
      placement.rootRevision !== authority.rootRevision || placement.controllerRevision > controller.revision ||
      placement.childWorkID !== child.work_id || placement.childSessionID !== child.session_id || placement.childInputID !== child.input_id ||
      placement.workspace.repositoryRoot !== root.binding.projectScope.canonicalRoot ||
      hash(placement.parentRootIdentity) !== hash(root.binding.projectScope.rootIdentity) ||
      placement.helperHash !== root.binding.projectScope.helperHash || placement.projectID !== root.binding.projectScope.projectID ||
      placement.expiresAt !== authority.expiresAt || workspace.event_id !== receipt.eventID || workspace.task_id !== node.id ||
      workspace.operation_key !== placement.workspace.operationKey || workspace.repository_root !== placement.workspace.repositoryRoot ||
      workspace.base_commit !== placement.workspace.baseCommit || workspace.branch !== placement.workspace.branch ||
      workspace.directory !== placement.workspace.directory || !["ready", "retained", "reclaimed"].includes(workspace.state) ||
      hash({ eventID: workspace.event_id, nodeID: workspace.task_id, generation: workspace.generation, operationKey: workspace.operation_key,
        repositoryRoot: workspace.repository_root, baseCommit: workspace.base_commit, branch: workspace.branch,
        directory: workspace.directory, createdAt: workspace.time_created }) !== placement.workspace.immutableRowHash)
      return "event placement differs from its immutable workspace custody"
  }
  if (!WorkAuthorityPolicy.checkChild(root.binding, child.binding, placement ? { eventPlacement: placement } : undefined).ok)
    return "event child exceeds the original placement, scope or budget ceiling"
}

function classifyWorkDispatchItem(row: WorkDispatchInventoryRow): StartupInventoryItem {
  const item = (classification: InventoryClassification, reason: string): StartupInventoryItem => ({
    category: "work_dispatch",
    id: row.dispatch.reservation_id,
    state: row.dispatch.state,
    classification,
    reason,
  })
  const problem = workBindingProblem(row)
  if (problem) return item("unclassified", problem)
  const dispatch = row.dispatch
  const binding = row.work.binding
  if (
    dispatch.reservation_id !== `wdr_${Hash.sha256(CanonicalJson.stringify([dispatch.work_id, dispatch.dispatch_key]))}` ||
    dispatch.request_hash !==
      Hash.sha256(CanonicalJson.stringify({
        workID: dispatch.work_id,
        dispatchKey: dispatch.dispatch_key,
        receiptID: dispatch.receipt_id,
        attemptID: dispatch.attempt_id,
        sessionClaimToken: dispatch.session_claim_token,
        ownerToken: dispatch.owner_token,
        contextSelectionID: dispatch.context_selection_id,
        contextProjectionHash: dispatch.context_projection_hash,
        inputUpperBound: dispatch.input_bound,
        completionTokens: dispatch.reserved_completion_tokens,
        expectedRevision: dispatch.control_revision,
      }))
  )
    return item("unclassified", "dispatch stable identity or admitted request fingerprint differs")
  if (
    row.work.admission_state !== "ready" ||
    dispatch.root_work_id !== row.work.root_work_id ||
    dispatch.kind !== "provider" ||
    dispatch.control_revision > row.work.control_revision ||
    !Schema.is(WorkAuthoritySchema.InputBound)(dispatch.input_bound) ||
    dispatch.reserved_input_tokens !== dispatch.input_bound.tokens ||
    dispatch.reserved_total_tokens !== dispatch.reserved_input_tokens + dispatch.reserved_completion_tokens ||
    !WorkAuthorityPolicy.providerReservation(binding.budget, dispatch.input_bound, dispatch.reserved_completion_tokens)
      .ok ||
    !Schema.is(WorkAuthoritySchema.DispatchState)(dispatch.state)
  )
    return item("unclassified", "dispatch identity, escrow or control revision is inconsistent")
  if (
    !row.receipt ||
    !row.attempt ||
    !row.selection ||
    !row.session ||
    row.receipt.session_id !== row.work.session_id ||
    row.receipt.user_message_id !== row.work.input_id ||
    row.receipt.provider_attempt_id !== dispatch.attempt_id ||
    row.receipt.owner_token !== dispatch.owner_token ||
    row.receipt.provider_id !== binding.provider.providerID ||
    row.receipt.model_id !== binding.provider.modelID ||
    row.receipt.protocol !== binding.provider.protocol ||
    row.attempt.session_id !== row.work.session_id ||
    row.attempt.activity_id !== row.receipt.activity_id ||
    row.attempt.provider_turn_seq !== row.receipt.provider_turn_seq ||
    row.attempt.request_hash !== row.receipt.request_input_hash ||
    row.attempt.owner_token !== dispatch.owner_token ||
    row.attempt.provider_id !== binding.provider.providerID ||
    row.attempt.execution_claim_token !== dispatch.session_claim_token ||
    dispatch.session_claim_token <= 0 ||
    row.attempt.selection_id !== dispatch.context_selection_id ||
    row.attempt.projection_hash !== dispatch.context_projection_hash ||
    row.selection.session_id !== row.work.session_id ||
    row.selection.activity_id !== row.receipt.activity_id ||
    row.selection.trigger_input_id !== row.work.input_id ||
    row.selection.projection_hash !== dispatch.context_projection_hash ||
    row.selection.security_namespace_id !== binding.scope.securityNamespaceID ||
    row.selection.project_scope_key !== binding.scope.projectScopeKey
  )
    return item("unclassified", "dispatch lacks exact Session/input/Context/provider receipt and attempt identities")
  if (["reserved", "released"].includes(dispatch.state)) {
    if (
      dispatch.wire_hash !== null ||
      dispatch.endpoint !== null ||
      dispatch.dispatching_at !== null ||
      row.receipt.dispatching_at !== null ||
      !(
        (row.receipt.state === "preparing" && row.attempt.state === "prepared") ||
        (row.receipt.state === "failed" && row.attempt.state === "failed")
      )
    )
      return item("unclassified", "predispatch escrow conflicts with physical dispatch evidence")
    if (
      dispatch.charged_tokens !== (dispatch.state === "released" ? 0 : dispatch.reserved_total_tokens) ||
      dispatch.actual_usage !== null
    )
      return item("unclassified", "predispatch escrow has unexplained charge or usage")
    return item(
      dispatch.state === "released" ? "resolved" : "safe_before_dispatch",
      "physical permit was never issued; classification does not release or requeue work",
    )
  }
  if (
    !Schema.is(WorkAuthoritySchema.Digest)(dispatch.wire_hash) ||
    dispatch.endpoint !== binding.provider.endpoint ||
    dispatch.dispatching_at === null ||
    row.receipt.wire_request_hash !== dispatch.wire_hash ||
    row.attempt.wire_request_hash !== dispatch.wire_hash ||
    row.receipt.dispatching_at === null ||
    row.receipt.prepared_turn_hash === null ||
    row.receipt.prepared_turn_hash !== row.attempt.prepared_turn_hash ||
    !["dispatching", "streaming", "settled", "failed", "indeterminate_after_crash"].includes(row.receipt.state) ||
    row.receipt.state !== row.attempt.state
  )
    return item("unclassified", "issued work permit has no matching sealed provider state pair")
  if (dispatch.state === "settled") {
    const usage = dispatch.actual_usage && WorkAuthorityPolicy.usageTotal(dispatch.actual_usage)
    if (
      !["settled", "failed"].includes(row.receipt.state) ||
      row.receipt.outcome_hash === null ||
      row.receipt.terminal_at === null ||
      dispatch.settled_at === null ||
      !usage ||
      !usage.ok ||
      usage.value !== dispatch.charged_tokens ||
      dispatch.actual_usage!.inputTokens > dispatch.reserved_input_tokens ||
      dispatch.actual_usage!.completionTokens > dispatch.reserved_completion_tokens
    )
      return item("unclassified", "settled work lacks exact terminal provider and non-overlapping usage evidence")
    return item("resolved", "work and provider receipt have matching terminal evidence")
  }
  const unknownUsage = dispatch.actual_usage ? WorkAuthorityPolicy.usageTotal(dispatch.actual_usage) : undefined
  if (
    (unknownUsage && (!unknownUsage.ok || dispatch.charged_tokens < unknownUsage.value)) ||
    dispatch.charged_tokens < dispatch.reserved_total_tokens ||
    dispatch.settled_at !== null
  )
    return item("unclassified", "unsettled dispatch has lost its escrow or invented settlement")
  return item("recovery", "physical permit was issued; escrow remains held and explicit recovery is required")
}

function classifyWorkItem(row: WorkInventoryRow, dispatches: readonly StartupInventoryItem[]): StartupInventoryItem {
  const item = (classification: InventoryClassification, reason: string): StartupInventoryItem => ({
    category: "work_execution",
    id: row.work.work_id,
    state: `${row.work.admission_state}:${row.work.control_state}:${row.work.outcome}`,
    classification,
    reason,
  })
  const problem = workBindingProblem(row)
  if (problem) return item("unclassified", problem)
  if (row.work.execution_role === "dag_controller" && (row.work.outcome === "succeeded" || row.work.outcome === "failed")) {
    const problem = terminalControllerProblem(row, dispatches)
    return problem ? item("unclassified", problem) : item("resolved", "event controller has original known node terminals and never executes a provider")
  }
  if (dispatches.filter((entry) => entry.state !== "released").length > row.work.binding.budget.maxProviderDispatches)
    return item("unclassified", "work has more physical reservations than its frozen dispatch ceiling")
  if (dispatches.some((entry) => entry.classification === "unclassified"))
    return item("unclassified", "work has an unverifiable dispatch reservation")
  if (dispatches.some((entry) => entry.classification === "recovery"))
    return item("recovery", "work has an issued unsettled permit; no automatic provider replay")
  if (
    row.work.outcome === "unknown" ||
    ((row.work.outcome === "succeeded" || row.work.outcome === "failed") &&
      !dispatches.some((entry) => entry.state === "settled"))
  )
    return item("unclassified", "work outcome has no matching durable dispatch evidence")
  if (
    row.work.admission_state === "rejected" ||
    ["revoked", "cancelled", "expired"].includes(row.work.control_state)
  )
    return item("resolved", "work is terminal; classification performs no execution or budget release")
  if (dispatches.some((entry) => entry.state === "settled"))
    return row.work.outcome === "pending"
      ? item("recovery", "physical dispatch is settled but result authority is pending; never replay provider work")
      : item("resolved", "work has terminal result authority and a settled physical dispatch")
  if (row.work.parent_work_id !== null)
    return item("recovery", "derived child requires its original opaque Task owner; startup never requeues or revives it")
  return item(
    "safe_before_dispatch",
    "work has no issued physical permit; fresh authority validation is required before any continuation",
  )
}

/** A controller's terminal evidence is its original node graph, never an invented provider
 * dispatch. This historical classification grants no current source, wake or custody release. */
function terminalControllerProblem(row: WorkInventoryRow, dispatches: readonly StartupInventoryItem[]): string | undefined {
  const facts = row.controller
  if (!facts?.receipt || row.derived || row.event || row.work.parent_work_id !== null || row.work.work_id !== row.work.root_work_id ||
    row.work.binding.schemaVersion !== "work-execution.v2" || !EventWorkDagPolicy.profileMatches(row.work.binding.profile) ||
    dispatches.length !== 0 || (facts.providers.get(row.work.session_id) ?? 0) !== 0)
    return "event controller lacks its distinct original graph or has provider/dispatch authority"
  const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(EventWorkDagSchema.Controller), { onExcessProperty: "error" })(facts.record.record)
  if (Option.isNone(decoded)) return "event controller has an invalid exact record schema"
  const controller = decoded.value
  const hash = EventWorkDagPolicy.hash
  if (hash(controller) !== facts.record.record_hash || Buffer.byteLength(facts.record.record, "utf8") !== facts.record.record_bytes ||
    controller.controllerID !== facts.record.controller_id || controller.receiptID !== facts.record.receipt_id ||
    controller.rootWorkID !== facts.record.root_work_id || controller.state !== facts.record.state || controller.revision !== facts.record.revision ||
    EventWorkDagPolicy.identities(controller.receiptID).controllerID !== controller.controllerID ||
    controller.rootWorkID !== row.work.work_id || controller.rootSessionID !== row.work.session_id || controller.rootInputID !== row.work.input_id ||
    controller.rootBindingHash !== row.work.binding_hash || hash(controller.plan) !== controller.planHash ||
    !EventWorkDagPolicy.validatePlan(controller.plan, row.work.binding).ok || controller.state !== row.work.outcome || controller.activeNodeID !== null ||
    facts.receipt.receipt_id !== controller.receiptID || facts.receipt.work_id !== row.work.work_id ||
    facts.authorities.length !== facts.children.length || facts.children.length === 0 ||
    facts.children.some((child) => child.event?.authority.receipt_id !== controller.receiptID ||
      child.event.controller?.record_hash !== facts.record.record_hash || child.event.receipt?.record_hash !== facts.receipt!.record_hash ||
      !controller.plan.nodes.some((node) => node.id === child.event!.authority.node_id)))
    return "event controller terminal graph, stable mirrors or original children are inconsistent"
  const baseline = controller.baseline
  if (baseline && (baseline.sourceHash !== row.work.source_record_hash || baseline.scopeHash !== hash(row.work.binding.toolPolicy.fileScope) ||
    hash(baseline.rootIdentity) !== hash(row.work.binding.projectScope.rootIdentity) ||
    !controller.plan.nodes.some((node) => node.id === baseline.nodeID) || baseline.startedAt < controller.createdAt ||
    (baseline.gitDirectory === undefined) !== (baseline.gitRootIdentity === undefined) || baseline.state !== "sealed" ||
    baseline.sealedAt < baseline.startedAt || baseline.settledRetentionAt !== undefined && baseline.settledRetentionAt < baseline.sealedAt) ||
    controller.plan.nodes.some((node) => EventWorkDagPolicy.requiresPlacement(controller.plan, node)) && (!baseline || baseline.state !== "sealed"))
    return "event controller terminal baseline differs from original scope and immutable custody"
  const terminals = new Map<string, EventWorkDagSchema.Terminal>()
  const records = new Map<string, EventWorkDagSchema.Authority>()
  for (const child of facts.children) {
    const problem = workBindingProblem(child)
    if (problem) return problem
    const authority = Schema.decodeUnknownOption(Schema.fromJsonString(EventWorkDagSchema.Authority), { onExcessProperty: "error" })(child.event!.authority.record)
    if (Option.isNone(authority)) return "event controller child has an invalid original authority"
    records.set(authority.value.nodeID, authority.value)
    const terminal = authority.value.terminal
    if (!terminal) {
      if (controller.state !== "failed" || child.event!.authority.state !== "pending" || child.work.admission_state === "ready" ||
        child.work.outcome !== "pending" || (facts.providers.get(child.work.session_id) ?? 0) !== 0 ||
        (facts.dispatches.get(child.work.work_id)?.length ?? 0) !== 0)
        return "event controller terminal has an admitted or physically issued child without a known result"
      continue
    }
    if (terminal.controllerID !== controller.controllerID || terminal.nodeID !== authority.value.nodeID ||
      terminal.workID !== child.work.work_id || terminal.sessionID !== child.work.session_id || terminal.inputID !== child.work.input_id ||
      terminal.bindingHash !== child.work.binding_hash || terminal.sourceHash !== row.work.source_record_hash || terminal.outcome !== child.work.outcome ||
      terminal.controlRevision > child.work.control_revision || terminal.settledAt < authority.value.createdAt ||
      terminal.chargedTokens > child.work.binding.budget.maxTotalTokens || terminals.has(terminal.nodeID) ||
      authority.value.placement && (!authority.value.artifactCustody || terminal.workspaceCommit !== authority.value.artifactCustody.commit ||
        terminal.workspaceRef !== authority.value.artifactCustody.commit || child.event!.workspace?.error !== null ||
        child.event!.workspace.continuation_ref !== terminal.workspaceRef ||
        child.event!.workspace.state !== "retained" && !(child.event!.workspace.state === "reclaimed" && authority.value.artifactCustody.cleanup?.state === "collected")))
      return "event controller child terminal differs from original Work or sealed artifact"
    terminals.set(terminal.nodeID, terminal)
  }
  if (controller.state === "succeeded" && (terminals.size !== controller.plan.nodes.length || [...terminals.values()].some((value) => value.outcome !== "succeeded")) ||
    controller.state === "failed" && ![...terminals.values()].some((value) => value.outcome === "failed"))
    return "event controller outcome has no complete success graph or original failed node"
  if ([...records.values()].some((authority) => authority.predecessorRefs.some((terminal) =>
    hash(terminal) !== hash(terminals.get(terminal.nodeID)))))
    return "event controller predecessor references differ from their original known terminals"
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
    work_execution: emptyCounts(),
    work_dispatch: emptyCounts(),
    mcp_app: emptyCounts(),
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
    SELECT attempt.attempt_id AS id, attempt.session_id, attempt.state, attempt.execution_claim_token,
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
           command.actor_id, command.command_kind, command.evidence,
           command.created_at, command.updated_at,
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

  // These tables are required after the current migration; never silently skip a missing
  // durable surface. Read-only inventory does not renew proofs, refund escrow or wake work.
  const workRows = yield* db.select().from(WorkExecutionTable).all()
  const dispatchRows = yield* db.select().from(WorkDispatchReservationTable).all()
  if (workRows.length > 0 || dispatchRows.length > 0) {
    const parents = new Map(workRows.map((row) => [row.work_id,row]))
    const eventAuthorities = yield* db.select().from(EventWorkNodeAuthorityTable).all()
    const eventControllers = new Map((yield* db.select().from(EventWorkControllerTable).all()).map((row) => [row.controller_id, row]))
    const eventReceipts = new Map((yield* db.select().from(EventWorkReceiptTable).all()).map((row) => [row.receipt_id, row]))
    const eventWorkspaces = new Map((yield* db.select().from(EventTaskWorkspaceTable).all()).filter((row) => row.generation === 0)
      .map((row) => [CanonicalJson.stringify([row.event_id, row.task_id]), row]))
    const events = new Map(eventAuthorities.map((authority) => {
      const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(EventWorkDagSchema.Authority), { onExcessProperty: "error" })(authority.record)
      const record = Option.getOrUndefined(decoded)
      const receipt = eventReceipts.get(authority.receipt_id)
      return [authority.work_id, { authority, controller: record ? eventControllers.get(record.controllerID) : undefined, receipt,
        workspace: receipt ? eventWorkspaces.get(CanonicalJson.stringify([receipt.event_id, authority.node_id])) : undefined }] as const
    }))
    const works = yield* db.select({ work: WorkExecutionTable, session: SessionTable, input: SessionInputTable, derived: WorkChildAuthorityTable })
      .from(WorkExecutionTable).leftJoin(SessionTable, eq(SessionTable.id, WorkExecutionTable.session_id))
      .leftJoin(WorkChildAuthorityTable,eq(WorkChildAuthorityTable.child_work_id,WorkExecutionTable.work_id))
      .leftJoin(SessionInputTable, eq(SessionInputTable.id, WorkExecutionTable.input_id)).all()
    const dispatches = yield* db.select({ dispatch: WorkDispatchReservationTable, work: WorkExecutionTable, session: SessionTable, input: SessionInputTable, derived: WorkChildAuthorityTable,
      receipt: V2ProviderTurnReceiptTable, attempt: SessionProviderAttemptTable, selection: SessionContextSelectionTable })
      .from(WorkDispatchReservationTable).leftJoin(WorkExecutionTable, eq(WorkExecutionTable.work_id, WorkDispatchReservationTable.work_id))
      .leftJoin(WorkChildAuthorityTable,eq(WorkChildAuthorityTable.child_work_id,WorkExecutionTable.work_id))
      .leftJoin(SessionTable, eq(SessionTable.id, WorkExecutionTable.session_id)).leftJoin(SessionInputTable, eq(SessionInputTable.id, WorkExecutionTable.input_id))
      .leftJoin(V2ProviderTurnReceiptTable, eq(V2ProviderTurnReceiptTable.receipt_id, WorkDispatchReservationTable.receipt_id))
      .leftJoin(SessionProviderAttemptTable, eq(SessionProviderAttemptTable.attempt_id, WorkDispatchReservationTable.attempt_id))
      .leftJoin(SessionContextSelectionTable, eq(SessionContextSelectionTable.selection_id, WorkDispatchReservationTable.context_selection_id)).all()
    const byWork = new Map<string, StartupInventoryItem[]>()
    for (const row of dispatches) {
      const item = row.work ? classifyWorkDispatchItem({ ...row, event: events.get(row.work.work_id), work: row.work, parent: row.work.parent_work_id ? parents.get(row.work.parent_work_id) : undefined }) : { category: "work_dispatch" as const, id: row.dispatch.reservation_id, state: row.dispatch.state, classification: "unclassified" as const, reason: "dispatch has no durable Work authority" }
      accept(item)
      byWork.set(row.dispatch.work_id, [...(byWork.get(row.dispatch.work_id) ?? []), item])
    }
    const workContexts: WorkInventoryRow[] = works.map((row) => ({ ...row, event: events.get(row.work.work_id),
      parent: row.work.parent_work_id ? parents.get(row.work.parent_work_id) : undefined }))
    const children = new Map<string, WorkInventoryRow[]>()
    workContexts.forEach((row) => { if (row.work.parent_work_id) children.set(row.work.parent_work_id,
      [...children.get(row.work.parent_work_id) ?? [], row]) })
    const authorities = new Map<string, typeof eventAuthorities>()
    eventAuthorities.forEach((row) => authorities.set(row.receipt_id, [...authorities.get(row.receipt_id) ?? [], row]))
    const controllers = new Map([...eventControllers.values()].map((row) => [row.root_work_id, row]))
    const providers = new Map<string, number>()
    attempts.forEach((row) => providers.set(row.session_id, (providers.get(row.session_id) ?? 0) + 1))
    bindings.forEach((row) => providers.set(row.receipt_session_id, (providers.get(row.receipt_session_id) ?? 0) + 1))
    workContexts.forEach((row) => {
      const controller = controllers.get(row.work.work_id)
      accept(classifyWorkItem({ ...row, ...(controller ? { controller: { record: controller,
        receipt: eventReceipts.get(controller.receipt_id), authorities: authorities.get(controller.receipt_id) ?? [],
        children: children.get(row.work.work_id) ?? [], providers, dispatches: byWork } } : {}) }, byWork.get(row.work.work_id) ?? []))
    })
  }

  // External App effects have their own admission/source ledger, not provider/tool receipts.
  // Cold views are never reconstructed; safe-before-dispatch is a fact, not automatic replay.
  const apps = yield* db.select({ invocation: McpAppInvocationTable, effect: McpAppEffectTable }).from(McpAppInvocationTable)
    .leftJoin(McpAppEffectTable, eq(McpAppEffectTable.invocation_id, McpAppInvocationTable.invocation_id)).all()
  for (const row of apps) {
    const valid = row.effect !== null && Schema.is(McpAppInvocationSchema.Source)(row.invocation.source) &&
      Hash.sha256(CanonicalJson.stringify(row.invocation.source)) === row.invocation.source_hash &&
      row.invocation.source.sessionID === row.invocation.session_id && row.invocation.source.viewID === row.invocation.view_id
    const state = row.effect?.state ?? "missing"
    const classification = !valid ? "unclassified" : state === "queued" || state === "awaiting_permission" ? "safe_before_dispatch"
      : state === "dispatching" || state === "unknown" ? "recovery" : state === "settled" || state === "failed" || state === "cancelled_before_dispatch" ? "resolved" : "unclassified"
    accept({ category: "mcp_app", id: row.invocation.invocation_id, state, classification,
      reason: !valid ? "App effect/source identity is invalid" : classification === "safe_before_dispatch" ? "App admitted before dispatch; original live view required"
        : classification === "recovery" ? "App dispatch may have reached the original server; never replay" : "App terminal receipt retained" })
  }

  const total = StartupCategories.reduce(
    (sum, category) => sum + InventoryClassifications.reduce((categorySum, classification) => categorySum + byCategory[category][classification], 0),
    0,
  )

  return { total, byCategory, unclassifiedItems, ready: gateReady({ unclassifiedItems }) } satisfies StartupInventory
})
