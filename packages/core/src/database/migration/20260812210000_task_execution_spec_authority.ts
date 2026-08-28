import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

const safeExecutionSpec = "CASE WHEN json_valid(execution_spec) = 1 THEN execution_spec ELSE '{}' END"
const safeNewExecutionSpec = "CASE WHEN json_valid(NEW.execution_spec) = 1 THEN NEW.execution_spec ELSE '{}' END"

const invalidStructuredContract = (value: string) => `
  json_type(${value}, '$.structuredOutput') IS NOT NULL AND (
    json_type(${value}, '$.structuredOutput') != 'object' OR
    json_type(${value}, '$.agent') IS NOT 'text' OR
    length(trim(COALESCE(json_extract(${value}, '$.agent'), ''))) = 0 OR
    json_type(${value}, '$.model') IS NOT 'object' OR
    json_type(${value}, '$.model.providerID') IS NOT 'text' OR
    length(trim(COALESCE(json_extract(${value}, '$.model.providerID'), ''))) = 0 OR
    json_type(${value}, '$.model.modelID') IS NOT 'text' OR
    length(trim(COALESCE(json_extract(${value}, '$.model.modelID'), ''))) = 0 OR
    json_type(${value}, '$.structuredOutput.schema') != 'object' OR
    json_type(${value}, '$.structuredOutput.allowTextFallback') NOT IN ('true', 'false') OR
    json_type(${value}, '$.structuredOutput.receiptVersion') != 'integer' OR
    json_extract(${value}, '$.structuredOutput.receiptVersion') != 1 OR
    json_type(${value}, '$.structuredOutput.maxAttempts') != 'integer' OR
    json_extract(${value}, '$.structuredOutput.maxAttempts') != 2 OR
    (SELECT count(*) FROM json_each(json_extract(${value}, '$.structuredOutput'))) != 4
  )
`

const invalidStructuredCompletion = (value: string, row: "NEW" | "OLD") => `
  json_type(${value}, '$.structuredOutput') = 'object' AND
  ${row}.state = 'completed' AND (
    ${row}.phase != 'settled' OR
    ${row}.reason NOT IN (
      'structured_output_valid',
      'structured_output_text_fallback',
      'structured_output_degraded_text'
    ) OR
    ${row}.structured_output_receipt IS NULL OR
    ${row}.raw_result_message_id IS NULL OR
    (
      ${row}.reason = 'structured_output_text_fallback' AND
      json_extract(${value}, '$.structuredOutput.allowTextFallback') IS NOT 1
    )
  )
`

const invalidStructuredEvidence = (row: "NEW" | "task_run") => `
  ${row}.structured_output_receipt IS NOT NULL AND (
    ${row}.raw_result_message_id IS NULL OR
    NOT EXISTS (
      SELECT 1 FROM message
      WHERE message.id = ${row}.raw_result_message_id
        AND message.session_id = ${row}.child_session_id
        AND json_valid(message.data) = 1
        AND json_extract(message.data, '$.role') = 'assistant'
    ) OR (
      ${row}.reason IN ('structured_output_valid', 'structured_output_text_fallback') AND (
        ${row}.structured_result_message_id IS NULL OR
        NOT EXISTS (
          SELECT 1 FROM message
          WHERE message.id = ${row}.structured_result_message_id
            AND message.session_id = ${row}.child_session_id
            AND json_valid(message.data) = 1
            AND json_extract(message.data, '$.role') = 'assistant'
        )
      )
    )
  )
`

