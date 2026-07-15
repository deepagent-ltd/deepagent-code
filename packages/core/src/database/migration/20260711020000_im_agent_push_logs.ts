import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

/**
 * Migration: IM Agent Push Logs (V4.0 §B4)
 *
 * Creates `im_agent_push_logs` — the durable audit + rate-limit-accounting log
 * for agent PROACTIVE pushes (§B2). One row per push attempt (delivered, held
 * for digest, or blocked), so the per-agent-per-group-per-hour rate window is
 * countable and Oversight can trace what an agent pushed and why. Kept separate
 * from im_messages so the push audit survives independent of the delivered row.
 */
export default {
  id: "20260711020000_im_agent_push_logs",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`im_agent_push_logs\` (
          \`id\` text PRIMARY KEY NOT NULL,
          \`workspace_id\` text NOT NULL,
          \`group_id\` text NOT NULL,
          \`agent_id\` text NOT NULL,
          \`reason\` text NOT NULL,
          \`priority\` text NOT NULL,
          \`decision\` text NOT NULL,
          \`idempotency_key\` text NOT NULL,
          \`message_id\` text,
          \`content\` text,
          \`created_at\` integer NOT NULL
        );
      `)

      // §B2 去重: storage-enforced one-delivery-per idempotency key.
      yield* tx.run(`
        CREATE UNIQUE INDEX IF NOT EXISTS \`idx_im_agent_push_logs_idempotency\`
        ON \`im_agent_push_logs\` (\`idempotency_key\`);
      `)
      // §B2 rate-limit scan + Oversight timeline: this agent's recent pushes to a group.
      yield* tx.run(`
        CREATE INDEX IF NOT EXISTS \`idx_im_agent_push_logs_agent_time\`
        ON \`im_agent_push_logs\` (\`agent_id\`, \`group_id\`, \`created_at\`);
      `)
      // per-workspace audit sweep.
      yield* tx.run(`
        CREATE INDEX IF NOT EXISTS \`idx_im_agent_push_logs_workspace\`
        ON \`im_agent_push_logs\` (\`workspace_id\`, \`created_at\`);
      `)
    })
  },
} satisfies DatabaseMigration.Migration
