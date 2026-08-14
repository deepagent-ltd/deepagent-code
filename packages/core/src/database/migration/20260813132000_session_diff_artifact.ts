import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260813132000_session_diff_artifact",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE session_diff_migration_receipt (
          message_id TEXT NOT NULL PRIMARY KEY REFERENCES message(id) ON DELETE CASCADE,
          session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
          artifact_id TEXT NOT NULL UNIQUE REFERENCES event_artifact(artifact_id) ON DELETE RESTRICT,
          source_event_id TEXT NOT NULL,
          expected_message_data_hash TEXT NOT NULL CHECK (length(expected_message_data_hash) = 64),
          committed_message_data_hash TEXT CHECK (committed_message_data_hash IS NULL OR length(committed_message_data_hash) = 64),
          expected_session_summary_hash TEXT NOT NULL CHECK (length(expected_session_summary_hash) = 64),
          committed_session_summary_hash TEXT CHECK (committed_session_summary_hash IS NULL OR length(committed_session_summary_hash) = 64),
          canonicalizer_version INTEGER NOT NULL CHECK (canonicalizer_version >= 1),
          canonicalization_version INTEGER NOT NULL CHECK (canonicalization_version >= 1),
          epoch_hashes TEXT NOT NULL CHECK (json_valid(epoch_hashes)),
          state TEXT NOT NULL CHECK (state IN ('prepared', 'committed', 'migration_validation_failed')),
          failure_reason TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          committed_at INTEGER,
          CHECK (
            (state = 'committed' AND committed_message_data_hash IS NOT NULL AND committed_session_summary_hash IS NOT NULL AND committed_at IS NOT NULL AND failure_reason IS NULL)
            OR (state = 'migration_validation_failed' AND committed_message_data_hash IS NULL AND committed_session_summary_hash IS NULL AND committed_at IS NULL AND failure_reason IS NOT NULL)
            OR (state = 'prepared' AND committed_message_data_hash IS NULL AND committed_session_summary_hash IS NULL AND committed_at IS NULL AND failure_reason IS NULL)
          )
        )
      `)
      yield* tx.run(
        "CREATE INDEX session_diff_migration_receipt_session_state_idx ON session_diff_migration_receipt(session_id, state)",
      )
      yield* tx.run(`
        CREATE TABLE session_diff_artifact_file (
          artifact_id TEXT NOT NULL REFERENCES event_artifact(artifact_id) ON DELETE CASCADE,
          file_index INTEGER NOT NULL CHECK (file_index >= 0),
          path TEXT NOT NULL CHECK (length(path) > 0),
          path_key TEXT NOT NULL CHECK (length(path_key) > 0),
          additions INTEGER NOT NULL CHECK (additions >= 0),
          deletions INTEGER NOT NULL CHECK (deletions >= 0),
          status TEXT CHECK (status IS NULL OR status IN ('added', 'deleted', 'modified')),
          patch_hash TEXT NOT NULL CHECK (length(patch_hash) = 64),
          patch_bytes INTEGER NOT NULL CHECK (patch_bytes >= 0),
          patch_chunk_count INTEGER NOT NULL CHECK (patch_chunk_count >= 1),
          PRIMARY KEY (artifact_id, file_index),
          UNIQUE (artifact_id, path_key)
        )
      `)
      yield* tx.run(`
        CREATE TABLE session_diff_artifact_file_chunk (
          artifact_id TEXT NOT NULL,
          file_index INTEGER NOT NULL,
          chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
          data BLOB NOT NULL,
          chunk_hash TEXT NOT NULL CHECK (length(chunk_hash) = 64),
          PRIMARY KEY (artifact_id, file_index, chunk_index),
          FOREIGN KEY (artifact_id, file_index)
            REFERENCES session_diff_artifact_file(artifact_id, file_index) ON DELETE CASCADE
        )
      `)
      yield* tx.run(`
        CREATE TRIGGER session_diff_migration_receipt_committed_immutable
        BEFORE UPDATE ON session_diff_migration_receipt
        WHEN OLD.state = 'committed'
        BEGIN
          SELECT RAISE(ABORT, 'session_diff_migration_receipt_committed_immutable');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER session_diff_artifact_file_receipt_guard
        BEFORE INSERT ON session_diff_artifact_file
        WHEN NOT EXISTS (
          SELECT 1 FROM session_diff_migration_receipt receipt
          WHERE receipt.artifact_id = NEW.artifact_id
            AND receipt.state = 'prepared'
        )
        BEGIN
          SELECT RAISE(ABORT, 'session_diff_artifact_file_requires_prepared_receipt');
        END
      `)
    })
  },
} satisfies DatabaseMigration.Migration
