import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"

// Durable terminal authority (compensation receipt) for TaskRun settlements: one row per settled
// run, recording the terminal outcome evidence. Terminal-only admission, immutable, append-only —
// the recovery inventory and watermark proofs consume it read-only.
export const V2TaskRunReceiptTable = sqliteTable(
  "session_v2_task_run_receipt",
  {
    receipt_id: text().primaryKey(),
    session_id: text().notNull(),
    run_id: text().notNull(),
    child_session_id: text().notNull(),
    generation: integer().notNull(),
    state: text().$type<"completed" | "failed" | "cancelled" | "interrupted" | "closed">().notNull(),
    reason: text().notNull(),
    outcome_hash: text().notNull(),
    owner_token: text().notNull(),
    time_created: integer().notNull(),
  },
  (table) => [uniqueIndex("session_v2_task_run_receipt_run_idx").on(table.run_id)],
)
