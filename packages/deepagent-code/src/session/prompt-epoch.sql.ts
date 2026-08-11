// BUG-005: drizzle-orm type bindings for the session_prompt_epoch table
// created by migration 20260806070000_compaction_lifecycle.
//
// Ownership: packages/deepagent-code/src/session (legacy SessionPrompt owner).
// The table lives in the shared SQLite database alongside core Session tables.
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

export type PromptEpochState = "active" | "retired"
export type PromptEpochReason =
  | "bootstrap"
  | "compaction"
  | "model"
  | "agent"
  | "directory"
  | "workspace"
  | "tools"
  | "permission"
  | "renderer"

export const SessionPromptEpochTable = sqliteTable("session_prompt_epoch", {
  session_id: text().notNull(),
  epoch: integer().notNull(),
  state: text().$type<PromptEpochState>().notNull(),
  checkpoint_user_id: text(),
  checkpoint_assistant_id: text(),
  retained_tail_start_id: text(),
  source_end_message_id: text(),
  checkpoint_hash: text(),
  projection_version: integer(),
  canonicalization_version: integer(),
  base_message_count: integer(),
  effective_history_hash: text(),
  first_window_id: text(),
  previous_window_id: text(),
  window_id: text(),
  world_state_baseline_hash: text(),
  authority_state: text().$type<"legacy_pending" | "ready" | "recovery_required">(),
  recovery_reason: text(),
  reason: text().$type<PromptEpochReason>().notNull(),
  created_at: integer().notNull(),
  retired_at: integer(),
})
