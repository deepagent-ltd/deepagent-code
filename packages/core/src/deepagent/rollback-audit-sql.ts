import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"

// V4.0 §D2/§F — durable ROLLBACK audit log. A "rollback" is the moment a human reverts an agent-produced
// change over a session (via SessionRevert — the same primitive the goal loop uses). The §D2 Rollback
// surface (paired with the Takeover surface) records these so an operator can see WHEN, on WHICH session,
// BY WHOM, and WITH WHAT OUTCOME a change was rolled back, and §F exposes the count as `rollback_total`.
// One append-only row per rollback attempt — this is an audit record (never mutated), kept separate from
// the mutable Approval Queue because a rollback is an already-happened FACT, not a request awaiting one.
// Mirrors deepagent_human_takeover exactly, plus an `outcome` column (rollbacks can be a no-op when there
// is nothing to revert, so the recorded fact carries the result).
export const RollbackAuditTable = sqliteTable(
  "deepagent_rollback",
  {
    id: text().primaryKey(),
    workspace_id: text().notNull(),
    // the session whose agent-produced changes were rolled back. NOT NULL: a rollback always targets a
    // concrete session (unlike a branch-level takeover, which can have no single session).
    session_id: text().notNull(),
    // the human actor who initiated the rollback (routed workspace identity / user id).
    actor_id: text(),
    // a short, free-form reason for the §D2 surface.
    reason: text(),
    // the result of the SessionRevert call: "reverted" (a revert happened) or "noop" (nothing to revert).
    outcome: text().notNull(),
    created_at: integer().notNull(),
  },
  (table) => [
    // §F metric + §D2 surface: a workspace's rollbacks over a window, newest first.
    index("deepagent_rollback_workspace_idx").on(table.workspace_id, table.created_at),
  ],
)

export * as RollbackAuditSql from "./rollback-audit-sql"
