import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260813130000_file_part_artifact",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE file_part_artifact (
          artifact_id TEXT NOT NULL PRIMARY KEY,
          body_hash TEXT NOT NULL UNIQUE CHECK (length(body_hash) = 64),
          body_bytes INTEGER NOT NULL CHECK (body_bytes >= 0),
          chunk_bytes INTEGER NOT NULL CHECK (chunk_bytes = 262144),
          chunk_count INTEGER NOT NULL CHECK (chunk_count >= 1 AND chunk_count <= 128),
          codec_version INTEGER NOT NULL CHECK (codec_version = 1),
          complete INTEGER NOT NULL CHECK (complete IN (0, 1)),
          created_at INTEGER NOT NULL
        )
      `)
      yield* tx.run(`
        CREATE TABLE file_part_artifact_chunk (
          artifact_id TEXT NOT NULL REFERENCES file_part_artifact(artifact_id) ON DELETE CASCADE,
          chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0 AND chunk_index < 128),
          data BLOB NOT NULL CHECK (length(data) <= 262144),
          chunk_hash TEXT NOT NULL CHECK (length(chunk_hash) = 64),
          PRIMARY KEY (artifact_id, chunk_index)
        )
      `)
      yield* tx.run(`
        CREATE TABLE file_part_artifact_binding (
          event_id TEXT NOT NULL PRIMARY KEY,
          aggregate_id TEXT NOT NULL REFERENCES event_sequence(aggregate_id) ON DELETE CASCADE,
          seq INTEGER NOT NULL CHECK (seq >= 0),
          part_id TEXT NOT NULL CHECK (part_id LIKE 'prt%'),
          artifact_id TEXT NOT NULL REFERENCES file_part_artifact(artifact_id) ON DELETE RESTRICT,
          original_data_hash TEXT NOT NULL CHECK (length(original_data_hash) = 64),
          canonical_data_hash TEXT NOT NULL CHECK (length(canonical_data_hash) = 64),
          canonical_data TEXT NOT NULL CHECK (json_valid(canonical_data)),
          created_at INTEGER NOT NULL,
          UNIQUE (aggregate_id, seq)
        )
      `)
      yield* tx.run(`
        CREATE INDEX file_part_artifact_binding_part_idx
        ON file_part_artifact_binding(aggregate_id, part_id, seq)
      `)
      yield* tx.run(`
        CREATE INDEX file_part_artifact_binding_artifact_idx
        ON file_part_artifact_binding(artifact_id)
      `)
      yield* tx.run(`
        CREATE TABLE file_part_artifact_import (
          event_id TEXT NOT NULL PRIMARY KEY,
          aggregate_id TEXT NOT NULL,
          seq INTEGER NOT NULL CHECK (seq >= 0),
          artifact_id TEXT NOT NULL REFERENCES file_part_artifact(artifact_id) ON DELETE CASCADE,
          original_data_hash TEXT NOT NULL CHECK (length(original_data_hash) = 64),
          canonical_data_hash TEXT NOT NULL CHECK (length(canonical_data_hash) = 64),
          canonical_data TEXT NOT NULL CHECK (json_valid(canonical_data)),
          created_at INTEGER NOT NULL,
          UNIQUE (aggregate_id, seq)
        )
      `)
      yield* tx.run(`
        CREATE INDEX file_part_artifact_import_artifact_idx
        ON file_part_artifact_import(artifact_id)
      `)
      yield* tx.run(`
        CREATE TABLE file_part_artifact_discard (
          event_id TEXT NOT NULL PRIMARY KEY,
          aggregate_id TEXT NOT NULL,
          seq INTEGER NOT NULL CHECK (seq >= 0),
          artifact_id TEXT NOT NULL REFERENCES file_part_artifact(artifact_id) ON DELETE CASCADE,
          original_data_hash TEXT NOT NULL CHECK (length(original_data_hash) = 64),
          canonical_data_hash TEXT NOT NULL CHECK (length(canonical_data_hash) = 64),
          canonical_data TEXT NOT NULL CHECK (json_valid(canonical_data)),
          created_at INTEGER NOT NULL,
          UNIQUE (aggregate_id, seq)
        )
      `)
      yield* tx.run(`
        CREATE TRIGGER file_part_artifact_binding_source_guard
        BEFORE INSERT ON file_part_artifact_binding
        BEGIN
          SELECT CASE WHEN NOT EXISTS (
            SELECT 1 FROM event source
            WHERE source.id = NEW.event_id
              AND source.aggregate_id = NEW.aggregate_id
              AND source.seq = NEW.seq
              AND source.type = 'message.part.updated.1'
          ) AND NOT EXISTS (
            SELECT 1 FROM file_part_artifact_import imported
            WHERE imported.event_id = NEW.event_id
              AND imported.aggregate_id = NEW.aggregate_id
              AND imported.seq = NEW.seq
              AND imported.artifact_id = NEW.artifact_id
              AND imported.original_data_hash = NEW.original_data_hash
              AND imported.canonical_data_hash = NEW.canonical_data_hash
              AND imported.canonical_data = NEW.canonical_data
          ) THEN RAISE(ABORT, 'file_part_artifact_source_mismatch') END;
        END
      `)
    })
  },
} satisfies DatabaseMigration.Migration
