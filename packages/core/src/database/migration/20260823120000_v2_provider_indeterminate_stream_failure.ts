import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

// P1-B: a post-dispatch stream failure that cannot be proven terminal must be recorded as
// `indeterminate_after_crash` (recovery_required), never as a retryable `failed` receipt. The
// previous guard only whitelisted owner-lost/consumer-cancelled indeterminate transitions with no
// outcome evidence; the live owner may now also quarantine its own dispatch with a
// `*_stream_failed:<fingerprint>` error code and the partial event artifact it observed.
export default {
  id: "20260823120000_v2_provider_indeterminate_stream_failure",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`DROP TRIGGER session_v2_provider_turn_receipt_transition_guard`)
      yield* tx.run(`
        CREATE TRIGGER session_v2_provider_turn_receipt_transition_guard
        BEFORE UPDATE OF state ON session_v2_provider_turn_receipt
        WHEN NOT (
          (OLD.state = 'preparing' AND NEW.state = 'dispatching'
            AND NEW.prepared_turn_hash IS NOT NULL
            AND NEW.wire_request_hash IS NOT NULL
            AND NEW.prepared_turn IS NOT NULL
            AND json_extract(NEW.prepared_turn, '$.request_hash') = NEW.prepared_turn_hash
            AND json_extract(NEW.prepared_turn, '$.wire_request_hash') = NEW.wire_request_hash
            AND NEW.dispatching_at IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM session_provider_owner_lease owner
              WHERE owner.owner_token = NEW.owner_token
                AND owner.released_at IS NULL
                AND owner.lease_expires_at > NEW.dispatching_at
            ))
          OR (OLD.state = 'dispatching' AND NEW.state = 'streaming'
            AND NEW.first_event_at IS NOT NULL)
          OR (OLD.state IN ('dispatching', 'streaming') AND NEW.state IN ('settled', 'failed')
            AND length(NEW.outcome_hash) = 64
            AND NEW.outcome_hash NOT GLOB '*[^0-9a-f]*'
            AND json_valid(NEW.outcome_artifact)
            AND json_type(NEW.outcome_artifact) = 'array'
            AND NEW.terminal_at IS NOT NULL)
          OR (OLD.state = 'preparing' AND NEW.state = 'failed'
            AND NEW.outcome_artifact IS NULL
            AND NEW.error_code IS NOT NULL AND NEW.terminal_at IS NOT NULL
            AND (
              NEW.error_code != 'owner_lost_before_dispatch'
              OR (
                NOT EXISTS (
                  SELECT 1 FROM session_provider_owner_lease owner
                  WHERE owner.owner_token = OLD.owner_token AND owner.released_at IS NULL
                    AND owner.lease_expires_at > NEW.terminal_at
                )
                AND EXISTS (
                  SELECT 1 FROM session_provider_owner_lease recovery
                  WHERE recovery.owner_token != OLD.owner_token AND recovery.released_at IS NULL
                    AND recovery.lease_expires_at > NEW.terminal_at
                )
              )
            ))
          OR (OLD.state IN ('dispatching', 'streaming') AND NEW.state = 'indeterminate_after_crash'
            AND NEW.terminal_at IS NOT NULL
            AND (
              (NEW.outcome_artifact IS NULL
               AND NEW.error_code IN ('owner_lost_after_dispatch', 'consumer_cancelled_after_dispatch')
               AND (
                 (NEW.error_code = 'consumer_cancelled_after_dispatch' AND EXISTS (
                   SELECT 1 FROM session_provider_owner_lease owner
                   WHERE owner.owner_token = OLD.owner_token AND owner.released_at IS NULL
                     AND owner.lease_expires_at > NEW.terminal_at
                 ))
                 OR (NEW.error_code = 'owner_lost_after_dispatch'
                   AND NOT EXISTS (
                     SELECT 1 FROM session_provider_owner_lease owner
                     WHERE owner.owner_token = OLD.owner_token AND owner.released_at IS NULL
                       AND owner.lease_expires_at > NEW.terminal_at
                   )
                   AND EXISTS (
                     SELECT 1 FROM session_provider_owner_lease recovery
                     WHERE recovery.owner_token != OLD.owner_token AND recovery.released_at IS NULL
                       AND recovery.lease_expires_at > NEW.terminal_at
                   ))
               ))
              OR ((NEW.error_code GLOB 'provider_stream_failed:*'
                   OR NEW.error_code GLOB 'compaction_stream_failed:*')
                AND (
                  NEW.outcome_artifact IS NULL
                  OR (json_valid(NEW.outcome_artifact) AND json_type(NEW.outcome_artifact) = 'array')
                )
                AND EXISTS (
                  SELECT 1 FROM session_provider_owner_lease owner
                  WHERE owner.owner_token = OLD.owner_token AND owner.released_at IS NULL
                    AND owner.lease_expires_at > NEW.terminal_at
                ))
            ))
        )
        BEGIN
          SELECT RAISE(ABORT, 'illegal v2 provider receipt transition');
        END
      `)
    })
  },
} satisfies DatabaseMigration.Migration
