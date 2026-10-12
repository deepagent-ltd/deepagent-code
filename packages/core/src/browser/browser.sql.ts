import { sql } from "drizzle-orm"
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { BrowserSchema } from "./schema"

// Business identities survive host/Session deletion. Tool execution authority remains solely
// session_v2_tool_effect_admission/effect; these records cannot authorize replay after a crash.
export const BrowserControlTable = sqliteTable("browser_control", {
  control_id: text().primaryKey().notNull(),
  request_id: text().notNull(),
  request_digest: text().notNull(),
  principal: text().notNull(),
  security_namespace_id: text().notNull(),
  location_key: text().notNull(),
  project_scope_key: text().notNull(),
  namespace_binding_hash: text().notNull(),
  session_id: text().notNull(),
  project_id: text().notNull(),
  directory: text().notNull(),
  host_id: text().notNull(),
  host_incarnation: text().notNull(),
  resource_id: text().notNull(),
  credential_binding: text().notNull(),
  profile: text().notNull(),
  origin: text().notNull(),
  revision: integer().notNull(),
  epoch: integer().notNull(),
  policy_revision: integer().notNull(),
  state: text().$type<BrowserSchema.Control["state"]>().notNull(),
  expires_at: integer().notNull(),
  record: text().notNull(),
  record_hash: text().notNull(),
  created_at: integer().notNull(),
  updated_at: integer().notNull(),
}, (table) => [
  uniqueIndex("browser_control_request_idx").on(table.principal, table.session_id, table.request_id),
  uniqueIndex("browser_control_resource_idx").on(table.host_incarnation, table.resource_id),
  index("browser_control_state_idx").on(table.host_incarnation, table.state),
  check("browser_control_state_check", sql`${table.state} IN ('creating','active','cancel_requested','stopped','unknown')`),
  check("browser_control_profile_check", sql`${table.profile} IN ('managed-loopback-preview-v1','managed-loopback-interaction-v1','managed-public-readonly-v1','managed-loopback-exchange-v1','managed-public-interaction-v1','managed-public-api-v1')`),
  check("browser_control_revision_check", sql`${table.revision} > 0 AND ${table.epoch} > 0 AND ${table.policy_revision} > 0`),
  check("browser_control_time_check", sql`${table.updated_at} >= ${table.created_at} AND ${table.expires_at} > ${table.created_at}`),
  check("browser_control_record_check", sql`typeof(${table.record}) = 'text' AND length(CAST(${table.record} AS BLOB)) BETWEEN 1 AND ${sql.raw(String(BrowserSchema.MAX_CONTROL_BYTES))} AND json_valid(${table.record})`),
  ...[table.control_id, table.request_id, table.principal, table.security_namespace_id, table.location_key,
    table.project_scope_key, table.session_id, table.project_id, table.host_id,
    table.host_incarnation, table.resource_id, table.profile].map((column) =>
    check(`browser_control_${column.name}_text_check`, sql`typeof(${column}) = 'text' AND length(CAST(${column} AS BLOB)) BETWEEN 1 AND 512`)),
  ...[table.directory, table.origin].map((column) =>
    check(`browser_control_${column.name}_text_check`, sql`typeof(${column}) = 'text' AND length(CAST(${column} AS BLOB)) BETWEEN 1 AND 2048`)),
  ...[table.revision, table.epoch, table.policy_revision, table.expires_at, table.created_at, table.updated_at].map((column) =>
    check(`browser_control_${column.name}_integer_check`, sql`typeof(${column}) = 'integer' AND ${column} >= 0 AND ${column} <= 9007199254740991`)),
  ...[table.request_digest, table.record_hash, table.namespace_binding_hash, table.credential_binding].map((column) =>
    check(`browser_control_${column.name}_digest_check`, sql`typeof(${column}) = 'text' AND length(CAST(${column} AS BLOB)) = 64 AND ${column} NOT GLOB '*[^0-9a-f]*'`)),
])

export const BrowserActionTable = sqliteTable("browser_action", {
  action_id: text().primaryKey().notNull(),
  control_id: text().notNull(),
  request_id: text().notNull(),
  command_digest: text().notNull(),
  admission_id: text().notNull(),
  provider_receipt_id: text().notNull(),
  provider_attempt_id: text().notNull(),
  tool_call_id: text().notNull(),
  session_id: text().notNull(),
  host_incarnation: text().notNull(),
  resource_id: text().notNull(),
  control_epoch: integer().notNull(),
  policy_revision: integer().notNull(),
  revision: integer().notNull(),
  deadline: integer().notNull(),
  outcome: text().$type<BrowserSchema.Action["outcome"]>().notNull(),
  record: text().notNull(),
  record_hash: text().notNull(),
  created_at: integer().notNull(),
  updated_at: integer().notNull(),
}, (table) => [
  uniqueIndex("browser_action_request_idx").on(table.control_id, table.request_id),
  uniqueIndex("browser_action_admission_idx").on(table.admission_id),
  uniqueIndex("browser_action_call_idx").on(table.provider_receipt_id, table.tool_call_id),
  index("browser_action_control_outcome_idx").on(table.control_id, table.outcome),
  check("browser_action_outcome_check", sql`${table.outcome} IN ('pending','completed','failed','cancelled','unknown')`),
  check("browser_action_revision_check", sql`${table.revision} > 0 AND ${table.control_epoch} > 0 AND ${table.policy_revision} > 0`),
  check("browser_action_time_check", sql`${table.updated_at} >= ${table.created_at} AND ${table.deadline} > ${table.created_at}`),
  check("browser_action_record_check", sql`typeof(${table.record}) = 'text' AND length(CAST(${table.record} AS BLOB)) BETWEEN 1 AND ${sql.raw(String(BrowserSchema.MAX_ACTION_BYTES))} AND json_valid(${table.record})`),
  ...[table.action_id, table.control_id, table.request_id, table.admission_id, table.provider_receipt_id,
    table.provider_attempt_id, table.tool_call_id, table.session_id, table.host_incarnation, table.resource_id].map((column) =>
    check(`browser_action_${column.name}_text_check`, sql`typeof(${column}) = 'text' AND length(CAST(${column} AS BLOB)) BETWEEN 1 AND 512`)),
  ...[table.revision, table.control_epoch, table.policy_revision, table.deadline, table.created_at, table.updated_at].map((column) =>
    check(`browser_action_${column.name}_integer_check`, sql`typeof(${column}) = 'integer' AND ${column} >= 0 AND ${column} <= 9007199254740991`)),
  ...[table.command_digest, table.record_hash].map((column) =>
    check(`browser_action_${column.name}_digest_check`, sql`typeof(${column}) = 'text' AND length(CAST(${column} AS BLOB)) = 64 AND ${column} NOT GLOB '*[^0-9a-f]*'`)),
])
