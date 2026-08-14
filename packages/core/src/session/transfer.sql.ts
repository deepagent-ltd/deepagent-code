import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { sql } from "drizzle-orm"
import { SessionTable } from "../session/sql"

export const SessionTransferOperationTable = sqliteTable(
  "session_transfer_operation",
  {
    transfer_id: text().primaryKey(),
    session_id: text()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    source_workspace_id: text(),
    target_workspace_id: text(),
    source_owner_id: text(),
    target_owner_id: text(),
    source_event_seq: integer().notNull(),
    source_mutation_epoch: integer().notNull(),
    snapshot_id: text(),
    snapshot_hash: text(),
    state: text()
      .$type<"admitted" | "source_frozen" | "target_staged" | "owner_committed" | "target_activated" | "aborted">()
      .notNull(),
    request_hash: text().notNull(),
    error_code: text(),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
    completed_at: integer(),
  },
  (table) => [
    uniqueIndex("session_transfer_operation_session_request_idx").on(table.session_id, table.request_hash),
    uniqueIndex("session_transfer_operation_active_idx")
      .on(table.session_id)
      .where(sql`${table.state} NOT IN ('target_activated', 'aborted')`),
  ],
)

export const SessionTransferTargetReceiptTable = sqliteTable("session_transfer_target_receipt", {
  transfer_id: text().primaryKey(),
  session_id: text().notNull(),
  source_snapshot_id: text().notNull(),
  source_snapshot_hash: text().notNull(),
  source_event_seq: integer().notNull(),
  target_workspace_id: text(),
  target_owner_id: text(),
  state: text().$type<"staged" | "activated">().notNull(),
  activated_snapshot_id: text(),
  activated_at: integer(),
  created_at: integer().notNull(),
})
