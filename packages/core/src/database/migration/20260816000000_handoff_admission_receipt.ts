import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

// FEAT-008 — durable admission receipt for `agent.handoff.requested` (see handoff-admission-sql.ts
// for the carrier decision: a NEW table, because deepagent_event_delivery models delivery lifecycle
// only, task_admission is the subagent task_run receipt, and agent_execution never models the
// consumer's processing/terminal admission). Forward-only: pure additive CREATE TABLE + indexes.
export default {
  id: "20260816000000_handoff_admission_receipt",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`deepagent_handoff_admission\` (
          \`handoff_id\` text PRIMARY KEY NOT NULL,
          \`event_id\` text NOT NULL,
          \`workspace_id\` text NOT NULL,
          \`state\` text NOT NULL,
          \`claimant_id\` text NOT NULL,
          \`reason\` text,
          \`started_at\` integer NOT NULL,
          \`updated_at\` integer NOT NULL,
          \`settled_at\` integer
        );
      `)
      yield* tx.run(`
        CREATE INDEX IF NOT EXISTS \`deepagent_handoff_admission_workspace_state_idx\`
        ON \`deepagent_handoff_admission\` (\`workspace_id\`, \`state\`);
      `)
      yield* tx.run(`
        CREATE UNIQUE INDEX IF NOT EXISTS \`deepagent_handoff_admission_event_idx\`
        ON \`deepagent_handoff_admission\` (\`event_id\`);
      `)
    })
  },
} satisfies DatabaseMigration.Migration
