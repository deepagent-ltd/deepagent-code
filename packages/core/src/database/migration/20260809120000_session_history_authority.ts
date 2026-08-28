import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260809120000_session_history_authority",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run("ALTER TABLE session_prompt_epoch ADD COLUMN projection_version INTEGER")
      yield* tx.run("ALTER TABLE session_prompt_epoch ADD COLUMN canonicalization_version INTEGER")
      yield* tx.run("ALTER TABLE session_prompt_epoch ADD COLUMN base_message_count INTEGER")
      yield* tx.run("ALTER TABLE session_prompt_epoch ADD COLUMN effective_history_hash TEXT")
      yield* tx.run("ALTER TABLE session_prompt_epoch ADD COLUMN first_window_id TEXT")
      yield* tx.run("ALTER TABLE session_prompt_epoch ADD COLUMN previous_window_id TEXT")
      yield* tx.run("ALTER TABLE session_prompt_epoch ADD COLUMN window_id TEXT")
      yield* tx.run("ALTER TABLE session_prompt_epoch ADD COLUMN world_state_baseline_hash TEXT")
      yield* tx.run(`
        ALTER TABLE session_prompt_epoch ADD COLUMN authority_state TEXT
        CHECK (authority_state IN ('legacy_pending', 'ready', 'recovery_required'))
      `)
      yield* tx.run("ALTER TABLE session_prompt_epoch ADD COLUMN recovery_reason TEXT")
      yield* tx.run("ALTER TABLE compaction_run ADD COLUMN summary_text TEXT")
      yield* tx.run("ALTER TABLE compaction_run ADD COLUMN recent_context TEXT")
      yield* tx.run(`
        ALTER TABLE compaction_run ADD COLUMN completion_reason TEXT
        CHECK (completion_reason IN ('auto', 'manual'))
      `)
      yield* tx.run("ALTER TABLE compaction_run ADD COLUMN continuation_published_at INTEGER")
      yield* tx.run("ALTER TABLE compaction_run ADD COLUMN terminal_events_published_at INTEGER")
      yield* tx.run(`
        UPDATE session_prompt_epoch
        SET authority_state = 'legacy_pending'
        WHERE authority_state IS NULL
      `)
      yield* tx.run(`
        CREATE UNIQUE INDEX session_prompt_epoch_window_idx
        ON session_prompt_epoch (window_id)
        WHERE window_id IS NOT NULL
      `)

      yield* tx.run(`
        CREATE TABLE session_history_state (
          session_id TEXT NOT NULL PRIMARY KEY REFERENCES session(id) ON DELETE CASCADE,
          state TEXT NOT NULL CHECK (state IN ('ready', 'provisioning', 'recovery_required')),
          reason TEXT,
          time_created INTEGER NOT NULL,
          time_updated INTEGER NOT NULL
        )
      `)

      yield* tx.run(`
        CREATE TABLE session_prompt_epoch_message (
          session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
          prompt_epoch INTEGER NOT NULL,
          ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
          message_id TEXT NOT NULL REFERENCES message(id) ON DELETE CASCADE,
          PRIMARY KEY (session_id, prompt_epoch, ordinal),
          UNIQUE (session_id, prompt_epoch, message_id)
        )
      `)
      yield* tx.run(`
        CREATE INDEX session_prompt_epoch_message_lookup_idx
        ON session_prompt_epoch_message (session_id, prompt_epoch, message_id)
      `)
      yield* tx.run(`
        CREATE TRIGGER session_prompt_epoch_message_validate_insert
        BEFORE INSERT ON session_prompt_epoch_message
        BEGIN
          SELECT CASE WHEN NOT EXISTS (
            SELECT 1 FROM session_prompt_epoch
            WHERE session_id = NEW.session_id AND epoch = NEW.prompt_epoch
          ) THEN RAISE(ABORT, 'prompt_epoch_message_epoch_missing') END;
          SELECT CASE WHEN NOT EXISTS (
            SELECT 1 FROM message WHERE id = NEW.message_id AND session_id = NEW.session_id
          ) THEN RAISE(ABORT, 'prompt_epoch_message_cross_session') END;
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER session_prompt_epoch_message_validate_update
        BEFORE UPDATE ON session_prompt_epoch_message
        BEGIN
          SELECT CASE WHEN NEW.session_id IS NOT OLD.session_id OR
            NEW.prompt_epoch IS NOT OLD.prompt_epoch OR
            NEW.ordinal IS NOT OLD.ordinal OR
            NEW.message_id IS NOT OLD.message_id
          THEN RAISE(ABORT, 'prompt_epoch_message_binding_immutable') END;
        END
      `)

      yield* tx.run(`
        CREATE TABLE session_fork_intent (
          intent_id TEXT NOT NULL PRIMARY KEY,
          request_hash TEXT NOT NULL,
          fork_mode TEXT NOT NULL CHECK (fork_mode IN ('foreground', 'task')),
          source_session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
          source_prompt_epoch INTEGER NOT NULL,
          source_window_id TEXT NOT NULL,
          source_effective_history_hash TEXT NOT NULL,
          source_mutation_epoch INTEGER NOT NULL,
          source_message_count INTEGER NOT NULL CHECK (source_message_count >= 0),
          source_cutoff_message_id TEXT,
          projection_version INTEGER NOT NULL,
          sanitation_policy_version INTEGER NOT NULL,
          target_session_id TEXT NOT NULL UNIQUE REFERENCES session(id) ON DELETE CASCADE,
          target_prompt_epoch INTEGER NOT NULL,
          target_window_id TEXT NOT NULL,
          target_effective_history_hash TEXT NOT NULL,
          target_world_state_baseline_hash TEXT NOT NULL,
          cloned_message_count INTEGER NOT NULL CHECK (cloned_message_count >= 0),
          cloned_part_count INTEGER NOT NULL CHECK (cloned_part_count >= 0),
          state TEXT NOT NULL CHECK (state IN
            ('prepared', 'committed', 'publishing', 'complete', 'recovery_required')),
          event_cursor INTEGER NOT NULL DEFAULT 0 CHECK (event_cursor >= 0),
          event_count INTEGER NOT NULL CHECK (event_count >= 0),
          delivery_owner TEXT,
          lease_expires_at INTEGER,
          delivery_attempts INTEGER NOT NULL DEFAULT 0 CHECK (delivery_attempts >= 0),
          recovery_reason TEXT,
          time_created INTEGER NOT NULL,
          time_updated INTEGER NOT NULL,
          time_committed INTEGER,
          time_completed INTEGER,
          CHECK (event_cursor <= event_count)
        )
      `)
      yield* tx.run(`
        CREATE INDEX session_fork_intent_source_idx
        ON session_fork_intent (source_session_id, time_created)
      `)
      yield* tx.run(`
        CREATE INDEX session_fork_intent_delivery_idx
        ON session_fork_intent (state, time_updated)
      `)

      yield* tx.run(`
        CREATE TABLE session_world_state_baseline (
          session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
          prompt_epoch INTEGER NOT NULL,
          section_id TEXT NOT NULL,
          snapshot TEXT NOT NULL,
          fragment TEXT NOT NULL,
          fragment_hash TEXT NOT NULL,
          provenance TEXT NOT NULL CHECK (provenance IN ('native', 'fork_rebuilt', 'legacy_migration')),
          created_at INTEGER NOT NULL,
          PRIMARY KEY (session_id, prompt_epoch, section_id),
          FOREIGN KEY (session_id, prompt_epoch)
            REFERENCES session_prompt_epoch(session_id, epoch) ON DELETE CASCADE
        )
      `)
      yield* tx.run(`
        CREATE INDEX session_world_state_baseline_epoch_idx
        ON session_world_state_baseline (session_id, prompt_epoch)
      `)

      yield* tx.run(`
        CREATE TABLE compaction_artifact (
          artifact_id TEXT NOT NULL PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES compaction_run(run_id) ON DELETE CASCADE,
          session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
          message_id TEXT NOT NULL REFERENCES message(id) ON DELETE CASCADE,
          part_id TEXT REFERENCES part(id) ON DELETE CASCADE,
          kind TEXT NOT NULL CHECK (kind IN ('marker', 'summary_attempt', 'replay', 'continue', 'world_state')),
          state TEXT NOT NULL CHECK (state IN ('pending', 'committed', 'orphaned')),
          created_at INTEGER NOT NULL,
          committed_at INTEGER,
          published_at INTEGER,
          UNIQUE (run_id, message_id, part_id, kind)
        )
      `)
      yield* tx.run(`
        CREATE INDEX compaction_artifact_session_message_idx
        ON compaction_artifact (session_id, message_id)
      `)
      yield* tx.run(`
        CREATE INDEX compaction_artifact_run_state_idx
        ON compaction_artifact (run_id, state)
      `)
      yield* tx.run(`
        CREATE TRIGGER compaction_artifact_validate_insert
        BEFORE INSERT ON compaction_artifact
        BEGIN
          SELECT CASE WHEN NOT EXISTS (
            SELECT 1 FROM compaction_run WHERE run_id = NEW.run_id AND session_id = NEW.session_id
          ) THEN RAISE(ABORT, 'compaction_artifact_run_cross_session') END;
          SELECT CASE WHEN NOT EXISTS (
            SELECT 1 FROM message WHERE id = NEW.message_id AND session_id = NEW.session_id
          ) THEN RAISE(ABORT, 'compaction_artifact_message_cross_session') END;
          SELECT CASE WHEN NEW.part_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM part
            WHERE id = NEW.part_id AND message_id = NEW.message_id AND session_id = NEW.session_id
          ) THEN RAISE(ABORT, 'compaction_artifact_part_cross_session') END;
          SELECT CASE WHEN NEW.state = 'pending' AND NOT EXISTS (
            SELECT 1 FROM compaction_run
            WHERE run_id = NEW.run_id AND state IN ('requested', 'summarizing')
          ) THEN RAISE(ABORT, 'compaction_artifact_pending_without_live_run') END;
          SELECT CASE WHEN NEW.state = 'committed' AND NOT EXISTS (
            SELECT 1 FROM compaction_run WHERE run_id = NEW.run_id AND state = 'committed'
          ) THEN RAISE(ABORT, 'compaction_artifact_committed_without_run') END;
          SELECT CASE WHEN NEW.state = 'pending' AND (NEW.committed_at IS NOT NULL OR NEW.published_at IS NOT NULL)
            THEN RAISE(ABORT, 'compaction_artifact_pending_terminal_fields') END;
          SELECT CASE WHEN NEW.state = 'committed' AND NEW.committed_at IS NULL
            THEN RAISE(ABORT, 'compaction_artifact_committed_without_timestamp') END;
          SELECT CASE WHEN NEW.state = 'orphaned' AND (NEW.committed_at IS NOT NULL OR NEW.published_at IS NOT NULL)
            THEN RAISE(ABORT, 'compaction_artifact_orphaned_terminal_fields') END;
          SELECT CASE WHEN NEW.published_at IS NOT NULL AND NEW.state != 'committed'
            THEN RAISE(ABORT, 'compaction_artifact_published_without_commit') END;
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER compaction_artifact_validate_update
        BEFORE UPDATE ON compaction_artifact
        BEGIN
          SELECT CASE WHEN NEW.run_id IS NOT OLD.run_id OR
            NEW.session_id IS NOT OLD.session_id OR
            NEW.message_id IS NOT OLD.message_id OR
            NEW.part_id IS NOT OLD.part_id OR
            NEW.kind IS NOT OLD.kind
          THEN RAISE(ABORT, 'compaction_artifact_binding_immutable') END;
          SELECT CASE WHEN NEW.state = 'committed' AND NOT EXISTS (
            SELECT 1 FROM compaction_run WHERE run_id = NEW.run_id AND state = 'committed'
          ) THEN RAISE(ABORT, 'compaction_artifact_committed_without_run') END;
          SELECT CASE WHEN NOT (
            NEW.state = OLD.state OR
            (OLD.state = 'pending' AND NEW.state IN ('committed', 'orphaned'))
          ) THEN RAISE(ABORT, 'compaction_artifact_invalid_state_transition') END;
          SELECT CASE WHEN NEW.state = 'pending' AND (NEW.committed_at IS NOT NULL OR NEW.published_at IS NOT NULL)
            THEN RAISE(ABORT, 'compaction_artifact_pending_terminal_fields') END;
          SELECT CASE WHEN NEW.state = 'committed' AND NEW.committed_at IS NULL
            THEN RAISE(ABORT, 'compaction_artifact_committed_without_timestamp') END;
          SELECT CASE WHEN NEW.state = 'orphaned' AND (NEW.committed_at IS NOT NULL OR NEW.published_at IS NOT NULL)
            THEN RAISE(ABORT, 'compaction_artifact_orphaned_terminal_fields') END;
          SELECT CASE WHEN NEW.published_at IS NOT NULL AND NEW.state != 'committed'
            THEN RAISE(ABORT, 'compaction_artifact_published_without_commit') END;
        END
      `)
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
          SELECT CASE WHEN OLD.state != 'committed' AND NEW.state = 'committed' AND (
            NEW.target_prompt_epoch IS NULL OR NEW.committed_summary_message_id IS NULL OR
            NEW.checkpoint_hash IS NULL OR NEW.summary_text IS NULL OR NEW.recent_context IS NULL OR
            NEW.completion_reason IS NULL OR NEW.committed_at IS NULL
          ) THEN RAISE(ABORT, 'compaction_run_commit_binding_incomplete') END;
        END
      `)

      yield* tx.run(`
        CREATE TRIGGER session_fork_intent_validate_insert
        BEFORE INSERT ON session_fork_intent
        BEGIN
          SELECT CASE WHEN NEW.source_session_id = NEW.target_session_id
            THEN RAISE(ABORT, 'session_fork_intent_self_fork') END;
          SELECT CASE WHEN NEW.state = 'publishing' AND
            (NEW.delivery_owner IS NULL OR NEW.lease_expires_at IS NULL)
            THEN RAISE(ABORT, 'session_fork_intent_publishing_without_lease') END;
          SELECT CASE WHEN NEW.state = 'complete' AND
            (NEW.event_cursor != NEW.event_count OR NEW.time_completed IS NULL)
            THEN RAISE(ABORT, 'session_fork_intent_incomplete_delivery') END;
          SELECT CASE WHEN NEW.state != 'publishing' AND
            (NEW.delivery_owner IS NOT NULL OR NEW.lease_expires_at IS NOT NULL)
            THEN RAISE(ABORT, 'session_fork_intent_nonpublishing_with_lease') END;
          SELECT CASE WHEN NEW.state = 'recovery_required' AND NEW.recovery_reason IS NULL
            THEN RAISE(ABORT, 'session_fork_intent_recovery_without_reason') END;
          SELECT CASE WHEN NEW.state IN ('committed', 'publishing', 'complete') AND NEW.time_committed IS NULL
            THEN RAISE(ABORT, 'session_fork_intent_committed_without_timestamp') END;
          SELECT CASE WHEN NEW.state != 'complete' AND NEW.time_completed IS NOT NULL
            THEN RAISE(ABORT, 'session_fork_intent_incomplete_timestamp') END;
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER session_fork_intent_validate_update
        BEFORE UPDATE ON session_fork_intent
        BEGIN
          SELECT CASE WHEN NEW.intent_id IS NOT OLD.intent_id OR
            NEW.request_hash IS NOT OLD.request_hash OR
            NEW.source_session_id IS NOT OLD.source_session_id OR
            NEW.fork_mode IS NOT OLD.fork_mode OR
            NEW.target_session_id IS NOT OLD.target_session_id OR
            NEW.source_prompt_epoch IS NOT OLD.source_prompt_epoch OR
            NEW.source_window_id IS NOT OLD.source_window_id OR
            NEW.source_effective_history_hash IS NOT OLD.source_effective_history_hash OR
            NEW.source_mutation_epoch IS NOT OLD.source_mutation_epoch OR
            NEW.source_message_count IS NOT OLD.source_message_count OR
            NEW.source_cutoff_message_id IS NOT OLD.source_cutoff_message_id OR
            NEW.projection_version IS NOT OLD.projection_version OR
            NEW.sanitation_policy_version IS NOT OLD.sanitation_policy_version OR
            NEW.target_prompt_epoch IS NOT OLD.target_prompt_epoch OR
            NEW.target_window_id IS NOT OLD.target_window_id OR
            NEW.target_effective_history_hash IS NOT OLD.target_effective_history_hash OR
            NEW.target_world_state_baseline_hash IS NOT OLD.target_world_state_baseline_hash OR
            NEW.cloned_message_count IS NOT OLD.cloned_message_count OR
            NEW.cloned_part_count IS NOT OLD.cloned_part_count OR
            NEW.event_count IS NOT OLD.event_count
          THEN RAISE(ABORT, 'session_fork_intent_binding_immutable') END;
          SELECT CASE WHEN NOT (
            NEW.state = OLD.state OR
            (OLD.state = 'prepared' AND NEW.state = 'recovery_required') OR
            (OLD.state = 'committed' AND NEW.state = 'publishing') OR
            (OLD.state = 'publishing' AND NEW.state IN ('committed', 'complete', 'recovery_required'))
          ) THEN RAISE(ABORT, 'session_fork_intent_invalid_state_transition') END;
          SELECT CASE WHEN NEW.state = 'publishing' AND
            (NEW.delivery_owner IS NULL OR NEW.lease_expires_at IS NULL)
            THEN RAISE(ABORT, 'session_fork_intent_publishing_without_lease') END;
          SELECT CASE WHEN NEW.state != 'publishing' AND
            (NEW.delivery_owner IS NOT NULL OR NEW.lease_expires_at IS NOT NULL)
            THEN RAISE(ABORT, 'session_fork_intent_nonpublishing_with_lease') END;
          SELECT CASE WHEN NEW.state = 'complete' AND
            (NEW.event_cursor != NEW.event_count OR NEW.time_completed IS NULL)
            THEN RAISE(ABORT, 'session_fork_intent_incomplete_delivery') END;
          SELECT CASE WHEN NEW.state = 'recovery_required' AND NEW.recovery_reason IS NULL
            THEN RAISE(ABORT, 'session_fork_intent_recovery_without_reason') END;
          SELECT CASE WHEN NEW.state IN ('committed', 'publishing', 'complete') AND NEW.time_committed IS NULL
            THEN RAISE(ABORT, 'session_fork_intent_committed_without_timestamp') END;
          SELECT CASE WHEN NEW.state != 'complete' AND NEW.time_completed IS NOT NULL
            THEN RAISE(ABORT, 'session_fork_intent_incomplete_timestamp') END;
          SELECT CASE WHEN NEW.event_cursor < OLD.event_cursor OR NEW.event_cursor > NEW.event_count
            THEN RAISE(ABORT, 'session_fork_intent_invalid_event_cursor') END;
        END
      `)

      yield* tx.run(`
        CREATE TRIGGER session_prompt_epoch_validate_insert
        BEFORE INSERT ON session_prompt_epoch
        BEGIN
          SELECT CASE WHEN NOT EXISTS (
            SELECT 1 FROM session WHERE id = NEW.session_id
          ) THEN RAISE(ABORT, 'prompt_epoch_session_missing') END;
          SELECT CASE WHEN NEW.checkpoint_user_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM message WHERE id = NEW.checkpoint_user_id AND session_id = NEW.session_id
          ) THEN RAISE(ABORT, 'prompt_epoch_checkpoint_user_cross_session') END;
          SELECT CASE WHEN NEW.checkpoint_assistant_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM message WHERE id = NEW.checkpoint_assistant_id AND session_id = NEW.session_id
          ) THEN RAISE(ABORT, 'prompt_epoch_checkpoint_assistant_cross_session') END;
          SELECT CASE WHEN NEW.retained_tail_start_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM message WHERE id = NEW.retained_tail_start_id AND session_id = NEW.session_id
          ) THEN RAISE(ABORT, 'prompt_epoch_retained_tail_cross_session') END;
          SELECT CASE WHEN NEW.source_end_message_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM message WHERE id = NEW.source_end_message_id AND session_id = NEW.session_id
          ) THEN RAISE(ABORT, 'prompt_epoch_source_end_cross_session') END;
          SELECT CASE WHEN NEW.previous_window_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM session_prompt_epoch
            WHERE session_id = NEW.session_id AND window_id = NEW.previous_window_id
          ) THEN RAISE(ABORT, 'prompt_epoch_previous_window_cross_session') END;
          SELECT CASE WHEN NEW.authority_state = 'ready' AND (
            NEW.projection_version IS NULL OR NEW.canonicalization_version IS NULL OR
            NEW.base_message_count IS NULL OR NEW.base_message_count < 0 OR
            NEW.effective_history_hash IS NULL OR NEW.first_window_id IS NULL OR NEW.window_id IS NULL OR
            (NEW.epoch > 0 AND (
              NEW.checkpoint_user_id IS NULL OR NEW.checkpoint_assistant_id IS NULL OR
              NEW.checkpoint_hash IS NULL OR NEW.world_state_baseline_hash IS NULL
            ))
          ) THEN RAISE(ABORT, 'prompt_epoch_ready_binding_incomplete') END;
          SELECT CASE WHEN NEW.authority_state = 'recovery_required' AND NEW.recovery_reason IS NULL
            THEN RAISE(ABORT, 'prompt_epoch_recovery_without_reason') END;
          SELECT CASE WHEN NEW.authority_state != 'recovery_required' AND NEW.recovery_reason IS NOT NULL
            THEN RAISE(ABORT, 'prompt_epoch_nonrecovery_with_reason') END;
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER session_prompt_epoch_validate_update
        BEFORE UPDATE ON session_prompt_epoch
        BEGIN
          SELECT CASE WHEN NEW.checkpoint_user_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM message WHERE id = NEW.checkpoint_user_id AND session_id = NEW.session_id
          ) THEN RAISE(ABORT, 'prompt_epoch_checkpoint_user_cross_session') END;
          SELECT CASE WHEN NEW.checkpoint_assistant_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM message WHERE id = NEW.checkpoint_assistant_id AND session_id = NEW.session_id
          ) THEN RAISE(ABORT, 'prompt_epoch_checkpoint_assistant_cross_session') END;
          SELECT CASE WHEN NEW.retained_tail_start_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM message WHERE id = NEW.retained_tail_start_id AND session_id = NEW.session_id
          ) THEN RAISE(ABORT, 'prompt_epoch_retained_tail_cross_session') END;
          SELECT CASE WHEN NEW.source_end_message_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM message WHERE id = NEW.source_end_message_id AND session_id = NEW.session_id
          ) THEN RAISE(ABORT, 'prompt_epoch_source_end_cross_session') END;
          SELECT CASE WHEN NEW.previous_window_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM session_prompt_epoch
            WHERE session_id = NEW.session_id AND window_id = NEW.previous_window_id
          ) THEN RAISE(ABORT, 'prompt_epoch_previous_window_cross_session') END;
          SELECT CASE WHEN OLD.authority_state = 'ready' AND (
            NEW.session_id IS NOT OLD.session_id OR
            NEW.epoch IS NOT OLD.epoch OR
            NEW.checkpoint_user_id IS NOT OLD.checkpoint_user_id OR
            NEW.checkpoint_assistant_id IS NOT OLD.checkpoint_assistant_id OR
            NEW.retained_tail_start_id IS NOT OLD.retained_tail_start_id OR
            NEW.source_end_message_id IS NOT OLD.source_end_message_id OR
            NEW.checkpoint_hash IS NOT OLD.checkpoint_hash OR
            NEW.projection_version IS NOT OLD.projection_version OR
            NEW.canonicalization_version IS NOT OLD.canonicalization_version OR
            NEW.base_message_count IS NOT OLD.base_message_count OR
            NEW.effective_history_hash IS NOT OLD.effective_history_hash OR
            NEW.first_window_id IS NOT OLD.first_window_id OR
            NEW.previous_window_id IS NOT OLD.previous_window_id OR
            NEW.window_id IS NOT OLD.window_id OR
            NEW.world_state_baseline_hash IS NOT OLD.world_state_baseline_hash OR
            NEW.reason IS NOT OLD.reason
          ) THEN RAISE(ABORT, 'prompt_epoch_ready_binding_immutable') END;
          SELECT CASE WHEN OLD.authority_state = 'recovery_required' AND NEW.authority_state != 'recovery_required'
            THEN RAISE(ABORT, 'prompt_epoch_recovery_state_immutable') END;
          SELECT CASE WHEN OLD.authority_state = 'ready' AND NEW.authority_state NOT IN ('ready', 'recovery_required')
            THEN RAISE(ABORT, 'prompt_epoch_invalid_authority_transition') END;
          SELECT CASE WHEN NEW.authority_state = 'ready' AND (
            NEW.projection_version IS NULL OR NEW.canonicalization_version IS NULL OR
            NEW.base_message_count IS NULL OR NEW.base_message_count < 0 OR
            NEW.effective_history_hash IS NULL OR NEW.first_window_id IS NULL OR NEW.window_id IS NULL OR
            (NEW.epoch > 0 AND (
              NEW.checkpoint_user_id IS NULL OR NEW.checkpoint_assistant_id IS NULL OR
              NEW.checkpoint_hash IS NULL OR NEW.world_state_baseline_hash IS NULL
            ))
          ) THEN RAISE(ABORT, 'prompt_epoch_ready_binding_incomplete') END;
          SELECT CASE WHEN NEW.authority_state = 'recovery_required' AND NEW.recovery_reason IS NULL
            THEN RAISE(ABORT, 'prompt_epoch_recovery_without_reason') END;
          SELECT CASE WHEN NEW.authority_state != 'recovery_required' AND NEW.recovery_reason IS NOT NULL
            THEN RAISE(ABORT, 'prompt_epoch_nonrecovery_with_reason') END;
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER session_prompt_epoch_message_owner_immutable
        BEFORE UPDATE OF session_id ON message
        WHEN EXISTS (
          SELECT 1 FROM session_prompt_epoch
          WHERE checkpoint_user_id = OLD.id
             OR checkpoint_assistant_id = OLD.id
             OR retained_tail_start_id = OLD.id
             OR source_end_message_id = OLD.id
        )
        BEGIN
          SELECT RAISE(ABORT, 'prompt_epoch_referenced_message_owner_immutable');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER session_history_state_ready_validate_insert
        BEFORE INSERT ON session_history_state
        WHEN NEW.state = 'ready'
        BEGIN
          SELECT CASE WHEN NOT EXISTS (
            SELECT 1 FROM session_prompt_epoch
            WHERE session_id = NEW.session_id AND state = 'active' AND authority_state = 'ready'
          ) THEN RAISE(ABORT, 'session_history_ready_without_authority') END;
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER session_history_state_ready_validate_update
        BEFORE UPDATE ON session_history_state
        WHEN NEW.state = 'ready'
        BEGIN
          SELECT CASE WHEN NOT EXISTS (
            SELECT 1 FROM session_prompt_epoch
            WHERE session_id = NEW.session_id AND state = 'active' AND authority_state = 'ready'
          ) THEN RAISE(ABORT, 'session_history_ready_without_authority') END;
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER session_history_state_recovery_validate_insert
        BEFORE INSERT ON session_history_state
        WHEN NEW.state = 'recovery_required'
        BEGIN
          SELECT CASE WHEN NEW.reason IS NULL
            THEN RAISE(ABORT, 'session_history_recovery_without_reason') END;
          SELECT CASE WHEN EXISTS (
            SELECT 1 FROM session_prompt_epoch
            WHERE session_id = NEW.session_id AND state = 'active' AND authority_state != 'recovery_required'
          ) THEN RAISE(ABORT, 'session_history_recovery_without_quarantined_authority') END;
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER session_history_state_recovery_validate_update
        BEFORE UPDATE ON session_history_state
        WHEN NEW.state = 'recovery_required'
        BEGIN
          SELECT CASE WHEN NEW.reason IS NULL
            THEN RAISE(ABORT, 'session_history_recovery_without_reason') END;
          SELECT CASE WHEN EXISTS (
            SELECT 1 FROM session_prompt_epoch
            WHERE session_id = NEW.session_id AND state = 'active' AND authority_state != 'recovery_required'
          ) THEN RAISE(ABORT, 'session_history_recovery_without_quarantined_authority') END;
        END
      `)
    })
  },
} satisfies DatabaseMigration.Migration
