import { sql } from "drizzle-orm"
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { LearningJobTable } from "./learning-job.sql"

export const LearningAdmissionOutboxTable = sqliteTable(
  "learning_admission_outbox",
  {
    intent_id: text().primaryKey(),
    session_id: text().notNull(),
    run_id: text().notNull(),
    trigger: text().$type<"idle" | "pause" | "project_switch" | "session_finalization">().notNull(),
    dedupe_key: text().notNull(),
    payload_json: text().notNull(),
    payload_fingerprint: text().notNull(),
    state: text().$type<"pending" | "admitted" | "rejected">().notNull(),
    job_id: text().references(() => LearningJobTable.job_id),
    candidate_input_ref: text(),
    rejection_code: text(),
    rejection_detail: text(),
    created_at: integer().notNull(),
    settled_at: integer(),
    updated_at: integer().notNull(),
  },
  (table) => [
    uniqueIndex("learning_admission_outbox_dedupe_idx").on(table.dedupe_key),
    index("learning_admission_outbox_pending_idx")
      .on(table.created_at)
      .where(sql`${table.state} = 'pending'`),
    check(
      "learning_admission_outbox_trigger_check",
      sql`${table.trigger} IN ('idle', 'pause', 'project_switch', 'session_finalization')`,
    ),
    check(
      "learning_admission_outbox_payload_json_check",
      sql`json_valid(${table.payload_json}) AND json_type(${table.payload_json}) = 'object'`,
    ),
    check(
      "learning_admission_outbox_payload_fingerprint_check",
      sql`length(${table.payload_fingerprint}) = 64 AND ${table.payload_fingerprint} NOT GLOB '*[^0-9a-f]*'`,
    ),
    check("learning_admission_outbox_state_check", sql`${table.state} IN ('pending', 'admitted', 'rejected')`),
    check(
      "learning_admission_outbox_settlement_check",
      sql`(${table.state} = 'pending' AND ${table.job_id} IS NULL AND ${table.candidate_input_ref} IS NULL AND ${table.rejection_code} IS NULL AND ${table.rejection_detail} IS NULL AND ${table.settled_at} IS NULL) OR (${table.state} = 'admitted' AND ${table.job_id} IS NOT NULL AND length(trim(${table.candidate_input_ref})) > 0 AND ${table.rejection_code} IS NULL AND ${table.rejection_detail} IS NULL AND ${table.settled_at} IS NOT NULL) OR (${table.state} = 'rejected' AND ${table.job_id} IS NULL AND length(trim(${table.rejection_code})) > 0 AND length(trim(${table.rejection_detail})) > 0 AND ${table.settled_at} IS NOT NULL)`,
    ),
  ],
)
