import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260813120000_legacy_provider_receipt_supersession",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run("DROP TRIGGER session_tool_request_receipt_provider_transition")
      yield* tx.run(`
        UPDATE session_tool_request_receipt AS receipt
        SET provider_state = 'failed',
            terminal_at = COALESCE(receipt.terminal_at, receipt.created_at),
            request_error_code = 'legacy_request_superseded_by_later_request'
        WHERE receipt.provider_state = 'indeterminate_after_crash'
          AND receipt.request_error_code = 'legacy_dispatch_outcome_unknown'
          AND receipt.provider_attempt_id IS NULL
          AND EXISTS (
            SELECT 1
            FROM session_tool_request_receipt AS later
            WHERE later.session_id = receipt.session_id
              AND later.request_ordinal > receipt.request_ordinal
          )
      `)
      yield* tx.run(`
        CREATE TRIGGER session_tool_request_receipt_provider_transition
        BEFORE UPDATE OF provider_state ON session_tool_request_receipt
        WHEN NEW.provider_state != OLD.provider_state AND NOT (
          (OLD.provider_state = 'preparing' AND NEW.provider_state IN ('prepared', 'failed')) OR
          (OLD.provider_state = 'prepared' AND NEW.provider_state IN ('dispatching', 'failed')) OR
          (OLD.provider_state = 'dispatching' AND NEW.provider_state IN ('streaming', 'settled', 'failed', 'indeterminate_after_crash')) OR
          (OLD.provider_state = 'streaming' AND NEW.provider_state IN ('settled', 'failed', 'indeterminate_after_crash'))
        )
        BEGIN
          SELECT RAISE(ABORT, 'illegal provider receipt transition');
        END
      `)
    })
  },
} satisfies DatabaseMigration.Migration
