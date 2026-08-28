import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

// UPD-005: a remote commit is only valid when its session-scoped pointer resolves
// to the blob written for the same compaction run. The original migration checked
// only that the pointer was non-empty, which allowed dangling or cross-session
// pointers to become committed state.
export default {
  id: "20260821120000_remote_compact_pointer_integrity",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE compaction_run ADD COLUMN remote_provider_id TEXT`)
      yield* tx.run(`DROP TRIGGER IF EXISTS compaction_run_remote_pointer_integrity`)
      yield* tx.run(`
        CREATE TRIGGER compaction_run_remote_pointer_integrity
        BEFORE UPDATE ON compaction_run
        WHEN NEW.state = 'committed'
          AND NEW.compaction_mode = 'remote_compact'
          AND (
            OLD.state != 'committed' OR
            OLD.encrypted_content_session IS NOT NEW.encrypted_content_session OR
            OLD.remote_provider_id IS NOT NEW.remote_provider_id
          )
        BEGIN
          SELECT CASE WHEN NEW.encrypted_content_session IS NULL
              OR NEW.encrypted_content_session != NEW.session_id
            THEN RAISE(ABORT, 'remote compaction pointer session mismatch') END;
          SELECT CASE WHEN NOT EXISTS (
              SELECT 1
              FROM session_compaction_encrypted_content blob
              WHERE blob.session_id = NEW.session_id
                AND blob.source_run_id = NEW.run_id
                AND blob.provider_id = NEW.remote_provider_id
            )
            THEN RAISE(ABORT, 'remote compaction pointer blob is missing or has different provenance') END;
        END
      `)
      // The released 1:1 table only retains the latest blob for a session. Backfill
      // the committed run that still has exact provenance; older committed runs
      // remain explicit legacy history with a NULL provider and are not replayable.
      // Every new non-committed -> committed transition is still fail-closed above.
      yield* tx.run(`
        UPDATE compaction_run
        SET remote_provider_id = (
          SELECT blob.provider_id
          FROM session_compaction_encrypted_content blob
          WHERE blob.session_id = compaction_run.encrypted_content_session
            AND blob.source_run_id = compaction_run.run_id
        )
        WHERE state = 'committed' AND compaction_mode = 'remote_compact'
      `)
    })
  },
} satisfies DatabaseMigration.Migration
