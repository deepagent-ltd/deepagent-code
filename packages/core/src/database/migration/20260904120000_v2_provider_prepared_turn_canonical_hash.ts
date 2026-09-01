import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

// W8 协议收口 — the durable canonical `prepared_turn_hash` changes from the raw
// `request_hash` to the identity-folded `sha256(request_hash +
// protocolAttemptIdentityHash)` (design §4.1 step 8; audit DEFECT 3: the canonical
// hash omitted route/protocol/endpoint-origin). The receipt transition guard and
// the parity receipt authority guard pinned `prepared_turn_hash` to
// `prepared_turn.request_hash`; the prepared-turn JSON now carries the folded value
// as `prepared_turn_hash` (computed by `PreparedProviderTurn.prepare`), so the
// triggers verify the W8 canonical binding instead — an identity drift changes the
// persisted canonical hash even when the request payload is byte-identical.
export default {
  id: "20260904120000_v2_provider_prepared_turn_canonical_hash",
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
            AND json_extract(NEW.prepared_turn, '$.request_hash') IS NOT NULL
            AND json_extract(NEW.prepared_turn, '$.prepared_turn_hash') = NEW.prepared_turn_hash
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
      yield* tx.run(`DROP TRIGGER session_v2_provider_parity_receipt_authority_guard`)
      // The ACTIVE parity receipt authority (20260813121200) validates the legacy side against the
      // SETTLED parity baseline row (never the legacy tool receipt) and the V2 side against the
      // settled provider receipt; keep that authority intact and only adapt the canonical-hash pin:
      // `core.prepared_turn_hash = NEW.core_v2_request_hash` (pre-W8 raw semantics) becomes the W8
      // pair `json_extract(core_v2_prepared_turn, '$.request_hash') = NEW.core_v2_request_hash` (the
      // parity claim still compares REQUEST payload identity) + the folded canonical pinned to the
      // persisted column through the JSON-carried `prepared_turn_hash` field.
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
            AND core.outcome_hash = NEW.core_v2_outcome_hash
            AND core.outcome_artifact IS NOT NULL
            AND NEW.core_v2_prepared_turn = core.prepared_turn
            AND json_extract(NEW.core_v2_prepared_turn, '$.request_hash') = NEW.core_v2_request_hash
            AND json_extract(NEW.core_v2_prepared_turn, '$.prepared_turn_hash') = core.prepared_turn_hash
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
