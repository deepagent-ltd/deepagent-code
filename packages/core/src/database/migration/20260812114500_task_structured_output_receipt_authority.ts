import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260812114500_task_structured_output_receipt_authority",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TEMP TABLE task_structured_output_receipt_preflight (
          valid INTEGER NOT NULL CHECK (valid = 1)
        )
      `)
      yield* tx.run(`
        INSERT INTO task_structured_output_receipt_preflight(valid)
        SELECT CASE WHEN EXISTS (
          SELECT 1
          FROM task_run
          WHERE phase = 'settled'
            AND reason IN (
              'structured_output_valid',
              'structured_output_text_fallback',
              'structured_output_degraded_text'
            )
            AND (
              state != 'completed' OR
              attempts NOT IN (1, 2) OR
              (reason IN ('structured_output_text_fallback', 'structured_output_degraded_text') AND attempts != 2) OR
              (reason IN ('structured_output_valid', 'structured_output_text_fallback') AND
                structured_result_message_id IS NULL) OR
              (reason = 'structured_output_degraded_text' AND (
                structured_result_message_id IS NOT NULL OR
                output IS NULL OR
                json_valid(output) != 1 OR
                json_extract(output, '$._degraded') IS NOT 1 OR
                json_extract(output, '$._attempts') IS NOT attempts OR
                COALESCE(json_type(output, '$._reason'), 'missing') != 'text' OR
                json_extract(output, '$._reason') NOT IN (
                  'structured_output_missing',
                  'structured_output_invalid'
                )
              ))
            )
        ) THEN 0 ELSE 1 END
      `)
      yield* tx.run("DROP TABLE task_structured_output_receipt_preflight")
      yield* tx.run(`
        UPDATE task_run
        SET structured_output_receipt = CASE reason
          WHEN 'structured_output_text_fallback'
            THEN json_object('attempt', attempts, 'transport', 'text_fallback')
          WHEN 'structured_output_degraded_text'
            THEN json_object(
              'attempt', attempts,
              'transport', 'degraded_text',
              'reason', json_extract(output, '$._reason')
            )
          ELSE NULL
        END
        WHERE phase = 'settled'
          AND reason IN ('structured_output_text_fallback', 'structured_output_degraded_text')
      `)
      yield* tx.run(`
        CREATE TRIGGER task_run_structured_output_receipt_insert_guard
        BEFORE INSERT ON task_run
        WHEN NOT (
          CASE
            WHEN NEW.structured_output_receipt IS NULL THEN
              NEW.phase != 'settled' OR NEW.reason IS NULL OR NEW.reason NOT IN (
                'structured_output_valid',
                'structured_output_text_fallback',
                'structured_output_degraded_text'
              )
            WHEN NEW.phase != 'settled' OR NEW.state != 'completed' OR NEW.reason IS NULL OR
              NEW.reason NOT IN (
                'structured_output_valid',
                'structured_output_text_fallback',
                'structured_output_degraded_text'
              ) THEN 0
            WHEN json_valid(NEW.structured_output_receipt) != 1 OR
              json_type(NEW.structured_output_receipt) != 'object' THEN 0
            WHEN json_type(NEW.structured_output_receipt, '$.attempt') != 'integer' OR
              json_extract(NEW.structured_output_receipt, '$.attempt') != NEW.attempts OR
              NEW.attempts NOT IN (1, 2) OR
              json_type(NEW.structured_output_receipt, '$.transport') != 'text' THEN 0
            WHEN NEW.reason = 'structured_output_valid' THEN
              json_extract(NEW.structured_output_receipt, '$.transport') = 'structured' AND
              json_type(NEW.structured_output_receipt, '$.reason') IS NULL AND
              (SELECT count(*) FROM json_each(NEW.structured_output_receipt)) = 2 AND
              NEW.structured_result_message_id IS NOT NULL
            WHEN NEW.reason = 'structured_output_text_fallback' THEN
              json_extract(NEW.structured_output_receipt, '$.transport') = 'text_fallback' AND
              NEW.attempts = 2 AND
              json_type(NEW.structured_output_receipt, '$.reason') IS NULL AND
              (SELECT count(*) FROM json_each(NEW.structured_output_receipt)) = 2 AND
              NEW.structured_result_message_id IS NOT NULL
            ELSE
              json_extract(NEW.structured_output_receipt, '$.transport') = 'degraded_text' AND
              NEW.attempts = 2 AND
              json_extract(NEW.structured_output_receipt, '$.reason') IN (
                'structured_output_missing',
                'structured_output_invalid'
              ) AND
              (SELECT count(*) FROM json_each(NEW.structured_output_receipt)) = 3 AND
              NEW.structured_result_message_id IS NULL AND
              NEW.output IS NOT NULL AND json_valid(NEW.output) = 1 AND
              json_extract(NEW.output, '$._degraded') IS 1 AND
              json_extract(NEW.output, '$._attempts') IS NEW.attempts AND
              json_extract(NEW.output, '$._reason') IS
                json_extract(NEW.structured_output_receipt, '$.reason')
          END
        )
        BEGIN
          SELECT RAISE(ABORT, 'invalid task structured output receipt');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER task_run_structured_output_receipt_update_guard
        BEFORE UPDATE ON task_run
        WHEN NOT (
          CASE
            WHEN NEW.structured_output_receipt IS NULL THEN
              NEW.phase != 'settled' OR NEW.reason IS NULL OR NEW.reason NOT IN (
                'structured_output_valid',
                'structured_output_text_fallback',
                'structured_output_degraded_text'
              ) OR (
                OLD.structured_output_receipt IS NULL AND
                OLD.phase = 'settled' AND OLD.state = 'completed' AND
                OLD.reason = 'structured_output_valid' AND
                NEW.phase IS OLD.phase AND NEW.state IS OLD.state AND
                NEW.reason IS OLD.reason AND NEW.attempts IS OLD.attempts AND
                NEW.raw_result_message_id IS OLD.raw_result_message_id AND
                NEW.structured_result_message_id IS OLD.structured_result_message_id AND
                NEW.output IS OLD.output AND NEW.error IS OLD.error AND
                NEW.result_hash IS OLD.result_hash AND NEW.usage IS OLD.usage AND
                NEW.time_settled IS OLD.time_settled AND
                NEW.control_state IS OLD.control_state AND
                NEW.finalizer_input_message_id IS OLD.finalizer_input_message_id AND
                NEW.execution_spec IS OLD.execution_spec
              )
            WHEN NEW.phase != 'settled' OR NEW.state != 'completed' OR NEW.reason IS NULL OR
              NEW.reason NOT IN (
                'structured_output_valid',
                'structured_output_text_fallback',
                'structured_output_degraded_text'
              ) THEN 0
            WHEN json_valid(NEW.structured_output_receipt) != 1 OR
              json_type(NEW.structured_output_receipt) != 'object' THEN 0
            WHEN json_type(NEW.structured_output_receipt, '$.attempt') != 'integer' OR
              json_extract(NEW.structured_output_receipt, '$.attempt') != NEW.attempts OR
              NEW.attempts NOT IN (1, 2) OR
              json_type(NEW.structured_output_receipt, '$.transport') != 'text' THEN 0
            WHEN NEW.reason = 'structured_output_valid' THEN
              json_extract(NEW.structured_output_receipt, '$.transport') = 'structured' AND
              json_type(NEW.structured_output_receipt, '$.reason') IS NULL AND
              (SELECT count(*) FROM json_each(NEW.structured_output_receipt)) = 2 AND
              NEW.structured_result_message_id IS NOT NULL
            WHEN NEW.reason = 'structured_output_text_fallback' THEN
              json_extract(NEW.structured_output_receipt, '$.transport') = 'text_fallback' AND
              NEW.attempts = 2 AND
              json_type(NEW.structured_output_receipt, '$.reason') IS NULL AND
              (SELECT count(*) FROM json_each(NEW.structured_output_receipt)) = 2 AND
              NEW.structured_result_message_id IS NOT NULL
            ELSE
              json_extract(NEW.structured_output_receipt, '$.transport') = 'degraded_text' AND
              NEW.attempts = 2 AND
              json_extract(NEW.structured_output_receipt, '$.reason') IN (
                'structured_output_missing',
                'structured_output_invalid'
              ) AND
              (SELECT count(*) FROM json_each(NEW.structured_output_receipt)) = 3 AND
              NEW.structured_result_message_id IS NULL AND
              NEW.output IS NOT NULL AND json_valid(NEW.output) = 1 AND
              json_extract(NEW.output, '$._degraded') IS 1 AND
              json_extract(NEW.output, '$._attempts') IS NEW.attempts AND
              json_extract(NEW.output, '$._reason') IS
                json_extract(NEW.structured_output_receipt, '$.reason')
          END
        )
        BEGIN
          SELECT RAISE(ABORT, 'invalid task structured output receipt');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER task_run_structured_output_receipt_immutable
        BEFORE UPDATE OF structured_output_receipt ON task_run
        WHEN OLD.structured_output_receipt IS NOT NULL
          AND NEW.structured_output_receipt IS NOT OLD.structured_output_receipt
        BEGIN
          SELECT RAISE(ABORT, 'task structured output receipt is immutable');
        END
      `)
    })
  },
} satisfies DatabaseMigration.Migration
