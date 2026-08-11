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
    role: text().$type<"trigger" | "steer">().notNull(),
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
