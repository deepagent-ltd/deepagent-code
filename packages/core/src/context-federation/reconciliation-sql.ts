// FEAT-007: durable per-turn reconciliation records for federated context selections.
// One row per federated provider turn receipt — compares the legacy selected refs (when
// available at the receipt write site) against the projection selection ref set so the
// "why did the model see these documents" question survives restarts (knowledgeMemoryDelta
// is in-memory only).
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { SessionTable } from "../session/sql"
import { SessionActivityTable } from "./session-sql"
import type { ContextReconciliation } from "./reconciliation"

export const SessionContextReconciliationTable = sqliteTable(
  "session_context_reconciliation",
  {
    reconciliation_id: text().primaryKey().notNull(),
    session_id: text()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    activity_id: text()
      .notNull()
      .references(() => SessionActivityTable.activity_id, { onDelete: "cascade" }),
    turn_receipt_id: text().notNull(),
    selection_id: text(),
    legacy_refs_fingerprint: text(),
    projection_refs_fingerprint: text().notNull(),
    outcome: text().$type<ContextReconciliation.Outcome>().notNull(),
    diff_summary: text({ mode: "json" }).$type<ContextReconciliation.DiffSummary>().notNull(),
    created_at: integer().notNull(),
  },
  (table) => [
    uniqueIndex("session_context_reconciliation_receipt_idx").on(table.turn_receipt_id),
    index("session_context_reconciliation_session_idx").on(table.session_id, table.created_at),
  ],
)
