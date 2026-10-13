import { sql } from "drizzle-orm"
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { WorkKnownRecoveryTable } from "./work-known-recovery.sql"

// The explicit continuation is a separate immutable intent. Reading or retrying
// the original recovery receipt never schedules another drain.
export const WorkKnownRecoveryResumeTable = sqliteTable("work_known_recovery_resume", {
  recovery_id: text().primaryKey().notNull().references(() => WorkKnownRecoveryTable.recovery_id, { onDelete: "restrict", onUpdate: "restrict" }),
  version: integer().notNull(),
  instance_id: text().notNull(),
  operator_id: text().notNull(),
  work_id: text().notNull(),
  session_id: text().notNull(),
  request_id: text().notNull(),
  control_revision: integer().notNull(),
  operator_revision: integer().notNull(),
  source_revision: integer().notNull(),
  approval_revision: integer().notNull(),
  binding_hash: text().notNull(),
  recovery_record_hash: text().notNull(),
  request_hash: text().notNull(),
  record_hash: text().notNull(),
  mac: text().notNull(),
  created_at: integer().notNull(),
  record: text().notNull(),
}, (table) => [
  uniqueIndex("work_known_recovery_resume_request_idx").on(table.instance_id, table.operator_id, table.work_id, table.request_id),
  index("work_known_recovery_resume_session_idx").on(table.session_id, table.control_revision),
  check("work_known_recovery_resume_version_check", sql`typeof(${table.version})='integer' AND ${table.version}=1`),
  check("work_known_recovery_resume_record_check", sql`typeof(${table.record})='text'
    AND length(CAST(${table.record} AS BLOB)) BETWEEN 1 AND 8192
    AND instr(${table.record},char(0))=0 AND json_valid(${table.record})`),
  ...[table.recovery_id, table.instance_id, table.operator_id, table.work_id, table.session_id, table.request_id].map((column) =>
    check(`work_known_recovery_resume_${column.name}_text_check`, sql`typeof(${column})='text'
      AND length(CAST(${column} AS BLOB)) BETWEEN 1 AND 512 AND instr(${column},char(0))=0`)),
  ...[table.control_revision, table.operator_revision, table.source_revision, table.approval_revision, table.created_at].map((column) =>
    check(`work_known_recovery_resume_${column.name}_integer_check`, sql`typeof(${column})='integer'
      AND ${column} BETWEEN 1 AND 9007199254740991`)),
  ...[table.binding_hash, table.recovery_record_hash, table.request_hash, table.record_hash, table.mac].map((column) =>
    check(`work_known_recovery_resume_${column.name}_digest_check`, sql`typeof(${column})='text'
      AND length(CAST(${column} AS BLOB))=64 AND ${column} NOT GLOB '*[^0-9a-f]*'`)),
  ...([
    [table.recovery_id, "recoveryID"], [table.instance_id, "instanceID"], [table.operator_id, "operatorID"],
    [table.work_id, "workID"], [table.session_id, "sessionID"], [table.request_id, "requestID"],
    [table.binding_hash, "bindingHash"], [table.recovery_record_hash, "recoveryRecordHash"], [table.request_hash, "requestHash"],
  ] as const).map(([column, field]) => check(`work_known_recovery_resume_${column.name}_mirror_check`, sql`
    json_type(${table.record},${sql.raw(`'$.${field}'`)}) IS 'text'
    AND json_extract(${table.record},${sql.raw(`'$.${field}'`)}) IS ${column}`)),
  ...([
    [table.version, "version"], [table.control_revision, "controlRevision"], [table.operator_revision, "operatorRevision"],
    [table.source_revision, "sourceRevision"], [table.approval_revision, "approvalRevision"], [table.created_at, "createdAt"],
  ] as const).map(([column, field]) => check(`work_known_recovery_resume_${column.name}_mirror_check`, sql`
    json_type(${table.record},${sql.raw(`'$.${field}'`)}) IS 'integer'
    AND json_extract(${table.record},${sql.raw(`'$.${field}'`)}) IS ${column}`)),
])
