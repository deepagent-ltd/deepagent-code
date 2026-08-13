import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260812224000_learning_artifact_phase_receipt",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        UPDATE learning_job
        SET state = 'recovery_required', owner = NULL, lease_expires_at = NULL,
            version = version + 1, side_effect_state = 'unknown',
            side_effect_kind = CASE
              WHEN state = 'running' THEN 'extraction'
              WHEN state = 'reviewing' THEN 'reviewer'
              ELSE 'governance'
            END,
            expected_result_ref = NULL, error_code = 'legacy_artifact_plan_missing',
            error_detail = 'The side effect started before exact artifact planning was durable; automatic replay is forbidden.',
            settled_at = updated_at
        WHERE (state = 'running' AND side_effect_state <> 'not_started')
          OR state IN ('reviewing', 'governance')
      `)
      yield* tx.run(`
        CREATE TRIGGER learning_job_expected_result_insert_guard
        BEFORE INSERT ON learning_job
        WHEN NOT (
          (NEW.side_effect_state = 'not_started' AND NEW.expected_result_ref IS NULL) OR
          (NEW.side_effect_kind IN ('extraction', 'reviewer') AND
            NEW.side_effect_state IN ('started', 'settled') AND length(trim(NEW.expected_result_ref)) > 0) OR
          (NEW.side_effect_kind = 'governance' AND NEW.expected_result_ref IS NULL) OR
          (NEW.side_effect_state = 'unknown' AND NEW.expected_result_ref IS NULL)
        )
        BEGIN SELECT RAISE(ABORT, 'learning_job_expected_result_invalid'); END
      `)
      yield* tx.run(`
        CREATE TRIGGER learning_job_expected_result_update_guard
        BEFORE UPDATE ON learning_job
        WHEN NOT (
          (NEW.side_effect_state = 'not_started' AND NEW.expected_result_ref IS NULL) OR
          (NEW.side_effect_kind IN ('extraction', 'reviewer') AND
            NEW.side_effect_state IN ('started', 'settled') AND length(trim(NEW.expected_result_ref)) > 0) OR
          (NEW.side_effect_kind = 'governance' AND NEW.expected_result_ref IS NULL) OR
          (NEW.side_effect_state = 'unknown' AND NEW.expected_result_ref IS NULL)
        )
        BEGIN SELECT RAISE(ABORT, 'learning_job_expected_result_invalid'); END
      `)
      yield* tx.run(`
        CREATE TRIGGER learning_job_expected_result_settlement_guard
        BEFORE UPDATE ON learning_job
        WHEN NEW.side_effect_state = 'settled' AND NEW.side_effect_kind IN ('extraction', 'reviewer')
          AND NEW.result_ref IS NOT NEW.expected_result_ref
        BEGIN SELECT RAISE(ABORT, 'learning_job_expected_result_mismatch'); END
      `)
      yield* tx.run(`
        CREATE TRIGGER learning_job_expected_result_immutable
        BEFORE UPDATE ON learning_job
        WHEN OLD.side_effect_state IN ('started', 'settled') AND
          OLD.side_effect_kind IN ('extraction', 'reviewer') AND
          NOT (
            NEW.expected_result_ref IS OLD.expected_result_ref OR
            (OLD.side_effect_state = 'settled' AND NEW.side_effect_state = 'not_started' AND
              NEW.expected_result_ref IS NULL)
          )
        BEGIN SELECT RAISE(ABORT, 'learning_job_expected_result_immutable'); END
      `)
    })
  },
} satisfies DatabaseMigration.Migration
