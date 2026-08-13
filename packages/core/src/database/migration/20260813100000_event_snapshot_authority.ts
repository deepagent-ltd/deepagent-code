import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260813100000_event_snapshot_authority",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run("ALTER TABLE event_sequence ADD COLUMN retention_floor_seq INTEGER")
      yield* tx.run("ALTER TABLE event_sequence ADD COLUMN snapshot_id TEXT")
      yield* tx.run("ALTER TABLE event ADD COLUMN sync_seq INTEGER")
      yield* tx.run("UPDATE event SET sync_seq = rowid WHERE sync_seq IS NULL")
      yield* tx.run("CREATE UNIQUE INDEX event_sync_seq_idx ON event(sync_seq)")
      yield* tx.run(`
        CREATE TABLE event_sync_sequence (
          id INTEGER NOT NULL PRIMARY KEY CHECK (id = 1),
          seq INTEGER NOT NULL CHECK (seq >= -1),
          generation TEXT NOT NULL CHECK (length(generation) = 32),
          cursor_secret TEXT NOT NULL CHECK (length(cursor_secret) = 64)
        )
      `)
      yield* tx.run("INSERT INTO event_sync_sequence(id, seq, generation, cursor_secret) SELECT 1, COALESCE(MAX(sync_seq), -1), lower(hex(randomblob(16))), lower(hex(randomblob(32))) FROM event")
      yield* tx.run(`
        CREATE TABLE workspace_sync_cursor (
          workspace_id TEXT NOT NULL,
          remote_fingerprint TEXT NOT NULL CHECK (length(remote_fingerprint) = 64),
          cursor TEXT NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (workspace_id, remote_fingerprint)
        )
      `)
      yield* tx.run(`
        CREATE TABLE event_snapshot (
          snapshot_id TEXT NOT NULL PRIMARY KEY,
          aggregate_id TEXT NOT NULL REFERENCES event_sequence(aggregate_id) ON DELETE CASCADE,
          through_seq INTEGER NOT NULL CHECK (through_seq >= 0),
          sync_seq INTEGER NOT NULL UNIQUE CHECK (sync_seq >= 0),
          codec TEXT NOT NULL CHECK (length(codec) > 0),
          schema_version INTEGER NOT NULL CHECK (schema_version >= 1),
          snapshot_hash TEXT NOT NULL CHECK (length(snapshot_hash) = 64),
          body TEXT NOT NULL CHECK (json_valid(body)),
          owner_id TEXT,
          created_at INTEGER NOT NULL,
          UNIQUE (aggregate_id, through_seq)
        )
      `)
      yield* tx.run(
        "CREATE INDEX event_snapshot_aggregate_created_idx ON event_snapshot(aggregate_id, created_at)",
      )
      yield* tx.run(`
        CREATE TABLE event_dedupe (
          aggregate_id TEXT NOT NULL REFERENCES event_sequence(aggregate_id) ON DELETE CASCADE,
          seq INTEGER NOT NULL CHECK (seq >= 0),
          event_id TEXT NOT NULL UNIQUE,
          type TEXT NOT NULL,
          data_hash TEXT NOT NULL CHECK (length(data_hash) = 64),
          compacted_at INTEGER NOT NULL,
          UNIQUE (aggregate_id, seq)
        )
      `)
      yield* tx.run(`
        CREATE TABLE event_artifact (
          artifact_id TEXT NOT NULL PRIMARY KEY,
          event_id TEXT NOT NULL UNIQUE,
          aggregate_id TEXT NOT NULL REFERENCES event_sequence(aggregate_id) ON DELETE CASCADE,
          seq INTEGER NOT NULL CHECK (seq >= 0),
          kind TEXT NOT NULL CHECK (kind IN ('legacy_message_diff')),
          original_data_hash TEXT NOT NULL CHECK (length(original_data_hash) = 64),
          canonical_data_hash TEXT NOT NULL CHECK (length(canonical_data_hash) = 64),
          canonical_data TEXT NOT NULL CHECK (json_valid(canonical_data)),
          body_hash TEXT NOT NULL CHECK (length(body_hash) = 64),
          body_bytes INTEGER NOT NULL CHECK (body_bytes >= 0),
          chunk_count INTEGER NOT NULL CHECK (chunk_count >= 1),
          codec_version INTEGER NOT NULL CHECK (codec_version >= 1),
          created_at INTEGER NOT NULL,
          UNIQUE (aggregate_id, seq)
        )
      `)
      yield* tx.run(`
        CREATE TABLE event_artifact_chunk (
          artifact_id TEXT NOT NULL REFERENCES event_artifact(artifact_id) ON DELETE CASCADE,
          chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
          data BLOB NOT NULL,
          chunk_hash TEXT NOT NULL CHECK (length(chunk_hash) = 64),
          PRIMARY KEY (artifact_id, chunk_index)
        )
      `)
      yield* tx.run(`
        CREATE TRIGGER event_sync_seq_legacy_allocator
        AFTER INSERT ON event
        WHEN NEW.sync_seq IS NULL
        BEGIN
          UPDATE event_sync_sequence SET seq = seq + 1 WHERE id = 1;
          UPDATE event SET sync_seq = (SELECT seq FROM event_sync_sequence WHERE id = 1) WHERE id = NEW.id;
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER event_sequence_snapshot_validate_insert
        BEFORE INSERT ON event_sequence
        WHEN NEW.retention_floor_seq IS NOT NULL OR NEW.snapshot_id IS NOT NULL
        BEGIN
          SELECT RAISE(ABORT, 'event_sequence_snapshot_requires_checkpoint_update');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER event_sequence_snapshot_validate_update
        BEFORE UPDATE OF retention_floor_seq, snapshot_id ON event_sequence
        BEGIN
          SELECT CASE
            WHEN NEW.retention_floor_seq IS NULL OR NEW.snapshot_id IS NULL
              THEN RAISE(ABORT, 'event_sequence_snapshot_pointer_incomplete')
            WHEN NEW.retention_floor_seq < 0 OR NEW.retention_floor_seq > NEW.seq
              THEN RAISE(ABORT, 'event_sequence_snapshot_floor_invalid')
            WHEN OLD.retention_floor_seq IS NOT NULL AND NEW.retention_floor_seq < OLD.retention_floor_seq
              THEN RAISE(ABORT, 'event_sequence_snapshot_floor_regressed')
            WHEN NOT EXISTS (
              SELECT 1 FROM event_snapshot snapshot
              WHERE snapshot.snapshot_id = NEW.snapshot_id
                AND snapshot.aggregate_id = NEW.aggregate_id
                AND snapshot.through_seq = NEW.retention_floor_seq
            ) THEN RAISE(ABORT, 'event_sequence_snapshot_missing')
          END;
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER event_snapshot_delete_active_guard
        BEFORE DELETE ON event_snapshot
        WHEN EXISTS (SELECT 1 FROM event_sequence sequence WHERE sequence.snapshot_id = OLD.snapshot_id)
        BEGIN
          SELECT RAISE(ABORT, 'event_snapshot_is_active');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER event_artifact_binding_guard
        BEFORE INSERT ON event_artifact
        BEGIN
          SELECT CASE WHEN NOT EXISTS (
            SELECT 1 FROM event source
            WHERE source.id = NEW.event_id
              AND source.aggregate_id = NEW.aggregate_id
              AND source.seq = NEW.seq
          ) THEN RAISE(ABORT, 'event_artifact_source_mismatch') END;
        END
      `)
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
        )
        BEGIN
          SELECT RAISE(ABORT, 'event_compaction_dedupe_missing');
        END
      `)
    })
  },
} satisfies DatabaseMigration.Migration
