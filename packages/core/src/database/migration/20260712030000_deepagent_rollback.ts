import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

/**
 * Migration: DeepAgent Rollback audit log (V4.0 §D2/§F)
 *
 * Creates `deepagent_rollback` — the append-only audit log of moments a human
 * rolled back an agent-produced change over a session (via SessionRevert, the
 * same primitive the goal loop uses). Backs the §D2 Rollback surface (paired
 * with the Takeover surface) and the §F `rollback_total` metric. One row per
 * rollback; never mutated (a rollback is a past fact, unlike the mutable
 * Approval Queue). Mirrors deepagent_human_takeover, plus an `outcome` column
 * ("reverted" | "noop") since a rollback can be a no-op with nothing to revert.
 *
 * Timestamp note (P4.4): placed at 20260712030000 — AFTER 20260712020000
 * (deepagent_human_takeover, P3.10) so it applies after the takeover slot.
 */
export default {
  id: "20260712030000_deepagent_rollback",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`deepagent_rollback\` (
          \`id\` text PRIMARY KEY NOT NULL,
          \`workspace_id\` text NOT NULL,
          \`session_id\` text NOT NULL,
          \`actor_id\` text,
          \`reason\` text,
          \`outcome\` text NOT NULL,
          \`created_at\` integer NOT NULL
        );
      `)

      // §F metric + §D2 surface: a workspace's rollbacks over a window, newest first.
      yield* tx.run(`
        CREATE INDEX IF NOT EXISTS \`deepagent_rollback_workspace_idx\`
        ON \`deepagent_rollback\` (\`workspace_id\`, \`created_at\`);
      `)
    })
  },
} satisfies DatabaseMigration.Migration
