import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { Effect } from "effect"
import type { DatabaseMigration } from "../database/migration"

// C5-08 — TASK DAG terminal reference ledger. Design authority: docs/core-v2.0-beta/design.md §8.4
// (each V2 work admission is a durable node with a terminal receipt) + §8.6 consumer ledger precedent
// (the event hotspot owns its own schema via an idempotent migration; wiring into the shared registry
// is the main agent's / database hotspot's job).
//
// The task DAG spans several DURABLE node shapes — TaskRun (`task_run`), AgentExecution
// (`deepagent_agent_execution`), Approval (`deepagent_approval_queue`), plus the Worktree and Conflict
// facets that live as sub-state on a `task_run` row (`worktree_state` / conflict-capable sub-states).
// A caller that must write or reconcile these nodes needs ONE unified, typed, restart-safe reference
// to a node plus a durable PROOF of its terminal (settled) outcome. This ledger is that proof: one
// row per (nodeKind, nodeId) recording the terminal state and a content-addressed receipt reference.
//
// The ledger is the durable receipt binding. Integrity is defined against BOTH sides:
//   - a durable NODE ROW that is terminal MUST have a matching ledger receipt (else "missing receipt");
//   - a ledger RECEIPT MUST reference a node whose durable row is actually terminal (else
//     "receipt without terminal node").
//
// The ledger is written by the terminal-settling consumer (recordTerminalRef) and read by
// `resolveDagFromRows` so a reference survives restart with NO in-memory registry (the reconciliation
// always re-derives from the durable rows).

export type TaskDagNodeKind = "task_run" | "agent_execution" | "approval" | "worktree" | "conflict"

/** Durable terminal reference (the receipt ledger): one row per (nodeKind, nodeId). */
export const DeepAgentTaskDagRefTable = sqliteTable("deepagent_task_dag_ref", {
  node_kind: text().$type<TaskDagNodeKind>().notNull(),
  node_id: text().notNull(),
  generation: integer().notNull(),
  terminal_state: text().notNull(),
  receipt_ref: text().notNull(),
  recorded_at: integer().notNull(),
  updated_at: integer().notNull(),
}, (table) => [
  primaryKey({ columns: [table.node_kind, table.node_id] }),
  index("deepagent_task_dag_ref_node_idx").on(table.node_id),
])

/** Idempotent migration that creates the task-DAG terminal reference ledger. */
export const taskDagRefMigration: DatabaseMigration.Migration = {
  id: "20260829000000_deepagent_task_dag_ref",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`deepagent_task_dag_ref\` (
          \`node_kind\` text NOT NULL,
          \`node_id\` text NOT NULL,
          \`generation\` integer NOT NULL,
          \`terminal_state\` text NOT NULL,
          \`receipt_ref\` text NOT NULL,
          \`recorded_at\` integer NOT NULL,
          \`updated_at\` integer NOT NULL,
          CONSTRAINT \`deepagent_task_dag_ref_pk\` PRIMARY KEY(\`node_kind\`, \`node_id\`),
          CONSTRAINT \`deepagent_task_dag_ref_kind_check\` CHECK(\`node_kind\` IN ('task_run', 'agent_execution', 'approval', 'worktree', 'conflict'))
        );
      `)
      yield* tx.run(`
        CREATE INDEX IF NOT EXISTS \`deepagent_task_dag_ref_node_idx\` ON \`deepagent_task_dag_ref\`(\`node_id\`);
      `)
    })
  },
}

export * as TaskDagRefSql from "./task-dag-ref-sql"
