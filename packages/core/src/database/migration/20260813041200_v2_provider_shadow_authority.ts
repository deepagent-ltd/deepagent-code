import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260813041200_v2_provider_shadow_authority",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TRIGGER session_v2_provider_turn_receipt_insert_guard
        BEFORE INSERT ON session_v2_provider_turn_receipt
        WHEN NEW.state != 'preparing'
          OR NEW.prepared_turn_hash IS NOT NULL
          OR NEW.wire_request_hash IS NOT NULL
          OR NEW.prepared_turn IS NOT NULL
          OR NEW.outcome_hash IS NOT NULL
          OR NEW.error_code IS NOT NULL
          OR NEW.dispatching_at IS NOT NULL
          OR NEW.first_event_at IS NOT NULL
          OR NEW.terminal_at IS NOT NULL
          OR NOT EXISTS (
            SELECT 1 FROM session_provider_owner_lease owner
            WHERE owner.owner_token = NEW.owner_token
              AND owner.released_at IS NULL
              AND owner.lease_expires_at > NEW.created_at
          )
        BEGIN
          SELECT RAISE(ABORT, 'v2 provider receipt admission requires a live owner and preparing state');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER session_v2_provider_turn_receipt_identity_immutable
        BEFORE UPDATE ON session_v2_provider_turn_receipt
        WHEN NEW.receipt_id != OLD.receipt_id
          OR NEW.session_id != OLD.session_id
          OR NEW.request_ordinal != OLD.request_ordinal
          OR NEW.user_message_id != OLD.user_message_id
          OR NEW.history_prompt_epoch != OLD.history_prompt_epoch
          OR NEW.history_source_end_message_id IS NOT OLD.history_source_end_message_id
          OR NEW.request_input_hash != OLD.request_input_hash
          OR NEW.provider_id != OLD.provider_id
          OR NEW.model_id != OLD.model_id
          OR NEW.protocol != OLD.protocol
          OR NEW.owner_mode != OLD.owner_mode
          OR NEW.owner_token != OLD.owner_token
          OR NEW.created_at != OLD.created_at
          OR (OLD.prepared_turn_hash IS NOT NULL AND NEW.prepared_turn_hash IS NOT OLD.prepared_turn_hash)
          OR (OLD.wire_request_hash IS NOT NULL AND NEW.wire_request_hash IS NOT OLD.wire_request_hash)
          OR (OLD.prepared_turn IS NOT NULL AND NEW.prepared_turn IS NOT OLD.prepared_turn)
          OR (OLD.outcome_hash IS NOT NULL AND NEW.outcome_hash IS NOT OLD.outcome_hash)
          OR (OLD.error_code IS NOT NULL AND NEW.error_code IS NOT OLD.error_code)
          OR (OLD.dispatching_at IS NOT NULL AND NEW.dispatching_at IS NOT OLD.dispatching_at)
          OR (OLD.first_event_at IS NOT NULL AND NEW.first_event_at IS NOT OLD.first_event_at)
          OR (OLD.terminal_at IS NOT NULL AND NEW.terminal_at IS NOT OLD.terminal_at)
        BEGIN
          SELECT RAISE(ABORT, 'v2 provider receipt identity is immutable');
        END
      `)
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
            AND NEW.outcome_hash IS NOT NULL AND NEW.terminal_at IS NOT NULL)
          OR (OLD.state = 'preparing' AND NEW.state = 'failed'
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
            AND NEW.error_code IN ('owner_lost_after_dispatch', 'consumer_cancelled_after_dispatch')
            AND NEW.terminal_at IS NOT NULL
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
        )
        BEGIN
          SELECT RAISE(ABORT, 'illegal v2 provider receipt transition');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER session_v2_provider_turn_receipt_delete_guard
        BEFORE DELETE ON session_v2_provider_turn_receipt
        BEGIN
          SELECT RAISE(ABORT, 'v2 provider receipts are append only');
        END
      `)

      yield* tx.run(`
        CREATE TRIGGER session_v2_provider_parity_receipt_authority_guard
        BEFORE INSERT ON session_v2_provider_parity_receipt
        WHEN NOT EXISTS (
          SELECT 1 FROM session_tool_request_receipt legacy
          WHERE legacy.receipt_id = NEW.legacy_receipt_id
            AND legacy.provider_state = 'settled'
            AND legacy.prepared_turn_hash = NEW.legacy_request_hash
            AND legacy.response_fingerprint = NEW.legacy_outcome_hash
            AND json_extract(NEW.legacy_prepared_turn, '$.receipt_id') = legacy.receipt_id
            AND json_extract(NEW.legacy_prepared_turn, '$.request_ordinal') = legacy.request_ordinal
            AND json_extract(NEW.legacy_prepared_turn, '$.session_id') = legacy.session_id
            AND json_extract(NEW.legacy_prepared_turn, '$.user_message_id') = legacy.user_message_id
            AND json_extract(NEW.legacy_prepared_turn, '$.request_hash') = legacy.prepared_turn_hash
            AND json_extract(NEW.legacy_prepared_turn, '$.wire_request_hash') = legacy.wire_request_hash
        ) OR NOT EXISTS (
          SELECT 1 FROM session_v2_provider_turn_receipt core
          WHERE core.receipt_id = NEW.core_v2_receipt_id
            AND core.state = 'settled'
            AND core.prepared_turn_hash = NEW.core_v2_request_hash
            AND core.outcome_hash = NEW.core_v2_outcome_hash
            AND NEW.core_v2_prepared_turn = core.prepared_turn
            AND json_extract(NEW.core_v2_prepared_turn, '$.request_hash') = core.prepared_turn_hash
        ) OR EXISTS (
          SELECT 1 FROM json_each(NEW.allowlisted_differences)
          WHERE value NOT IN (
            'owner', 'receipt_id', 'provider_attempt_id', 'assistant_message_id', 'prepared_at'
          )
        ) OR EXISTS (
          SELECT 1 FROM json_each(NEW.evidence)
          WHERE value NOT IN ('shadow_snapshot', 'recorded_provider', 'real_session_replay')
        ) OR NEW.verified NOT IN (0, 1)
          OR (NEW.verified = 1 AND (
            NEW.legacy_request_hash != NEW.core_v2_request_hash
            OR NEW.legacy_outcome_hash != NEW.core_v2_outcome_hash
            OR json_array_length(NEW.disallowed_differences) != 0
            OR json_remove(
              NEW.legacy_prepared_turn,
              '$.owner', '$.receipt_id', '$.provider_attempt_id', '$.assistant_message_id', '$.prepared_at'
            ) != json_remove(
              NEW.core_v2_prepared_turn,
              '$.owner', '$.receipt_id', '$.provider_attempt_id', '$.assistant_message_id', '$.prepared_at'
            )
          ))
        BEGIN
          SELECT RAISE(ABORT, 'v2 provider parity receipt lacks exact terminal authority');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER session_v2_provider_parity_receipt_delete_guard
        BEFORE DELETE ON session_v2_provider_parity_receipt
        BEGIN
          SELECT RAISE(ABORT, 'v2 provider parity receipts are append only');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER session_v2_provider_parity_receipt_update_guard
        BEFORE UPDATE ON session_v2_provider_parity_receipt
        BEGIN
          SELECT RAISE(ABORT, 'v2 provider parity receipts are immutable');
        END
      `)
    })
  },
} satisfies DatabaseMigration.Migration
