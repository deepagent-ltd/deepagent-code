import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

// Extend the PromptEpoch recovery binding to accept the continuation resolution
// authority introduced by 20260821150000. Recovery still requires a successor
// epoch; this only makes the new receipt a valid binding source alongside the
// legacy provider-resolution table.
export default {
  id: "20260821160000_compaction_resolution_epoch_authority",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run("DROP TRIGGER IF EXISTS session_prompt_epoch_validate_insert")
      yield* tx.run("DROP TRIGGER IF EXISTS session_prompt_epoch_validate_update")
      yield* tx.run("DROP TRIGGER IF EXISTS session_prompt_epoch_recovery_binding_guard")
      yield* tx.run("DROP TRIGGER IF EXISTS session_prompt_epoch_recovery_binding_update_guard")
      const common = `
          SELECT CASE WHEN NEW.authority_state IS NOT 'recovery_required' AND NEW.checkpoint_user_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM message WHERE id = NEW.checkpoint_user_id AND session_id = NEW.session_id
          ) THEN RAISE(ABORT, 'prompt_epoch_checkpoint_user_cross_session') END;
          SELECT CASE WHEN NEW.authority_state IS NOT 'recovery_required' AND NEW.checkpoint_assistant_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM message WHERE id = NEW.checkpoint_assistant_id AND session_id = NEW.session_id
          ) THEN RAISE(ABORT, 'prompt_epoch_checkpoint_assistant_cross_session') END;
          SELECT CASE WHEN NEW.authority_state IS NOT 'recovery_required' AND NEW.retained_tail_start_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM message WHERE id = NEW.retained_tail_start_id AND session_id = NEW.session_id
          ) THEN RAISE(ABORT, 'prompt_epoch_retained_tail_cross_session') END;
          SELECT CASE WHEN NEW.authority_state IS NOT 'recovery_required' AND NEW.source_end_message_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM message WHERE id = NEW.source_end_message_id AND session_id = NEW.session_id
          ) THEN RAISE(ABORT, 'prompt_epoch_source_end_cross_session') END;
          SELECT CASE WHEN NEW.authority_state IS NOT 'recovery_required' AND NEW.previous_window_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM session_prompt_epoch WHERE session_id = NEW.session_id AND window_id = NEW.previous_window_id
          ) THEN RAISE(ABORT, 'prompt_epoch_previous_window_cross_session') END;
          SELECT CASE WHEN NEW.authority_state = 'ready' AND (
            NEW.projection_version IS NULL OR NEW.canonicalization_version IS NULL OR NEW.base_message_count IS NULL OR
            NEW.base_message_count < 0 OR NEW.effective_history_hash IS NULL OR NEW.first_window_id IS NULL OR NEW.window_id IS NULL OR
            (NEW.recovery_resolution_id IS NOT NULL AND NEW.world_state_baseline_hash IS NULL) OR
            (NEW.recovery_resolution_id IS NULL AND NEW.epoch > 0 AND (
              NEW.checkpoint_user_id IS NULL OR NEW.checkpoint_assistant_id IS NULL OR NEW.checkpoint_hash IS NULL OR
              NEW.world_state_baseline_hash IS NULL
            ))
          ) THEN RAISE(ABORT, 'prompt_epoch_ready_binding_incomplete') END;
          SELECT CASE WHEN NEW.recovery_resolution_id IS NOT NULL AND NEW.authority_state != 'recovery_required' AND (
            NEW.authority_state != 'ready' OR NEW.checkpoint_user_id IS NOT NULL OR NEW.checkpoint_assistant_id IS NOT NULL OR
            NEW.retained_tail_start_id IS NOT NULL OR NEW.reason != 'recovery'
          ) THEN RAISE(ABORT, 'prompt_epoch_recovery_binding_invalid') END;
          SELECT CASE WHEN NEW.recovery_resolution_id IS NOT NULL AND NOT (
            EXISTS (
              SELECT 1 FROM session_tool_request_resolution resolution
              WHERE resolution.resolution_id = NEW.recovery_resolution_id
                AND resolution.session_id = NEW.session_id
                AND resolution.successor_prompt_epoch = NEW.epoch
            ) OR EXISTS (
              SELECT 1 FROM compaction_continuation_resolution resolution
              WHERE resolution.resolution_id = NEW.recovery_resolution_id
                AND resolution.session_id = NEW.session_id
                AND resolution.successor_prompt_epoch = NEW.epoch
                AND resolution.successor_window_id = NEW.window_id
                AND resolution.successor_history_hash = NEW.effective_history_hash
            )
          ) THEN RAISE(ABORT, 'prompt_epoch_recovery_resolution_invalid') END;
          SELECT CASE WHEN NEW.reason = 'recovery' AND NEW.recovery_resolution_id IS NULL
            THEN RAISE(ABORT, 'prompt_epoch_recovery_resolution_missing') END;
          SELECT CASE WHEN NEW.authority_state = 'recovery_required' AND NEW.recovery_reason IS NULL
            THEN RAISE(ABORT, 'prompt_epoch_recovery_without_reason') END;
          SELECT CASE WHEN NEW.authority_state != 'recovery_required' AND NEW.recovery_reason IS NOT NULL
            THEN RAISE(ABORT, 'prompt_epoch_nonrecovery_with_reason') END;
        `
      yield* tx.run(`
        CREATE TRIGGER session_prompt_epoch_validate_insert
        BEFORE INSERT ON session_prompt_epoch
        BEGIN
          SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM session WHERE id = NEW.session_id)
            THEN RAISE(ABORT, 'prompt_epoch_session_missing') END;
          ${common}
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER session_prompt_epoch_validate_update
        BEFORE UPDATE ON session_prompt_epoch
        BEGIN
          ${common}
          SELECT CASE WHEN OLD.authority_state = 'ready' AND (
            NEW.session_id IS NOT OLD.session_id OR NEW.epoch IS NOT OLD.epoch OR
            NEW.checkpoint_user_id IS NOT OLD.checkpoint_user_id OR NEW.checkpoint_assistant_id IS NOT OLD.checkpoint_assistant_id OR
            NEW.retained_tail_start_id IS NOT OLD.retained_tail_start_id OR NEW.source_end_message_id IS NOT OLD.source_end_message_id OR
            NEW.checkpoint_hash IS NOT OLD.checkpoint_hash OR NEW.projection_version IS NOT OLD.projection_version OR
            NEW.canonicalization_version IS NOT OLD.canonicalization_version OR NEW.base_message_count IS NOT OLD.base_message_count OR
            NEW.effective_history_hash IS NOT OLD.effective_history_hash OR NEW.first_window_id IS NOT OLD.first_window_id OR
            NEW.previous_window_id IS NOT OLD.previous_window_id OR NEW.window_id IS NOT OLD.window_id OR
            NEW.world_state_baseline_hash IS NOT OLD.world_state_baseline_hash OR NEW.recovery_resolution_id IS NOT OLD.recovery_resolution_id OR
            NEW.reason IS NOT OLD.reason
          ) THEN RAISE(ABORT, 'prompt_epoch_ready_binding_immutable') END;
          SELECT CASE WHEN OLD.authority_state = 'recovery_required' AND NEW.authority_state != 'recovery_required'
            THEN RAISE(ABORT, 'prompt_epoch_recovery_state_immutable') END;
          SELECT CASE WHEN OLD.authority_state = 'ready' AND NEW.authority_state NOT IN ('ready', 'recovery_required')
            THEN RAISE(ABORT, 'prompt_epoch_invalid_authority_transition') END;
        END
      `)
    })
  },
} satisfies DatabaseMigration.Migration
