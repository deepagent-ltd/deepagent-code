import { sql } from "drizzle-orm"
import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"

export const SessionActivityAdmissionTable = sqliteTable(
  "session_activity_admission",
  {
    admission_id: text().primaryKey(),
    session_id: text().notNull(),
    source_kind: text().$type<"legacy_intent" | "session_input">().notNull(),
    legacy_intent_id: text(),
    session_input_id: text(),
    admitted_message_id: text().notNull(),
    delivery: text().$type<"turn" | "steer" | "queue" | "goal_steer">().notNull(),
    payload_fingerprint_kind: text().$type<"payload_hash" | "source_identity">().notNull(),
    payload_fingerprint: text().notNull(),
    execution_mode: text().$type<"legacy" | "run_now" | "deferred">().notNull().default("legacy"),
    created_at: integer().notNull(),
  },
  (table) => [
    uniqueIndex("session_activity_admission_legacy_idx").on(table.legacy_intent_id),
    uniqueIndex("session_activity_admission_input_idx").on(table.session_input_id),
  ],
)

export const SessionLegacyActivityAdmissionTable = sqliteTable(
  "session_legacy_activity_admission",
  {
    activity_id: text().notNull(),
    admission_id: text().notNull(),
    ordinal: integer().notNull(),
    role: text().$type<"trigger" | "steer" | "deferred_context">().notNull(),
    attached_at: integer().notNull(),
  },
  (table) => [
    uniqueIndex("session_legacy_activity_admission_ordinal_idx").on(table.activity_id, table.ordinal),
    uniqueIndex("session_legacy_activity_admission_admission_idx").on(table.admission_id),
  ],
)

export const SessionLegacyActivityTable = sqliteTable(
  "session_legacy_activity",
  {
    activity_id: text().primaryKey(),
    session_id: text().notNull(),
    ordinal: integer().notNull(),
    trigger_admission_id: text().notNull(),
    owner_token: text().notNull(),
    state: text().$type<"active" | "settled" | "failed" | "interrupted" | "recovery_required">().notNull(),
    terminal_reason: text(),
    created_at: integer().notNull(),
    settled_at: integer(),
  },
  (table) => [uniqueIndex("session_legacy_activity_ordinal_idx").on(table.session_id, table.ordinal)],
)

export const SessionActivityProgressTable = sqliteTable(
  "session_activity_progress",
  {
    activity_id: text().notNull(),
    revision: integer().notNull(),
    assistant_message_id: text().notNull(),
    text_part_id: text(),
    provider_receipt_id: text().notNull(),
    input_membership_ordinal: integer().notNull().default(0),
    state: text().$type<"provisional" | "progress" | "final" | "interrupted" | "recovery_required">().notNull(),
    finish_observed: text(),
    response_fingerprint: text(),
    created_at: integer().notNull(),
    settled_at: integer(),
  },
  (table) => [
    uniqueIndex("session_activity_progress_revision_idx").on(table.activity_id, table.revision),
    uniqueIndex("session_activity_progress_assistant_idx").on(table.assistant_message_id),
    uniqueIndex("session_activity_progress_receipt_idx").on(table.provider_receipt_id),
  ],
)

export const SessionLegacyActivityRunTable = sqliteTable(
  "session_legacy_activity_run",
  {
    run_id: text().primaryKey(),
    activity_id: text().notNull(),
    session_id: text().notNull(),
    mutation_epoch: integer().notNull(),
    generation: integer().notNull(),
    owner_token: text().notNull(),
    state: text()
      .$type<"running" | "finalizing" | "completed" | "failed" | "interrupted" | "recovery_required">()
      .notNull(),
    started_at: integer().notNull(),
    terminal_at: integer(),
    terminal_reason: text(),
  },
  (table) => [
    uniqueIndex("session_legacy_activity_run_generation_idx").on(
      table.session_id,
      table.mutation_epoch,
      table.generation,
    ),
    uniqueIndex("session_legacy_activity_live_run_idx")
      .on(table.activity_id)
      .where(sql`${table.state} IN ('running','finalizing')`),
  ],
)

export const SessionLegacyActivityTerminalTable = sqliteTable(
  "session_legacy_activity_terminal",
  {
    activity_id: text().primaryKey(),
    session_id: text().notNull(),
    mutation_epoch: integer().notNull(),
    state: text().$type<"settled" | "failed" | "interrupted" | "recovery_required">().notNull(),
    reason_code: text().notNull(),
    source: text()
      .$type<
        | "provider_final"
        | "host_stop"
        | "cancel"
        | "compaction"
        | "restart_recovery"
        | "same_process_recovery"
        | "migration_repair"
        | "migration_backfill"
      >()
      .notNull(),
    operation_id: text().notNull(),
    run_id: text(),
    assistant_message_id: text(),
    progress_revision: integer(),
    membership_ordinal: integer().notNull(),
    owner_token: text().notNull(),
    created_at: integer().notNull(),
  },
  (table) => [uniqueIndex("session_legacy_activity_terminal_operation_idx").on(table.operation_id)],
)

export const SessionLegacyActivityMigrationReceiptTable = sqliteTable(
  "session_legacy_activity_migration_receipt",
  {
    receipt_id: text().primaryKey(),
    batch_id: text().notNull(),
    activity_id: text().notNull(),
    classifier_version: text().notNull(),
    before_state: text().$type<"active" | "settled" | "failed" | "interrupted" | "recovery_required">().notNull(),
    after_state: text().$type<"settled" | "failed" | "interrupted" | "recovery_required">().notNull(),
    evidence_hash: text().notNull(),
    terminal_operation_id: text().notNull(),
    error_code: text(),
    created_at: integer().notNull(),
  },
  (table) => [
    uniqueIndex("session_legacy_activity_migration_batch_idx").on(table.batch_id, table.activity_id),
    uniqueIndex("session_legacy_activity_migration_terminal_idx").on(table.terminal_operation_id),
  ],
)
