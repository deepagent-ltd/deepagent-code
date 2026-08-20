import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

// BUG-407-009 §10.1 fail-closed path for committed compaction continuations whose recovery
// cannot proceed (e.g. the incident sessions have no assistant message for the v2 owner to
// continue from). The original continuation state machine only allowed pending → admitted, and
// the admission bindings (receipt id / admitted_at / response fingerprint) cannot exist for a
// run that never reached admission — so recovery failures could not be recorded, and instance
// initialization re-woke the same runs forever (log flood, endless retry loop).
//
// This migration widens the machine with one transition: pending → failed, exempt from the
// admission/response binding requirements. Real continuation recovery remains a Maintenance
// deliverable; this only makes the hotfix fail closed and stop re-advertising the run.

export default {
  id: "20260820130000_compaction_continuation_fail_closed",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`DROP TRIGGER compaction_run_continuation_transition`)
      yield* tx.run(`
        CREATE TRIGGER compaction_run_continuation_transition
        BEFORE UPDATE OF continuation_state ON compaction_run
        WHEN OLD.continuation_state IS NOT NEW.continuation_state AND NOT (
          (OLD.continuation_state IS NULL AND NEW.continuation_state = 'pending') OR
          (OLD.continuation_state = 'pending' AND NEW.continuation_state IN ('admitted', 'failed')) OR
          (OLD.continuation_state = 'admitted' AND NEW.continuation_state IN ('pending', 'dispatching', 'failed')) OR
          (OLD.continuation_state = 'dispatching' AND NEW.continuation_state IN ('settled', 'failed', 'indeterminate'))
        )
        BEGIN
          SELECT RAISE(ABORT, 'illegal compaction continuation transition');
        END
      `)
      yield* tx.run(`DROP TRIGGER compaction_run_continuation_binding_validate`)
      yield* tx.run(`
        CREATE TRIGGER compaction_run_continuation_binding_validate
        BEFORE UPDATE ON compaction_run
        WHEN NOT (OLD.continuation_state = 'pending' AND NEW.continuation_state = 'failed') AND (
          (NEW.continuation_state IN ('admitted', 'dispatching', 'settled', 'failed', 'indeterminate') AND
            (NEW.continuation_receipt_id IS NULL OR NEW.continuation_admitted_at IS NULL)) OR
          (NEW.continuation_state IN ('dispatching', 'settled', 'failed', 'indeterminate') AND
            NEW.continuation_dispatching_at IS NULL AND NEW.continuation_state != 'failed') OR
          (NEW.continuation_state IN ('settled', 'failed', 'indeterminate') AND
            NEW.continuation_terminal_at IS NULL)
        )
        BEGIN
          SELECT RAISE(ABORT, 'incomplete compaction continuation binding');
        END
      `)
      yield* tx.run(`DROP TRIGGER compaction_run_continuation_response_validate`)
      yield* tx.run(`
        CREATE TRIGGER compaction_run_continuation_response_validate
        BEFORE UPDATE OF continuation_state ON compaction_run
        WHEN NEW.continuation_state IN ('settled', 'failed')
          AND NOT (OLD.continuation_state = 'pending' AND NEW.continuation_state = 'failed')
          AND NOT EXISTS (
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
