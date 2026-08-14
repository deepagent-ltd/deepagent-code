import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

const databaseNow = "CAST(strftime('%s', 'now') AS INTEGER) * 1000"

export default {
  id: "20260812220000_task_structured_output_evidence_authority",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TEMP TABLE task_structured_output_evidence_upgrade_preflight (
          valid INTEGER NOT NULL CHECK(valid = 1)
        )
      `)
      yield* tx.run(`
        INSERT INTO task_structured_output_evidence_upgrade_preflight(valid)
        SELECT CASE
          WHEN NOT EXISTS (SELECT 1 FROM task_structured_output_evidence) THEN 1
          ELSE 0
        END
      `)
      yield* tx.run(`DROP TABLE task_structured_output_evidence_upgrade_preflight`)
      yield* tx.run(`
        CREATE TRIGGER task_structured_output_evidence_insert_guard
        BEFORE INSERT ON task_structured_output_evidence
        WHEN NEW.terminal_state NOT IN ('completed', 'failed') OR
          NEW.attempts NOT BETWEEN 0 AND 2 OR
          json_valid(NEW.contract_json) != 1 OR json_type(NEW.contract_json) != 'object' OR
          json_valid(NEW.raw_message_json) != 1 OR json_extract(NEW.raw_message_json, '$.role') != 'assistant' OR
          json_valid(NEW.raw_parts_json) != 1 OR json_type(NEW.raw_parts_json) != 'array' OR
          NOT EXISTS (
            SELECT 1 FROM task_run
            WHERE task_run.run_id = NEW.run_id
              AND task_run.child_session_id = NEW.child_session_id
              AND task_run.execution_owner = NEW.owner_token
              AND task_run.claim_generation = NEW.claim_generation
              AND task_run.version = NEW.expected_version
              AND task_run.state IN ('provisioning', 'running', 'researching', 'finalizing')
              AND task_run.lease_expires_at > ${databaseNow}
              AND task_run.execution_spec IS NOT NULL
              AND json_valid(task_run.execution_spec) = 1
              AND json_type(task_run.execution_spec, '$.structuredOutput') = 'object'
              AND json_extract(task_run.execution_spec, '$.structuredOutput') = NEW.contract_json
          ) OR
          NOT EXISTS (
            SELECT 1 FROM message
            WHERE message.id = NEW.raw_result_message_id
              AND message.session_id = NEW.child_session_id
              AND message.data = NEW.raw_message_json
          ) OR (
            NEW.terminal_state = 'completed' AND (
              NEW.attempts NOT BETWEEN 1 AND 2 OR
              NEW.output IS NULL OR
              NEW.structured_output_receipt IS NULL OR json_valid(NEW.structured_output_receipt) != 1 OR
              json_extract(NEW.structured_output_receipt, '$.attempt') != NEW.attempts OR
              json_extract(NEW.structured_output_receipt, '$.transport') NOT IN ('structured', 'text_fallback', 'degraded_text') OR
              NEW.failure_code IS NOT NULL OR (
                json_extract(NEW.structured_output_receipt, '$.transport') IN ('structured', 'text_fallback') AND (
                  NEW.result_message_id IS NULL OR NEW.result_message_json IS NULL OR
                  NEW.result_parts_json IS NULL OR
                  json_valid(NEW.result_message_json) != 1 OR
                  json_extract(NEW.result_message_json, '$.role') != 'assistant' OR
                  json_valid(NEW.result_parts_json) != 1 OR json_type(NEW.result_parts_json) != 'array' OR
                  NOT EXISTS (
                    SELECT 1 FROM message
                    WHERE message.id = NEW.result_message_id
                      AND message.session_id = NEW.child_session_id
                      AND message.data = NEW.result_message_json
                  )
                )
              ) OR (
                json_extract(NEW.structured_output_receipt, '$.transport') = 'degraded_text' AND (
                  NEW.result_message_id IS NOT NULL OR NEW.result_message_json IS NOT NULL OR
                  NEW.result_parts_json IS NOT NULL OR
                  json_extract(NEW.structured_output_receipt, '$.reason') NOT IN (
                    'structured_output_missing', 'structured_output_invalid'
                  )
                )
              )
            )
          ) OR (
            NEW.terminal_state = 'failed' AND (
              NEW.output IS NOT NULL OR
              NEW.structured_output_receipt IS NOT NULL OR
              NEW.result_message_id IS NOT NULL OR NEW.result_message_json IS NOT NULL OR
              NEW.result_parts_json IS NOT NULL OR
              NEW.failure_code NOT LIKE 'structured_finalizer_%'
            )
          )
        BEGIN
          SELECT RAISE(ABORT, 'invalid task structured output evidence');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER task_structured_output_evidence_part_insert_guard
        BEFORE INSERT ON task_structured_output_evidence_part
        WHEN NEW.role NOT IN ('raw', 'result') OR NEW.ordinal < 0 OR
          json_valid(NEW.part_json) != 1 OR
          NOT EXISTS (
            SELECT 1
            FROM task_structured_output_evidence evidence
            JOIN part ON part.id = NEW.part_id
            WHERE evidence.run_id = NEW.run_id
              AND part.message_id = NEW.message_id
              AND part.session_id = NEW.session_id
              AND part.data = NEW.part_json
              AND NEW.session_id = evidence.child_session_id
              AND NEW.message_id = CASE NEW.role
                WHEN 'raw' THEN evidence.raw_result_message_id
                ELSE evidence.result_message_id
              END
              AND NEW.ordinal = (
                SELECT count(*) FROM part prior
                WHERE prior.message_id = NEW.message_id
                  AND prior.session_id = NEW.session_id
                  AND prior.id < NEW.part_id
              )
          )
        BEGIN
          SELECT RAISE(ABORT, 'invalid task structured output evidence part');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER task_run_structured_output_evidence_guard
        BEFORE UPDATE ON task_run
        WHEN OLD.phase != 'settled' AND NEW.phase = 'settled' AND
          OLD.execution_spec IS NOT NULL AND json_valid(OLD.execution_spec) = 1 AND
          json_type(OLD.execution_spec, '$.structuredOutput') = 'object' AND (
            NEW.state = 'completed' OR
            (NEW.state IN ('failed', 'error') AND json_extract(NEW.error, '$.code') LIKE 'structured_finalizer_%')
          ) AND NOT EXISTS (
            SELECT 1 FROM task_structured_output_evidence evidence
            WHERE evidence.run_id = NEW.run_id
              AND evidence.child_session_id = NEW.child_session_id
              AND evidence.owner_token = OLD.execution_owner
              AND evidence.claim_generation = OLD.claim_generation
              AND evidence.expected_version <= OLD.version
              AND NEW.version = OLD.version + 1
              AND evidence.terminal_state = CASE NEW.state WHEN 'completed' THEN 'completed' ELSE 'failed' END
              AND evidence.attempts = NEW.attempts
              AND evidence.contract_json = json_extract(OLD.execution_spec, '$.structuredOutput')
              AND evidence.raw_result_message_id = NEW.raw_result_message_id
              AND evidence.result_message_id IS NEW.structured_result_message_id
              AND evidence.output IS NEW.output
              AND evidence.structured_output_receipt IS NEW.structured_output_receipt
              AND evidence.failure_code IS json_extract(NEW.error, '$.code')
              AND json(evidence.raw_parts_json) = (
                SELECT COALESCE(json_group_array(json(snapshot)), json('[]'))
                FROM (
                  SELECT json_object(
                    'id', part.id,
                    'messageID', part.message_id,
                    'sessionID', part.session_id,
                    'data', json(part.data)
                  ) AS snapshot
                  FROM part
                  WHERE part.message_id = evidence.raw_result_message_id
                    AND part.session_id = evidence.child_session_id
                  ORDER BY part.id
                )
              )
              AND (
                evidence.result_message_id IS NULL OR json(evidence.result_parts_json) = (
                  SELECT COALESCE(json_group_array(json(snapshot)), json('[]'))
                  FROM (
                    SELECT json_object(
                      'id', part.id,
                      'messageID', part.message_id,
                      'sessionID', part.session_id,
                      'data', json(part.data)
                    ) AS snapshot
                    FROM part
                    WHERE part.message_id = evidence.result_message_id
                      AND part.session_id = evidence.child_session_id
                    ORDER BY part.id
                  )
                )
              )
              AND EXISTS (
                SELECT 1 FROM message
                WHERE message.id = evidence.raw_result_message_id
                  AND message.session_id = evidence.child_session_id
                  AND message.data = evidence.raw_message_json
              )
              AND (
                evidence.result_message_id IS NULL OR EXISTS (
                  SELECT 1 FROM message
                  WHERE message.id = evidence.result_message_id
                    AND message.session_id = evidence.child_session_id
                    AND message.data = evidence.result_message_json
                )
              )
              AND (
                SELECT count(*) FROM part
                WHERE part.message_id = evidence.raw_result_message_id
                  AND part.session_id = evidence.child_session_id
              ) = (
                SELECT count(*) FROM task_structured_output_evidence_part sealed
                WHERE sealed.run_id = evidence.run_id AND sealed.role = 'raw'
              )
              AND NOT EXISTS (
                SELECT 1 FROM part
                WHERE part.message_id = evidence.raw_result_message_id
                  AND part.session_id = evidence.child_session_id
                  AND NOT EXISTS (
                    SELECT 1 FROM task_structured_output_evidence_part sealed
                    WHERE sealed.run_id = evidence.run_id AND sealed.role = 'raw'
                      AND sealed.part_id = part.id AND sealed.message_id = part.message_id
                      AND sealed.session_id = part.session_id AND sealed.part_json = part.data
                  )
              )
              AND (
                evidence.result_message_id IS NULL OR (
                  (SELECT count(*) FROM part
                   WHERE part.message_id = evidence.result_message_id
                     AND part.session_id = evidence.child_session_id) =
                  (SELECT count(*) FROM task_structured_output_evidence_part sealed
                   WHERE sealed.run_id = evidence.run_id AND sealed.role = 'result')
                )
              )
              AND NOT EXISTS (
                SELECT 1 FROM part
                WHERE part.message_id = evidence.result_message_id
                  AND part.session_id = evidence.child_session_id
                  AND NOT EXISTS (
                    SELECT 1 FROM task_structured_output_evidence_part sealed
                    WHERE sealed.run_id = evidence.run_id AND sealed.role = 'result'
                      AND sealed.part_id = part.id AND sealed.message_id = part.message_id
                      AND sealed.session_id = part.session_id AND sealed.part_json = part.data
                  )
              )
          )
        BEGIN
          SELECT RAISE(ABORT, 'task structured terminal is missing exact material evidence');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER task_run_structured_terminal_insert_requires_history
        BEFORE INSERT ON task_run
        WHEN NEW.phase = 'settled' AND NEW.execution_spec IS NOT NULL AND
          json_valid(NEW.execution_spec) = 1 AND
          json_type(NEW.execution_spec, '$.structuredOutput') = 'object'
        BEGIN
          SELECT RAISE(ABORT, 'new structured task terminals require transition evidence');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER task_structured_output_evidence_immutable
        BEFORE UPDATE ON task_structured_output_evidence
        BEGIN
          SELECT RAISE(ABORT, 'task structured output evidence is immutable');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER task_structured_output_evidence_delete_guard
        BEFORE DELETE ON task_structured_output_evidence
        WHEN EXISTS (SELECT 1 FROM task_run WHERE task_run.run_id = OLD.run_id)
        BEGIN
          SELECT RAISE(ABORT, 'task structured output evidence cannot be deleted');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER task_structured_output_evidence_part_immutable
        BEFORE UPDATE ON task_structured_output_evidence_part
        BEGIN
          SELECT RAISE(ABORT, 'task structured output evidence part is immutable');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER task_structured_output_evidence_part_delete_guard
        BEFORE DELETE ON task_structured_output_evidence_part
        WHEN EXISTS (
          SELECT 1 FROM task_structured_output_evidence
          WHERE task_structured_output_evidence.run_id = OLD.run_id
        )
        BEGIN
          SELECT RAISE(ABORT, 'task structured output evidence part cannot be deleted');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER task_structured_output_message_update_guard
        BEFORE UPDATE ON message
        WHEN NEW.data IS NOT OLD.data AND EXISTS (
          SELECT 1 FROM task_structured_output_evidence
          WHERE raw_result_message_id = OLD.id OR result_message_id = OLD.id
        )
        BEGIN
          SELECT RAISE(ABORT, 'task structured output message material is immutable');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER task_structured_output_message_delete_guard
        BEFORE DELETE ON message
        WHEN EXISTS (
          SELECT 1 FROM task_structured_output_evidence
          WHERE raw_result_message_id = OLD.id OR result_message_id = OLD.id
        )
        BEGIN
          SELECT RAISE(ABORT, 'task structured output message material cannot be deleted');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER task_structured_output_part_insert_guard
        BEFORE INSERT ON part
        WHEN EXISTS (
          SELECT 1 FROM task_structured_output_evidence
          WHERE raw_result_message_id = NEW.message_id OR result_message_id = NEW.message_id
        )
        BEGIN
          SELECT RAISE(ABORT, 'task structured output message cannot gain parts');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER task_structured_output_part_update_guard
        BEFORE UPDATE ON part
        WHEN EXISTS (
          SELECT 1 FROM task_structured_output_evidence
          WHERE raw_result_message_id = OLD.message_id OR result_message_id = OLD.message_id
        )
        BEGIN
          SELECT RAISE(ABORT, 'task structured output part material is immutable');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER task_structured_output_part_delete_guard
        BEFORE DELETE ON part
        WHEN EXISTS (
          SELECT 1 FROM task_structured_output_evidence
          WHERE raw_result_message_id = OLD.message_id OR result_message_id = OLD.message_id
        )
        BEGIN
          SELECT RAISE(ABORT, 'task structured output part material cannot be deleted');
        END
      `)
    })
  },
} satisfies DatabaseMigration.Migration
