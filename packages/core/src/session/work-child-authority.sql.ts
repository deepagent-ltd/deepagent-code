import { sql } from "drizzle-orm"
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import type { WorkChildAuthoritySchema } from "./work-child-authority.schema"

/** No cascading foreign keys: unknown execution retains the original derived authority. */
export const WorkChildAuthorityTable = sqliteTable("work_child_authority", {
  child_work_id: text().primaryKey().notNull(), root_work_id: text().notNull(), parent_work_id: text().notNull(),
  task_run_id: text().notNull(), admission_id: text().notNull(), child_session_id: text().notNull(),
  child_input_id: text().notNull(), child_binding_hash: text().notNull(),
  parent_binding_hash: text().notNull(), root_binding_hash: text().notNull(),
  parent_revision: integer().notNull(), root_revision: integer().notNull(),
  record: text({ mode: "json" }).$type<WorkChildAuthoritySchema.Record>().notNull(),
  record_hash: text().notNull(), expires_at: integer().notNull(), created_at: integer().notNull(),
}, (table) => [
  uniqueIndex("work_child_authority_run_idx").on(table.task_run_id),
  uniqueIndex("work_child_authority_admission_idx").on(table.admission_id),
  uniqueIndex("work_child_authority_session_idx").on(table.child_session_id),
  uniqueIndex("work_child_authority_input_idx").on(table.child_input_id),
  index("work_child_authority_root_idx").on(table.root_work_id),
  check("work_child_authority_text_check", sql.join([table.child_work_id, table.root_work_id, table.parent_work_id,
    table.task_run_id, table.admission_id, table.child_session_id, table.child_input_id].map((column) =>
    sql`typeof(${column})='text' AND length(CAST(${column} AS BLOB)) BETWEEN 1 AND 512 AND instr(${column},char(0))=0`), sql` AND `)),
  check("work_child_authority_lineage_check", sql`${table.child_work_id} != ${table.parent_work_id} AND ${table.parent_work_id} = ${table.root_work_id}`),
  check("work_child_authority_revision_check", sql`typeof(${table.parent_revision})='integer' AND ${table.parent_revision} BETWEEN 1 AND 9007199254740991 AND typeof(${table.root_revision})='integer' AND ${table.root_revision} BETWEEN 1 AND 9007199254740991`),
  check("work_child_authority_time_check", sql`typeof(${table.created_at})='integer' AND ${table.created_at} BETWEEN 0 AND 9007199254740991 AND typeof(${table.expires_at})='integer' AND ${table.expires_at} BETWEEN 1 AND 9007199254740991 AND ${table.expires_at}>${table.created_at}`),
  check("work_child_authority_hash_check", sql`length(${table.record_hash})=64 AND ${table.record_hash} NOT GLOB '*[^0-9a-f]*' AND length(${table.child_binding_hash})=64 AND ${table.child_binding_hash} NOT GLOB '*[^0-9a-f]*' AND length(${table.parent_binding_hash})=64 AND ${table.parent_binding_hash} NOT GLOB '*[^0-9a-f]*' AND length(${table.root_binding_hash})=64 AND ${table.root_binding_hash} NOT GLOB '*[^0-9a-f]*'`),
  check("work_child_authority_record_check", sql`json_valid(${table.record}) AND length(CAST(${table.record} AS BLOB)) BETWEEN 2 AND 196608 AND json_type(${table.record})='object' AND json_extract(${table.record},'$.version') IS 1 AND json_extract(${table.record},'$.childWorkID') IS ${table.child_work_id} AND json_extract(${table.record},'$.rootWorkID') IS ${table.root_work_id} AND json_extract(${table.record},'$.parentWorkID') IS ${table.parent_work_id} AND json_extract(${table.record},'$.taskRunID') IS ${table.task_run_id} AND json_extract(${table.record},'$.admissionID') IS ${table.admission_id} AND json_extract(${table.record},'$.childSessionID') IS ${table.child_session_id} AND json_extract(${table.record},'$.childInputID') IS ${table.child_input_id} AND json_extract(${table.record},'$.childBindingHash') IS ${table.child_binding_hash} AND json_extract(${table.record},'$.parentBindingHash') IS ${table.parent_binding_hash} AND json_extract(${table.record},'$.rootBindingHash') IS ${table.root_binding_hash} AND json_extract(${table.record},'$.parentRevision') IS ${table.parent_revision} AND json_extract(${table.record},'$.rootRevision') IS ${table.root_revision} AND json_extract(${table.record},'$.expiresAt') IS ${table.expires_at} AND json_extract(${table.record},'$.createdAt') IS ${table.created_at}`),
  check("work_child_authority_parent_check", sql`json_extract(${table.record},'$.parentBinding.workID') IS ${table.parent_work_id} AND json_extract(${table.record},'$.rootBinding.workID') IS ${table.root_work_id} AND json_extract(${table.record},'$.parentBinding.rootWorkID') IS ${table.root_work_id} AND json_extract(${table.record},'$.rootBinding.rootWorkID') IS ${table.root_work_id} AND json_extract(${table.record},'$.parentBinding.sessionID') IS json_extract(${table.record},'$.parentSessionID') AND json_extract(${table.record},'$.rootBinding.sessionID') IS json_extract(${table.record},'$.parentSessionID') AND json_extract(${table.record},'$.parentBinding.inputID') IS json_extract(${table.record},'$.triggerInputID') AND json_extract(${table.record},'$.rootBinding.inputID') IS json_extract(${table.record},'$.triggerInputID') AND json_extract(${table.record},'$.parentBinding.profile.id') IS 'project_shared_root_v1' AND json_extract(${table.record},'$.rootBinding.profile.id') IS 'project_shared_root_v1' AND json_extract(${table.record},'$.parentBinding.schemaVersion') IS 'work-execution.v2' AND json_extract(${table.record},'$.rootBinding.schemaVersion') IS 'work-execution.v2' AND json_type(${table.record},'$.parentBinding.parentWorkID') IS NULL AND json_type(${table.record},'$.rootBinding.parentWorkID') IS NULL`),
  check("work_child_authority_record_ids_check", sql.join(['parentSessionID','parentMessageID','toolCallID','receiptID','attemptID','ownerToken','activityID','triggerInputID','registrationGeneration'].map((key) =>
    sql`json_type(${table.record},${sql.raw("'$.".concat(key, "'"))}) IS 'text' AND length(CAST(json_extract(${table.record},${sql.raw("'$.".concat(key, "'"))}) AS BLOB)) BETWEEN 1 AND 512 AND instr(json_extract(${table.record},${sql.raw("'$.".concat(key, "'"))}),char(0))=0`), sql` AND `)),
  check("work_child_authority_record_counts_check", sql.join(['sessionClaimToken','expectedInputSeq'].map((key) =>
    sql`json_type(${table.record},${sql.raw("'$.".concat(key, "'"))}) IS 'integer' AND json_extract(${table.record},${sql.raw("'$.".concat(key, "'"))}) BETWEEN 1 AND 9007199254740991`), sql` AND `)),
  check("work_child_authority_ordinal_check", sql`json_type(${table.record},'$.activityOrdinal') IS 'integer' AND json_extract(${table.record},'$.activityOrdinal') BETWEEN 0 AND 9007199254740991`),
])
