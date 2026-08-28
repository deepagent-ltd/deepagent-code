export * as RecoveryBinding from "./recovery-binding"

import { Effect } from "effect"
import { sql } from "drizzle-orm"
import type { EffectDrizzleSqlite } from "@deepagent-code/effect-drizzle-sqlite"

type Database = EffectDrizzleSqlite.EffectSQLiteDatabase

// §16.4 DATA-AND-RECOVERY D-5 — recovery binding audit. Every recovery chain (provider turn,
// tool effect, task run) must bind to the SAME owner/generation and history/context identity as
// its parent rows; a classifier or replayer must never pair evidence across identities. This
// module runs three deterministic read-only queries over one DB snapshot and reports every row
// that breaks the binding — no writes, no auto-recovery.

export type Problem = {
  readonly chain: "provider_turn" | "tool_effect" | "task_run"
  readonly kind: string
  readonly row: string
  readonly detail: string
}

export type Verdict = { readonly ok: boolean; readonly problems: readonly Problem[] }

export const audit = Effect.fn("RecoveryBinding.audit")(function* (db: Database) {
  const problems: Problem[] = []

  // provider_turn: a receipt bound to an attempt must agree on session/activity/turn/owner.
  const turns = yield* db.all<{ row: string; detail: string }>(sql`
    SELECT r.receipt_id AS row, r.session_id || '/' || r.activity_id || '/' || r.provider_turn_seq AS detail
    FROM session_v2_provider_turn_receipt r
    LEFT JOIN session_provider_attempt a ON a.attempt_id = r.provider_attempt_id
    WHERE r.provider_attempt_id IS NOT NULL
      AND (a.attempt_id IS NULL OR a.session_id != r.session_id OR a.activity_id != r.activity_id
           OR a.provider_turn_seq != r.provider_turn_seq OR a.owner_token != r.owner_token)
  `)
  problems.push(...turns.map((t) => ({ chain: "provider_turn" as const, kind: "receipt_attempt_mismatch", ...t })))

  // tool_effect: bound receipt must exist and agree on session; attempt must exist; grant
  // evidence columns must be all set or all null (the insert guard contract).
  const effects = yield* db.all<{ row: string; detail: string }>(sql`
    SELECT e.effect_id AS row, e.session_id || '/' || e.receipt_id AS detail
    FROM session_v2_tool_effect e
    LEFT JOIN session_v2_provider_turn_receipt r ON r.receipt_id = e.receipt_id
    LEFT JOIN session_provider_attempt a ON a.attempt_id = e.provider_attempt_id
    WHERE r.receipt_id IS NULL OR r.session_id != e.session_id OR a.attempt_id IS NULL
  `)
  problems.push(...effects.map((e) => ({ chain: "tool_effect" as const, kind: "binding_mismatch", ...e })))

  const grants = yield* db.all<{ row: string; detail: string }>(sql`
    SELECT effect_id AS row, effect_id AS detail
    FROM session_v2_tool_effect
    WHERE (grant_receipt_id IS NULL) != (grant_owner_id IS NULL)
       OR (grant_owner_id IS NULL) != (grant_state IS NULL)
       OR (grant_state IS NULL) != (grant_version IS NULL)
  `)
  problems.push(...grants.map((g) => ({ chain: "tool_effect" as const, kind: "partial_grant_evidence", ...g })))

  // task_run: the terminal receipt must agree with the task_run row on generation and owner.
  const tasks = yield* db.all<{ row: string; detail: string }>(sql`
    SELECT e.receipt_id AS row, e.run_id AS detail
    FROM session_v2_task_run_receipt e
    LEFT JOIN task_run t ON t.run_id = e.run_id
    WHERE t.run_id IS NULL OR t.generation != e.generation
       OR (t.execution_owner IS NOT NULL AND t.execution_owner != e.owner_token)
  `)
  problems.push(...tasks.map((t) => ({ chain: "task_run" as const, kind: "owner_generation_mismatch", ...t })))

  return { ok: problems.length === 0, problems }
})
