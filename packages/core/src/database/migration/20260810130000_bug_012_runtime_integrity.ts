import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260810130000_bug_012_runtime_integrity",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run("ALTER TABLE session_steer ADD COLUMN materialized_at INTEGER")

      yield* tx.run(`
        CREATE TABLE session_fork_admission (
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
          requested_directory TEXT,
          isolation_mode TEXT NOT NULL CHECK (isolation_mode IN ('none', 'worktree')),
          requested_target_session_id TEXT,
          target_session_id TEXT NOT NULL UNIQUE,
          child_depth INTEGER CHECK (child_depth IS NULL OR child_depth >= 0),
          task_request_hash TEXT,
          worktree_directory TEXT,
          worktree_branch TEXT,
          worktree_base_commit TEXT,
          state TEXT NOT NULL CHECK (state IN
            ('admitted', 'provisioning', 'ready', 'manifest_committed', 'recovery_required')),
          recovery_reason TEXT,
          time_created INTEGER NOT NULL,
          time_updated INTEGER NOT NULL
        )
      `)
      yield* tx.run(`
        CREATE INDEX session_fork_admission_source_idx
        ON session_fork_admission (source_session_id, time_created)
      `)
      yield* tx.run(`
        CREATE INDEX session_fork_admission_recovery_idx
        ON session_fork_admission (state, time_updated)
      `)
      yield* tx.run(`
        CREATE TRIGGER session_fork_admission_validate_insert
        BEFORE INSERT ON session_fork_admission
        BEGIN
          SELECT CASE WHEN NEW.state = 'manifest_committed'
            THEN RAISE(ABORT, 'fork_admission_cannot_start_committed') END;
          SELECT CASE WHEN NEW.state = 'recovery_required' AND NEW.recovery_reason IS NULL
            THEN RAISE(ABORT, 'fork_admission_recovery_without_reason') END;
          SELECT CASE WHEN NEW.state != 'recovery_required' AND NEW.recovery_reason IS NOT NULL
            THEN RAISE(ABORT, 'fork_admission_nonrecovery_with_reason') END;
          SELECT CASE WHEN NEW.isolation_mode = 'worktree' AND (
            NEW.worktree_directory IS NULL OR NEW.worktree_branch IS NULL OR NEW.worktree_base_commit IS NULL
          ) THEN RAISE(ABORT, 'fork_admission_worktree_plan_incomplete') END;
          SELECT CASE WHEN NEW.isolation_mode = 'none' AND (
            NEW.worktree_directory IS NOT NULL OR NEW.worktree_branch IS NOT NULL OR NEW.worktree_base_commit IS NOT NULL
          ) THEN RAISE(ABORT, 'fork_admission_worktree_plan_unexpected') END;
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER session_fork_admission_validate_update
        BEFORE UPDATE ON session_fork_admission
        BEGIN
          SELECT CASE WHEN
            NEW.intent_id IS NOT OLD.intent_id OR
            NEW.request_hash IS NOT OLD.request_hash OR
            NEW.fork_mode IS NOT OLD.fork_mode OR
            NEW.source_session_id IS NOT OLD.source_session_id OR
            NEW.source_prompt_epoch IS NOT OLD.source_prompt_epoch OR
            NEW.source_window_id IS NOT OLD.source_window_id OR
            NEW.source_effective_history_hash IS NOT OLD.source_effective_history_hash OR
            NEW.source_mutation_epoch IS NOT OLD.source_mutation_epoch OR
            NEW.source_message_count IS NOT OLD.source_message_count OR
            NEW.source_cutoff_message_id IS NOT OLD.source_cutoff_message_id OR
            NEW.projection_version IS NOT OLD.projection_version OR
            NEW.sanitation_policy_version IS NOT OLD.sanitation_policy_version OR
            NEW.requested_directory IS NOT OLD.requested_directory OR
            NEW.isolation_mode IS NOT OLD.isolation_mode OR
            NEW.requested_target_session_id IS NOT OLD.requested_target_session_id OR
            NEW.target_session_id IS NOT OLD.target_session_id OR
            NEW.child_depth IS NOT OLD.child_depth OR
            NEW.task_request_hash IS NOT OLD.task_request_hash OR
            NEW.worktree_directory IS NOT OLD.worktree_directory OR
            NEW.worktree_branch IS NOT OLD.worktree_branch OR
            NEW.worktree_base_commit IS NOT OLD.worktree_base_commit OR
            NEW.time_created IS NOT OLD.time_created
          THEN RAISE(ABORT, 'fork_admission_binding_immutable') END;
          SELECT CASE WHEN NOT (
            NEW.state = OLD.state OR
            (OLD.state = 'admitted' AND NEW.state IN ('provisioning', 'ready', 'recovery_required')) OR
            (OLD.state = 'provisioning' AND NEW.state IN ('ready', 'recovery_required')) OR
            (OLD.state = 'ready' AND NEW.state IN ('manifest_committed', 'recovery_required')) OR
            (OLD.state = 'manifest_committed' AND NEW.state = 'recovery_required')
          ) THEN RAISE(ABORT, 'fork_admission_invalid_state_transition') END;
          SELECT CASE WHEN NEW.state = 'recovery_required' AND NEW.recovery_reason IS NULL
            THEN RAISE(ABORT, 'fork_admission_recovery_without_reason') END;
          SELECT CASE WHEN NEW.state != 'recovery_required' AND NEW.recovery_reason IS NOT NULL
            THEN RAISE(ABORT, 'fork_admission_nonrecovery_with_reason') END;
          SELECT CASE WHEN NEW.state = 'manifest_committed' AND NOT EXISTS (
            SELECT 1 FROM session_fork_intent
            WHERE intent_id = NEW.intent_id AND target_session_id = NEW.target_session_id
          ) THEN RAISE(ABORT, 'fork_admission_manifest_missing') END;
        END
      `)

      yield* tx.run(`
        CREATE TRIGGER message_binding_immutable
        BEFORE UPDATE ON message
        WHEN NEW.id IS NOT OLD.id OR NEW.session_id IS NOT OLD.session_id
        BEGIN
          SELECT RAISE(ABORT, 'message_binding_immutable');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER part_parent_validate_insert
        BEFORE INSERT ON part
        WHEN NOT EXISTS (
          SELECT 1 FROM message WHERE id = NEW.message_id AND session_id = NEW.session_id
        )
        BEGIN
          SELECT RAISE(ABORT, 'part_parent_cross_session');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER part_binding_validate_update
        BEFORE UPDATE ON part
        BEGIN
          SELECT CASE WHEN
            NEW.id IS NOT OLD.id OR NEW.message_id IS NOT OLD.message_id OR NEW.session_id IS NOT OLD.session_id
          THEN RAISE(ABORT, 'part_binding_immutable') END;
          SELECT CASE WHEN NOT EXISTS (
            SELECT 1 FROM message WHERE id = NEW.message_id AND session_id = NEW.session_id
          ) THEN RAISE(ABORT, 'part_parent_cross_session') END;
        END
      `)
    })
  },
} satisfies DatabaseMigration.Migration
