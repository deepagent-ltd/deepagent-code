import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260813135000_event_immutable",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TRIGGER event_update_immutable
        BEFORE UPDATE ON event
        BEGIN
          SELECT RAISE(ABORT, 'event_update_immutable');
        END
      `)
      for (const table of [
        "event_artifact",
        "event_artifact_chunk",
        "file_part_artifact_chunk",
        "file_part_artifact_binding",
        "session_diff_artifact_file",
        "session_diff_artifact_file_chunk",
      ]) {
        yield* tx.run(`
          CREATE TRIGGER ${table}_update_immutable
          BEFORE UPDATE ON ${table}
          BEGIN
            SELECT RAISE(ABORT, '${table}_update_immutable');
          END
        `)
      }
      yield* tx.run(`
        CREATE TRIGGER file_part_artifact_update_immutable
        BEFORE UPDATE ON file_part_artifact
        WHEN NOT (
          OLD.complete = 0 AND NEW.complete = 1
          AND NEW.artifact_id = OLD.artifact_id
          AND NEW.body_hash = OLD.body_hash
          AND NEW.body_bytes = OLD.body_bytes
          AND NEW.chunk_bytes = OLD.chunk_bytes
          AND NEW.chunk_count = OLD.chunk_count
          AND NEW.codec_version = OLD.codec_version
          AND NEW.created_at = OLD.created_at
        )
        BEGIN
          SELECT RAISE(ABORT, 'file_part_artifact_update_immutable');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER event_artifact_delete_immutable
        BEFORE DELETE ON event_artifact
        WHEN EXISTS (SELECT 1 FROM event_sequence WHERE aggregate_id = OLD.aggregate_id)
        BEGIN
          SELECT RAISE(ABORT, 'event_artifact_delete_immutable');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER event_artifact_chunk_delete_immutable
        BEFORE DELETE ON event_artifact_chunk
        WHEN EXISTS (SELECT 1 FROM event_artifact WHERE artifact_id = OLD.artifact_id)
        BEGIN
          SELECT RAISE(ABORT, 'event_artifact_chunk_delete_immutable');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER file_part_artifact_binding_delete_immutable
        BEFORE DELETE ON file_part_artifact_binding
        WHEN EXISTS (SELECT 1 FROM event_sequence WHERE aggregate_id = OLD.aggregate_id)
        BEGIN
          SELECT RAISE(ABORT, 'file_part_artifact_binding_delete_immutable');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER file_part_artifact_delete_guard
        BEFORE DELETE ON file_part_artifact
        WHEN EXISTS (SELECT 1 FROM file_part_artifact_binding WHERE artifact_id = OLD.artifact_id)
          OR EXISTS (SELECT 1 FROM file_part_artifact_import WHERE artifact_id = OLD.artifact_id)
        BEGIN
          SELECT RAISE(ABORT, 'file_part_artifact_is_referenced');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER file_part_artifact_chunk_delete_immutable
        BEFORE DELETE ON file_part_artifact_chunk
        WHEN EXISTS (SELECT 1 FROM file_part_artifact WHERE artifact_id = OLD.artifact_id)
        BEGIN
          SELECT RAISE(ABORT, 'file_part_artifact_chunk_delete_immutable');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER session_diff_artifact_file_delete_immutable
        BEFORE DELETE ON session_diff_artifact_file
        WHEN EXISTS (
          SELECT 1 FROM session_diff_migration_receipt receipt
          WHERE receipt.artifact_id = OLD.artifact_id AND receipt.state = 'committed'
        )
        BEGIN
          SELECT RAISE(ABORT, 'session_diff_artifact_file_delete_immutable');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER session_diff_artifact_file_chunk_delete_immutable
        BEFORE DELETE ON session_diff_artifact_file_chunk
        WHEN EXISTS (
          SELECT 1 FROM session_diff_migration_receipt receipt
          WHERE receipt.artifact_id = OLD.artifact_id AND receipt.state = 'committed'
        )
        BEGIN
          SELECT RAISE(ABORT, 'session_diff_artifact_file_chunk_delete_immutable');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER session_diff_migration_receipt_delete_immutable
        BEFORE DELETE ON session_diff_migration_receipt
        WHEN OLD.state = 'committed'
          AND EXISTS (SELECT 1 FROM session WHERE id = OLD.session_id)
        BEGIN
          SELECT RAISE(ABORT, 'session_diff_migration_receipt_delete_immutable');
        END
      `)
    })
  },
} satisfies DatabaseMigration.Migration
