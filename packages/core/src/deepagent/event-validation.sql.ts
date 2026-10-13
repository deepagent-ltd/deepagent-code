import { sql, type SQLWrapper } from "drizzle-orm"
import { check, foreignKey, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"

export const EventValidationRuleTable = sqliteTable("event_validation_rule", {
  rule_id: text().primaryKey().notNull(), instance_id: text().notNull(), project_key: text().notNull(),
  revision: integer().notNull(), state: text().notNull(), operator_id: text().notNull(), operator_revision: integer().notNull(),
  config_hash: text().notNull(), content_revision: integer().notNull(), content_hash: text(), run_count: integer().notNull(),
  pending_first_at: integer(), pending_last_at: integer(), due_at: integer(), current_run_id: text(), last_reason: text().notNull(),
  record: text().notNull(), record_hash: text().notNull(), created_at: integer().notNull(), updated_at: integer().notNull(),
  investigation_epoch: integer().notNull().default(0),
}, (table) => [
  check("event_validation_rule_ids", sql`${id(table.rule_id)} AND ${id(table.instance_id)} AND ${id(table.operator_id)} AND ${digest(table.project_key)} AND ${digest(table.config_hash)} AND ${digest(table.record_hash)} AND (${table.content_hash} IS NULL OR ${digest(table.content_hash)}) AND (${table.current_run_id} IS NULL OR ${id(table.current_run_id)})`),
  check("event_validation_rule_counters", sql`${count(table.revision, 1)} AND ${count(table.operator_revision, 1)} AND ${count(table.content_revision)} AND ${count(table.run_count, 0, 10000)}`),
  check("event_validation_rule_state", sql`${table.state} IN ('disabled','enabled','paused','revoked') AND ${table.last_reason} IN ('disabled','paused','revoked','debouncing','unchanged','ready','running','superseded','cancelled','expired','budget_exhausted','authority_changed','native_unavailable','unknown','completed')`),
  check("event_validation_rule_time", sql`${count(table.created_at, 1)} AND ${count(table.updated_at, 1)} AND ${table.updated_at}>=${table.created_at} AND ((${table.pending_first_at} IS NULL AND ${table.pending_last_at} IS NULL AND ${table.due_at} IS NULL) OR (${count(table.pending_first_at, 1)} AND ${count(table.pending_last_at, 1)} AND ${count(table.due_at, 1)} AND ${table.pending_last_at}>=${table.pending_first_at} AND ${table.due_at}>=${table.pending_first_at} AND ${table.due_at}<=${table.pending_first_at}+5000))`),
  check("event_validation_rule_record", json(table.record, 65536, [
    [table.rule_id, "ruleID", "text"], [table.instance_id, "instanceID", "text"], [table.project_key, "projectKey", "text"],
    [table.revision, "revision", "integer"], [table.state, "state", "text"], [table.operator_id, "operatorID", "text"],
    [table.operator_revision, "operatorRevision", "integer"], [table.config_hash, "configHash", "text"],
    [table.content_revision, "contentRevision", "integer"], [table.content_hash, "contentHash", "text|null"],
    [table.run_count, "runCount", "integer"], [table.pending_first_at, "pendingFirstAt", "integer|null"],
    [table.pending_last_at, "pendingLastAt", "integer|null"], [table.due_at, "dueAt", "integer|null"],
    [table.current_run_id, "currentRunID", "text|null"], [table.last_reason, "lastReason", "text"],
    [table.created_at, "createdAt", "integer"], [table.updated_at, "updatedAt", "integer"],
  ])),
  uniqueIndex("event_validation_rule_scope_idx").on(table.rule_id, table.instance_id, table.project_key),
  index("event_validation_rule_instance_idx").on(table.instance_id, table.rule_id),
  index("event_validation_rule_due_idx").on(table.state, table.due_at, table.rule_id),
])

export const EventValidationProjectTable = sqliteTable("event_validation_project", {
  project_key: text().primaryKey().notNull(), instance_id: text().notNull(), active_run_id: text(), owner_token: text(),
  revision: integer().notNull(), updated_at: integer().notNull(),
}, (table) => [
  check("event_validation_project_identity", sql`${digest(table.project_key)} AND ${id(table.instance_id)} AND (${table.active_run_id} IS NULL OR ${id(table.active_run_id)}) AND (${table.owner_token} IS NULL OR ${id(table.owner_token)})`),
  check("event_validation_project_owner", sql`(${table.active_run_id} IS NULL AND ${table.owner_token} IS NULL) OR (${table.active_run_id} IS NOT NULL AND ${table.owner_token} IS NOT NULL)`),
  check("event_validation_project_counters", sql`${count(table.revision, 1)} AND ${count(table.updated_at, 1)}`),
  uniqueIndex("event_validation_project_scope_idx").on(table.project_key, table.instance_id),
])

export const EventValidationRunTable = sqliteTable("event_validation_run", {
  run_id: text().primaryKey().notNull(), rule_id: text().notNull(), instance_id: text().notNull(), project_key: text().notNull(),
  rule_revision: integer().notNull(), content_revision: integer().notNull(), content_hash: text().notNull(), recipe_hash: text().notNull(),
  state: text().notNull(), outcome: text(), owner_token: text().notNull(), revision: integer().notNull(), cancel_requested: integer().notNull(),
  record: text().notNull(), record_hash: text().notNull(), retained_bytes: integer().notNull(), released_at: integer(),
  created_at: integer().notNull(), started_at: integer(), terminal_at: integer(), deadline: integer().notNull(),
}, (table) => [
  check("event_validation_run_ids", sql`${id(table.run_id)} AND ${id(table.rule_id)} AND ${id(table.instance_id)} AND ${id(table.owner_token)} AND ${digest(table.project_key)} AND ${digest(table.content_hash)} AND ${digest(table.recipe_hash)} AND ${digest(table.record_hash)}`),
  check("event_validation_run_counters", sql`${count(table.rule_revision, 1)} AND ${count(table.content_revision, 1)} AND ${count(table.revision, 1)} AND ${count(table.cancel_requested, 0, 1)} AND ${count(table.retained_bytes)}`),
  check("event_validation_run_state", sql`${table.state} IN ('queued','preparing','dispatching','settled','cancelled','superseded','unknown') AND (${table.outcome} IS NULL OR ${table.outcome} IN ('passed','failed','cancelled','refused'))`),
  check("event_validation_run_time", sql`${count(table.created_at, 1)} AND ${count(table.deadline, 1)} AND ${table.deadline}>${table.created_at} AND (${table.started_at} IS NULL OR (${count(table.started_at, 1)} AND ${table.started_at}>=${table.created_at})) AND (${table.terminal_at} IS NULL OR (${count(table.terminal_at, 1)} AND ${table.terminal_at}>=coalesce(${table.started_at},${table.created_at}))) AND (${table.released_at} IS NULL OR (${count(table.released_at, 1)} AND ${table.released_at}>=${table.created_at} AND ${table.retained_bytes}=0 AND ${table.state}<>'unknown'))`),
  check("event_validation_run_record", json(table.record, 262144, [
    [table.run_id, "runID", "text"], [table.rule_id, "ruleID", "text"], [table.instance_id, "instanceID", "text"], [table.project_key, "projectKey", "text"],
    [table.rule_revision, "ruleRevision", "integer"], [table.content_revision, "contentRevision", "integer"], [table.content_hash, "contentHash", "text"],
    [table.recipe_hash, "recipeHash", "text"], [table.state, "state", "text"], [table.outcome, "outcome", "text|null"],
    [table.owner_token, "ownerToken", "text"], [table.revision, "revision", "integer"], [table.cancel_requested, "cancelRequested", "true|false"],
    [table.retained_bytes, "retainedBytes", "integer"], [table.released_at, "releasedAt", "integer|null"],
    [table.created_at, "createdAt", "integer"], [table.started_at, "startedAt", "integer|null"],
    [table.terminal_at, "terminalAt", "integer|null"], [table.deadline, "deadline", "integer"],
  ])),
  foreignKey({ columns: [table.rule_id, table.instance_id, table.project_key], foreignColumns: [EventValidationRuleTable.rule_id, EventValidationRuleTable.instance_id, EventValidationRuleTable.project_key] }).onDelete("restrict").onUpdate("restrict"),
  uniqueIndex("event_validation_run_content_idx").on(table.rule_id, table.rule_revision, table.content_revision),
  uniqueIndex("event_validation_run_lineage_idx").on(table.run_id, table.rule_id, table.instance_id, table.project_key),
  index("event_validation_run_custody_idx").on(table.instance_id, table.released_at, table.run_id),
  index("event_validation_run_state_idx").on(table.state, table.created_at, table.run_id),
])

export const EventValidationCommandTable = sqliteTable("event_validation_command", {
  instance_id: text().notNull(), request_id: text().notNull(), rule_id: text().notNull(), action: text().notNull(),
  request_hash: text().notNull(), receipt: text().notNull(), created_at: integer().notNull(),
}, (table) => [
  primaryKey({ columns: [table.instance_id, table.request_id] }),
  check("event_validation_command_ids", sql`${id(table.instance_id)} AND ${id(table.request_id)} AND ${id(table.rule_id)} AND ${digest(table.request_hash)} AND ${count(table.created_at, 1)}`),
  check("event_validation_command_action", sql`${table.action} IN ('create','update','enable','pause','revoke','verify','cancel')`),
  check("event_validation_command_receipt", json(table.receipt, 8192, [
    [table.instance_id, "instanceID", "text"], [table.request_id, "requestID", "text"], [table.rule_id, "ruleID", "text"],
    [table.action, "action", "text"], [table.created_at, "createdAt", "integer"],
  ])),
  index("event_validation_command_rule_idx").on(table.instance_id, table.rule_id, table.created_at),
])

function id(column: SQLWrapper) {
  return sql`typeof(${column})='text' AND length(CAST(${column} AS BLOB)) BETWEEN 1 AND 512 AND instr(${column},char(0))=0`
}

function digest(column: SQLWrapper) {
  return sql`typeof(${column})='text' AND length(CAST(${column} AS BLOB))=64 AND length(${column})=64 AND ${column} NOT GLOB '*[^0-9a-f]*'`
}

function count(column: SQLWrapper, minimum = 0, maximum = 9007199254740991) {
  return sql`typeof(${column})='integer' AND ${column} BETWEEN ${sql.raw(String(minimum))} AND ${sql.raw(String(maximum))}`
}

// Guard JSON evaluation and distinguish missing keys, explicit null, integers,
// and booleans. Mirrors are facts, not native execution or operator authority.
function json(record: SQLWrapper, maximum: number, mirrors: readonly (readonly [SQLWrapper, string, string])[]) {
  return sql`CASE WHEN typeof(${record})='text' AND length(CAST(${record} AS BLOB)) BETWEEN 2 AND ${sql.raw(String(maximum))} AND instr(${record},char(0))=0 AND json_valid(${record}) THEN coalesce(json_type(${record})='object' AND json_type(${record},'$.version')='integer' AND json_extract(${record},'$.version')=1 AND ${sql.join(mirrors.map((entry) => sql`(json_type(${record},${sql.raw(`'$.${entry[1]}'`)}) IN (${sql.join(entry[2].split("|").map((type) => sql.raw(`'${type}'`)), sql`,`)}) AND json_extract(${record},${sql.raw(`'$.${entry[1]}'`)}) IS ${entry[0]})`), sql` AND `)},0) ELSE 0 END`
}
