import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260813125000_event_sync_backfill_authority",
  up(tx) {
    return Effect.gen(function* () {
      const columns = yield* tx.all<{ name: string }>("PRAGMA table_info('event_sync_sequence')")
      if (!columns.some((column) => column.name === "backfill_complete"))
        yield* tx.run(
          "ALTER TABLE event_sync_sequence ADD COLUMN backfill_complete INTEGER NOT NULL DEFAULT 0 CHECK (backfill_complete IN (0, 1))",
        )

      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS event_sync_backfill (
          id INTEGER NOT NULL PRIMARY KEY CHECK (id = 1),
          state TEXT NOT NULL CHECK (state IN ('pending', 'complete')),
          cursor_rowid INTEGER NOT NULL CHECK (cursor_rowid >= 0),
          high_water_rowid INTEGER NOT NULL CHECK (high_water_rowid >= 0),
          processed_count INTEGER NOT NULL CHECK (processed_count >= 0),
          started_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          completed_at INTEGER
        )
      `)
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS event_sync_index (
          sync_seq INTEGER NOT NULL PRIMARY KEY CHECK (sync_seq >= 0),
          event_id TEXT NOT NULL UNIQUE REFERENCES event(id) ON DELETE CASCADE,
          aggregate_id TEXT NOT NULL,
          seq INTEGER NOT NULL CHECK (seq >= 0),
          UNIQUE (aggregate_id, seq)
        )
      `)
      yield* tx.run(
        "CREATE INDEX IF NOT EXISTS event_sync_index_aggregate_seq_idx ON event_sync_index(aggregate_id, seq)",
      )
      yield* tx.run(`
        INSERT OR IGNORE INTO event_sync_backfill(
          id, state, cursor_rowid, high_water_rowid, processed_count,
          started_at, updated_at, completed_at
        )
        SELECT 1,
          CASE WHEN MAX(rowid) IS NULL THEN 'complete' ELSE 'pending' END,
          0, COALESCE(MAX(rowid), 0), 0,
          unixepoch('subsec') * 1000, unixepoch('subsec') * 1000,
          CASE WHEN MAX(rowid) IS NULL THEN unixepoch('subsec') * 1000 END
        FROM event
      `)
      yield* tx.run(`
        UPDATE event_sync_sequence
        SET seq = max(seq, (SELECT high_water_rowid FROM event_sync_backfill WHERE id = 1)),
          backfill_complete = CASE
            WHEN (SELECT state FROM event_sync_backfill WHERE id = 1) = 'complete' THEN 1
            ELSE 0
          END
        WHERE id = 1
      `)
      yield* tx.run("DROP TRIGGER IF EXISTS event_sync_index_explicit_insert")
      yield* tx.run("DROP TRIGGER IF EXISTS event_sync_seq_legacy_allocator")
      yield* tx.run("DROP TRIGGER IF EXISTS event_sync_seq_required")
      yield* tx.run(`
        CREATE TRIGGER event_sync_index_explicit_insert
        AFTER INSERT ON event
        WHEN NEW.sync_seq IS NOT NULL
        BEGIN
          INSERT INTO event_sync_index(sync_seq, event_id, aggregate_id, seq)
          VALUES (NEW.sync_seq, NEW.id, NEW.aggregate_id, NEW.seq);
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER event_sync_seq_required
        BEFORE INSERT ON event
        WHEN NEW.sync_seq IS NULL
        BEGIN
          SELECT RAISE(ABORT, 'event_sync_seq_required');
        END
      `)
    })
  },
} satisfies DatabaseMigration.Migration
