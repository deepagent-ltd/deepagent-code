// BUG-005: drizzle-orm type bindings for compaction_run and compaction_summary_attempt.
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { SessionTable } from "@deepagent-code/core/session/sql"

export type CompactionRunState = "requested" | "summarizing" | "committed" | "failed" | "indeterminate"
// UPD-005 Gap 2: how a run compacted. 'local_summary' is the default/historical
// path (TEXT summary committed); 'remote_compact' commits an opaque server-held
// encrypted context instead (summary_text stays NULL — information-hole exempt).
export type CompactionMode = "local_summary" | "remote_compact"
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
  // UPD-005 Gap 2 (migration 20260820000000_remote_compact_persistence).
  compaction_mode: text().$type<CompactionMode>().notNull().default("local_summary"),
  // Compatibility pointer for older readers; current provenance is the blob id below.
  encrypted_content_session: text(),
  // Immutable per-run blob used by the current remote compaction authority.
  encrypted_content_blob_id: text(),
  // Provider provenance copied from the current blob and enforced at commit.
  remote_provider_id: text(),
})

export const CompactionContinuationFailureTable = sqliteTable("compaction_continuation_failure", {
  failure_id: text().primaryKey().notNull(),
  run_id: text()
    .notNull()
    .references(() => CompactionRunTable.run_id, { onDelete: "cascade" }),
  session_id: text()
    .notNull()
    .references(() => SessionTable.id, { onDelete: "cascade" }),
  ordinal: integer().notNull(),
  source_state: text().$type<"pending" | "admitted" | "dispatching">().notNull(),
  reason: text().notNull(),
  created_at: integer().notNull(),
})

export const CompactionContinuationResolutionCommandTable = sqliteTable("compaction_continuation_resolution_command", {
  command_id: text().primaryKey().notNull(),
  request_hash: text().notNull(),
  run_id: text()
    .notNull()
    .references(() => CompactionRunTable.run_id, { onDelete: "cascade" }),
  result_resolution_id: text(),
  created_at: integer().notNull(),
})

export const CompactionContinuationResolutionTable = sqliteTable("compaction_continuation_resolution", {
  resolution_id: text().primaryKey().notNull(),
  failure_id: text()
    .notNull()
    .unique()
    .references(() => CompactionContinuationFailureTable.failure_id, { onDelete: "cascade" }),
  run_id: text()
    .notNull()
    .references(() => CompactionRunTable.run_id, { onDelete: "cascade" }),
  session_id: text()
    .notNull()
    .references(() => SessionTable.id, { onDelete: "cascade" }),
  decision: text().$type<"abandoned" | "replay">().notNull(),
  actor_id: text().notNull(),
  reason: text().notNull(),
  risk_acknowledged: integer({ mode: "boolean" }).notNull(),
  source_prompt_epoch: integer().notNull(),
  source_window_id: text().notNull(),
  source_history_hash: text().notNull(),
  source_mutation_epoch: integer().notNull(),
  successor_prompt_epoch: integer().notNull(),
  successor_window_id: text().notNull(),
  successor_history_hash: text().notNull(),
  successor_mutation_epoch: integer().notNull(),
  created_at: integer().notNull(),
})

// UPD-005 Gap 1: the ONE currently-valid `/responses/compact` encrypted context per
// session (1:1; the write path upserts so only the latest blob survives). The blob
// is cross-run / session-scoped — replayed on the next compaction — hence its own
// table instead of a compaction_run column. provider_id is the same-provenance
// guard checked before replay; session deletion cascades.
export const SessionCompactionEncryptedContentTable = sqliteTable("session_compaction_encrypted_content", {
  session_id: text()
    .primaryKey()
    .notNull()
    .references(() => SessionTable.id, { onDelete: "cascade" }),
  encrypted_content: text().notNull(),
  provider_id: text().notNull(),
  model_id: text(),
  source_run_id: text(),
  // Last durable message represented by encrypted_content. Ordinary provider
  // requests replay only messages after this boundary.
  source_end_message_id: text(),
  created_at: integer().notNull(),
  updated_at: integer().notNull(),
})

// Compatibility projection for the pre-1.4.7 session singleton. New writes use
// the per-run blob/head pair below; the singleton remains a read-compatible
// mirror for older callers and is never used as release provenance.
export const SessionCompactionEncryptedBlobTable = sqliteTable("session_compaction_encrypted_blob", {
  blob_id: text().primaryKey().notNull(),
  session_id: text()
    .notNull()
    .references(() => SessionTable.id, { onDelete: "cascade" }),
  encrypted_content: text().notNull(),
  provider_id: text().notNull(),
  model_id: text(),
  source_run_id: text(),
  source_end_message_id: text(),
  created_at: integer().notNull(),
})

export const SessionCompactionEncryptedHeadTable = sqliteTable("session_compaction_encrypted_head", {
  session_id: text()
    .primaryKey()
    .notNull()
    .references(() => SessionTable.id, { onDelete: "cascade" }),
  blob_id: text()
    .notNull()
    .references(() => SessionCompactionEncryptedBlobTable.blob_id, { onDelete: "restrict" }),
  updated_at: integer().notNull(),
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
