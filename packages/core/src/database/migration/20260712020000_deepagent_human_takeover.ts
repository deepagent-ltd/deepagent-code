import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

/**
 * Migration: DeepAgent Human Takeover log (V4.0 §D2/§F)
 *
 * Creates `deepagent_human_takeover` — the append-only audit log of moments a
 * human stepped in over an agent (pausing/reverting its session, or claiming a
 * branch/session it was driving). Backs the §D2 Takeover surface and the §F
 * `human_takeover_total` metric. One row per takeover; never mutated (a takeover
 * is a past fact, unlike the mutable Approval Queue).
 *
 * Timestamp note (P3.10): placed at 20260712020000 — after 20260712000000 and
 * after P3.13's migration slot — so the two parallel worktrees do not collide.
 */
export default {
  id: "20260712020000_deepagent_human_takeover",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`deepagent_human_takeover\` (
          \`id\` text PRIMARY KEY NOT NULL,
          \`workspace_id\` text NOT NULL,
          \`session_id\` text,
          \`agent_id\` text,
          \`actor_id\` text,
          \`reason\` text,
          \`created_at\` integer NOT NULL
        );
      `)

      // §F metric + §D2 surface: a workspace's takeovers over a window, newest first.
      yield* tx.run(`
        CREATE INDEX IF NOT EXISTS \`deepagent_human_takeover_workspace_idx\`
        ON \`deepagent_human_takeover\` (\`workspace_id\`, \`created_at\`);
      `)
    })
  },
} satisfies DatabaseMigration.Migration