export default {
  id: "20260812210000_task_execution_spec_authority",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TEMP TABLE task_execution_spec_preflight (
          valid INTEGER NOT NULL CHECK (valid = 1)
        )
      `)
      yield* tx.run(`
        INSERT INTO task_execution_spec_preflight(valid)
        SELECT CASE WHEN EXISTS (
          SELECT 1
          FROM task_run
          WHERE execution_spec IS NOT NULL AND (
            json_valid(execution_spec) != 1 OR
            json_type(${safeExecutionSpec}) != 'object' OR
            (${invalidStructuredContract(safeExecutionSpec)})
          )
          OR (${invalidStructuredEvidence("task_run")})
        ) THEN 0 ELSE 1 END
      `)
      yield* tx.run("DROP TABLE task_execution_spec_preflight")
      yield* tx.run(`
        CREATE TRIGGER task_run_execution_spec_insert_guard
        BEFORE INSERT ON task_run
        WHEN NEW.execution_spec IS NOT NULL AND (
          json_valid(NEW.execution_spec) != 1 OR
          json_type(${safeNewExecutionSpec}) != 'object' OR
          (${invalidStructuredContract(safeNewExecutionSpec)})
        )
        BEGIN
          SELECT RAISE(ABORT, 'invalid task execution spec');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER task_run_execution_spec_immutable
        BEFORE UPDATE OF execution_spec ON task_run
        WHEN NEW.execution_spec IS NOT OLD.execution_spec
        BEGIN
          SELECT RAISE(ABORT, 'task execution spec is immutable');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER task_run_structured_receipt_requires_execution_spec_insert
        BEFORE INSERT ON task_run
        WHEN (
          NEW.structured_output_receipt IS NOT NULL AND (
            NEW.execution_spec IS NULL OR
            json_valid(NEW.execution_spec) != 1 OR
            json_type(${safeNewExecutionSpec}, '$.structuredOutput') != 'object' OR
            (${invalidStructuredContract(safeNewExecutionSpec)})
          )
        ) OR (
          NEW.execution_spec IS NOT NULL AND
          json_valid(NEW.execution_spec) = 1 AND
          (${invalidStructuredCompletion(safeNewExecutionSpec, "NEW")})
        ) OR (${invalidStructuredEvidence("NEW")})
        BEGIN
          SELECT RAISE(ABORT, 'task structured receipt requires frozen execution spec');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER task_run_structured_receipt_requires_execution_spec_update
        BEFORE UPDATE ON task_run
        WHEN (
          OLD.structured_output_receipt IS NULL AND NEW.structured_output_receipt IS NOT NULL AND (
            NEW.execution_spec IS NULL OR
            json_valid(NEW.execution_spec) != 1 OR
            json_type(${safeNewExecutionSpec}, '$.structuredOutput') != 'object' OR
            (${invalidStructuredContract(safeNewExecutionSpec)})
          )
        ) OR (
          (
            NEW.phase IS NOT OLD.phase OR
            NEW.state IS NOT OLD.state OR
            NEW.reason IS NOT OLD.reason OR
            NEW.attempts IS NOT OLD.attempts OR
            NEW.structured_result_message_id IS NOT OLD.structured_result_message_id OR
            NEW.structured_output_receipt IS NOT OLD.structured_output_receipt
          ) AND
          NEW.execution_spec IS NOT NULL AND
          json_valid(NEW.execution_spec) = 1 AND
          (${invalidStructuredCompletion(safeNewExecutionSpec, "NEW")})
        ) OR (${invalidStructuredEvidence("NEW")})
        BEGIN
          SELECT RAISE(ABORT, 'task structured receipt requires frozen execution spec');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER task_run_historical_structured_terminal_immutable
        BEFORE UPDATE ON task_run
        WHEN OLD.execution_spec IS NOT NULL AND
          json_valid(OLD.execution_spec) = 1 AND
          (${invalidStructuredCompletion(
            "CASE WHEN json_valid(OLD.execution_spec) = 1 THEN OLD.execution_spec ELSE '{}' END",
            "OLD",
          )}) AND (
            NEW.phase IS NOT OLD.phase OR
            NEW.state IS NOT OLD.state OR
            NEW.reason IS NOT OLD.reason OR
            NEW.attempts IS NOT OLD.attempts OR
            NEW.raw_result_message_id IS NOT OLD.raw_result_message_id OR
            NEW.structured_result_message_id IS NOT OLD.structured_result_message_id OR
            NEW.structured_output_receipt IS NOT OLD.structured_output_receipt OR
            NEW.output IS NOT OLD.output OR
            NEW.error IS NOT OLD.error OR
            NEW.result_hash IS NOT OLD.result_hash OR
            NEW.usage IS NOT OLD.usage OR
            NEW.time_settled IS NOT OLD.time_settled OR
            NEW.control_state IS NOT OLD.control_state OR
            NEW.finalizer_input_message_id IS NOT OLD.finalizer_input_message_id
          )
        BEGIN
          SELECT RAISE(ABORT, 'historical task structured terminal is immutable');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER task_run_structured_terminal_immutable
        BEFORE UPDATE ON task_run
        WHEN OLD.structured_output_receipt IS NOT NULL AND (
          NEW.phase IS NOT OLD.phase OR
          NEW.state IS NOT OLD.state OR
          NEW.reason IS NOT OLD.reason OR
          NEW.attempts IS NOT OLD.attempts OR
          NEW.raw_result_message_id IS NOT OLD.raw_result_message_id OR
          NEW.structured_result_message_id IS NOT OLD.structured_result_message_id OR
          NEW.structured_output_receipt IS NOT OLD.structured_output_receipt OR
          NEW.output IS NOT OLD.output OR
          NEW.error IS NOT OLD.error OR
          NEW.result_hash IS NOT OLD.result_hash OR
          NEW.usage IS NOT OLD.usage OR
          NEW.time_settled IS NOT OLD.time_settled OR
          NEW.control_state IS NOT OLD.control_state OR
          NEW.execution_spec IS NOT OLD.execution_spec OR
          NEW.finalizer_input_message_id IS NOT OLD.finalizer_input_message_id
        )
        BEGIN
          SELECT RAISE(ABORT, 'task structured terminal is immutable');
        END
      `)
    })
  },
} satisfies DatabaseMigration.Migration
