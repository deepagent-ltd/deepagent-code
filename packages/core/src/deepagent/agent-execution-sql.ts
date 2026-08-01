import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core"
import type { DeepAgentEvent } from "./deepagent-event"

export const AgentExecutionTable = sqliteTable(
  "deepagent_agent_execution",
  {
    workspace_id: text().notNull(),
    event_id: text().$type<DeepAgentEvent.ID>().notNull(),
    task_id: text().notNull(),
    status: text().$type<"available" | "running" | "handoff_pending" | "completed" | "failed">().notNull(),
    owner_id: text(),
    generation: integer().notNull(),
    agent_id: text(),
    assigned_agent_id: text(),
    lease_expires_at: integer(),
    continuation_ref: text(),
    artifacts: text({ mode: "json" }).$type<ReadonlyArray<string>>().notNull(),
    tokens_used: integer().notNull(),
    last_error: text(),
    handoff_id: text(),
    handoff_to_agent_id: text(),
    handoff_reason: text(),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspace_id, table.event_id, table.task_id] }),
    index("deepagent_agent_execution_lease_idx").on(table.status, table.lease_expires_at),
    index("deepagent_agent_execution_handoff_idx").on(table.handoff_id),
  ],
)

export const AgentExecutionLockTable = sqliteTable(
  "deepagent_agent_execution_lock",
  {
    workspace_id: text().notNull(),
    resource_key: text().notNull(),
    event_id: text().$type<DeepAgentEvent.ID>().notNull(),
    task_id: text().notNull(),
    owner_id: text().notNull(),
    generation: integer().notNull(),
    lease_expires_at: integer().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspace_id, table.resource_key] }),
    index("deepagent_agent_execution_lock_lease_idx").on(table.lease_expires_at),
  ],
)

export const AgentTokenDebitTable = sqliteTable(
  "deepagent_agent_token_debit",
  {
    workspace_id: text().notNull(),
    agent_id: text().notNull(),
    window_start: integer().notNull(),
    tokens_used: integer().notNull(),
    updated_at: integer().notNull(),
  },
  (table) => [primaryKey({ columns: [table.workspace_id, table.agent_id, table.window_start] })],
)

export * as AgentExecutionSql from "./agent-execution-sql"
