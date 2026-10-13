import { sql } from "drizzle-orm"
import { check, foreignKey, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { V2ToolEffectAdmissionTable } from "./runner/v2-tool-effect.sql"

// This meter accounts controlled custody; observed growth must remain recordable
// even when an external writer pushes it over the admission limit.
export const WorkWriteStageMeterTable = sqliteTable("work_write_stage_meter", {
  instance_id: text().primaryKey().notNull(),
  custody_count: integer().notNull(),
  retained_bytes: integer().notNull(),
  audit_count: integer().notNull(),
  revision: integer().notNull(),
  updated_at: integer().notNull(),
}, (table) => [
  check("work_write_stage_meter_instance_check", sql`typeof(${table.instance_id})='text' AND length(CAST(${table.instance_id} AS BLOB)) BETWEEN 1 AND 512 AND instr(${table.instance_id},char(0))=0`),
  check("work_write_stage_meter_count_check", sql`typeof(${table.custody_count})='integer' AND ${table.custody_count} BETWEEN 0 AND 32 AND typeof(${table.audit_count})='integer' AND ${table.audit_count} BETWEEN 0 AND 10000 AND ${table.custody_count}<=${table.audit_count}`),
  check("work_write_stage_meter_bytes_check", sql`typeof(${table.retained_bytes})='integer' AND ${table.retained_bytes} BETWEEN 0 AND 9007199254740991`),
  check("work_write_stage_meter_time_check", sql`typeof(${table.revision})='integer' AND ${table.revision} BETWEEN 1 AND 9007199254740991 AND typeof(${table.updated_at})='integer' AND ${table.updated_at} BETWEEN 1 AND 9007199254740991`),
])

export const WorkWriteStageTable = sqliteTable("work_write_stage", {
  stage_id: text().primaryKey().notNull(),
  instance_id: text().notNull(),
  work_id: text().notNull(),
  root_work_id: text().notNull(),
  session_id: text().notNull(),
  input_id: text().notNull(),
  provider_receipt_id: text().notNull(),
  provider_attempt_id: text().notNull(),
  admission_id: text().notNull(),
  tool_call_id: text().notNull(),
  binding_hash: text().notNull(),
  control_revision: integer().notNull(),
  request_hash: text().notNull(),
  state: text().$type<"reserved" | "prepared" | "publication_unknown" | "published" | "refused">().notNull(),
  revision: integer().notNull(),
  reserved_bytes: integer().notNull(),
  observed_retained_bytes: integer().notNull(),
  record: text().notNull(),
  record_hash: text().notNull(),
  created_at: integer().notNull(),
  updated_at: integer().notNull(),
  released_at: integer(),
}, (table) => [
  uniqueIndex("work_write_stage_admission_idx").on(table.admission_id),
  index("work_write_stage_custody_idx").on(table.instance_id, table.released_at, table.stage_id),
  index("work_write_stage_work_idx").on(table.work_id, table.created_at, table.stage_id),
  foreignKey({ columns: [table.instance_id], foreignColumns: [WorkWriteStageMeterTable.instance_id] }).onDelete("restrict").onUpdate("restrict"),
  foreignKey({ columns: [table.admission_id], foreignColumns: [V2ToolEffectAdmissionTable.admission_id] }).onDelete("restrict").onUpdate("restrict"),
  ...[table.stage_id, table.instance_id, table.work_id, table.root_work_id, table.session_id, table.input_id,
    table.provider_receipt_id, table.provider_attempt_id, table.admission_id, table.tool_call_id].map((column) =>
    check(`work_write_stage_${column.name}_text_check`, sql`typeof(${column})='text' AND length(CAST(${column} AS BLOB)) BETWEEN 1 AND 512 AND instr(${column},char(0))=0`)),
  ...[table.binding_hash, table.request_hash, table.record_hash].map((column) =>
    check(`work_write_stage_${column.name}_hash_check`, sql`typeof(${column})='text' AND length(CAST(${column} AS BLOB))=64 AND ${column} NOT GLOB '*[^0-9a-f]*'`)),
  ...[table.control_revision, table.revision, table.created_at, table.updated_at].map((column) =>
    check(`work_write_stage_${column.name}_integer_check`, sql`typeof(${column})='integer' AND ${column} BETWEEN 1 AND 9007199254740991`)),
  ...[table.reserved_bytes, table.observed_retained_bytes].map((column) =>
    check(`work_write_stage_${column.name}_bytes_check`, sql`typeof(${column})='integer' AND ${column} BETWEEN 0 AND 9007199254740991`)),
  check("work_write_stage_time_check", sql`${table.updated_at}>=${table.created_at} AND (${table.released_at} IS NULL OR (typeof(${table.released_at})='integer' AND ${table.released_at} BETWEEN ${table.created_at} AND ${table.updated_at}))`),
  check("work_write_stage_state_check", sql`${table.state} IN ('reserved','prepared','publication_unknown','published','refused') AND ((${table.released_at} IS NULL AND ${table.reserved_bytes}>0) OR (${table.released_at} IS NOT NULL AND ${table.state} IN ('published','refused') AND ${table.reserved_bytes}=0 AND ${table.observed_retained_bytes}=0))`),
  check("work_write_stage_record_check", sql`typeof(${table.record})='text' AND length(CAST(${table.record} AS BLOB)) BETWEEN 1 AND 16384 AND instr(${table.record},char(0))=0 AND json_valid(${table.record}) AND json_type(${table.record}) IS 'object' AND json_type(${table.record},'$.version') IS 'integer' AND json_extract(${table.record},'$.version') IS 1`),
  ...([
    [table.stage_id, "stageID"], [table.instance_id, "instanceID"], [table.work_id, "workID"],
    [table.root_work_id, "rootWorkID"], [table.session_id, "sessionID"], [table.input_id, "inputID"],
    [table.provider_receipt_id, "providerReceiptID"], [table.provider_attempt_id, "providerAttemptID"],
    [table.admission_id, "admissionID"], [table.tool_call_id, "toolCallID"],
    [table.binding_hash, "bindingHash"], [table.request_hash, "requestHash"], [table.state, "state"],
  ] as const).map(([column, field]) => check(`work_write_stage_${column.name}_mirror_check`, sql`json_type(${table.record},${sql.raw(`'$.${field}'`)}) IS 'text' AND json_extract(${table.record},${sql.raw(`'$.${field}'`)}) IS ${column}`)),
  ...([
    [table.control_revision, "controlRevision"], [table.revision, "revision"],
    [table.reserved_bytes, "reservedBytes"], [table.observed_retained_bytes, "observedRetainedBytes"],
    [table.created_at, "createdAt"], [table.updated_at, "updatedAt"],
  ] as const).map(([column, field]) => check(`work_write_stage_${column.name}_mirror_check`, sql`json_type(${table.record},${sql.raw(`'$.${field}'`)}) IS 'integer' AND json_extract(${table.record},${sql.raw(`'$.${field}'`)}) IS ${column}`)),
  check("work_write_stage_release_mirror_check", sql`((${table.released_at} IS NULL AND json_type(${table.record},'$.releasedAt') IS 'null') OR (${table.released_at} IS NOT NULL AND json_type(${table.record},'$.releasedAt') IS 'integer' AND json_extract(${table.record},'$.releasedAt') IS ${table.released_at}))`),
])
