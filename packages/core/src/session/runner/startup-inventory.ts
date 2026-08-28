export * as StartupInventory from "./startup-inventory"

// C1B-10 — unified startup inventory (design §10.7 recovery order steps 3-7).
//
// After migration and BEFORE open admission, the boot must classify every durable
// recovery surface into a deterministic bucket and prove the inventory is TOTAL
// (`unclassified = 0`) before it may advance to `ready`. This module is the single
// in-process classification surface for the five recovery categories:
//
//   provider_attempt (session_provider_attempt)
//   tool_effect      (session_v2_tool_effect — V2 tool receipt + permission grant evidence)
//   task_run         (task_run)
//   compaction       (event_snapshot_attempt + event_compaction_receipt)
//   session_activity (session_facade_activity)
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

type Database = EffectDrizzleSqlite.EffectSQLiteDatabase

/** The five durable recovery surfaces the startup inventory classifies. */
export type StartupCategory =
  | "provider_attempt"
  | "tool_effect"
  | "task_run"
  | "compaction"
  | "session_activity"

export const StartupCategories: readonly StartupCategory[] = [
  "provider_attempt",
  "tool_effect",
  "task_run",
  "compaction",
  "session_activity",
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
   * Durable row id. For compaction (two tables) this is prefixed so the row is
   * unambiguous: `snapshot:<id>` | `receipt:<id>`.
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

const taskRunTerminal = new Set(["completed", "error", "cancelled", "interrupted", "failed", "closed"])
const taskRunPredispatch = new Set(["admitted", "queued", "provisioning"])
const taskRunActive = new Set(["researching", "finalizing", "running", "recovery_required"])

function classifyProviderAttemptItem(row: CategoryRow): StartupInventoryItem {
  const classification = providerAttempt[row.state]
  if (classification === undefined)
    return {
      category: "provider_attempt",
      id: row.id,
      classification: "unclassified",
      state: row.state,
      reason: `unknown provider_attempt state '${row.state}'`,
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

function classifyCompactionItem(
  row: CategoryRow & { readonly table: "snapshot" | "receipt" },
): StartupInventoryItem {
  const map = row.table === "snapshot" ? compactionSnapshot : compactionReceipt
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
    reason:
      classification === "safe_before_dispatch"
        ? "snapshot built but not committed; provably pre-commit (requeue-eligible rebuild)"
        : classification === "recovery"
          ? "compaction in-flight with no committed receipt; recovery"
          : "compaction complete; resolved",
  }
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
  }
  const unclassifiedItems: StartupInventoryItem[] = []
  const observedAt = Date.now()

  const accept = (item: StartupInventoryItem): void => {
    tallyCounts(byCategory, item.category, item)
    if (item.classification === "unclassified") unclassifiedItems.push(item)
  }

  // Provider attempts.
  const attempts = yield* db.all<CategoryRow>(sql`SELECT attempt_id AS id, state FROM session_provider_attempt`)
  attempts.forEach((row) => accept(classifyProviderAttemptItem(row)))

  // V2 tool effects (tool receipt + permission grant evidence).
  const effects = yield* db.all<{ id: string; state: string; grant_state: string | null }>(
    sql`SELECT effect_id AS id, state, grant_state FROM session_v2_tool_effect`,
  )
  effects.forEach((row) => accept(classifyToolEffectItem(row)))

  // Task runs.
  const tasks = yield* db.all<{ id: string; state: string; execution_owner: string | null; lease_expires_at: number | null }>(
    sql`SELECT run_id AS id, state, execution_owner, lease_expires_at FROM task_run`,
  )
  tasks.forEach((row) => accept(classifyTaskRunItem(row, observedAt)))

  // Compaction (snapshot attempt + compaction receipt).
  const snapshots = yield* db.all<CategoryRow>(sql`SELECT snapshot_id AS id, state FROM event_snapshot_attempt`)
  snapshots.forEach((row) => accept(classifyCompactionItem({ ...row, table: "snapshot" })))
  const receipts = yield* db.all<CategoryRow>(
    sql`SELECT aggregate_id AS id, state FROM event_compaction_receipt`,
  )
  receipts.forEach((row) => accept(classifyCompactionItem({ ...row, table: "receipt" })))

  // Session activity.
  const activities = yield* db.all<CategoryRow>(
    sql`SELECT activity_id AS id, state FROM session_facade_activity`,
  )
  activities.forEach((row) => accept(classifySessionActivityItem(row)))

  const total =
    byCategory.provider_attempt.safe_before_dispatch +
    byCategory.provider_attempt.recovery +
    byCategory.provider_attempt.resolved +
    byCategory.provider_attempt.unclassified +
    byCategory.tool_effect.safe_before_dispatch +
    byCategory.tool_effect.recovery +
    byCategory.tool_effect.resolved +
    byCategory.tool_effect.unclassified +
    byCategory.task_run.safe_before_dispatch +
    byCategory.task_run.recovery +
    byCategory.task_run.resolved +
    byCategory.task_run.unclassified +
    byCategory.compaction.safe_before_dispatch +
    byCategory.compaction.recovery +
    byCategory.compaction.resolved +
    byCategory.compaction.unclassified +
    byCategory.session_activity.safe_before_dispatch +
    byCategory.session_activity.recovery +
    byCategory.session_activity.resolved +
    byCategory.session_activity.unclassified

  return { total, byCategory, unclassifiedItems, ready: gateReady({ unclassifiedItems }) } satisfies StartupInventory
})
