import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260813041000_learning_reviewer_attempt_authority",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TRIGGER learning_reviewer_attempt_identity_immutable
        BEFORE UPDATE ON learning_reviewer_attempt
        WHEN NEW.attempt_id != OLD.attempt_id OR NEW.job_id != OLD.job_id OR
          NEW.review_session_id != OLD.review_session_id OR NEW.request_ref != OLD.request_ref OR
          NEW.request_hash != OLD.request_hash OR NEW.source_candidate_ids_json != OLD.source_candidate_ids_json OR
          NEW.source_candidate_set_hash != OLD.source_candidate_set_hash OR NEW.provider_id != OLD.provider_id OR
          NEW.model_id != OLD.model_id OR NEW.policy_hash != OLD.policy_hash OR NEW.created_at != OLD.created_at
        BEGIN SELECT RAISE(ABORT, 'learning_reviewer_attempt_identity_immutable'); END
      `)
      yield* tx.run(`
        CREATE TRIGGER learning_reviewer_attempt_version_fence
        BEFORE UPDATE ON learning_reviewer_attempt
        WHEN NEW.version != OLD.version + 1
        BEGIN SELECT RAISE(ABORT, 'learning_reviewer_attempt_version_must_advance_once'); END
      `)
      yield* tx.run(`
        CREATE TRIGGER learning_reviewer_attempt_terminal_immutable
        BEFORE UPDATE ON learning_reviewer_attempt
        WHEN OLD.state IN ('settled', 'failed', 'recovery_required')
        BEGIN SELECT RAISE(ABORT, 'learning_reviewer_attempt_terminal_immutable'); END
      `)
      yield* tx.run(`
        CREATE TRIGGER learning_reviewer_attempt_transition_guard
        BEFORE UPDATE OF state ON learning_reviewer_attempt
        WHEN NOT (
          (OLD.state = 'prepared' AND NEW.state IN ('prepared', 'dispatching', 'failed')) OR
          (OLD.state = 'dispatching' AND NEW.state IN ('settled', 'failed', 'recovery_required'))
        )
        BEGIN SELECT RAISE(ABORT, 'learning_reviewer_attempt_transition_invalid'); END
      `)
      yield* tx.run(`
        CREATE TRIGGER learning_reviewer_attempt_delete_guard
        BEFORE DELETE ON learning_reviewer_attempt
        BEGIN SELECT RAISE(ABORT, 'learning_reviewer_attempt_delete_forbidden'); END
      `)
      yield* tx.run("DROP TRIGGER IF EXISTS learning_job_expected_result_settlement_guard")
      yield* tx.run(`
        CREATE TRIGGER learning_job_expected_result_settlement_guard
        BEFORE UPDATE ON learning_job
        WHEN NEW.side_effect_state = 'settled' AND NEW.side_effect_kind = 'extraction'
          AND NEW.result_ref IS NOT NEW.expected_result_ref
        BEGIN SELECT RAISE(ABORT, 'learning_job_expected_result_mismatch'); END
      `)
      yield* tx.run(`
        CREATE TRIGGER learning_job_reviewer_result_guard
        BEFORE UPDATE ON learning_job
        WHEN NEW.side_effect_state = 'settled' AND NEW.side_effect_kind = 'reviewer'
          AND NEW.review_job_id GLOB 'review:*' AND NOT EXISTS (
          SELECT 1 FROM learning_reviewer_attempt attempt
          WHERE attempt.job_id = NEW.job_id AND attempt.attempt_id = NEW.review_job_id
            AND attempt.state = 'settled' AND attempt.request_ref = NEW.expected_result_ref
            AND attempt.response_ref = NEW.result_ref
        )
        BEGIN SELECT RAISE(ABORT, 'learning_job_reviewer_receipt_required'); END
      `)
      yield* tx.run(`
        CREATE TRIGGER learning_reviewer_attempt_prepare_guard
        BEFORE INSERT ON learning_reviewer_attempt
        WHEN NOT EXISTS (
          SELECT 1 FROM learning_job job
          WHERE job.job_id = NEW.job_id AND job.state = 'reviewing' AND job.side_effect_state = 'started'
            AND job.side_effect_kind = 'reviewer' AND job.review_job_id = NEW.attempt_id
            AND job.expected_result_ref = NEW.request_ref AND job.owner = NEW.owner
            AND job.lease_expires_at > NEW.created_at
        )
        BEGIN SELECT RAISE(ABORT, 'learning_reviewer_attempt_job_receipt_required'); END
      `)
    })
  },
} satisfies DatabaseMigration.Migration
