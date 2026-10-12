import { sql } from "drizzle-orm"
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { WorkCountAcquisitionSchema } from "./work-count-acquisition.schema"

// Deliberately no cascading FK and no charge columns. This slot is a disclosure receipt;
// WorkAuthority remains the only generation reservation and usage ledger.
export const WorkCountAcquisitionTable = sqliteTable("work_count_acquisition", {
  acquisition_id: text().primaryKey().notNull(),
  work_id: text().notNull(),
  slot_version: integer().notNull().default(1),
  root_work_id: text(),
  activity_id: text(),
  provider_turn_seq: integer(),
  turn_key: text(),
  input_id: text().notNull(),
  session_id: text().notNull(),
  provider_receipt_id: text().notNull(),
  provider_attempt_id: text().notNull(),
  binding_hash: text().notNull(),
  approval_id: text().notNull(),
  approval_revision: integer().notNull(),
  state: text().$type<WorkCountAcquisitionSchema.State>().notNull(),
  revision: integer().notNull(),
  owner_token: text().notNull(),
  boot_id: text().notNull(),
  deadline: integer().notNull(),
  record: text().notNull(),
  record_hash: text().notNull(),
  record_mac: text().notNull(),
  created_at: integer().notNull(),
  updated_at: integer().notNull(),
}, (table) => [
  uniqueIndex("work_count_acquisition_v1_work_idx").on(table.work_id).where(sql`${table.slot_version}=1`),
  uniqueIndex("work_count_acquisition_v1_input_idx").on(table.work_id, table.input_id).where(sql`${table.slot_version}=1`),
  uniqueIndex("work_count_acquisition_v2_turn_idx").on(table.work_id, table.activity_id, table.provider_turn_seq).where(sql`${table.slot_version}=2`),
  uniqueIndex("work_count_acquisition_v2_key_idx").on(table.work_id, table.turn_key).where(sql`${table.slot_version}=2`),
  uniqueIndex("work_count_acquisition_v2_receipt_idx").on(table.provider_receipt_id).where(sql`${table.slot_version}=2`),
  uniqueIndex("work_count_acquisition_v2_attempt_idx").on(table.provider_attempt_id).where(sql`${table.slot_version}=2`),
  index("work_count_acquisition_v2_root_state_idx").on(table.root_work_id, table.state),
  check("work_count_acquisition_slot_version_check", sql`typeof(${table.slot_version})='integer' AND ${table.slot_version} IN (1,2)
    AND json_type(${table.record}, '$.version') IS 'integer'
    AND ((${table.slot_version}=1 AND json_extract(${table.record}, '$.version') IS 1
      AND ${table.root_work_id} IS NULL AND ${table.activity_id} IS NULL AND ${table.provider_turn_seq} IS NULL AND ${table.turn_key} IS NULL)
    OR (${table.slot_version}=2 AND json_extract(${table.record}, '$.version') IS 2
      AND typeof(${table.root_work_id})='text' AND length(CAST(${table.root_work_id} AS BLOB)) BETWEEN 1 AND 512
      AND typeof(${table.activity_id})='text' AND length(CAST(${table.activity_id} AS BLOB)) BETWEEN 1 AND 512
      AND typeof(${table.provider_turn_seq})='integer' AND ${table.provider_turn_seq} BETWEEN 1 AND 9007199254740991
      AND typeof(${table.turn_key})='text' AND length(CAST(${table.turn_key} AS BLOB))=64 AND ${table.turn_key} NOT GLOB '*[^0-9a-f]*'
      AND json_type(${table.record}, '$.binding.rootWorkID') IS 'text' AND json_extract(${table.record}, '$.binding.rootWorkID') IS ${table.root_work_id}
      AND json_type(${table.record}, '$.binding.turn.activityID') IS 'text' AND json_extract(${table.record}, '$.binding.turn.activityID') IS ${table.activity_id}
      AND json_type(${table.record}, '$.binding.turn.providerTurnSeq') IS 'integer' AND json_extract(${table.record}, '$.binding.turn.providerTurnSeq') IS ${table.provider_turn_seq}
      AND json_type(${table.record}, '$.binding.turn.key') IS 'text' AND json_extract(${table.record}, '$.binding.turn.key') IS ${table.turn_key}))`),
  index("work_count_acquisition_deadline_idx").on(table.state, table.deadline),
  check("work_count_acquisition_id_check", sql`${table.acquisition_id} IS NOT NULL AND length(${table.acquisition_id}) > 0`),
  check("work_count_acquisition_state_check", sql`${table.state} IN ('prepared','sending','settled','failed','unknown')`),
  check("work_count_acquisition_revision_check", sql`${table.revision} > 0 AND ${table.approval_revision} > 0`),
  check("work_count_acquisition_record_check", sql`json_valid(${table.record}) AND length(${table.record_hash}) = 64 AND length(${table.record_mac}) = 64`),
  check("work_count_acquisition_time_check", sql`${table.created_at} >= 0 AND ${table.updated_at} >= ${table.created_at} AND ${table.deadline} > ${table.created_at}`),
  ...[table.revision, table.approval_revision, table.deadline, table.created_at, table.updated_at].map((column) =>
    check(`work_count_acquisition_${column.name}_integer_check`, sql`typeof(${column}) = 'integer' AND ${column} >= 0 AND ${column} <= 9007199254740991`)),
  ...[table.acquisition_id, table.work_id, table.input_id, table.session_id, table.provider_receipt_id,
    table.provider_attempt_id, table.approval_id, table.owner_token, table.boot_id].map((column) =>
    check(`work_count_acquisition_${column.name}_text_check`, sql`typeof(${column}) = 'text' AND length(CAST(${column} AS BLOB)) BETWEEN 1 AND 512`)),
  ...[table.binding_hash, table.record_hash, table.record_mac].map((column) =>
    check(`work_count_acquisition_${column.name}_digest_check`, sql`typeof(${column}) = 'text' AND length(CAST(${column} AS BLOB)) = 64 AND ${column} NOT GLOB '*[^0-9a-f]*'`)),
  check("work_count_acquisition_record_bytes_check", sql`typeof(${table.record}) = 'text' AND length(CAST(${table.record} AS BLOB)) BETWEEN 1 AND ${sql.raw(String(WorkCountAcquisitionSchema.MAX_RECORD_BYTES))}`),
])
