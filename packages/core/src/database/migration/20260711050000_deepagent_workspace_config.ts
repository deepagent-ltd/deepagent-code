import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

/**
 * Migration: DeepAgent per-workspace config (V4.0)
 *
 * Creates `deepagent_workspace_config` — one row per workspace holding the V4
 * policy knobs (retention days, quiet-hours window, rate-limit overrides,
 * trusted event sources) as a single versioned JSON blob. An absent row means
 * "use code defaults", so this is fully backward-compatible: existing workspaces
 * keep the lenient defaults until a config is explicitly written.
 */
export default {
  id: "20260711050000_deepagent_workspace_config",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`deepagent_workspace_config\` (
          \`workspace_id\` text PRIMARY KEY NOT NULL,
          \`config\` text NOT NULL,
          \`created_at\` integer NOT NULL,
          \`updated_at\` integer NOT NULL
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
