import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260810160000_compaction_continuation_admission",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run("ALTER TABLE compaction_run ADD COLUMN continuation_state TEXT")
      yield* tx.run("ALTER TABLE compaction_run ADD COLUMN continuation_receipt_id TEXT")
      yield* tx.run("ALTER TABLE compaction_run ADD COLUMN continuation_admitted_at INTEGER")
      yield* tx.run("ALTER TABLE compaction_run ADD COLUMN continuation_dispatching_at INTEGER")
      yield* tx.run("ALTER TABLE compaction_run ADD COLUMN continuation_terminal_at INTEGER")
      yield* tx.run("ALTER TABLE compaction_run ADD COLUMN continuation_error_code TEXT")
      yield* tx.run("DROP TRIGGER IF EXISTS session_tool_request_receipt_response_guard")
      yield* tx.run(`
        CREATE TRIGGER session_tool_request_receipt_response_guard
        BEFORE UPDATE OF response_fingerprint ON session_tool_request_receipt
        WHEN NEW.response_fingerprint IS NOT OLD.response_fingerprint AND (
          OLD.response_fingerprint IS NOT NULL OR
          NEW.response_fingerprint IS NULL OR
          NEW.provider_state NOT IN ('settled', 'failed')
        )
        BEGIN
          SELECT RAISE(ABORT, 'provider response fingerprint requires terminal receipt');
        END
      `)

      // Recover the strongest state available from the old wakeup timestamp and its physical
      // continuation receipt. A wakeup without a receipt is the historical pre-admission crash gap
      // and must become pending so the startup recovery loop can safely retry it.
      yield* tx.run(`
        UPDATE compaction_run
        SET continuation_receipt_id = (
          SELECT receipt.receipt_id
          FROM compaction_artifact artifact
          JOIN session_tool_request_receipt receipt
            ON receipt.session_id = artifact.session_id
           AND receipt.user_message_id = artifact.message_id
          WHERE artifact.run_id = compaction_run.run_id
            AND artifact.state = 'committed'
            AND artifact.kind IN ('replay', 'continue')
          ORDER BY receipt.request_ordinal DESC
          LIMIT 1
        )
        WHERE state = 'committed'
          AND EXISTS (
            SELECT 1 FROM compaction_artifact artifact
            WHERE artifact.run_id = compaction_run.run_id
              AND artifact.state = 'committed'
              AND artifact.kind IN ('replay', 'continue')
          )
      `)
      yield* tx.run(`
        UPDATE compaction_run
        SET continuation_state = CASE
          WHEN continuation_receipt_id IS NULL THEN 'pending'
          WHEN (SELECT provider_state FROM session_tool_request_receipt
                WHERE receipt_id = continuation_receipt_id) IN ('preparing', 'prepared') THEN 'admitted'
          WHEN (SELECT provider_state FROM session_tool_request_receipt
                WHERE receipt_id = continuation_receipt_id) IN ('dispatching', 'streaming') THEN 'dispatching'
          WHEN (SELECT provider_state FROM session_tool_request_receipt
                WHERE receipt_id = continuation_receipt_id) = 'settled' AND
               (SELECT response_fingerprint FROM session_tool_request_receipt
                WHERE receipt_id = continuation_receipt_id) IS NOT NULL THEN 'settled'
          WHEN (SELECT provider_state FROM session_tool_request_receipt
                WHERE receipt_id = continuation_receipt_id) = 'failed' AND
               (SELECT response_fingerprint FROM session_tool_request_receipt
                WHERE receipt_id = continuation_receipt_id) IS NOT NULL THEN 'failed'
          WHEN (SELECT provider_state FROM session_tool_request_receipt
                WHERE receipt_id = continuation_receipt_id) = 'failed' AND
               (SELECT dispatching_at FROM session_tool_request_receipt
                WHERE receipt_id = continuation_receipt_id) IS NULL THEN 'pending'
          WHEN (SELECT provider_state FROM session_tool_request_receipt
                WHERE receipt_id = continuation_receipt_id) = 'indeterminate_after_crash' THEN 'indeterminate'
          ELSE 'indeterminate'
        END,
        continuation_admitted_at = CASE
          WHEN continuation_receipt_id IS NOT NULL THEN COALESCE(
            continuation_wakeup_at,
            (SELECT created_at FROM session_tool_request_receipt WHERE receipt_id = continuation_receipt_id)
          )
          ELSE NULL
        END,
        continuation_dispatching_at = CASE
          WHEN continuation_receipt_id IS NOT NULL AND
            (SELECT provider_state FROM session_tool_request_receipt
             WHERE receipt_id = continuation_receipt_id) IN
              ('dispatching', 'streaming', 'settled', 'failed', 'indeterminate_after_crash')
          THEN COALESCE(
            (SELECT dispatching_at FROM session_tool_request_receipt
             WHERE receipt_id = continuation_receipt_id),
            (SELECT created_at FROM session_tool_request_receipt
             WHERE receipt_id = continuation_receipt_id)
          )
          ELSE NULL
        END,
        continuation_terminal_at = CASE
          WHEN continuation_receipt_id IS NOT NULL AND
            (SELECT provider_state FROM session_tool_request_receipt
             WHERE receipt_id = continuation_receipt_id) IN
              ('settled', 'failed', 'indeterminate_after_crash')
          THEN COALESCE(
            (SELECT terminal_at FROM session_tool_request_receipt
             WHERE receipt_id = continuation_receipt_id),
            (SELECT created_at FROM session_tool_request_receipt
             WHERE receipt_id = continuation_receipt_id)
          )
          ELSE NULL
        END,
        continuation_error_code = CASE
          WHEN continuation_receipt_id IS NOT NULL
          THEN (SELECT request_error_code FROM session_tool_request_receipt
                WHERE receipt_id = continuation_receipt_id)
          ELSE CASE WHEN continuation_wakeup_at IS NOT NULL
            THEN 'legacy_wakeup_without_provider_admission' ELSE NULL END
        END
        WHERE continuation_state IS NULL
          AND EXISTS (
            SELECT 1 FROM compaction_artifact artifact
            WHERE artifact.run_id = compaction_run.run_id
              AND artifact.state = 'committed'
              AND artifact.kind IN ('replay', 'continue')
          )
      `)
      yield* tx.run(`
        UPDATE compaction_run
        SET continuation_receipt_id = NULL,
            continuation_admitted_at = NULL,
            continuation_dispatching_at = NULL,
            continuation_terminal_at = NULL,
            continuation_error_code = 'legacy_failed_without_provider_dispatch',
            continuation_wakeup_at = NULL
        WHERE continuation_state = 'pending'
          AND continuation_receipt_id IS NOT NULL
      `)
      yield* tx.run(`
        CREATE INDEX compaction_run_continuation_recovery_idx
        ON compaction_run (continuation_state, session_id)
        WHERE state = 'committed' AND continuation_state IS NOT NULL
      `)
      yield* tx.run(`
        CREATE UNIQUE INDEX compaction_run_continuation_receipt_idx
        ON compaction_run (continuation_receipt_id)
        WHERE continuation_receipt_id IS NOT NULL
      `)
      yield* tx.run(`
        CREATE TRIGGER compaction_run_continuation_state_validate
        BEFORE UPDATE OF continuation_state ON compaction_run
        WHEN NEW.continuation_state IS NOT NULL AND NEW.continuation_state NOT IN
          ('pending', 'admitted', 'dispatching', 'settled', 'failed', 'indeterminate')
        BEGIN
          SELECT RAISE(ABORT, 'invalid compaction continuation state');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER compaction_run_continuation_transition
        BEFORE UPDATE OF continuation_state ON compaction_run
        WHEN OLD.continuation_state IS NOT NEW.continuation_state AND NOT (
          (OLD.continuation_state IS NULL AND NEW.continuation_state = 'pending') OR
          (OLD.continuation_state = 'pending' AND NEW.continuation_state = 'admitted') OR
          (OLD.continuation_state = 'admitted' AND NEW.continuation_state IN ('pending', 'dispatching', 'failed')) OR
          (OLD.continuation_state = 'dispatching' AND NEW.continuation_state IN ('settled', 'failed', 'indeterminate'))
        )
        BEGIN
          SELECT RAISE(ABORT, 'illegal compaction continuation transition');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER compaction_run_continuation_binding_validate
        BEFORE UPDATE ON compaction_run
        WHEN
          (NEW.continuation_state IN ('admitted', 'dispatching', 'settled', 'failed', 'indeterminate') AND
            (NEW.continuation_receipt_id IS NULL OR NEW.continuation_admitted_at IS NULL)) OR
          (NEW.continuation_state IN ('dispatching', 'settled', 'failed', 'indeterminate') AND
            NEW.continuation_dispatching_at IS NULL AND NEW.continuation_state != 'failed') OR
          (NEW.continuation_state IN ('settled', 'failed', 'indeterminate') AND
            NEW.continuation_terminal_at IS NULL)
        BEGIN
          SELECT RAISE(ABORT, 'incomplete compaction continuation binding');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER compaction_run_continuation_response_validate
        BEFORE UPDATE OF continuation_state ON compaction_run
        WHEN NEW.continuation_state IN ('settled', 'failed') AND NOT EXISTS (
          SELECT 1
          FROM session_tool_request_receipt receipt
          WHERE receipt.receipt_id = NEW.continuation_receipt_id
            AND receipt.response_fingerprint IS NOT NULL
        )
        BEGIN
          SELECT RAISE(ABORT, 'compaction continuation response is not durable');
        END
      `)
    })
  },
} satisfies DatabaseMigration.Migration
