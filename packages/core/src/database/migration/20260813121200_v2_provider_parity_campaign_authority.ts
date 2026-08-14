import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

const cases = [
  "admission_activity",
  "batched_steer_queue",
  "exact_retry_interrupt",
  "stable_prefix_runtime_tail_cache",
  "tool_registry_permissions_question",
  "attachments_location_agent_model",
  "compaction_overflow_provider_errors_tokens",
  "tool_settlement_cancellation",
  "task_goal_finalizer_im",
  "status_events_telemetry",
  "provider_contract_replay",
]

export default {
  id: "20260813121200_v2_provider_parity_campaign_authority",
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
            AND NEW.outcome_artifact IS NULL
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
      yield* tx.run(`DROP TRIGGER session_v2_provider_turn_receipt_identity_immutable`)
      yield* tx.run(`
        CREATE TRIGGER session_v2_provider_turn_receipt_identity_immutable
        BEFORE UPDATE ON session_v2_provider_turn_receipt
        WHEN NEW.receipt_id != OLD.receipt_id
          OR NEW.session_id != OLD.session_id
          OR NEW.user_message_id != OLD.user_message_id
          OR NEW.request_ordinal != OLD.request_ordinal
          OR NEW.owner_token != OLD.owner_token
          OR NEW.owner_mode != OLD.owner_mode
          OR NEW.history_prompt_epoch != OLD.history_prompt_epoch
          OR NEW.history_source_end_message_id IS NOT OLD.history_source_end_message_id
          OR NEW.request_input_hash != OLD.request_input_hash
          OR NEW.provider_id != OLD.provider_id
          OR NEW.model_id != OLD.model_id
          OR NEW.protocol != OLD.protocol
          OR (OLD.prepared_turn_hash IS NOT NULL AND NEW.prepared_turn_hash IS NOT OLD.prepared_turn_hash)
          OR (OLD.wire_request_hash IS NOT NULL AND NEW.wire_request_hash IS NOT OLD.wire_request_hash)
          OR (OLD.prepared_turn IS NOT NULL AND NEW.prepared_turn IS NOT OLD.prepared_turn)
          OR (OLD.outcome_hash IS NOT NULL AND NEW.outcome_hash IS NOT OLD.outcome_hash)
          OR (OLD.outcome_artifact IS NOT NULL AND NEW.outcome_artifact IS NOT OLD.outcome_artifact)
          OR (OLD.error_code IS NOT NULL AND NEW.error_code IS NOT OLD.error_code)
          OR (OLD.dispatching_at IS NOT NULL AND NEW.dispatching_at IS NOT OLD.dispatching_at)
          OR (OLD.first_event_at IS NOT NULL AND NEW.first_event_at IS NOT OLD.first_event_at)
          OR (OLD.terminal_at IS NOT NULL AND NEW.terminal_at IS NOT OLD.terminal_at)
          OR NEW.created_at != OLD.created_at
        BEGIN
          SELECT RAISE(ABORT, 'v2 provider receipt identity is immutable');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER session_v2_provider_parity_baseline_insert_guard
        BEFORE INSERT ON session_v2_provider_parity_baseline
        WHEN length(trim(NEW.campaign_id)) = 0
          OR length(NEW.campaign_id) > 128
          OR NEW.case_name NOT IN (${cases.map((item) => `'${item}'`).join(", ")})
          OR NEW.state != 'prepared'
          OR NEW.outcome_hash IS NOT NULL
          OR NEW.outcome_artifact IS NOT NULL
          OR NEW.legacy_response_fingerprint IS NOT NULL
          OR NEW.settled_at IS NOT NULL
          OR length(NEW.receipt_hash) != 64
          OR NEW.receipt_hash GLOB '*[^0-9a-f]*'
          OR NOT json_valid(NEW.prepared_turn)
          OR json_type(NEW.prepared_turn) != 'object'
          OR NOT json_valid(NEW.evidence)
          OR json_type(NEW.evidence) != 'array'
          OR json_array_length(NEW.evidence) != 2
          OR NOT EXISTS (SELECT 1 FROM json_each(NEW.evidence) WHERE value = 'shadow_snapshot')
          OR NOT EXISTS (SELECT 1 FROM json_each(NEW.evidence) WHERE value = 'recorded_provider')
          OR EXISTS (SELECT 1 FROM json_each(NEW.evidence) WHERE value NOT IN ('shadow_snapshot', 'recorded_provider'))
          OR NOT EXISTS (
            SELECT 1 FROM session_tool_request_receipt legacy
            WHERE legacy.receipt_id = NEW.legacy_receipt_id
              AND legacy.provider_state = 'prepared'
              AND legacy.prepared_turn_hash = json_extract(NEW.prepared_turn, '$.request_hash')
              AND legacy.wire_request_hash = json_extract(NEW.prepared_turn, '$.wire_request_hash')
              AND legacy.request_ordinal = json_extract(NEW.prepared_turn, '$.request_ordinal')
              AND legacy.session_id = json_extract(NEW.prepared_turn, '$.session_id')
              AND legacy.user_message_id = json_extract(NEW.prepared_turn, '$.user_message_id')
          )
        BEGIN
          SELECT RAISE(ABORT, 'v2 parity baseline lacks exact prepared legacy authority');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER session_v2_provider_parity_baseline_update_guard
        BEFORE UPDATE ON session_v2_provider_parity_baseline
        WHEN NEW.campaign_id != OLD.campaign_id
          OR NEW.case_name != OLD.case_name
          OR NEW.legacy_receipt_id != OLD.legacy_receipt_id
          OR NEW.prepared_turn != OLD.prepared_turn
          OR NEW.evidence != OLD.evidence
          OR NEW.receipt_hash != OLD.receipt_hash
          OR NEW.created_at != OLD.created_at
          OR NOT (OLD.state = 'prepared' AND NEW.state = 'settled')
          OR length(NEW.outcome_hash) != 64
          OR NEW.outcome_hash GLOB '*[^0-9a-f]*'
          OR NOT json_valid(NEW.outcome_artifact)
          OR json_type(NEW.outcome_artifact) != 'array'
          OR length(NEW.legacy_response_fingerprint) != 64
          OR NEW.legacy_response_fingerprint GLOB '*[^0-9a-f]*'
          OR NEW.settled_at IS NULL
          OR NOT EXISTS (
            SELECT 1 FROM session_tool_request_receipt legacy
            WHERE legacy.receipt_id = NEW.legacy_receipt_id
              AND legacy.provider_state = 'settled'
              AND legacy.prepared_turn_hash = json_extract(NEW.prepared_turn, '$.request_hash')
              AND legacy.wire_request_hash = json_extract(NEW.prepared_turn, '$.wire_request_hash')
              AND legacy.response_fingerprint = NEW.legacy_response_fingerprint
          )
        BEGIN
          SELECT RAISE(ABORT, 'v2 parity baseline settlement lacks exact legacy terminal authority');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER session_v2_provider_parity_baseline_delete_guard
        BEFORE DELETE ON session_v2_provider_parity_baseline
        BEGIN
          SELECT RAISE(ABORT, 'v2 parity baselines are append only');
        END
      `)
      yield* tx.run(`DROP TRIGGER session_v2_provider_parity_receipt_authority_guard`)
      yield* tx.run(`
        CREATE TRIGGER session_v2_provider_parity_receipt_authority_guard
        BEFORE INSERT ON session_v2_provider_parity_receipt
        WHEN NOT EXISTS (
          SELECT 1 FROM session_v2_provider_parity_baseline baseline
          WHERE baseline.campaign_id = NEW.campaign_id
            AND baseline.case_name = NEW.case_name
            AND baseline.legacy_receipt_id = NEW.legacy_receipt_id
            AND baseline.state = 'settled'
            AND baseline.prepared_turn = NEW.legacy_prepared_turn
            AND baseline.outcome_hash = NEW.legacy_outcome_hash
            AND baseline.outcome_artifact IS NOT NULL
        ) OR NOT EXISTS (
          SELECT 1 FROM session_v2_provider_turn_receipt core
          WHERE core.receipt_id = NEW.core_v2_receipt_id
            AND core.state = 'settled'
            AND core.prepared_turn_hash = NEW.core_v2_request_hash
            AND core.outcome_hash = NEW.core_v2_outcome_hash
            AND core.outcome_artifact IS NOT NULL
            AND NEW.core_v2_prepared_turn = core.prepared_turn
            AND json_extract(NEW.core_v2_prepared_turn, '$.request_hash') = core.prepared_turn_hash
        ) OR (NEW.verified = 1 AND NOT EXISTS (
          SELECT 1 FROM session_v2_provider_parity_baseline baseline
          JOIN session_v2_provider_turn_receipt core ON core.receipt_id = NEW.core_v2_receipt_id
          WHERE baseline.campaign_id = NEW.campaign_id
            AND baseline.case_name = NEW.case_name
            AND baseline.outcome_artifact = core.outcome_artifact
        )) OR EXISTS (
          SELECT 1 FROM json_each(NEW.allowlisted_differences)
          WHERE value NOT IN ('owner', 'receipt_id', 'provider_attempt_id', 'assistant_message_id', 'prepared_at')
        ) OR NOT EXISTS (SELECT 1 FROM json_each(NEW.evidence) WHERE value = 'shadow_snapshot')
          OR NOT EXISTS (SELECT 1 FROM json_each(NEW.evidence) WHERE value = 'recorded_provider')
          OR NOT EXISTS (SELECT 1 FROM json_each(NEW.evidence) WHERE value = 'real_session_replay')
          OR EXISTS (
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
          SELECT RAISE(ABORT, 'v2 provider parity receipt lacks exact campaign authority');
        END
      `)
    })
  },
} satisfies DatabaseMigration.Migration
