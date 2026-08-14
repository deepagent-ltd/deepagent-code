// BUG-009: drizzle-orm type bindings for session_tool_request_receipt.
// One row per physical Provider dispatch — maps the registry→filter→wire pipeline.
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { ContextFederationRollout } from "@deepagent-code/core/context-federation/rollout"
import type { ContextActivationReceipt } from "@/context-federation/activation-receipt"
import type { DocumentRef, StoredBindingState } from "@deepagent-code/core/deepagent/released-snapshot"
import type { ProjectScopeKey, SecurityNamespaceID } from "@deepagent-code/core/context-federation/reference"

export type RequestReceiptState = "prepared" | "dispatched" | "rejected"
export type ProviderReceiptState =
  | "preparing"
  | "prepared"
  | "dispatching"
  | "streaming"
  | "settled"
  | "failed"
  | "indeterminate_after_crash"
export type AdapterToolCapability = "supported" | "unsupported" | "unknown"
export type AdapterLoweringOutcome = "ok" | "schema_rejected" | "omitted_no_support"

export const SessionToolRequestReceiptTable = sqliteTable("session_tool_request_receipt", {
  receipt_id: text().primaryKey().notNull(),
  request_ordinal: integer().notNull(),
  session_id: text().notNull(),
  user_message_id: text().notNull(),
  assistant_message_id: text(),
  provider_attempt_id: text(),
  context_selection_id: text(),
  context_eligibility: text({ mode: "json" }).$type<ContextFederationRollout.ProjectDecision>(),
  context_readiness: text({ mode: "json" }).$type<ContextFederationRollout.DerivedContextDataReadiness>(),
  context_activation: text({ mode: "json" }).$type<ContextActivationReceipt.Receipt>(),
  context_activation_fingerprint: text(),
  released_knowledge_security_namespace_id: text().$type<SecurityNamespaceID>(),
  released_knowledge_project_scope_key: text().$type<ProjectScopeKey>(),
  released_knowledge_binding_state: text().$type<StoredBindingState>(),
  released_knowledge_snapshot_id: text(),
  released_knowledge_generation: integer(),
  released_knowledge_membership_hash: text(),
  released_knowledge_manifest_hash: text(),
  released_knowledge_exact_refs: text({ mode: "json" }).$type<readonly DocumentRef[]>(),
  released_knowledge_exact_refs_fingerprint: text(),
  released_knowledge_selected_refs: text({ mode: "json" }).$type<readonly DocumentRef[]>(),
  released_knowledge_selected_refs_fingerprint: text(),
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
  prompt_epoch: integer(),
  prompt_window_id: text(),
  effective_history_hash: text(),
  world_state_baseline_hash: text(),
  prompt_cache_key: text(),
  provider_request_hash: text(),
  response_chain_reuse_decision: text().$type<"not_supported" | "refused" | "reused">(),
  response_chain_refusal_reason: text(),
  request_input_hash: text(),
  final_request_hash: text(),
  prepared_turn_hash: text(),
  system_stable_hash: text(),
  system_volatile_hash: text(),
  wire_request_hash: text(),
  tool_result_reference_ids: text({ mode: "json" }).$type<readonly string[]>().notNull().default([]),
  tool_result_reference_count: integer().notNull().default(0),
  provider_state: text().$type<ProviderReceiptState>().notNull().default("preparing"),
  adapter_prepared_at: integer(),
  dispatching_at: integer(),
  streaming_at: integer(),
  terminal_at: integer(),
  response_fingerprint: text(),
  owner_token: text(),
  request_state: text().$type<RequestReceiptState>().notNull(),
  request_error_code: text(),
  created_at: integer().notNull(),
})
