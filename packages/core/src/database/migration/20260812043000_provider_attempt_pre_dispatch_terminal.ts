import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260812043000_provider_attempt_pre_dispatch_terminal",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run("DROP TRIGGER IF EXISTS session_provider_attempt_legal_update")
      yield* tx.run(`
        CREATE TRIGGER session_provider_attempt_legal_update
        BEFORE UPDATE ON session_provider_attempt
        WHEN NEW.attempt_id != OLD.attempt_id
          OR NEW.session_id != OLD.session_id
          OR NEW.activity_id != OLD.activity_id
          OR NEW.provider_turn_seq != OLD.provider_turn_seq
          OR NEW.selection_id != OLD.selection_id
          OR NEW.projection_hash != OLD.projection_hash
          OR NEW.request_hash != OLD.request_hash
          OR NEW.provider_id != OLD.provider_id
          OR NEW.parent_attempt_id IS NOT OLD.parent_attempt_id
          OR NEW.idempotency_key IS NOT OLD.idempotency_key
          OR NEW.created_at != OLD.created_at
          OR (NEW.first_event_at IS NOT OLD.first_event_at AND NOT (OLD.state = 'dispatching' AND NEW.state = 'streaming' AND OLD.first_event_at IS NULL AND NEW.first_event_at IS NOT NULL))
          OR (NEW.error_code IS NOT OLD.error_code AND NEW.state NOT IN ('failed', 'indeterminate_after_crash'))
          OR NOT (
            (OLD.state = 'prepared' AND NEW.state = 'dispatching' AND NEW.first_event_at IS NULL AND NEW.settled_at IS NULL AND NEW.error_code IS NULL) OR
            (OLD.state = 'prepared' AND NEW.state = 'failed' AND NEW.first_event_at IS NULL AND NEW.settled_at IS NOT NULL AND length(trim(COALESCE(NEW.error_code, ''))) > 0) OR
            (OLD.state = 'dispatching' AND NEW.state = 'streaming' AND NEW.first_event_at IS NOT NULL AND NEW.settled_at IS NULL) OR
            (OLD.state IN ('dispatching', 'streaming') AND NEW.state IN ('settled', 'failed') AND NEW.settled_at IS NOT NULL) OR
            (OLD.state IN ('dispatching', 'streaming') AND NEW.state = 'indeterminate_after_crash' AND NEW.settled_at IS NULL) OR
            (OLD.state = 'indeterminate_after_crash' AND NEW.state IN ('resolved_abandoned', 'resolved_settled', 'resolved_replayed') AND NEW.settled_at IS NOT NULL)
          )
        BEGIN
          SELECT RAISE(ABORT, 'illegal session_provider_attempt transition');
        END
      `)
    })
  },
} satisfies DatabaseMigration.Migration
