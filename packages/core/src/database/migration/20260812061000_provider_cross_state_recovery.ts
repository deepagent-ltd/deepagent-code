import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260812061000_provider_cross_state_recovery",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TEMP TABLE provider_cross_state_recovery_preflight (
          valid INTEGER NOT NULL CHECK (valid = 1)
        )
      `)
      yield* tx.run(`
        INSERT INTO provider_cross_state_recovery_preflight(valid)
        SELECT CASE WHEN EXISTS (
          SELECT 1
          FROM session_tool_request_receipt receipt
          LEFT JOIN session_provider_attempt attempt
            ON attempt.attempt_id = receipt.provider_attempt_id
          LEFT JOIN session_context_selection selection
            ON selection.selection_id = attempt.selection_id
          WHERE receipt.provider_attempt_id IS NOT NULL
            AND (
              attempt.attempt_id IS NULL OR
              attempt.session_id IS NOT receipt.session_id OR
              attempt.owner_token IS NOT receipt.owner_token OR
              attempt.selection_id IS NOT receipt.context_selection_id OR
              attempt.activity_id IS NOT selection.activity_id OR
              attempt.session_id IS NOT selection.session_id OR
              attempt.projection_hash IS NOT selection.projection_hash OR
              attempt.provider_id IS NOT receipt.provider_id OR
              attempt.request_hash IS NOT receipt.request_input_hash OR
              attempt.prepared_turn_hash IS NOT receipt.prepared_turn_hash OR
              attempt.wire_request_hash IS NOT receipt.wire_request_hash
            )
        ) OR EXISTS (
          SELECT 1
          FROM compaction_run continuation
          JOIN session_tool_request_receipt receipt
            ON receipt.receipt_id = continuation.continuation_receipt_id
          JOIN session_provider_attempt attempt
            ON attempt.attempt_id = receipt.provider_attempt_id
          WHERE receipt.provider_state IN ('preparing', 'prepared')
            AND attempt.state != 'prepared'
            AND (
              continuation.session_id IS NOT receipt.session_id OR
              continuation.state != 'committed' OR
              continuation.continuation_state NOT IN ('admitted', 'dispatching', 'indeterminate')
            )
        ) THEN 0 ELSE 1 END
      `)
      yield* tx.run("DROP TABLE provider_cross_state_recovery_preflight")
      yield* tx.run("DROP TRIGGER IF EXISTS session_tool_request_receipt_provider_transition")

      // Keep the attempt as the physical-dispatch evidence. Only its stale receipt,
      // continuation, and Session history authorities are moved into fail-closed recovery.
      yield* tx.run(`
        UPDATE compaction_run
        SET continuation_state = 'dispatching',
            continuation_dispatching_at = COALESCE(
              continuation_dispatching_at,
              CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
            ),
            continuation_error_code = 'provider_attempt_started_before_receipt_state_recovery'
        WHERE state = 'committed'
          AND continuation_state = 'admitted'
          AND continuation_receipt_id IN (
            SELECT receipt.receipt_id
            FROM session_tool_request_receipt receipt
            JOIN session_provider_attempt attempt
              ON attempt.attempt_id = receipt.provider_attempt_id
            WHERE receipt.provider_state IN ('preparing', 'prepared')
              AND attempt.state != 'prepared'
          )
      `)
      yield* tx.run(`
        UPDATE compaction_run
        SET continuation_state = 'indeterminate',
            continuation_terminal_at = COALESCE(
              continuation_terminal_at,
              CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
            ),
            continuation_error_code = 'provider_started_outcome_unknown_after_process_restart'
        WHERE state = 'committed'
          AND continuation_state = 'dispatching'
          AND continuation_receipt_id IN (
            SELECT receipt.receipt_id
            FROM session_tool_request_receipt receipt
            JOIN session_provider_attempt attempt
              ON attempt.attempt_id = receipt.provider_attempt_id
            WHERE receipt.provider_state IN ('preparing', 'prepared')
              AND attempt.state != 'prepared'
          )
      `)
      yield* tx.run(`
        UPDATE session_prompt_epoch
        SET authority_state = 'recovery_required',
            recovery_reason = 'provider outcome is unknown after process restart'
        WHERE state = 'active'
          AND session_id IN (
            SELECT receipt.session_id
            FROM session_tool_request_receipt receipt
            JOIN session_provider_attempt attempt
              ON attempt.attempt_id = receipt.provider_attempt_id
            WHERE receipt.provider_state IN ('preparing', 'prepared')
              AND attempt.state != 'prepared'
          )
      `)
      yield* tx.run(`
        INSERT INTO session_history_state (
          session_id, state, reason, time_created, time_updated
        )
        SELECT DISTINCT
          receipt.session_id,
          'recovery_required',
          'provider outcome is unknown after process restart',
          CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER),
          CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
        FROM session_tool_request_receipt receipt
        JOIN session_provider_attempt attempt
          ON attempt.attempt_id = receipt.provider_attempt_id
        WHERE receipt.provider_state IN ('preparing', 'prepared')
          AND attempt.state != 'prepared'
        ON CONFLICT(session_id) DO UPDATE SET
          state = 'recovery_required',
          reason = 'provider outcome is unknown after process restart',
          time_updated = excluded.time_updated
      `)
      yield* tx.run(`
        UPDATE session_tool_request_receipt
        SET provider_state = 'indeterminate_after_crash',
            terminal_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER),
            request_error_code = 'provider_started_outcome_unknown_after_process_restart'
        WHERE provider_state IN ('preparing', 'prepared')
          AND EXISTS (
            SELECT 1
            FROM session_provider_attempt attempt
            WHERE attempt.attempt_id = session_tool_request_receipt.provider_attempt_id
              AND attempt.state != 'prepared'
          )
      `)
      yield* tx.run(`
        CREATE TRIGGER session_tool_request_receipt_provider_transition
        BEFORE UPDATE OF provider_state ON session_tool_request_receipt
        WHEN NEW.provider_state != OLD.provider_state AND NOT (
          (OLD.provider_state = 'preparing' AND NEW.provider_state IN ('prepared', 'failed')) OR
          (OLD.provider_state = 'prepared' AND NEW.provider_state IN ('dispatching', 'failed')) OR
          (
            OLD.provider_state IN ('preparing', 'prepared')
            AND NEW.provider_state = 'indeterminate_after_crash'
          ) OR
          (OLD.provider_state = 'dispatching' AND NEW.provider_state IN ('streaming', 'settled', 'failed', 'indeterminate_after_crash')) OR
          (OLD.provider_state = 'streaming' AND NEW.provider_state IN ('settled', 'failed', 'indeterminate_after_crash'))
        )
        BEGIN
          SELECT RAISE(ABORT, 'illegal provider receipt transition');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER session_tool_request_receipt_cross_state_recovery_guard
        BEFORE UPDATE OF provider_state ON session_tool_request_receipt
        WHEN OLD.provider_state IN ('preparing', 'prepared')
          AND NEW.provider_state = 'indeterminate_after_crash'
          AND (
            NEW.terminal_at IS NULL OR
            NEW.request_error_code != 'provider_started_outcome_unknown_after_process_restart' OR
            NEW.provider_attempt_id IS NULL OR
            NOT EXISTS (
              SELECT 1
              FROM session_provider_attempt attempt
              JOIN session_context_selection selection
                ON selection.selection_id = attempt.selection_id
              WHERE attempt.attempt_id = NEW.provider_attempt_id
                AND attempt.session_id = NEW.session_id
                AND attempt.owner_token = NEW.owner_token
                AND attempt.selection_id = NEW.context_selection_id
                AND attempt.activity_id = selection.activity_id
                AND attempt.session_id = selection.session_id
                AND attempt.projection_hash = selection.projection_hash
                AND attempt.provider_id = NEW.provider_id
                AND attempt.request_hash = NEW.request_input_hash
                AND attempt.prepared_turn_hash = NEW.prepared_turn_hash
                AND attempt.wire_request_hash = NEW.wire_request_hash
                AND attempt.state != 'prepared'
            )
          )
        BEGIN
          SELECT RAISE(ABORT, 'provider receipt cross-state recovery requires exact physical-start evidence');
        END
      `)
    })
  },
} satisfies DatabaseMigration.Migration
