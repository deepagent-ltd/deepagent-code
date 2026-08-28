import { sql } from "drizzle-orm"
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"

export const LearningLifecycleTriggerTable = sqliteTable(
  "learning_lifecycle_trigger_receipt",
  {
    receipt_id: text().primaryKey(),
    trigger: text().$type<"idle" | "pause" | "project_switch">().notNull(),
    boundary_key: text().notNull(),
    session_id: text().notNull(),
    run_id: text().notNull(),
    source_admission_hash: text().notNull(),
    source_terminal_hash: text().notNull(),
    artifact_path: text().notNull(),
    artifact_hash: text().notNull(),
    artifact_json: text().notNull(),
    admission_fingerprint: text().notNull(),
    admission_json: text().notNull(),
    state: text().$type<"prepared" | "admitted">().notNull(),
    error_detail: text(),
    created_at: integer().notNull(),
    settled_at: integer(),
    updated_at: integer().notNull(),
  },
  (table) => [
    uniqueIndex("learning_lifecycle_trigger_identity_idx").on(table.trigger, table.session_id, table.run_id),
    index("learning_lifecycle_trigger_pending_idx")
      .on(table.created_at, table.receipt_id)
      .where(sql`${table.state} = 'prepared'`),
    check("learning_lifecycle_trigger_kind_check", sql`${table.trigger} IN ('idle', 'pause', 'project_switch')`),
    check("learning_lifecycle_trigger_state_check", sql`${table.state} IN ('prepared', 'admitted')`),
    check(
      "learning_lifecycle_trigger_source_admission_hash_check",
      sql`length(${table.source_admission_hash}) = 64 AND ${table.source_admission_hash} NOT GLOB '*[^0-9a-f]*'`,
    ),
    check(
      "learning_lifecycle_trigger_source_terminal_hash_check",
      sql`length(${table.source_terminal_hash}) = 64 AND ${table.source_terminal_hash} NOT GLOB '*[^0-9a-f]*'`,
    ),
    check(
      "learning_lifecycle_trigger_artifact_hash_check",
      sql`length(${table.artifact_hash}) = 64 AND ${table.artifact_hash} NOT GLOB '*[^0-9a-f]*'`,
    ),
    check(
      "learning_lifecycle_trigger_admission_fingerprint_check",
      sql`length(${table.admission_fingerprint}) = 64 AND ${table.admission_fingerprint} NOT GLOB '*[^0-9a-f]*'`,
    ),
    check(
      "learning_lifecycle_trigger_admission_json_check",
      sql`json_valid(${table.admission_json}) AND json_type(${table.admission_json}) = 'object'`,
    ),
    check(
      "learning_lifecycle_trigger_artifact_json_check",
      sql`json_valid(${table.artifact_json}) AND json_type(${table.artifact_json}) = 'object'`,
    ),
    check(
      "learning_lifecycle_trigger_settlement_check",
      sql`(${table.state} = 'prepared' AND ${table.settled_at} IS NULL) OR (${table.state} = 'admitted' AND ${table.settled_at} IS NOT NULL AND ${table.error_detail} IS NULL)`,
    ),
  ],
)
