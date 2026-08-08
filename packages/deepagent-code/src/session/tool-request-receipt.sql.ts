// BUG-009: drizzle-orm type bindings for session_tool_request_receipt.
// One row per physical Provider dispatch — maps the registry→filter→wire pipeline.
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

export type RequestReceiptState = "prepared" | "dispatched" | "rejected"
export type AdapterToolCapability = "supported" | "unsupported" | "unknown"
export type AdapterLoweringOutcome = "ok" | "schema_rejected" | "omitted_no_support"

export const SessionToolRequestReceiptTable = sqliteTable("session_tool_request_receipt", {
  receipt_id: text().primaryKey().notNull(),
  request_ordinal: integer().notNull(),
  session_id: text().notNull(),
  user_message_id: text().notNull(),
  assistant_message_id: text(),
  provider_attempt_id: text(),
  provider_id: text().notNull(),
  model_id: text().notNull(),
  protocol: text(),
  registry_tool_ids: text({ mode: "json" }).$type<string[]>().notNull(),
  permission_filtered_tool_ids: text({ mode: "json" }).$type<string[]>().notNull(),
  final_offered_tool_ids: text({ mode: "json" }).$type<string[]>().notNull(),
  call_ids: text({ mode: "json" }).$type<string[]>().notNull(),
  tool_definition_hash: text(),
  tool_choice_mode: text(),
  adapter_tool_capability: text().$type<AdapterToolCapability>(),
  adapter_lowering_outcome: text().$type<AdapterLoweringOutcome>(),
  estimated_input_tokens: integer(),
  physical_input_budget: integer(),
  reserved_output_tokens: integer(),
  safety_margin_tokens: integer(),
  context_limit_provenance: text().$type<"model_limit" | "host_guard">(),
  request_state: text().$type<RequestReceiptState>().notNull(),
  request_error_code: text(),
  created_at: integer().notNull(),
})
