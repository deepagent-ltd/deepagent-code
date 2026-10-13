import { sql } from "drizzle-orm"
import { check, foreignKey, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { V2ToolEffectAdmissionTable } from "./runner/v2-tool-effect.sql"
import { WorkWindowsIdentitySql } from "./work-windows-identity.sql"

// Admission is bounded; real retained growth must still be observable after an
// external fault exceeds the budget. Only the verified custodian releases it.
export const WorkCommandMeterTable = sqliteTable("work_command_meter", {
  instance_id: text().primaryKey().notNull(),
  custody_count: integer().notNull(),
  retained_bytes: integer().notNull(),
  audit_count: integer().notNull(),
  revision: integer().notNull(),
  updated_at: integer().notNull(),
}, (table) => [
  check("work_command_meter_instance_check", sql`typeof(${table.instance_id})='text' AND length(CAST(${table.instance_id} AS BLOB)) BETWEEN 1 AND 512 AND instr(${table.instance_id},char(0))=0`),
  check("work_command_meter_count_check", sql`typeof(${table.custody_count})='integer' AND ${table.custody_count} BETWEEN 0 AND 8 AND typeof(${table.audit_count})='integer' AND ${table.audit_count} BETWEEN 0 AND 10000 AND ${table.custody_count}<=${table.audit_count}`),
  check("work_command_meter_bytes_check", sql`typeof(${table.retained_bytes})='integer' AND ${table.retained_bytes} BETWEEN 0 AND 9007199254740991`),
  check("work_command_meter_time_check", sql`typeof(${table.revision})='integer' AND ${table.revision} BETWEEN 1 AND 9007199254740991 AND typeof(${table.updated_at})='integer' AND ${table.updated_at} BETWEEN 1 AND 9007199254740991`),
])

// Business intent and private workspace custody. V2ToolEffect remains the sole
// tool dispatcher; neither a persisted PID nor JSON is an executable handle.
export const WorkCommandIntentTable = sqliteTable("work_command_intent", {
  command_id: text().primaryKey().notNull(),
  admission_id: text().notNull(),
  instance_id: text().notNull(),
  work_id: text().notNull(),
  root_work_id: text().notNull(),
  session_id: text().notNull(),
  input_id: text().notNull(),
  activity_id: text().notNull(),
  provider_receipt_id: text().notNull(),
  provider_attempt_id: text().notNull(),
  tool_call_id: text().notNull(),
  owner_token: text().notNull(),
  session_claim_token: integer().notNull(),
  binding_hash: text().notNull(),
  control_revision: integer().notNull(),
  recipe_id: text().notNull(),
  recipe_revision: integer().notNull(),
  recipe_hash: text().notNull(),
  request_hash: text().notNull(),
  helper_hash: text().notNull(),
  runtime_hash: text().notNull(),
  workspace_basename: text().notNull(),
  state: text().$type<"reserved" | "prepared" | "dispatching" | "settled" | "unknown">().notNull(),
  outcome: text().$type<"exited" | "cancelled" | "refused_before_dispatch">(),
  revision: integer().notNull(),
  reserved_bytes: integer().notNull(),
  observed_retained_bytes: integer().notNull(),
  record: text().notNull(),
  record_hash: text().notNull(),
  created_at: integer().notNull(),
  updated_at: integer().notNull(),
  prepared_at: integer(),
  dispatched_at: integer(),
  terminal_at: integer(),
  released_at: integer(),
  deadline: integer().notNull(),
}, (table) => [
  uniqueIndex("work_command_intent_admission_idx").on(table.admission_id),
  index("work_command_intent_custody_idx").on(table.instance_id, table.released_at, table.command_id),
  index("work_command_intent_work_idx").on(table.work_id, table.created_at, table.command_id),
  foreignKey({ columns: [table.instance_id], foreignColumns: [WorkCommandMeterTable.instance_id] }).onDelete("restrict").onUpdate("restrict"),
  foreignKey({ columns: [table.admission_id], foreignColumns: [V2ToolEffectAdmissionTable.admission_id] }).onDelete("restrict").onUpdate("restrict"),
  ...[table.command_id, table.admission_id, table.instance_id, table.work_id, table.root_work_id,
    table.session_id, table.input_id, table.activity_id, table.provider_receipt_id, table.provider_attempt_id,
    table.tool_call_id, table.owner_token, table.recipe_id].map((column) =>
    check(`work_command_intent_${column.name}_text_check`, sql`typeof(${column})='text' AND length(CAST(${column} AS BLOB)) BETWEEN 1 AND 512 AND instr(${column},char(0))=0`)),
  ...[table.binding_hash, table.recipe_hash, table.request_hash, table.helper_hash, table.runtime_hash, table.record_hash].map((column) =>
    check(`work_command_intent_${column.name}_hash_check`, sql`typeof(${column})='text' AND length(CAST(${column} AS BLOB))=64 AND ${column} NOT GLOB '*[^0-9a-f]*'`)),
  ...[table.session_claim_token, table.control_revision, table.recipe_revision, table.revision,
    table.created_at, table.updated_at, table.deadline].map((column) =>
    check(`work_command_intent_${column.name}_integer_check`, sql`typeof(${column})='integer' AND ${column} BETWEEN 1 AND 9007199254740991`)),
  ...[table.reserved_bytes, table.observed_retained_bytes].map((column) =>
    check(`work_command_intent_${column.name}_bytes_check`, sql`typeof(${column})='integer' AND ${column} BETWEEN 0 AND 9007199254740991`)),
  ...[table.prepared_at, table.dispatched_at, table.terminal_at, table.released_at].map((column) =>
    check(`work_command_intent_${column.name}_time_check`, sql`${column} IS NULL OR (typeof(${column})='integer' AND ${column} BETWEEN ${table.created_at} AND ${table.updated_at})`)),
  check("work_command_intent_basename_check", sql`typeof(${table.workspace_basename})='text' AND length(CAST(${table.workspace_basename} AS BLOB))=36 AND substr(${table.workspace_basename},1,4)='cmd_' AND substr(${table.workspace_basename},5) NOT GLOB '*[^0-9a-f]*'`),
  check("work_command_intent_time_check", sql`${table.updated_at}>=${table.created_at} AND ${table.deadline}>${table.created_at} AND (${table.dispatched_at} IS NULL OR (${table.prepared_at} IS NOT NULL AND ${table.dispatched_at}>=${table.prepared_at})) AND (${table.terminal_at} IS NULL OR ${table.terminal_at}>=coalesce(${table.dispatched_at},${table.prepared_at},${table.created_at}))`),
  check("work_command_intent_state_check", sql`${table.state} IN ('reserved','prepared','dispatching','settled','unknown') AND ((${table.state}='settled' AND ${table.terminal_at} IS NOT NULL AND ${table.outcome} IS NOT NULL AND ${table.outcome} IN ('exited','cancelled','refused_before_dispatch')) OR (${table.state}<>'settled' AND ${table.outcome} IS NULL AND ${table.terminal_at} IS NULL)) AND (${table.state}<>'reserved' OR (${table.prepared_at} IS NULL AND ${table.dispatched_at} IS NULL)) AND (${table.state}<>'prepared' OR (${table.prepared_at} IS NOT NULL AND ${table.dispatched_at} IS NULL)) AND (${table.state} NOT IN ('dispatching','unknown') OR ${table.dispatched_at} IS NOT NULL) AND (${table.state}<>'settled' OR (${table.outcome}='refused_before_dispatch' AND ${table.dispatched_at} IS NULL) OR (${table.outcome} IN ('exited','cancelled') AND ${table.dispatched_at} IS NOT NULL))`),
  check("work_command_intent_custody_check", sql`(${table.released_at} IS NULL AND ${table.reserved_bytes}>0) OR (${table.released_at} IS NOT NULL AND ${table.state}='settled' AND ${table.reserved_bytes}=0 AND ${table.observed_retained_bytes}=0)`),
  check("work_command_intent_record_check", sql`typeof(${table.record})='text' AND length(CAST(${table.record} AS BLOB)) BETWEEN 1 AND 32768 AND instr(${table.record},char(0))=0 AND json_valid(${table.record}) AND json_type(${table.record}) IS 'object' AND json_type(${table.record},'$.version') IS 'integer'
    AND (json_extract(${table.record},'$.version') IS 1 OR (json_extract(${table.record},'$.version') IS 2
      AND json_type(${table.record},'$.target') IS 'text' AND json_extract(${table.record},'$.target') IN ('win32-x64','win32-arm64')
      AND (json_type(${table.record},'$.workspaceIdentity') IS 'null' OR ${WorkWindowsIdentitySql.check(table.record, "$.workspaceIdentity")})
      AND json_type(${table.record},'$.outputs') IS 'array' AND json_array_length(${table.record},'$.outputs')<=32
      AND ${sql.join(Array.from({ length: 32 }, (_value, index) => sql`(json_array_length(${table.record},'$.outputs')<=${sql.raw(String(index))} OR ${WorkWindowsIdentitySql.check(table.record, `$.outputs[${index}].identity`)})`), sql` AND `)}))`),
  ...([
    [table.command_id, "commandID"], [table.admission_id, "admissionID"], [table.instance_id, "instanceID"],
    [table.work_id, "workID"], [table.root_work_id, "rootWorkID"], [table.session_id, "sessionID"],
    [table.input_id, "inputID"], [table.activity_id, "activityID"], [table.provider_receipt_id, "providerReceiptID"],
    [table.provider_attempt_id, "providerAttemptID"], [table.tool_call_id, "toolCallID"], [table.owner_token, "ownerToken"],
    [table.binding_hash, "bindingHash"], [table.recipe_id, "recipeID"], [table.recipe_hash, "recipeHash"],
    [table.request_hash, "requestHash"], [table.helper_hash, "helperHash"], [table.runtime_hash, "runtimeHash"],
    [table.workspace_basename, "workspaceBasename"], [table.state, "state"],
  ] as const).map(([column, field]) => check(`work_command_intent_${column.name}_mirror_check`, sql`json_type(${table.record},${sql.raw(`'$.${field}'`)}) IS 'text' AND json_extract(${table.record},${sql.raw(`'$.${field}'`)}) IS ${column}`)),
  ...([
    [table.session_claim_token, "sessionClaimToken"], [table.control_revision, "controlRevision"],
    [table.recipe_revision, "recipeRevision"], [table.revision, "revision"], [table.deadline, "deadline"],
    [table.reserved_bytes, "reservedBytes"], [table.observed_retained_bytes, "observedRetainedBytes"],
    [table.created_at, "createdAt"], [table.updated_at, "updatedAt"],
  ] as const).map(([column, field]) => check(`work_command_intent_${column.name}_mirror_check`, sql`json_type(${table.record},${sql.raw(`'$.${field}'`)}) IS 'integer' AND json_extract(${table.record},${sql.raw(`'$.${field}'`)}) IS ${column}`)),
  ...([
    [table.prepared_at, "preparedAt"], [table.dispatched_at, "dispatchedAt"],
    [table.terminal_at, "terminalAt"], [table.released_at, "releasedAt"],
  ] as const).map(([column, field]) => check(`work_command_intent_${column.name}_mirror_check`, sql`(${column} IS NULL AND json_type(${table.record},${sql.raw(`'$.${field}'`)}) IS 'null') OR (${column} IS NOT NULL AND json_type(${table.record},${sql.raw(`'$.${field}'`)}) IS 'integer' AND json_extract(${table.record},${sql.raw(`'$.${field}'`)}) IS ${column})`)),
  check("work_command_intent_outcome_mirror_check", sql`(${table.outcome} IS NULL AND json_type(${table.record},'$.outcome') IS 'null') OR (${table.outcome} IS NOT NULL AND json_type(${table.record},'$.outcome') IS 'text' AND json_extract(${table.record},'$.outcome') IS ${table.outcome})`),
  check("work_command_intent_workspace_check", sql`${table.prepared_at} IS NULL OR (json_type(${table.record},'$.workspaceIdentity') IS 'object' AND json_type(${table.record},'$.snapshotHash') IS 'text')`),
  check("work_command_intent_stop_check", sql`(json_type(${table.record},'$.stopConfirmed') IS 'true' OR json_type(${table.record},'$.stopConfirmed') IS 'false') AND (${table.state}<>'settled' OR json_type(${table.record},'$.stopConfirmed') IS 'true')`),
])
