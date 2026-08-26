import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

/**
 * Migration: DeepAgent Scheduler idempotency key (V4.0 §A4, P1.6 follow-up)
 *
 * Adds a nullable `schedule_key` column + a UNIQUE index to `deepagent_schedule`.
 * The key is a stable dedupe identity for schedules that must be registered
 * idempotently across process restarts (the boot-time bootstrap schedules).
 * NULL for ordinary ad-hoc schedules, and because SQLite treats NULLs as
 * distinct in a UNIQUE index, the constraint applies ONLY to keyed rows — a
 * natural partial-unique. This closes the multi-process TOCTOU on the
 * list-then-insert bootstrap: a concurrent duplicate insert of the same key is
 * rejected at the DB layer (paired with onConflictDoNothing in the service).
 *
 * Backward compatible: existing rows get schedule_key = NULL (unconstrained).
 */
export default {
  id: "20260712000000_deepagent_schedule_key",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`deepagent_schedule\` ADD \`schedule_key\` text;`)
      // at most one row per non-null schedule_key; NULLs are distinct so unkeyed rows are unconstrained.
      yield* tx.run(`
        CREATE UNIQUE INDEX IF NOT EXISTS \`deepagent_schedule_key_uidx\`
        ON \`deepagent_schedule\` (\`schedule_key\`);
      `)
    })
  },
} satisfies DatabaseMigration.Migration
