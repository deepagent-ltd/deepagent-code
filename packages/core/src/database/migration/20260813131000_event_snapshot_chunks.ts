import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260813131000_event_snapshot_chunks",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE event_snapshot_row (
          snapshot_id TEXT NOT NULL,
          aggregate_id TEXT NOT NULL,
          row_index INTEGER NOT NULL CHECK (row_index >= 0),
          table_name TEXT NOT NULL CHECK (length(table_name) > 0),
          row_key TEXT NOT NULL CHECK (length(row_key) > 0),
          row_hash TEXT NOT NULL CHECK (length(row_hash) = 64),
          row_bytes INTEGER NOT NULL CHECK (row_bytes > 0),
          chunk_count INTEGER NOT NULL CHECK (chunk_count > 0),
          chain_hash TEXT NOT NULL CHECK (length(chain_hash) = 64),
          PRIMARY KEY (snapshot_id, row_index),
          UNIQUE (snapshot_id, table_name, row_key)
        )
      `)
      yield* tx.run("CREATE INDEX event_snapshot_row_aggregate_idx ON event_snapshot_row(aggregate_id)")
      yield* tx.run(`
        CREATE TABLE event_snapshot_chunk (
          row_hash TEXT NOT NULL CHECK (length(row_hash) = 64),
          chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
          data BLOB NOT NULL,
          chunk_hash TEXT NOT NULL CHECK (length(chunk_hash) = 64),
          PRIMARY KEY (row_hash, chunk_index)
        )
      `)
      yield* tx.run(`
        CREATE TABLE event_snapshot_attempt (
          snapshot_id TEXT NOT NULL PRIMARY KEY,
          aggregate_id TEXT NOT NULL REFERENCES event_sequence(aggregate_id) ON DELETE CASCADE,
          through_seq INTEGER NOT NULL CHECK (through_seq >= 0),
          expected_latest INTEGER NOT NULL CHECK (expected_latest >= 0),
          owner_id TEXT,
          codec TEXT NOT NULL CHECK (length(codec) > 0),
          schema_version INTEGER NOT NULL CHECK (schema_version > 0),
          projection_revision TEXT NOT NULL,
          cursor TEXT,
          row_count INTEGER NOT NULL CHECK (row_count >= 0),
          encoded_bytes INTEGER NOT NULL CHECK (encoded_bytes >= 0),
          content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
          tables TEXT NOT NULL CHECK (json_valid(tables)),
          state TEXT NOT NULL CHECK (state IN ('prepared', 'staged', 'complete')),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `)
      yield* tx.run("CREATE INDEX event_snapshot_attempt_aggregate_idx ON event_snapshot_attempt(aggregate_id)")
      yield* tx.run(`
        CREATE TRIGGER event_snapshot_row_immutable
        BEFORE UPDATE ON event_snapshot_row
        BEGIN
          SELECT RAISE(ABORT, 'event_snapshot_row_immutable');
        END
      `)
      yield* tx.run("CREATE INDEX event_snapshot_row_hash_idx ON event_snapshot_row(row_hash)")
      yield* tx.run(`
        CREATE TRIGGER event_snapshot_row_delete_guard
        BEFORE DELETE ON event_snapshot_row
        WHEN EXISTS (SELECT 1 FROM event_snapshot snapshot WHERE snapshot.snapshot_id = OLD.snapshot_id)
          OR EXISTS (
            SELECT 1 FROM event_snapshot_attempt attempt
            WHERE attempt.snapshot_id = OLD.snapshot_id
              AND attempt.state != 'prepared'
              AND EXISTS (
                SELECT 1 FROM event_sequence sequence
                WHERE sequence.aggregate_id = attempt.aggregate_id
              )
          )
        BEGIN
          SELECT RAISE(ABORT, 'event_snapshot_row_active');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER event_snapshot_row_chunk_cleanup
        AFTER DELETE ON event_snapshot_row
        BEGIN
          DELETE FROM event_snapshot_chunk
          WHERE row_hash = OLD.row_hash
            AND NOT EXISTS (
              SELECT 1 FROM event_snapshot_row row
              WHERE row.row_hash = OLD.row_hash
            );
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER event_snapshot_aggregate_cleanup
        AFTER DELETE ON event_sequence
        BEGIN
          DELETE FROM event_snapshot_row WHERE aggregate_id = OLD.aggregate_id;
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER event_snapshot_chunk_immutable
        BEFORE UPDATE ON event_snapshot_chunk
        BEGIN
          SELECT RAISE(ABORT, 'event_snapshot_chunk_immutable');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER event_snapshot_chunk_delete_guard
        BEFORE DELETE ON event_snapshot_chunk
        WHEN EXISTS (SELECT 1 FROM event_snapshot_row row WHERE row.row_hash = OLD.row_hash)
        BEGIN
          SELECT RAISE(ABORT, 'event_snapshot_chunk_referenced');
        END
      `)
      yield* tx.run("ALTER TABLE event_dedupe ADD COLUMN source_data TEXT CHECK (source_data IS NULL OR json_valid(source_data))")
      yield* tx.run("DROP TRIGGER IF EXISTS event_delete_requires_dedupe")
      yield* tx.run(`
        CREATE TRIGGER event_delete_requires_dedupe
        BEFORE DELETE ON event
        WHEN EXISTS (
          SELECT 1 FROM event_sequence sequence
          WHERE sequence.aggregate_id = OLD.aggregate_id
            AND sequence.retention_floor_seq IS NOT NULL
            AND OLD.seq <= sequence.retention_floor_seq
        ) AND NOT EXISTS (
          SELECT 1 FROM event_dedupe dedupe
          WHERE dedupe.aggregate_id = OLD.aggregate_id
            AND dedupe.seq = OLD.seq
            AND dedupe.event_id = OLD.id
            AND dedupe.type = OLD.type
            AND length(dedupe.data_hash) = 64
            AND dedupe.source_data = OLD.data
        )
        BEGIN
          SELECT RAISE(ABORT, 'event_compaction_dedupe_missing');
        END
      `)
      yield* tx.run(`
        CREATE TABLE event_compaction_receipt (
          aggregate_id TEXT NOT NULL PRIMARY KEY REFERENCES event_sequence(aggregate_id) ON DELETE CASCADE,
          snapshot_id TEXT NOT NULL,
          through_seq INTEGER NOT NULL CHECK (through_seq >= 0),
          codec TEXT NOT NULL,
          schema_version INTEGER NOT NULL CHECK (schema_version > 0),
          cursor_seq INTEGER NOT NULL CHECK (cursor_seq >= -1),
          deleted_count INTEGER NOT NULL CHECK (deleted_count >= 0),
          state TEXT NOT NULL CHECK (state IN ('running', 'complete')),
          updated_at INTEGER NOT NULL
        )
      `)
    })
  },
} satisfies DatabaseMigration.Migration
