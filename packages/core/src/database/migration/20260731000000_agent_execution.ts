import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260731000000_agent_execution",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS deepagent_agent_execution (
          workspace_id TEXT NOT NULL,
          event_id TEXT NOT NULL,
          task_id TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('available', 'running', 'handoff_pending', 'completed', 'failed')),
          owner_id TEXT,
          generation INTEGER NOT NULL,
          agent_id TEXT,
          assigned_agent_id TEXT,
          lease_expires_at INTEGER,
          continuation_ref TEXT,
          artifacts TEXT NOT NULL DEFAULT '[]',
          tokens_used INTEGER NOT NULL DEFAULT 0,
          last_error TEXT,
          handoff_id TEXT,
          handoff_to_agent_id TEXT,
          handoff_reason TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (workspace_id, event_id, task_id)
        )
      `)
      yield* tx.run(`
        CREATE INDEX IF NOT EXISTS deepagent_agent_execution_lease_idx
        ON deepagent_agent_execution (status, lease_expires_at)
      `)
      yield* tx.run(`
        CREATE INDEX IF NOT EXISTS deepagent_agent_execution_handoff_idx
        ON deepagent_agent_execution (handoff_id)
      `)
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS deepagent_agent_execution_lock (
          workspace_id TEXT NOT NULL,
          resource_key TEXT NOT NULL,
          event_id TEXT NOT NULL,
          task_id TEXT NOT NULL,
          owner_id TEXT NOT NULL,
          generation INTEGER NOT NULL,
          lease_expires_at INTEGER NOT NULL,
          PRIMARY KEY (workspace_id, resource_key)
        )
      `)
      yield* tx.run(`
        CREATE INDEX IF NOT EXISTS deepagent_agent_execution_lock_lease_idx
        ON deepagent_agent_execution_lock (lease_expires_at)
      `)
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS deepagent_agent_token_debit (
          workspace_id TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          window_start INTEGER NOT NULL,
          tokens_used INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (workspace_id, agent_id, window_start)
        )
      `)
    })
  },
} satisfies DatabaseMigration.Migration
