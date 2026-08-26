import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

/**
 * Migration: DeepAgent event publish-latency column (§F1 event_publish_latency_ms)
 *
 * Adds a nullable `publish_latency_ms` integer to `deepagent_event`. The Event Bus writes the
 * wall-clock delta (measured with the injected clock) around the persist transaction so Observability
 * can compute the §F1 event_publish_latency_ms P50/P95 histogram. ADD COLUMN is backward-compatible
 * (§H): the column is nullable, so pre-V4.0 rows (and any producer that doesn't populate it) read null
 * and are excluded from the percentile samples.
 */
export default {
  id: "20260711100000_deepagent_event_publish_latency",
  up(tx) {
    return Effect.gen(function* () {
      // ADD COLUMN errors if the column exists (SQLite has no ADD COLUMN IF NOT EXISTS), so guard via
      // a table_info check — mirrors 20260711040000_im_messages_v4_columns.
      const cols = yield* tx.all<{ name: string }>(`PRAGMA table_info(\`deepagent_event\`)`)
      const has = (name: string) => cols.some((c) => c.name === name)
      if (!has("publish_latency_ms")) {
        yield* tx.run(`ALTER TABLE \`deepagent_event\` ADD COLUMN \`publish_latency_ms\` integer;`)
      }
    })
  },
} satisfies DatabaseMigration.Migration
