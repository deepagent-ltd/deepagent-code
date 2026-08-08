// BUG-005: drizzle-orm type bindings for compaction_run and compaction_summary_attempt.
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

export type CompactionRunState = "requested" | "summarizing" | "committed" | "failed" | "indeterminate"
export type CompactionRunTrigger = "turn_start" | "provider_overflow" | "manual"
export type SummaryAttemptState =
  | "prepared"
  | "dispatching"
  | "streaming"
  | "settled"
  | "failed"
  | "indeterminate_after_crash"

export const CompactionRunTable = sqliteTable("compaction_run", {
  run_id: text().primaryKey().notNull(),
  session_id: text().notNull(),
  from_prompt_epoch: integer().notNull(),
  target_prompt_epoch: integer(),
  trigger: text().$type<CompactionRunTrigger>().notNull(),
  marker_message_id: text(),
  marker_part_id: text(),
  committed_summary_message_id: text(),
  checkpoint_ref: text(),
  checkpoint_hash: text(),
  state: text().$type<CompactionRunState>().notNull(),
  terminal_failure_kind: text(),
  created_at: integer().notNull(),
  committed_at: integer(),
})

export const CompactionSummaryAttemptTable = sqliteTable("compaction_summary_attempt", {
  summary_attempt_id: text().primaryKey().notNull(),
  run_id: text()
    .notNull()
    .references(() => CompactionRunTable.run_id, { onDelete: "cascade" }),
  ordinal: integer().notNull(),
  parent_attempt_id: text(),
  provider_id: text().notNull(),
  model_id: text().notNull(),
  protocol: text().notNull(),
  request_hash: text(),
  idempotency_key: text(),
  state: text().$type<SummaryAttemptState>().notNull(),
  retry_reason: text(),
  failure_kind: text(),
  prepared_at: integer().notNull(),
  dispatched_at: integer(),
  completed_at: integer(),
})
