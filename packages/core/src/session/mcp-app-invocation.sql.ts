import { sql } from "drizzle-orm"
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { SessionTable } from "./sql"
import type { McpAppInvocationSchema } from "./mcp-app-invocation.schema"

/** Source/input identity is independent of provider receipts. Body retirement keeps both hashes. */
export const McpAppInvocationTable = sqliteTable("session_mcp_app_invocation", {
  invocation_id: text().primaryKey(),
  session_id: text().notNull().references(() => SessionTable.id, { onDelete: "restrict" }),
  view_id: text().notNull(), rpc_id: text().notNull(), admitted_seq: integer().notNull(),
  source_kind: text().$type<"mcp_app">().notNull(), source: text({ mode: "json" }).$type<McpAppInvocationSchema.Source>().notNull(),
  source_hash: text().notNull(), input_hash: text().notNull(), arguments: text(), arguments_bytes: integer().notNull(),
  created_at: integer().notNull(), expires_at: integer().notNull(), arguments_retired_at: integer(),
}, (table) => [
  uniqueIndex("session_mcp_app_invocation_rpc_idx").on(table.view_id, table.rpc_id),
  index("session_mcp_app_invocation_session_idx").on(table.session_id, table.admitted_seq),
  check("session_mcp_app_invocation_source_check", sql`${table.source_kind}='mcp_app' AND json_valid(${table.source}) AND length(CAST(${table.source} AS BLOB)) BETWEEN 1 AND 16384 AND json_extract(${table.source}, '$.kind')='mcp_app' AND json_extract(${table.source}, '$.sessionID')=${table.session_id} AND json_extract(${table.source}, '$.viewID')=${table.view_id} AND length(${table.source_hash})=64 AND length(${table.input_hash})=64 AND ${table.expires_at}>${table.created_at} AND ${table.expires_at}<=json_extract(${table.source}, '$.expiresAt') AND ${table.admitted_seq}>=0`),
  check("session_mcp_app_invocation_body_check", sql`(${table.arguments} IS NOT NULL AND json_valid(${table.arguments}) AND json_type(${table.arguments})='object' AND length(CAST(${table.arguments} AS BLOB))=${table.arguments_bytes} AND ${table.arguments_bytes} BETWEEN 2 AND 32768 AND ${table.arguments_retired_at} IS NULL) OR (${table.arguments} IS NULL AND ${table.arguments_bytes}=0 AND ${table.arguments_retired_at} IS NOT NULL)`),
])

/** Dispatch reservation commits before transport. Unknown never loses its receipt or reservation. */
export const McpAppEffectTable = sqliteTable("session_mcp_app_effect", {
  invocation_id: text().primaryKey().references(() => McpAppInvocationTable.invocation_id, { onDelete: "restrict" }),
  state: text().$type<McpAppInvocationSchema.State>().notNull(), revision: integer().notNull(),
  owner_nonce: text(), session_claim_token: integer(), permission: text({ mode: "json" }).$type<Record<string, unknown>>(),
  reserved_bytes: integer().notNull().default(0), dispatched_at: integer(), terminal_at: integer(),
  result: text(), result_hash: text(), result_bytes: integer().notNull().default(0), result_retired_at: integer(),
  error_code: text().$type<McpAppInvocationSchema.Error["code"]>(),
}, (table) => [
  index("session_mcp_app_effect_pending_idx").on(table.state),
  check("session_mcp_app_effect_state_check", sql`${table.state} IN ('queued','awaiting_permission','dispatching','settled','failed','cancelled_before_dispatch','unknown') AND ${table.revision}>0 AND ${table.reserved_bytes} BETWEEN 0 AND 8388608 AND ${table.result_bytes} BETWEEN 0 AND 8388608`),
  check("session_mcp_app_effect_dispatch_check", sql`(${table.state} IN ('queued','awaiting_permission','cancelled_before_dispatch') AND ${table.dispatched_at} IS NULL AND ${table.owner_nonce} IS NULL AND ${table.session_claim_token} IS NULL) OR (${table.state} IN ('dispatching','settled','failed','unknown') AND ${table.dispatched_at} IS NOT NULL AND ${table.owner_nonce} IS NOT NULL AND ${table.session_claim_token}>0)`),
  check("session_mcp_app_effect_result_check", sql`(${table.result} IS NULL AND ${table.result_bytes}=0) OR (${table.result} IS NOT NULL AND json_valid(${table.result}) AND json_type(${table.result})='object' AND length(CAST(${table.result} AS BLOB))=${table.result_bytes} AND length(${table.result_hash})=64 AND ${table.state} IN ('settled','failed') AND ${table.result_retired_at} IS NULL)`),
  check("session_mcp_app_effect_custody_check", sql`(${table.state} IN ('queued','awaiting_permission','cancelled_before_dispatch') AND ${table.reserved_bytes}=0 AND ${table.result_hash} IS NULL AND ${table.result_retired_at} IS NULL) OR (${table.state}='dispatching' AND ${table.reserved_bytes}=8388608 AND ${table.result_hash} IS NULL AND ${table.result_retired_at} IS NULL) OR (${table.state}='unknown' AND ${table.reserved_bytes}=8388608 AND ${table.result} IS NULL AND ${table.result_hash} IS NULL AND ${table.result_retired_at} IS NULL) OR (${table.state} IN ('settled','failed') AND ${table.reserved_bytes}=0 AND (${table.result_hash} IS NULL OR length(${table.result_hash})=64) AND (${table.result_retired_at} IS NULL OR (${table.result} IS NULL AND ${table.result_hash} IS NOT NULL)))`),
  check("session_mcp_app_effect_permission_check", sql`${table.permission} IS NULL OR (json_valid(${table.permission}) AND json_type(${table.permission})='object' AND length(CAST(${table.permission} AS BLOB)) BETWEEN 1 AND 4096)`),
  check("session_mcp_app_effect_terminal_check", sql`(${table.state} IN ('queued','awaiting_permission','dispatching') AND ${table.terminal_at} IS NULL) OR (${table.state} IN ('settled','failed','cancelled_before_dispatch','unknown') AND ${table.terminal_at} IS NOT NULL)`),
])
