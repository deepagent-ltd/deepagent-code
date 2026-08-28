import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

// UPD-005: replace the session latest-wins blob with immutable per-run blobs and
// a session current-head pointer. The old singleton remains as a compatibility
// projection, but it is no longer release provenance and may not be used to
// validate a committed run.
export default {
  id: "20260821140000_remote_compact_per_run_blob",
  up(tx) {
    return Effect.gen(function* () {
      const compactionColumns = new Set(
        (yield* tx.all<{ name: string }>("PRAGMA table_info(compaction_run)")).map((column) => column.name),
      )
      if (!compactionColumns.has("encrypted_content_blob_id"))
        yield* tx.run("ALTER TABLE compaction_run ADD COLUMN encrypted_content_blob_id TEXT")

      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS session_compaction_encrypted_blob (
          blob_id TEXT PRIMARY KEY NOT NULL,
          session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
          encrypted_content TEXT NOT NULL,
          provider_id TEXT NOT NULL,
          model_id TEXT,
          source_run_id TEXT,
          source_end_message_id TEXT,
          created_at INTEGER NOT NULL
        )
      `)
      yield* tx.run(`
        CREATE UNIQUE INDEX IF NOT EXISTS session_compaction_encrypted_blob_run_idx
        ON session_compaction_encrypted_blob(source_run_id)
        WHERE source_run_id IS NOT NULL
      `)
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS session_compaction_encrypted_head (
          session_id TEXT PRIMARY KEY NOT NULL REFERENCES session(id) ON DELETE CASCADE,
          blob_id TEXT NOT NULL REFERENCES session_compaction_encrypted_blob(blob_id),
          updated_at INTEGER NOT NULL
        )
      `)

      // The 1:1 table is the only source available on an upgrade. Copy each
      // verifiable row exactly once; legacy rows without a run keep a stable
      // synthetic id and are usable for replay but cannot validate a commit.
      yield* tx.run(`
        INSERT OR IGNORE INTO session_compaction_encrypted_blob (
          blob_id, session_id, encrypted_content, provider_id, model_id,
          source_run_id, source_end_message_id, created_at
        )
        SELECT
          COALESCE(NULLIF(source_run_id, ''), 'legacy:' || session_id),
          session_id, encrypted_content, provider_id, model_id,
          NULLIF(source_run_id, ''), source_end_message_id, created_at
        FROM session_compaction_encrypted_content
        WHERE session_id IS NOT NULL
      `)
      yield* tx.run(`
        INSERT OR REPLACE INTO session_compaction_encrypted_head (session_id, blob_id, updated_at)
        SELECT content.session_id,
          COALESCE(NULLIF(content.source_run_id, ''), 'legacy:' || content.session_id),
          content.updated_at
        FROM session_compaction_encrypted_content content
      `)
      yield* tx.run(`
        UPDATE compaction_run
        SET encrypted_content_blob_id = (
          SELECT blob.blob_id
          FROM session_compaction_encrypted_blob blob
          WHERE blob.source_run_id = compaction_run.run_id
            AND blob.session_id = compaction_run.session_id
        )
        WHERE compaction_mode = 'remote_compact'
          AND state = 'committed'
          AND encrypted_content_blob_id IS NULL
      `)

      yield* tx.run(`
        CREATE TRIGGER session_compaction_encrypted_head_session_insert
        BEFORE INSERT ON session_compaction_encrypted_head
        WHEN NOT EXISTS (
          SELECT 1 FROM session_compaction_encrypted_blob blob
          WHERE blob.blob_id = NEW.blob_id AND blob.session_id = NEW.session_id
        )
        BEGIN
          SELECT RAISE(ABORT, 'remote compaction head must reference a blob from the same session');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER session_compaction_encrypted_head_session_update
        BEFORE UPDATE OF session_id, blob_id ON session_compaction_encrypted_head
        WHEN NOT EXISTS (
          SELECT 1 FROM session_compaction_encrypted_blob blob
          WHERE blob.blob_id = NEW.blob_id AND blob.session_id = NEW.session_id
        )
        BEGIN
          SELECT RAISE(ABORT, 'remote compaction head must reference a blob from the same session');
        END
      `)

      yield* tx.run("DROP TRIGGER IF EXISTS compaction_run_remote_pointer_integrity")
      yield* tx.run(`
        CREATE TRIGGER compaction_run_remote_blob_integrity
        BEFORE UPDATE OF state, compaction_mode, encrypted_content_blob_id, remote_provider_id
        ON compaction_run
        WHEN NEW.state = 'committed'
          AND NEW.compaction_mode = 'remote_compact'
          AND (
            OLD.state IS NOT NEW.state
            OR OLD.compaction_mode IS NOT NEW.compaction_mode
            OR OLD.encrypted_content_blob_id IS NOT NEW.encrypted_content_blob_id
            OR OLD.remote_provider_id IS NOT NEW.remote_provider_id
          )
        BEGIN
          SELECT CASE WHEN NEW.encrypted_content_blob_id IS NULL
            OR NEW.encrypted_content_session IS NULL
            OR NEW.encrypted_content_session != NEW.session_id
            OR NOT EXISTS (
              SELECT 1
              FROM session_compaction_encrypted_blob blob
              WHERE blob.blob_id = NEW.encrypted_content_blob_id
                AND blob.session_id = NEW.session_id
                AND blob.source_run_id = NEW.run_id
                AND blob.provider_id = NEW.remote_provider_id
            )
          THEN RAISE(ABORT, 'remote committed run must point to its immutable per-run blob') END;
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER session_compaction_encrypted_blob_immutable
        BEFORE UPDATE OF blob_id, session_id, encrypted_content, provider_id,
          model_id, source_run_id, source_end_message_id, created_at
        ON session_compaction_encrypted_blob
        BEGIN
          SELECT RAISE(ABORT, 'remote compaction blobs are immutable');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER session_compaction_encrypted_blob_delete_guard
        BEFORE DELETE ON session_compaction_encrypted_blob
        WHEN EXISTS (SELECT 1 FROM session WHERE id = OLD.session_id)
          AND EXISTS (
            SELECT 1 FROM compaction_run run
            WHERE run.encrypted_content_blob_id = OLD.blob_id
              AND run.state = 'committed'
              AND run.compaction_mode = 'remote_compact'
          )
        BEGIN
          SELECT RAISE(ABORT, 'committed remote compaction blobs cannot be deleted');
        END
      `)
    })
  },
} satisfies DatabaseMigration.Migration
