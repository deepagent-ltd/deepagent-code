import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260813140000_event_sidecar_compaction",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS file_part_artifact_discard (
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

      const snapshotRowColumns = (yield* tx.all<{ name: string }>("PRAGMA table_info('event_snapshot_row')"))
        .map((column) => column.name)
      const sequenceColumns = (yield* tx.all<{ name: string }>("PRAGMA table_info('event_sequence')"))
        .map((column) => column.name)
      const hasSnapshotAuthority = sequenceColumns.includes("snapshot_id") && sequenceColumns.includes("retention_floor_seq")
      const legacySnapshotRowColumns = [
        "snapshot_id", "row_index", "table_name", "row_key", "row_hash", "row_bytes", "chunk_count", "chain_hash",
      ]
      const currentSnapshotRowColumns = [
        "snapshot_id", "aggregate_id", "row_index", "table_name", "row_key", "row_hash", "row_bytes", "chunk_count", "chain_hash",
      ]
      const hasSnapshotRows = snapshotRowColumns.length > 0
      const legacySnapshotRows = snapshotRowColumns.join("\0") === legacySnapshotRowColumns.join("\0")
      if (hasSnapshotRows && !legacySnapshotRows && snapshotRowColumns.join("\0") !== currentSnapshotRowColumns.join("\0"))
        return yield* Effect.fail(new Error(`unsupported event_snapshot_row schema: ${snapshotRowColumns.join(",")}`))
      const snapshotColumns = (yield* tx.all<{ name: string }>("PRAGMA table_info('event_snapshot')")).map(
        (column) => column.name,
      )
      const expectedSnapshotColumns = [
        "snapshot_id", "aggregate_id", "through_seq", "sync_seq", "codec", "schema_version",
        "snapshot_hash", "body", "owner_id", "created_at",
      ]
      if (hasSnapshotRows && snapshotColumns.join("\0") !== expectedSnapshotColumns.join("\0"))
        return yield* Effect.fail(new Error(`unsupported event_snapshot schema: ${snapshotColumns.join(",")}`))

      const uniqueSnapshotIndexColumns = yield* Effect.forEach(
        (yield* tx.all<{ name: string; unique: number }>("PRAGMA index_list('event_snapshot')"))
          .filter((index) => index.unique === 1),
        (index) => {
          if (!/^[A-Za-z0-9_]+$/.test(index.name)) return Effect.fail(new Error("invalid event_snapshot index name"))
          return tx.all<{ name: string }>(`PRAGMA index_info('${index.name}')`).pipe(
            Effect.map((columns) => columns.map((column) => column.name).join(",")),
          )
        },
      )
      const snapshotUniqueShapes = [...uniqueSnapshotIndexColumns].sort()
      const legacySnapshot = snapshotUniqueShapes.join("\0") === ["aggregate_id,through_seq", "snapshot_id", "sync_seq"].sort().join("\0")
      const currentSnapshot = snapshotUniqueShapes.join("\0") === ["snapshot_id", "sync_seq"].sort().join("\0")
      if (hasSnapshotRows && !legacySnapshot && !currentSnapshot)
        return yield* Effect.fail(new Error(`unsupported event_snapshot uniqueness: ${snapshotUniqueShapes.join(";")}`))

      if (hasSnapshotAuthority) {
        yield* tx.run("DROP TRIGGER IF EXISTS event_sequence_snapshot_validate_update")
        yield* tx.run("DROP TRIGGER IF EXISTS event_snapshot_delete_active_guard")
      }
      yield* tx.run("DROP TRIGGER IF EXISTS event_snapshot_row_immutable")
      yield* tx.run("DROP TRIGGER IF EXISTS event_snapshot_row_delete_guard")
      yield* tx.run("DROP TRIGGER IF EXISTS event_snapshot_row_chunk_cleanup")
      yield* tx.run("DROP TRIGGER IF EXISTS event_snapshot_chunk_delete_guard")
      yield* tx.run("DROP TRIGGER IF EXISTS event_snapshot_aggregate_cleanup")

      if (hasSnapshotRows && legacySnapshot) {
        yield* tx.run("ALTER TABLE event_snapshot RENAME TO event_snapshot_legacy")
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
            created_at INTEGER NOT NULL
          )
        `)
        yield* tx.run(`
          INSERT INTO event_snapshot(
            snapshot_id, aggregate_id, through_seq, sync_seq, codec, schema_version,
            snapshot_hash, body, owner_id, created_at
          )
          SELECT snapshot_id, aggregate_id, through_seq, sync_seq, codec, schema_version,
            snapshot_hash, body, owner_id, created_at
          FROM event_snapshot_legacy
        `)
        yield* tx.run("DROP TABLE event_snapshot_legacy")
        yield* tx.run("CREATE INDEX event_snapshot_aggregate_created_idx ON event_snapshot(aggregate_id, created_at)")
        yield* tx.run("CREATE INDEX event_snapshot_aggregate_seq_idx ON event_snapshot(aggregate_id, through_seq)")
      }

      if (hasSnapshotRows && legacySnapshotRows) {
        const conflictingAuthorities = yield* tx.get<{ count: number }>(`
          SELECT COUNT(*) AS count
          FROM event_snapshot_row row
          JOIN event_snapshot_attempt attempt ON attempt.snapshot_id = row.snapshot_id
          JOIN event_snapshot snapshot ON snapshot.snapshot_id = row.snapshot_id
          WHERE attempt.aggregate_id != snapshot.aggregate_id
        `)
        if ((conflictingAuthorities?.count ?? 0) !== 0)
          return yield* Effect.fail(new Error("legacy event_snapshot_row has conflicting aggregate authorities"))
        yield* tx.run(`
          CREATE TEMP TABLE event_snapshot_orphan_row_hash (
            row_hash TEXT NOT NULL PRIMARY KEY
          ) WITHOUT ROWID
        `)
        yield* tx.run(`
          INSERT OR IGNORE INTO event_snapshot_orphan_row_hash(row_hash)
          SELECT row.row_hash
          FROM event_snapshot_row row
          LEFT JOIN event_snapshot_attempt attempt ON attempt.snapshot_id = row.snapshot_id
          LEFT JOIN event_snapshot snapshot ON snapshot.snapshot_id = row.snapshot_id
          WHERE (attempt.aggregate_id IS NULL AND snapshot.aggregate_id IS NULL)
            OR (attempt.aggregate_id IS NOT NULL AND NOT EXISTS (
              SELECT 1 FROM event_sequence sequence WHERE sequence.aggregate_id = attempt.aggregate_id
            ))
        `)
        yield* tx.run(`
          DELETE FROM event_snapshot_row
          WHERE snapshot_id IN (
            SELECT row.snapshot_id
            FROM event_snapshot_row row
            LEFT JOIN event_snapshot_attempt attempt ON attempt.snapshot_id = row.snapshot_id
            LEFT JOIN event_snapshot snapshot ON snapshot.snapshot_id = row.snapshot_id
            WHERE (attempt.aggregate_id IS NULL AND snapshot.aggregate_id IS NULL)
              OR (attempt.aggregate_id IS NOT NULL AND NOT EXISTS (
                SELECT 1 FROM event_sequence sequence WHERE sequence.aggregate_id = attempt.aggregate_id
              ))
          )
        `)
        yield* tx.run(`
          DELETE FROM event_snapshot_chunk
          WHERE row_hash IN (SELECT row_hash FROM event_snapshot_orphan_row_hash)
            AND NOT EXISTS (
              SELECT 1 FROM event_snapshot_row row
              WHERE row.row_hash = event_snapshot_chunk.row_hash
            )
        `)
        yield* tx.run("DROP TABLE event_snapshot_orphan_row_hash")
        yield* tx.run("ALTER TABLE event_snapshot_row RENAME TO event_snapshot_row_legacy")
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
        yield* tx.run(`
          INSERT INTO event_snapshot_row(
            snapshot_id, aggregate_id, row_index, table_name, row_key,
            row_hash, row_bytes, chunk_count, chain_hash
          )
          SELECT row.snapshot_id, COALESCE(attempt.aggregate_id, snapshot.aggregate_id),
            row.row_index, row.table_name, row.row_key,
            row.row_hash, row.row_bytes, row.chunk_count, row.chain_hash
          FROM event_snapshot_row_legacy row
          LEFT JOIN event_snapshot_attempt attempt ON attempt.snapshot_id = row.snapshot_id
          LEFT JOIN event_snapshot snapshot ON snapshot.snapshot_id = row.snapshot_id
          WHERE COALESCE(attempt.aggregate_id, snapshot.aggregate_id) IS NOT NULL
        `)
        yield* tx.run("DROP TABLE event_snapshot_row_legacy")
      }

      const attemptColumns = yield* tx.all<{ name: string }>("PRAGMA table_info('event_snapshot_attempt')")
      const expectedAttemptColumns = [
        "snapshot_id", "aggregate_id", "through_seq", "expected_latest", "owner_id", "codec",
        "schema_version", "projection_revision", "cursor", "row_count", "encoded_bytes", "content_hash",
        "tables", "state", "created_at", "updated_at",
      ]
      if (hasSnapshotRows && attemptColumns.length > 0 && attemptColumns.map((column) => column.name).join("\0") !== expectedAttemptColumns.join("\0"))
        return yield* Effect.fail(new Error(`unsupported event_snapshot_attempt schema: ${attemptColumns.map((column) => column.name).join(",")}`))
      const attemptForeignKeys = attemptColumns.length === 0
        ? []
        : yield* tx.all<{ from: string; table: string; to: string; on_delete: string }>(
            "PRAGMA foreign_key_list('event_snapshot_attempt')",
          )
      if (attemptColumns.length > 0 && !attemptForeignKeys.some((foreignKey) =>
        foreignKey.from === "aggregate_id" && foreignKey.table === "event_sequence" &&
        foreignKey.to === "aggregate_id" && foreignKey.on_delete.toUpperCase() === "CASCADE")) {
        yield* tx.run(`
          CREATE TEMP TABLE event_snapshot_orphan_attempt (
            snapshot_id TEXT NOT NULL PRIMARY KEY
          ) WITHOUT ROWID
        `)
        yield* tx.run(`
          INSERT INTO event_snapshot_orphan_attempt(snapshot_id)
          SELECT attempt.snapshot_id
          FROM event_snapshot_attempt attempt
          LEFT JOIN event_sequence sequence ON sequence.aggregate_id = attempt.aggregate_id
          WHERE sequence.aggregate_id IS NULL
        `)
        yield* tx.run(`
          DELETE FROM event_snapshot_row
          WHERE snapshot_id IN (SELECT snapshot_id FROM event_snapshot_orphan_attempt)
            AND NOT EXISTS (
              SELECT 1 FROM event_snapshot snapshot
              WHERE snapshot.snapshot_id = event_snapshot_row.snapshot_id
            )
        `)
        yield* tx.run(`
          DELETE FROM event_snapshot_chunk
          WHERE NOT EXISTS (
            SELECT 1 FROM event_snapshot_row row
            WHERE row.row_hash = event_snapshot_chunk.row_hash
          )
        `)
        yield* tx.run(`
          DELETE FROM event_snapshot_attempt
          WHERE snapshot_id IN (SELECT snapshot_id FROM event_snapshot_orphan_attempt)
        `)
        yield* tx.run("DROP TABLE event_snapshot_orphan_attempt")
        yield* tx.run("ALTER TABLE event_snapshot_attempt RENAME TO event_snapshot_attempt_legacy")
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
        yield* tx.run(`
          INSERT INTO event_snapshot_attempt(
            snapshot_id, aggregate_id, through_seq, expected_latest, owner_id, codec,
            schema_version, projection_revision, cursor, row_count, encoded_bytes,
            content_hash, tables, state, created_at, updated_at
          )
          SELECT snapshot_id, aggregate_id, through_seq, expected_latest, owner_id, codec,
            schema_version, projection_revision, cursor, row_count, encoded_bytes,
            content_hash, tables, state, created_at, updated_at
          FROM event_snapshot_attempt_legacy
        `)
        yield* tx.run("DROP TABLE event_snapshot_attempt_legacy")
      }

      if (hasSnapshotAuthority) {
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
      }
      if (hasSnapshotRows) {
        yield* tx.run("CREATE INDEX IF NOT EXISTS event_snapshot_row_hash_idx ON event_snapshot_row(row_hash)")
        yield* tx.run("CREATE INDEX IF NOT EXISTS event_snapshot_row_aggregate_idx ON event_snapshot_row(aggregate_id)")
        yield* tx.run("CREATE INDEX IF NOT EXISTS event_snapshot_attempt_aggregate_idx ON event_snapshot_attempt(aggregate_id)")
        yield* tx.run(`
          CREATE TRIGGER event_snapshot_row_immutable
          BEFORE UPDATE ON event_snapshot_row
          BEGIN
            SELECT RAISE(ABORT, 'event_snapshot_row_immutable');
          END
        `)
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
            DELETE FROM event_snapshot_attempt WHERE aggregate_id = OLD.aggregate_id;
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
      }

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
            AND (
              dedupe.source_data = OLD.data
              OR (
                dedupe.source_data IS NULL
                AND (
                  EXISTS (
                    SELECT 1 FROM event_artifact artifact
                    WHERE artifact.event_id = OLD.id
                      AND artifact.aggregate_id = OLD.aggregate_id
                      AND artifact.seq = OLD.seq
                      AND artifact.original_data_hash = dedupe.data_hash
                  )
                  OR EXISTS (
                    SELECT 1 FROM file_part_artifact_binding binding
                    WHERE binding.event_id = OLD.id
                      AND binding.aggregate_id = OLD.aggregate_id
                      AND binding.seq = OLD.seq
                      AND binding.original_data_hash = dedupe.data_hash
                  )
                )
              )
            )
        )
        BEGIN
          SELECT RAISE(ABORT, 'event_compaction_dedupe_missing');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER event_dedupe_update_guard
        BEFORE UPDATE ON event_dedupe
        WHEN NOT (
          NEW.aggregate_id = OLD.aggregate_id
          AND NEW.seq = OLD.seq
          AND NEW.event_id = OLD.event_id
          AND NEW.type = OLD.type
          AND NEW.data_hash = OLD.data_hash
          AND NEW.compacted_at = OLD.compacted_at
          AND OLD.source_data IS NOT NULL
          AND NEW.source_data IS NULL
        )
        BEGIN
          SELECT RAISE(ABORT, 'event_dedupe_update_immutable');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER event_dedupe_delete_guard
        BEFORE DELETE ON event_dedupe
        WHEN EXISTS (
          SELECT 1 FROM event_sequence sequence
          WHERE sequence.aggregate_id = OLD.aggregate_id
        )
        BEGIN
          SELECT RAISE(ABORT, 'event_dedupe_delete_immutable');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER event_snapshot_update_immutable
        BEFORE UPDATE ON event_snapshot
        BEGIN
          SELECT RAISE(ABORT, 'event_snapshot_update_immutable');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER file_part_artifact_import_update_immutable
        BEFORE UPDATE ON file_part_artifact_import
        BEGIN
          SELECT RAISE(ABORT, 'file_part_artifact_import_update_immutable');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER file_part_artifact_import_delete_guard
        BEFORE DELETE ON file_part_artifact_import
        WHEN EXISTS (
          SELECT 1 FROM file_part_artifact artifact
          WHERE artifact.artifact_id = OLD.artifact_id
        ) AND NOT EXISTS (
          SELECT 1 FROM file_part_artifact_binding binding
          WHERE binding.event_id = OLD.event_id
            AND binding.aggregate_id = OLD.aggregate_id
            AND binding.seq = OLD.seq
            AND binding.artifact_id = OLD.artifact_id
            AND binding.original_data_hash = OLD.original_data_hash
            AND binding.canonical_data_hash = OLD.canonical_data_hash
            AND binding.canonical_data = OLD.canonical_data
        ) AND NOT EXISTS (
          SELECT 1 FROM file_part_artifact_discard discard
          WHERE discard.event_id = OLD.event_id
            AND discard.aggregate_id = OLD.aggregate_id
            AND discard.seq = OLD.seq
            AND discard.artifact_id = OLD.artifact_id
            AND discard.original_data_hash = OLD.original_data_hash
            AND discard.canonical_data_hash = OLD.canonical_data_hash
            AND discard.canonical_data = OLD.canonical_data
        )
        BEGIN
          SELECT RAISE(ABORT, 'file_part_artifact_import_not_consumed');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER file_part_artifact_discard_update_immutable
        BEFORE UPDATE ON file_part_artifact_discard
        BEGIN
          SELECT RAISE(ABORT, 'file_part_artifact_discard_update_immutable');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER file_part_artifact_discard_delete_guard
        BEFORE DELETE ON file_part_artifact_discard
        WHEN EXISTS (
          SELECT 1 FROM file_part_artifact artifact
          WHERE artifact.artifact_id = OLD.artifact_id
        )
        BEGIN
          SELECT RAISE(ABORT, 'file_part_artifact_discard_delete_immutable');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER file_part_artifact_binding_cleanup
        AFTER DELETE ON file_part_artifact_binding
        BEGIN
          DELETE FROM file_part_artifact
          WHERE artifact_id = OLD.artifact_id
            AND NOT EXISTS (
              SELECT 1 FROM file_part_artifact_binding binding
              WHERE binding.artifact_id = OLD.artifact_id
            )
            AND NOT EXISTS (
              SELECT 1 FROM file_part_artifact_import imported
              WHERE imported.artifact_id = OLD.artifact_id
            );
        END
      `)
      yield* tx.run(`
        CREATE INDEX IF NOT EXISTS file_part_artifact_binding_artifact_idx
        ON file_part_artifact_binding(artifact_id)
      `)
      yield* tx.run(`
        CREATE INDEX IF NOT EXISTS file_part_artifact_import_artifact_idx
        ON file_part_artifact_import(artifact_id)
      `)
    })
  },
} satisfies DatabaseMigration.Migration
