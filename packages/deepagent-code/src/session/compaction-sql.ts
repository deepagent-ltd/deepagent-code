// BUG-005: drizzle-orm type bindings for compaction_run and compaction_summary_attempt.
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

export type CompactionRunState = "requested" | "summarizing" | "committed" | "failed" | "indeterminate"
export type CompactionContinuationState =
  | "pending"
  | "admitted"
  | "dispatching"
  | "settled"
  | "failed"
  | "indeterminate"
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
  summary_text: text(),
  recent_context: text(),
  completion_reason: text().$type<"auto" | "manual">(),
  continuation_published_at: integer(),
  terminal_events_published_at: integer(),
  source_window_id: text(),
  source_effective_history_hash: text(),
  source_message_count: integer(),
  source_projection_version: integer(),
  context_ledger_required: integer({ mode: "boolean" }).notNull().default(false),
  ledger_mirrored_at: integer(),
  bridge_carried_at: integer(),
  continuation_wakeup_at: integer(),
  continuation_state: text().$type<CompactionContinuationState>(),
  continuation_receipt_id: text(),
  continuation_admitted_at: integer(),
  continuation_dispatching_at: integer(),
  continuation_terminal_at: integer(),
  continuation_error_code: text(),
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

export const CompactionArtifactTable = sqliteTable(
  "compaction_artifact",
  {
    artifact_id: text().primaryKey(),
    run_id: text().notNull(),
    session_id: text().notNull(),
    message_id: text().notNull(),
    part_id: text(),
    kind: text().$type<"marker" | "summary_attempt" | "replay" | "continue" | "world_state">().notNull(),
    state: text().$type<"pending" | "committed" | "orphaned">().notNull(),
    created_at: integer().notNull(),
    committed_at: integer(),
    published_at: integer(),
  },
  (table) => [
    index("compaction_artifact_session_message_idx").on(table.session_id, table.message_id),
    index("compaction_artifact_run_state_idx").on(table.run_id, table.state),
  ],
)
