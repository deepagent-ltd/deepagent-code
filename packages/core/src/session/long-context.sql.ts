import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { SessionTable } from "./sql"
import type { SessionSchema } from "./schema"
import type { ModelHardPolicy } from "./runner/model-hard-policy"

/** One diagnostic per assembled request; blocked requests never create a provider attempt. */
export const SessionModelPolicyReceiptTable = sqliteTable(
  "session_model_policy_receipt",
  {
    receipt_id: text().primaryKey(),
    session_id: text().$type<SessionSchema.ID>().notNull().references(() => SessionTable.id, { onDelete: "cascade" }),
    activity_id: text().notNull(),
    user_message_id: text().notNull(),
    prompt_epoch: integer().notNull(),
    request_hash: text().notNull(),
    provider_id: text().notNull(),
    runtime_model_id: text().notNull(),
    api_model_id: text().notNull(),
    policy: text({ mode: "json" }).$type<ModelHardPolicy.Decision>().notNull(),
    estimated_full_request_tokens: integer().notNull(),
    estimator_version: text().notNull(),
    reserved_output_tokens: integer().notNull(),
    context_selection_id: text().notNull(),
    context_projection_hash: text().notNull(),
    graph_snapshot_refs: text({ mode: "json" }).$type<readonly string[]>().notNull(),
    offered_tool_ids: text({ mode: "json" }).$type<readonly string[]>().notNull(),
    degraded_tool_ids: text({ mode: "json" }).$type<readonly string[]>().notNull(),
    provider_attempt_id: text(),
    trigger_source: text().$type<"threshold" | "none">().notNull(),
    checkpoint_id: text(),
    checkpoint_hash: text(),
    blocked_reason: text(),
    created_at: integer().notNull(),
  },
  (table) => [index("session_model_policy_receipt_session_idx").on(table.session_id, table.created_at)],
)

/** V2 compaction artifact; Ended's synchronized projection verifies this row before epoch change. */
export const SessionContextCheckpointTable = sqliteTable(
  "session_context_checkpoint",
  {
    checkpoint_id: text().primaryKey(),
    session_id: text().$type<SessionSchema.ID>().notNull().references(() => SessionTable.id, { onDelete: "cascade" }),
    activity_id: text().notNull(),
    prompt_epoch: integer().notNull(),
    content_hash: text().notNull(),
    content: text({ mode: "json" }).$type<unknown>().notNull(),
    created_at: integer().notNull(),
  },
  (table) => [index("session_context_checkpoint_session_idx").on(table.session_id, table.created_at)],
)
