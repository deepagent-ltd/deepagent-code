import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core"

// V4.0 §D2 — durable Approval Queue. The human-facing sink for events that need a decision: a Goal that
// escalated (goal.needs_human), a rollback (goal.rolled_back), or a Panel verdict of needs_human
// (§M/§N → §D2). One row per queued item; a human resolves it in the Oversight Dashboard (approve /
// reject / acknowledge). Kept as its own store (not folded into the event log) so the queue's
// resolution state — pending → resolved, who, when, decision — is mutable and queryable independent of
// the immutable domain-event that seeded it.
export const ApprovalQueueTable = sqliteTable(
  "deepagent_approval_queue",
  {
    id: text().primaryKey(),
    workspace_id: text().notNull(),
    // the domain event that raised this item (goal.needs_human / goal.rolled_back / panel.verdict).
    event_id: text().notNull(),
    event_type: text().notNull(),
    // correlationID of the raising event — links the queue item to its §F2 trace spine.
    correlation_id: text(),
    // a short human-facing summary of what needs approval (rendered from the event payload).
    summary: text().notNull(),
    // pending → resolved. A resolved item carries the decision + who + when.
    status: text().$type<"pending" | "resolved">().notNull(),
    decision: text().$type<"approved" | "rejected" | "acknowledged">(),
    resolved_by: text(),
    resolved_at: integer(),
    created_at: integer().notNull(),
  },
  (table) => [
    // §D2 去重: one queue item per raising event (a re-delivered event doesn't double-queue).
    uniqueIndex("deepagent_approval_queue_event_idx").on(table.event_id),
    // Dashboard: a workspace's pending items, newest first.
    index("deepagent_approval_queue_pending_idx").on(table.workspace_id, table.status, table.created_at),
  ],
)

export * as ApprovalQueueSql from "./approval-queue-sql"
