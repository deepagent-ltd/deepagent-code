import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

/**
 * Migration: DeepAgent event-drop DISTINCT-event semantics (§A4 event_dropped_total)
 *
 * P3.13 (migration 20260712010000) added `deepagent_event_drop` as an append-only audit log. But the §A4
 * backpressure path calls recordDrop on EVERY shed pass, so one logical event shed→nacked→re-shed ×N wrote
 * N rows → event_dropped_total counted shed-ATTEMPTS, not DISTINCT events.
 *
 * FIX: a UNIQUE index on `event_id` (alone). recordDrop now inserts with onConflictDoNothing on this index,
 * so a re-shed of the same event is a no-op → at most one drop row per event → COUNT(*) == distinct events
 * shed. Unique on event_id (not event_id+reason) is deliberate: an event is shed for one reason under §A4
 * backpressure and the first drop is the signal.
 *
 * DEDUPE-BEFORE-INDEX (migration robustness): a dev/beta DB that already ran 20260712010000 (create table)
 * with the V4 flags ON and shed the SAME event multiple times under backpressure ALREADY holds duplicate
 * event_id rows. Creating the UNIQUE index directly on such a table throws `UNIQUE constraint failed`,
 * aborting the migration transaction → the app fails to start and retries every restart (id never records).
 * So we DELETE the duplicates FIRST — keeping the first row (MIN(rowid)) per event_id — then build the
 * index. This makes the migration safe in ANY pre-existing data state (with or without duplicates), not
 * just a fresh install. On a fresh / duplicate-free table the DELETE is a harmless no-op. CREATE UNIQUE
 * INDEX IF NOT EXISTS stays idempotent.
 */
export default {
  id: "20260712040000_deepagent_event_drop_distinct",
  up(tx) {
    return Effect.gen(function* () {
      // 1) Collapse any historical duplicate event_id rows to one (the earliest, by rowid) BEFORE the
      //    unique index — otherwise the index build throws on a DB that shed the same event multiple times.
      //    No-op on a fresh / already-distinct table.
      yield* tx.run(`
        DELETE FROM \`deepagent_event_drop\`
        WHERE rowid NOT IN (SELECT MIN(rowid) FROM \`deepagent_event_drop\` GROUP BY \`event_id\`);
      `)
      // 2) Now the table is guaranteed one-row-per-event_id, so the UNIQUE index applies cleanly.
      yield* tx.run(`
        CREATE UNIQUE INDEX IF NOT EXISTS \`deepagent_event_drop_event_id_idx\`
        ON \`deepagent_event_drop\` (\`event_id\`);
      `)
    })
  },
} satisfies DatabaseMigration.Migration
