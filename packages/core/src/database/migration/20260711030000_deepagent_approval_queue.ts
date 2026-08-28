import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

/**
 * Migration: DeepAgent Approval Queue (V4.0 §D2)
 *
 * Creates `deepagent_approval_queue` — the durable human-decision sink for
 * events that escalate (goal.needs_human / goal.rolled_back / panel.verdict
 * needs_human). One row per raising event (UNIQUE(event_id) → a re-delivered
 * event never double-queues); a human resolves it in the Oversight Dashboard.
 */
export default {
  id: "20260711030000_deepagent_approval_queue",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`deepagent_approval_queue\` (
          \`id\` text PRIMARY KEY NOT NULL,
          \`workspace_id\` text NOT NULL,
          \`event_id\` text NOT NULL,
          \`event_type\` text NOT NULL,
          \`correlation_id\` text,
          \`summary\` text NOT NULL,
          \`status\` text NOT NULL,
          \`decision\` text,
          \`resolved_by\` text,
          \`resolved_at\` integer,
          \`created_at\` integer NOT NULL
        );
      `)

      // §D2 去重: one queue item per raising event.
      yield* tx.run(`
        CREATE UNIQUE INDEX IF NOT EXISTS \`deepagent_approval_queue_event_idx\`
        ON \`deepagent_approval_queue\` (\`event_id\`);
      `)
      // Dashboard: a workspace's pending items.
      yield* tx.run(`
        CREATE INDEX IF NOT EXISTS \`deepagent_approval_queue_pending_idx\`
        ON \`deepagent_approval_queue\` (\`workspace_id\`, \`status\`, \`created_at\`);
      `)
    })
  },
} satisfies DatabaseMigration.Migration
