import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

// A live owner that loses its provider stream after dispatch cannot prove a terminal outcome and
// quarantines the attempt as indeterminate. `process_recovery` stays reserved for the crash
// recovery path (stale old owner + live recovery owner); the live-owner quarantine carries the
// receipt's stream-failure fingerprint (`*_stream_failed:*` or `consumer_cancelled_after_dispatch`)
// so resolution evidence can distinguish the two paths.
export default {
  id: "20260823140000_v2_provider_attempt_live_quarantine",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`DROP TRIGGER session_provider_attempt_legal_update`)
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
          OR NEW.owner_token IS NOT OLD.owner_token
          OR NEW.parent_attempt_id IS NOT OLD.parent_attempt_id
          OR NEW.idempotency_key IS NOT OLD.idempotency_key
          OR NEW.created_at != OLD.created_at
          OR (NEW.first_event_at IS NOT OLD.first_event_at AND NOT (OLD.state = 'dispatching' AND NEW.state = 'streaming' AND OLD.first_event_at IS NULL AND NEW.first_event_at IS NOT NULL))
          OR (NEW.error_code IS NOT OLD.error_code AND NEW.state NOT IN ('failed', 'indeterminate_after_crash'))
          OR NOT (
            (
              OLD.state = 'prepared' AND NEW.state = 'prepared'
              AND OLD.prepared_turn_hash IS NULL AND OLD.wire_request_hash IS NULL
              AND NEW.prepared_turn_hash IS NOT NULL AND NEW.wire_request_hash IS NOT NULL
              AND NEW.first_event_at IS OLD.first_event_at
              AND NEW.settled_at IS OLD.settled_at
              AND NEW.error_code IS OLD.error_code
            ) OR
            (
              OLD.state = 'prepared' AND NEW.state = 'prepared'
              AND OLD.prepared_turn_hash IS NOT NULL AND OLD.wire_request_hash IS NOT NULL
              AND NEW.prepared_turn_hash IS OLD.prepared_turn_hash
              AND NEW.wire_request_hash IS OLD.wire_request_hash
              AND NEW.first_event_at IS OLD.first_event_at
              AND NEW.settled_at IS OLD.settled_at
              AND NEW.error_code IS OLD.error_code
            ) OR
            (
              OLD.state = 'prepared' AND NEW.state = 'dispatching'
              AND NEW.prepared_turn_hash IS NOT NULL AND NEW.wire_request_hash IS NOT NULL
              AND NEW.prepared_turn_hash IS OLD.prepared_turn_hash
              AND NEW.wire_request_hash IS OLD.wire_request_hash
              AND NEW.first_event_at IS NULL AND NEW.settled_at IS NULL AND NEW.error_code IS NULL
            ) OR
            (
              OLD.state = 'prepared' AND NEW.state = 'failed'
              AND NEW.prepared_turn_hash IS OLD.prepared_turn_hash
              AND NEW.wire_request_hash IS OLD.wire_request_hash
              AND NEW.first_event_at IS NULL AND NEW.settled_at IS NOT NULL
              AND length(trim(COALESCE(NEW.error_code, ''))) > 0
            ) OR
            (
              OLD.state = 'dispatching' AND NEW.state = 'streaming'
              AND NEW.prepared_turn_hash IS OLD.prepared_turn_hash
              AND NEW.wire_request_hash IS OLD.wire_request_hash
              AND NEW.first_event_at IS NOT NULL AND NEW.settled_at IS NULL
            ) OR
            (
              OLD.state IN ('dispatching', 'streaming') AND NEW.state IN ('settled', 'failed')
              AND NEW.prepared_turn_hash IS OLD.prepared_turn_hash
              AND NEW.wire_request_hash IS OLD.wire_request_hash
              AND NEW.settled_at IS NOT NULL
            ) OR
            (
              OLD.state = 'prepared' AND NEW.state = 'indeterminate_after_crash'
              AND NEW.prepared_turn_hash IS OLD.prepared_turn_hash
              AND NEW.wire_request_hash IS OLD.wire_request_hash
              AND NEW.first_event_at IS OLD.first_event_at
              AND NEW.settled_at IS NULL
              AND NEW.error_code = 'process_recovery'
            ) OR
            (
              OLD.state IN ('dispatching', 'streaming') AND NEW.state = 'indeterminate_after_crash'
              AND NEW.prepared_turn_hash IS OLD.prepared_turn_hash
              AND NEW.wire_request_hash IS OLD.wire_request_hash
              AND NEW.settled_at IS NULL
              AND (
                NEW.error_code = 'process_recovery'
                OR NEW.error_code = 'consumer_cancelled_after_dispatch'
                OR NEW.error_code GLOB 'provider_stream_failed:*'
                OR NEW.error_code GLOB 'compaction_stream_failed:*'
              )
            ) OR
            (
              OLD.state = 'indeterminate_after_crash'
              AND NEW.state IN ('resolved_abandoned', 'resolved_settled', 'resolved_replayed')
              AND NEW.prepared_turn_hash IS OLD.prepared_turn_hash
              AND NEW.wire_request_hash IS OLD.wire_request_hash
              AND NEW.settled_at IS NOT NULL
            )
          )
        BEGIN
          SELECT RAISE(ABORT, 'illegal session_provider_attempt transition');
        END
      `)
      // Live-owner quarantine keeps the attempt fenced to its exact owner: the recovery-owner
      // guard only applies to the crash recovery codes, never to live-owner quarantine codes.
      yield* tx.run(`DROP TRIGGER session_provider_attempt_recovery_owner_guard`)
      yield* tx.run(`
        CREATE TRIGGER session_provider_attempt_recovery_owner_guard
        BEFORE UPDATE ON session_provider_attempt
        WHEN (
          (
            OLD.state IN ('prepared', 'dispatching', 'streaming')
            AND NEW.state = 'indeterminate_after_crash'
            AND NEW.error_code = 'process_recovery'
          ) OR (
            OLD.state = 'prepared' AND NEW.state = 'failed'
            AND NEW.error_code = 'owner_lease_lost_before_dispatch'
          )
        )
          AND (
            EXISTS (
              SELECT 1
              FROM session_provider_owner_lease stale
              WHERE stale.owner_token = OLD.owner_token
                AND stale.released_at IS NULL
                AND stale.lease_expires_at > CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
            ) OR NOT EXISTS (
              SELECT 1
              FROM session_provider_owner_lease recovery
              WHERE recovery.owner_token IS NOT OLD.owner_token
                AND recovery.released_at IS NULL
                AND recovery.lease_expires_at > CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
            )
          )
        BEGIN
          SELECT RAISE(ABORT, 'provider attempt recovery requires stale old owner and a live recovery owner');
        END
      `)
      // A live-owner quarantine must be made by the attempt's own live owner, mirroring the
      // receipt quarantine fence.
      yield* tx.run(`
        CREATE TRIGGER session_provider_attempt_live_quarantine_owner_guard
        BEFORE UPDATE ON session_provider_attempt
        WHEN (
          OLD.state IN ('dispatching', 'streaming')
          AND NEW.state = 'indeterminate_after_crash'
          AND (
            NEW.error_code = 'consumer_cancelled_after_dispatch'
            OR NEW.error_code GLOB 'provider_stream_failed:*'
            OR NEW.error_code GLOB 'compaction_stream_failed:*'
          )
        ) AND NOT EXISTS (
          SELECT 1
          FROM session_provider_owner_lease owner
          WHERE owner.owner_token = OLD.owner_token
            AND owner.released_at IS NULL
            AND owner.lease_expires_at > CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
        )
        BEGIN
          SELECT RAISE(ABORT, 'live owner quarantine requires the attempt owner lease to be live');
        END
      `)
    })
  },
} satisfies DatabaseMigration.Migration
