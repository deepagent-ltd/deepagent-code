export * as CompactionRequestSQL from "./compaction-request.sql"

import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

/**
 * RI-18 durable manual-compaction request chain. A request fixes the summary model identity and
 * the history fence at admission; the runner drain is its only executor (pending → dispatched →
 * settled/recovery_required/failed); the summary turn itself owns the standard provider receipt
 * contract inside SessionCompaction.
 */
export const CompactionRequestTable = sqliteTable(
  "session_v2_compaction_request",
  {
    request_id: text().primaryKey(),
    session_id: text().notNull(),
    provider_id: text().notNull(),
    model_id: text().notNull(),
    fence_message_count: integer().notNull(),
    fence_last_message_id: text().notNull(),
    status: text().notNull(),
    outcome: text(),
    summary_receipt_id: text(),
    created_at: integer().notNull(),
    settled_at: integer(),
  },
  (table) => [
    index("session_v2_compaction_request_session_idx").on(table.session_id, table.created_at),
    index("session_v2_compaction_request_status_idx").on(table.status),
  ],
)
