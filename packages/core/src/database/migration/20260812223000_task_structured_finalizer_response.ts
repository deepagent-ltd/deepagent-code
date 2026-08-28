import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260812223000_task_structured_finalizer_response",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TRIGGER task_structured_finalizer_response_insert_guard
        BEFORE INSERT ON task_structured_finalizer_response
        WHEN NEW.attempt NOT BETWEEN 1 AND 2 OR
          json_valid(NEW.response_message_json) != 1 OR
          json_extract(NEW.response_message_json, '$.role') != 'assistant' OR
          json_extract(NEW.response_message_json, '$.error') IS NOT NULL OR
          NOT EXISTS (
            SELECT 1
            FROM task_run run
            JOIN message request
              ON request.id = NEW.request_message_id
             AND request.session_id = NEW.child_session_id
            JOIN message response
              ON response.id = NEW.response_message_id
             AND response.session_id = NEW.child_session_id
            WHERE run.run_id = NEW.run_id
              AND run.state = 'finalizing'
              AND run.control_state = 'open'
              AND run.interrupt_requested_at IS NULL
              AND run.child_session_id = NEW.child_session_id
              AND run.execution_owner = NEW.owner_token
              AND run.claim_generation = NEW.claim_generation
              AND run.version = NEW.expected_version
              AND run.attempts = NEW.attempt
              AND run.raw_result_message_id = NEW.source_message_id
              AND response.data = NEW.response_message_json
              AND json_extract(response.data, '$.parentID') = request.id
              AND json_valid(request.data) = 1
              AND json_extract(request.data, '$.role') = 'user'
              AND json_extract(request.data, '$.metadata.deepagent.structured_finalizer.run_id') = NEW.run_id
              AND json_extract(request.data, '$.metadata.deepagent.structured_finalizer.attempt') = NEW.attempt
              AND json_extract(request.data, '$.metadata.deepagent.structured_finalizer.source_message_id') = NEW.source_message_id
          )
        BEGIN
          SELECT RAISE(ABORT, 'invalid task structured finalizer response');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER task_structured_finalizer_response_immutable
        BEFORE UPDATE ON task_structured_finalizer_response
        BEGIN
          SELECT RAISE(ABORT, 'task structured finalizer response is immutable');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER task_structured_finalizer_response_delete_guard
        BEFORE DELETE ON task_structured_finalizer_response
        WHEN EXISTS (SELECT 1 FROM task_run WHERE task_run.run_id = OLD.run_id)
        BEGIN
          SELECT RAISE(ABORT, 'task structured finalizer response cannot be deleted');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER task_structured_finalizer_response_message_update_guard
        BEFORE UPDATE ON message
        WHEN EXISTS (
          SELECT 1 FROM task_structured_finalizer_response
          WHERE request_message_id = OLD.id OR response_message_id = OLD.id
        )
        BEGIN
          SELECT RAISE(ABORT, 'task structured finalizer response messages are immutable');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER task_structured_finalizer_response_message_delete_guard
        BEFORE DELETE ON message
        WHEN EXISTS (
          SELECT 1 FROM task_structured_finalizer_response
          WHERE request_message_id = OLD.id OR response_message_id = OLD.id
        )
        BEGIN
          SELECT RAISE(ABORT, 'task structured finalizer response messages cannot be deleted');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER task_structured_finalizer_response_part_insert_guard
        BEFORE INSERT ON part
        WHEN EXISTS (
          SELECT 1 FROM task_structured_finalizer_response
          WHERE response_message_id = NEW.message_id
        )
        BEGIN
          SELECT RAISE(ABORT, 'task structured finalizer response cannot gain parts');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER task_structured_finalizer_response_part_update_guard
        BEFORE UPDATE ON part
        WHEN EXISTS (
          SELECT 1 FROM task_structured_finalizer_response
          WHERE response_message_id = OLD.message_id
        )
        BEGIN
          SELECT RAISE(ABORT, 'task structured finalizer response parts are immutable');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER task_structured_finalizer_response_part_delete_guard
        BEFORE DELETE ON part
        WHEN EXISTS (
          SELECT 1 FROM task_structured_finalizer_response
          WHERE response_message_id = OLD.message_id
        )
        BEGIN
          SELECT RAISE(ABORT, 'task structured finalizer response parts cannot be deleted');
        END
      `)
    })
  },
} satisfies DatabaseMigration.Migration
