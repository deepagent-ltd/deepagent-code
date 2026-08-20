import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

// UPD-005 (server-side compaction, Gap 1 + Gap 2) — persistence for the opaque
// `encrypted_content` returned by `/responses/compact`, plus the mode columns on
// compaction_run.
//
// Gap 1: `session_compaction_encrypted_content` holds the ONE currently-valid blob
// per session (1:1, latest wins via ON CONFLICT(session_id) DO UPDATE at the write
// site). The blob is cross-run / session-scoped — it is sent back on the NEXT
// compaction so the provider can expand it — hence an independent table rather than
// a compaction_run column. `provider_id` is recorded so the read path can verify
// same-provenance before replaying a blob (a provider switch invalidates it).
// Cleanup: session deletion cascades; the fail-over path clears explicitly.
//
// Gap 2: compaction_run gains `compaction_mode` ('local_summary' — the default and
// the only value historical rows ever carry — | 'remote_compact') and
// `encrypted_content_session` (remote mode only: pointer to the blob row). Remote
// runs commit with `summary_text` NULL by design: losslessness is guaranteed by the
// provider's encrypted context, not by text, and the information-hole check exempts
// this mode.
//
// Forward-only: additive table + two ALTER ADD COLUMN statements; no existing data
// is touched. Existing compaction_run rows read back as 'local_summary'.
//
// The authority trigger is rebuilt (same name, same state machine) so a
// 'remote_compact' run may reach 'committed' without the TEXT-summary binding
// columns: losslessness for remote runs is guaranteed by the provider's encrypted
// context (see the information-hole exemption on the read path), not by
// summary_text. local_summary runs keep the exact previous commit binding check.
export default {
  id: "20260820000000_remote_compact_persistence",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE session_compaction_encrypted_content (
          session_id        TEXT NOT NULL PRIMARY KEY REFERENCES session(id) ON DELETE CASCADE,
          encrypted_content TEXT NOT NULL,
          provider_id       TEXT NOT NULL,
          model_id          TEXT,
          source_run_id     TEXT,
          created_at        INTEGER NOT NULL,
          updated_at        INTEGER NOT NULL
        )
      `)
      yield* tx.run(`
        ALTER TABLE compaction_run ADD COLUMN compaction_mode TEXT NOT NULL DEFAULT 'local_summary'
        CHECK (compaction_mode IN ('local_summary', 'remote_compact'))
      `)
      yield* tx.run(`
        ALTER TABLE compaction_run ADD COLUMN encrypted_content_session TEXT
      `)
      // Rebuild the update authority trigger: identical transitions
      // (requested → summarizing → committed|failed|indeterminate), but the commit
      // binding check no longer applies to remote_compact runs, which commit with
      // summary_text NULL and the encrypted_content pointer instead.
      yield* tx.run("DROP TRIGGER compaction_run_authority_validate_update")
      yield* tx.run(`
        CREATE TRIGGER compaction_run_authority_validate_update
        BEFORE UPDATE ON compaction_run
        BEGIN
          SELECT CASE WHEN NOT (
            NEW.state = OLD.state OR
            (OLD.state = 'requested' AND NEW.state IN ('summarizing', 'failed', 'indeterminate')) OR
            (OLD.state = 'summarizing' AND NEW.state IN ('committed', 'failed', 'indeterminate'))
          ) THEN RAISE(ABORT, 'compaction_run_invalid_state_transition') END;
          SELECT CASE WHEN NEW.state IN ('failed', 'indeterminate') AND NEW.terminal_failure_kind IS NULL
            THEN RAISE(ABORT, 'compaction_run_terminal_failure_without_reason') END;
          SELECT CASE WHEN OLD.state != 'committed' AND NEW.state = 'committed'
            AND NEW.compaction_mode != 'remote_compact'
            AND (
            NEW.target_prompt_epoch IS NULL OR NEW.committed_summary_message_id IS NULL OR
            NEW.checkpoint_hash IS NULL OR NEW.summary_text IS NULL OR NEW.recent_context IS NULL OR
            NEW.completion_reason IS NULL OR NEW.committed_at IS NULL
          ) THEN RAISE(ABORT, 'compaction_run_commit_binding_incomplete') END;
          SELECT CASE WHEN OLD.state != 'committed' AND NEW.state = 'committed'
            AND NEW.compaction_mode = 'remote_compact'
            AND (
            NEW.encrypted_content_session IS NULL OR
            NEW.completion_reason IS NULL OR NEW.committed_at IS NULL
          ) THEN RAISE(ABORT, 'compaction_run_commit_binding_incomplete') END;
        END
      `)
    })
  },
} satisfies DatabaseMigration.Migration
