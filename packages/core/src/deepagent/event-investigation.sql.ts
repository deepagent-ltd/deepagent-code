import { sql, type SQLWrapper } from "drizzle-orm"
import { check, foreignKey, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { SecurityNamespaceTable } from "../context-federation/sql"
import { EventValidationRuleTable, EventValidationRunTable } from "./event-validation.sql"

/** Immutable business evidence. Work is reserved after this insert in the same
 * transaction, so no immediate FK to the not-yet-created Work is possible.
 * Forward migration guards also bound nested evidence/grant/audited text and
 * require current known-failed, released lineage; SQL mirrors grant no authority. */
export const EventInvestigationReceiptTable = sqliteTable("event_validation_investigation_receipt", {
  receipt_id: text().primaryKey().notNull(), instance_id: text().notNull(), rule_id: text().notNull(),
  project_key: text().notNull(), security_namespace_id: text().notNull(),
  content_revision: integer().notNull(), content_hash: text().notNull(), recipe_hash: text().notNull(),
  failure_key: text().notNull(), run_id: text().notNull(), grant_epoch: integer().notNull(), authority_hash: text().notNull(),
  work_id: text().notNull(), root_work_id: text().notNull(), session_id: text().notNull(), input_id: text().notNull(),
  source_request_id: text().notNull(), binding_hash: text().notNull(), deadline: integer().notNull(), created_at: integer().notNull(),
  record: text().notNull(), record_hash: text().notNull(), record_bytes: integer().notNull(),
}, (table) => [
  check("event_investigation_receipt_ids", sql`${sql.join([table.receipt_id, table.instance_id, table.rule_id, table.security_namespace_id, table.run_id, table.work_id, table.root_work_id, table.session_id, table.input_id, table.source_request_id].map(id), sql` AND `)} AND ${table.root_work_id}=${table.work_id} AND ${table.source_request_id}=${table.failure_key}`),
  check("event_investigation_receipt_hashes", sql`${sql.join([table.project_key, table.content_hash, table.recipe_hash, table.failure_key, table.authority_hash, table.binding_hash, table.record_hash].map(digest), sql` AND `)}`),
  check("event_investigation_receipt_counters", sql`${positive(table.content_revision)} AND ${positive(table.grant_epoch)} AND ${positive(table.deadline)} AND ${positive(table.created_at)} AND ${table.deadline}>${table.created_at} AND typeof(${table.record_bytes})='integer' AND ${table.record_bytes} BETWEEN 2 AND 262144 AND ${table.record_bytes}=length(CAST(${table.record} AS BLOB))`),
  check("event_investigation_receipt_record", json(table.record, [
    [table.receipt_id, "receiptID", "text"], [table.instance_id, "instanceID", "text"], [table.rule_id, "ruleID", "text"],
    [table.project_key, "projectKey", "text"], [table.security_namespace_id, "securityNamespaceID", "text"],
    [table.content_revision, "contentRevision", "integer"], [table.content_hash, "contentHash", "text"],
    [table.recipe_hash, "recipeHash", "text"], [table.failure_key, "failureKey", "text"], [table.run_id, "runID", "text"],
    [table.grant_epoch, "grantEpoch", "integer"], [table.authority_hash, "authorityHash", "text"],
    [table.work_id, "workID", "text"], [table.root_work_id, "rootWorkID", "text"], [table.session_id, "sessionID", "text"],
    [table.input_id, "inputID", "text"], [table.source_request_id, "sourceRequestID", "text"],
    [table.binding_hash, "bindingHash", "text"], [table.deadline, "deadline", "integer"], [table.created_at, "createdAt", "integer"],
  ])),
  foreignKey({ columns: [table.rule_id, table.instance_id, table.project_key], foreignColumns: [EventValidationRuleTable.rule_id, EventValidationRuleTable.instance_id, EventValidationRuleTable.project_key] }).onDelete("restrict").onUpdate("restrict"),
  foreignKey({ columns: [table.run_id, table.rule_id, table.instance_id, table.project_key], foreignColumns: [EventValidationRunTable.run_id, EventValidationRunTable.rule_id, EventValidationRunTable.instance_id, EventValidationRunTable.project_key] }).onDelete("restrict").onUpdate("restrict"),
  foreignKey({ columns: [table.security_namespace_id], foreignColumns: [SecurityNamespaceTable.id] }).onDelete("restrict").onUpdate("restrict"),
  uniqueIndex("event_investigation_receipt_failure_idx").on(table.failure_key),
  uniqueIndex("event_investigation_receipt_content_idx").on(table.instance_id, table.rule_id, table.content_revision, table.content_hash, table.recipe_hash),
  uniqueIndex("event_investigation_receipt_work_idx").on(table.work_id),
  uniqueIndex("event_investigation_receipt_session_idx").on(table.session_id),
  uniqueIndex("event_investigation_receipt_input_idx").on(table.input_id),
  index("event_investigation_receipt_instance_idx").on(table.instance_id, table.created_at, table.receipt_id),
  index("event_investigation_receipt_scope_idx").on(table.security_namespace_id, table.project_key, table.created_at, table.receipt_id),
])

function id(column: SQLWrapper) {
  return sql`typeof(${column})='text' AND length(CAST(${column} AS BLOB)) BETWEEN 1 AND 512 AND instr(${column},char(0))=0`
}

function digest(column: SQLWrapper) {
  return sql`typeof(${column})='text' AND length(CAST(${column} AS BLOB))=64 AND length(${column})=64 AND ${column} NOT GLOB '*[^0-9a-f]*'`
}

function positive(column: SQLWrapper) {
  return sql`typeof(${column})='integer' AND ${column} BETWEEN 1 AND 9007199254740991`
}

function json(record: SQLWrapper, mirrors: readonly (readonly [SQLWrapper, string, string])[]) {
  return sql`CASE WHEN typeof(${record})='text' AND length(CAST(${record} AS BLOB)) BETWEEN 2 AND 262144 AND instr(${record},char(0))=0 AND json_valid(${record}) THEN coalesce(json_type(${record})='object' AND json_type(${record},'$.version')='integer' AND json_extract(${record},'$.version')=1 AND ${sql.join(mirrors.map((entry) => sql`(json_type(${record},${sql.raw(`'$.${entry[1]}'`)})=${sql.raw(`'${entry[2]}'`)} AND json_extract(${record},${sql.raw(`'$.${entry[1]}'`)}) IS ${entry[0]})`), sql` AND `)},0) ELSE 0 END`
}
