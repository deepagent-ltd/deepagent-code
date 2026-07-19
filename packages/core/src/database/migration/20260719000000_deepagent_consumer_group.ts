import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

/**
 * Migration: DeepAgent persistent consumer group registry (K40-2, v4.0.4)
 *
 * Adds `deepagent_consumer_group` so consumer group identity survives process restarts.
 * Previously, consumer groups were in-memory only: a group was registered for the lifetime
 * of its live `subscribe({group})` stream and dropped when the last stream unsubscribed.
 * This meant that offline/never-live groups NEVER received delivery rows — `publish` only
 * wrote delivery rows for groups with a live stream at publish time.
 *
 * With this table, a group can call `registerConsumerGroup` (durable) independently of
 * whether it has an active stream. `publish` now queries BOTH the in-memory live-group Map
 * AND this table, so an offline group gets delivery rows and can catch up via `dueRetries`
 * + `replay` on reconnect.
 *
 * `last_seen_at` is updated on every live stream connect/disconnect so a future maintenance
 * sweep can prune groups that have been permanently offline (not yet wired; placeholder).
 */
export default {
  id: "20260719000000_deepagent_consumer_group",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`deepagent_consumer_group\` (
          \`group_id\` text PRIMARY KEY NOT NULL,
          \`type_filter\` text,
          \`registered_at\` integer NOT NULL,
          \`last_seen_at\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE INDEX IF NOT EXISTS \`deepagent_consumer_group_type_idx\`
        ON \`deepagent_consumer_group\` (\`type_filter\`);
      `)
    })
  },
} satisfies DatabaseMigration.Migration
