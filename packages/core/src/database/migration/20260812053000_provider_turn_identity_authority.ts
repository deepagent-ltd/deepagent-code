import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260812053000_provider_turn_identity_authority",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        ALTER TABLE session_provider_attempt ADD COLUMN prepared_turn_hash TEXT
        CHECK (prepared_turn_hash IS NULL OR (
          length(prepared_turn_hash) = 64 AND
          prepared_turn_hash NOT GLOB '*[^0-9a-f]*'
        ))
      `)
      yield* tx.run(`
        ALTER TABLE session_provider_attempt ADD COLUMN wire_request_hash TEXT
        CHECK (
          (prepared_turn_hash IS NULL AND wire_request_hash IS NULL) OR
          (
            prepared_turn_hash IS NOT NULL AND
            wire_request_hash IS NOT NULL AND
            length(wire_request_hash) = 64 AND
            wire_request_hash NOT GLOB '*[^0-9a-f]*'
          )
        )
      `)
      yield* tx.run(`
        CREATE TEMP TABLE provider_turn_identity_preflight (
          valid INTEGER NOT NULL CHECK (valid = 1)
        )
      `)
      yield* tx.run(`
        INSERT INTO provider_turn_identity_preflight(valid)
        SELECT CASE WHEN EXISTS (
          SELECT 1
          FROM session_provider_owner_lease owner
          WHERE owner.registered_at > CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
            OR owner.heartbeat_at > CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
            OR owner.lease_expires_at - owner.heartbeat_at > 31536000000
            OR owner.released_at > CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
        ) OR EXISTS (
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
              attempt.request_hash IS NOT receipt.request_input_hash
            )
        ) THEN 0 ELSE 1 END
      `)
      yield* tx.run("DROP TABLE provider_turn_identity_preflight")
      yield* tx.run(`
        UPDATE session_provider_owner_lease
        SET released_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
        WHERE released_at IS NULL
      `)
      yield* tx.run(`
        CREATE UNIQUE INDEX session_tool_request_receipt_provider_attempt_idx
        ON session_tool_request_receipt(provider_attempt_id)
        WHERE provider_attempt_id IS NOT NULL
      `)
      yield* tx.run(`
        CREATE TRIGGER session_provider_owner_lease_insert_clock_guard
        BEFORE INSERT ON session_provider_owner_lease
        WHEN NEW.registered_at != CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
          OR NEW.heartbeat_at != NEW.registered_at
          OR NEW.lease_expires_at <= NEW.heartbeat_at
          OR NEW.lease_expires_at - NEW.heartbeat_at > 31536000000
          OR NEW.released_at IS NOT NULL
        BEGIN
          SELECT RAISE(ABORT, 'provider owner lease requires database observed time');
        END
      `)
      yield* tx.run("DROP TRIGGER IF EXISTS session_provider_owner_lease_legal_update")
      yield* tx.run(`
        CREATE TRIGGER session_provider_owner_lease_legal_update
        BEFORE UPDATE ON session_provider_owner_lease
        WHEN NEW.owner_token != OLD.owner_token
          OR NEW.registered_at != OLD.registered_at
          OR NOT (
            (
              OLD.released_at IS NULL AND NEW.released_at IS NULL
              AND NEW.heartbeat_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
              AND OLD.heartbeat_at <= NEW.heartbeat_at
              AND NEW.heartbeat_at < OLD.lease_expires_at
              AND NEW.lease_expires_at >= OLD.lease_expires_at
              AND NEW.lease_expires_at > NEW.heartbeat_at
              AND NEW.lease_expires_at - NEW.heartbeat_at <= 31536000000
            ) OR (
              OLD.released_at IS NULL AND NEW.released_at IS NOT NULL
              AND NEW.released_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
              AND NEW.heartbeat_at = OLD.heartbeat_at
              AND NEW.lease_expires_at = OLD.lease_expires_at
            )
          )
        BEGIN
          SELECT RAISE(ABORT, 'illegal session_provider_owner_lease update');
        END
      `)
      yield* tx.run("DROP TRIGGER IF EXISTS session_provider_attempt_owner_insert_guard")
      yield* tx.run(`
        CREATE TRIGGER session_provider_attempt_owner_insert_guard
        BEFORE INSERT ON session_provider_attempt
        WHEN NEW.owner_token IS NULL
          OR NOT EXISTS (
            SELECT 1
            FROM session_provider_owner_lease owner
            WHERE owner.owner_token = NEW.owner_token
              AND owner.released_at IS NULL
              AND owner.lease_expires_at > CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
          )
        BEGIN
          SELECT RAISE(ABORT, 'new provider attempt requires a live exact owner lease at database time');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER session_provider_attempt_owner_update_guard
        BEFORE UPDATE ON session_provider_attempt
        WHEN (
          (OLD.state = 'prepared' AND NEW.state IN ('prepared', 'dispatching')) OR
          (
            OLD.state = 'prepared' AND NEW.state = 'failed'
            AND NEW.error_code NOT IN (
              'owner_lease_lost_before_dispatch',
              'legacy_wire_identity_missing'
            )
          ) OR
          (OLD.state = 'dispatching' AND NEW.state = 'streaming') OR
          (OLD.state IN ('dispatching', 'streaming') AND NEW.state IN ('settled', 'failed'))
        ) AND NOT EXISTS (
          SELECT 1
          FROM session_provider_owner_lease owner
          WHERE owner.owner_token = OLD.owner_token
            AND owner.released_at IS NULL
            AND owner.lease_expires_at > CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
        )
        BEGIN
          SELECT RAISE(ABORT, 'provider attempt transition requires its live exact owner at database time');
        END
      `)
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
      yield* tx.run("DROP TRIGGER IF EXISTS session_tool_request_receipt_attempt_owner_insert_guard")
      yield* tx.run(`
        CREATE TRIGGER session_tool_request_receipt_attempt_owner_insert_guard
        BEFORE INSERT ON session_tool_request_receipt
        WHEN NEW.owner_token IS NULL OR
          NOT EXISTS (
            SELECT 1
            FROM session_provider_owner_lease owner
            WHERE owner.owner_token = NEW.owner_token
              AND owner.released_at IS NULL
              AND owner.lease_expires_at > CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
          ) OR
          (NEW.provider_attempt_id IS NOT NULL AND NOT EXISTS (
            SELECT 1
            FROM session_provider_attempt attempt
            WHERE attempt.attempt_id = NEW.provider_attempt_id
              AND attempt.session_id = NEW.session_id
              AND attempt.owner_token = NEW.owner_token
          ))
        BEGIN
          SELECT RAISE(ABORT, 'provider receipt requires the attempt live exact owner at database time');
        END
      `)

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
              AND NEW.settled_at IS NULL AND NEW.error_code = 'process_recovery'
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
      yield* tx.run(`
        CREATE TRIGGER session_provider_attempt_wire_identity_insert_guard
        BEFORE INSERT ON session_provider_attempt
        WHEN NEW.prepared_turn_hash IS NOT NULL OR NEW.wire_request_hash IS NOT NULL
        BEGIN
          SELECT RAISE(ABORT, 'provider attempt wire identity must be sealed after admission');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER session_provider_attempt_wire_identity_immutable
        BEFORE UPDATE OF prepared_turn_hash, wire_request_hash ON session_provider_attempt
        WHEN (
          NEW.prepared_turn_hash IS NOT OLD.prepared_turn_hash OR
          NEW.wire_request_hash IS NOT OLD.wire_request_hash
        ) AND NOT (
          OLD.state = 'prepared' AND NEW.state = 'prepared'
          AND OLD.prepared_turn_hash IS NULL AND OLD.wire_request_hash IS NULL
          AND NEW.prepared_turn_hash IS NOT NULL AND NEW.wire_request_hash IS NOT NULL
        )
        BEGIN
          SELECT RAISE(ABORT, 'provider attempt wire identity may only be sealed once');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER session_tool_request_receipt_attempt_identity_insert_guard
        BEFORE INSERT ON session_tool_request_receipt
        WHEN NEW.provider_attempt_id IS NOT NULL AND NOT EXISTS (
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
        )
        BEGIN
          SELECT RAISE(ABORT, 'provider receipt attempt identity mismatch');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER session_tool_request_receipt_attempt_wire_guard
        BEFORE UPDATE OF provider_state ON session_tool_request_receipt
        WHEN NEW.provider_attempt_id IS NOT NULL
          AND NEW.provider_state IN ('prepared', 'dispatching')
          AND NOT EXISTS (
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
              AND (
                (NEW.provider_state = 'prepared' AND attempt.state = 'prepared') OR
                (NEW.provider_state = 'dispatching' AND attempt.state = 'dispatching')
              )
          )
        BEGIN
          SELECT RAISE(ABORT, 'provider receipt requires exact attempt wire identity');
        END
      `)
    })
  },
} satisfies DatabaseMigration.Migration
