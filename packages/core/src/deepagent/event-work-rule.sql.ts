import { sql, type SQLWrapper } from "drizzle-orm"
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"

// Independent authority/custody domain. No Session/Event cascade: deleting a source must
// preserve its denial/accepted obligation, never turn a restricted identity into ordinary.
export const EventWorkRuleTable = sqliteTable("event_work_rule", {
  rule_id: text().primaryKey().notNull(), instance_id: text().notNull(), operator_id: text().notNull(),
  source_session_id: text().notNull(), revision: integer().notNull(), epoch: integer().notNull(),
  state: text().$type<"disabled" | "enabled" | "paused" | "revoked">().notNull(),
  record: text().notNull(), record_hash: text().notNull(), record_bytes: integer().notNull(),
}, (table) => [
  check("event_work_rule_record", record(table.record, table.record_bytes, 131072)),
  check("event_work_rule_revision", sql`${table.revision}>0 AND ${table.epoch}>0 AND ${table.state} IN ('disabled','enabled','paused','revoked')`),
  check("event_work_rule_hash", digest(table.record_hash)),
  check("event_work_rule_mirrors", sql`json_extract(${table.record},'$.ruleID') IS ${table.rule_id} AND json_extract(${table.record},'$.instanceID') IS ${table.instance_id} AND json_extract(${table.record},'$.operatorID') IS ${table.operator_id} AND json_extract(${table.record},'$.origin.sourceSessionID') IS ${table.source_session_id} AND json_extract(${table.record},'$.revision') IS ${table.revision} AND json_extract(${table.record},'$.epoch') IS ${table.epoch} AND json_extract(${table.record},'$.state') IS ${table.state}`),
  index("event_work_rule_source_idx").on(table.source_session_id, table.state),
])
export const EventWorkCommandTable = sqliteTable("event_work_command", {
  command_id: text().primaryKey().notNull(), instance_id: text().notNull(), operator_id: text().notNull(),
  request_id: text().notNull(), rule_id: text().notNull().references(() => EventWorkRuleTable.rule_id, { onDelete: "restrict", onUpdate: "restrict" }), action: text().$type<"create" | "enable" | "pause" | "revoke">().notNull(),
  request_hash: text().notNull(), record: text().notNull(), record_bytes: integer().notNull(), created_at: integer().notNull(),
}, (table) => [
  uniqueIndex("event_work_command_request_idx").on(table.instance_id, table.operator_id, table.request_id),
  check("event_work_command_record", record(table.record, table.record_bytes, 131072)),
  check("event_work_command_action", sql`${table.action} IN ('create','enable','pause','revoke') AND ${table.created_at}>0`),
  check("event_work_command_hash", digest(table.request_hash)),
])
export const EventWorkReceiptTable = sqliteTable("event_work_receipt", {
  receipt_id: text().primaryKey().notNull(), rule_id: text().notNull().references(() => EventWorkRuleTable.rule_id, { onDelete: "restrict", onUpdate: "restrict" }), instance_id: text().notNull(),
  occurrence_key: text().notNull(), event_id: text().notNull(), work_id: text().notNull(), session_id: text().notNull(), input_id: text().notNull(),
  phase: text().$type<"observed" | "reserved" | "ready">().notNull(), binding_hash: text(),
  record: text().notNull(), record_hash: text().notNull(), record_bytes: integer().notNull(), created_at: integer().notNull(),
}, (table) => [
  uniqueIndex("event_work_receipt_occurrence_idx").on(table.instance_id, table.rule_id, table.occurrence_key),
  uniqueIndex("event_work_receipt_event_idx").on(table.event_id),
  uniqueIndex("event_work_receipt_work_idx").on(table.work_id),
  uniqueIndex("event_work_receipt_session_idx").on(table.session_id),
  uniqueIndex("event_work_receipt_input_idx").on(table.input_id),
  index("event_work_receipt_due_idx").on(table.phase, table.created_at, table.receipt_id),
  check("event_work_receipt_record", record(table.record, table.record_bytes, 131072)),
  check("event_work_receipt_phase", sql`${table.phase} IN ('observed','reserved','ready') AND ((${table.phase}='observed' AND ${table.binding_hash} IS NULL) OR (${table.phase}<>'observed' AND ${digest(table.binding_hash)}))`),
  check("event_work_receipt_hashes", sql`${digest(table.occurrence_key)} AND ${digest(table.record_hash)}`),
  check("event_work_receipt_mirrors", sql`json_extract(${table.record},'$.receiptID') IS ${table.receipt_id} AND json_extract(${table.record},'$.ruleID') IS ${table.rule_id} AND json_extract(${table.record},'$.instanceID') IS ${table.instance_id} AND json_extract(${table.record},'$.eventID') IS ${table.event_id} AND json_extract(${table.record},'$.workID') IS ${table.work_id} AND json_extract(${table.record},'$.sessionID') IS ${table.session_id} AND json_extract(${table.record},'$.inputID') IS ${table.input_id}`),
])
// Future DAG authority is a distinct origin. E1 has no writer and cannot mint a node.
export const EventWorkNodeAuthorityTable = sqliteTable("event_work_node_authority", {
  authority_id: text().primaryKey().notNull(), receipt_id: text().notNull().references(() => EventWorkReceiptTable.receipt_id, { onDelete: "restrict", onUpdate: "restrict" }), node_id: text().notNull(),
  work_id: text().notNull(), state: text().$type<"pending" | "bound" | "terminal">().notNull(),
  record: text().notNull(), record_hash: text().notNull(), record_bytes: integer().notNull(),
}, (table) => [
  uniqueIndex("event_work_node_slot_idx").on(table.receipt_id, table.node_id),
  uniqueIndex("event_work_node_work_idx").on(table.work_id),
  check("event_work_node_record", record(table.record, table.record_bytes, 131072)),
  check("event_work_node_state", sql`${table.state} IN ('pending','bound','terminal')`),
  check("event_work_node_hash", digest(table.record_hash)),
])

function digest(value: SQLWrapper) {
  return sql`typeof(${value})='text' AND length(${value})=64 AND length(CAST(${value} AS BLOB))=64 AND ${value} NOT GLOB '*[^0-9a-f]*'`
}
function record(value: SQLWrapper, bytes: SQLWrapper, limit: number) {
  return sql`typeof(${bytes})='integer' AND ${bytes} BETWEEN 2 AND ${sql.raw(String(limit))} AND ${bytes}=length(CAST(${value} AS BLOB)) AND CASE WHEN typeof(${value})='text' AND instr(${value},char(0))=0 AND json_valid(${value}) THEN coalesce(json_type(${value})='object' AND json_extract(${value},'$.version')=1,0) ELSE 0 END`
}
