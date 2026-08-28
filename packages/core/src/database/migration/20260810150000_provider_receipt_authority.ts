import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260810150000_provider_receipt_authority",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run("ALTER TABLE session_tool_request_receipt ADD COLUMN request_input_hash TEXT")
      yield* tx.run("ALTER TABLE session_tool_request_receipt ADD COLUMN final_request_hash TEXT")
      yield* tx.run(
        "ALTER TABLE session_tool_request_receipt ADD COLUMN provider_state TEXT NOT NULL DEFAULT 'preparing'",
      )
      yield* tx.run("ALTER TABLE session_tool_request_receipt ADD COLUMN adapter_prepared_at INTEGER")
      yield* tx.run("ALTER TABLE session_tool_request_receipt ADD COLUMN dispatching_at INTEGER")
      yield* tx.run("ALTER TABLE session_tool_request_receipt ADD COLUMN streaming_at INTEGER")
      yield* tx.run("ALTER TABLE session_tool_request_receipt ADD COLUMN terminal_at INTEGER")
      yield* tx.run("ALTER TABLE session_tool_request_receipt ADD COLUMN response_fingerprint TEXT")
      yield* tx.run("ALTER TABLE session_tool_request_receipt ADD COLUMN owner_token TEXT")
      yield* tx.run(`
        UPDATE session_tool_request_receipt
        SET provider_state = CASE request_state
          WHEN 'dispatched' THEN 'indeterminate_after_crash'
          ELSE 'failed'
        END,
        terminal_at = created_at,
        request_error_code = CASE
          WHEN request_state = 'dispatched' THEN 'legacy_dispatch_outcome_unknown'
          WHEN request_state = 'rejected' THEN COALESCE(request_error_code, 'request_rejected')
          ELSE 'legacy_prepared_without_lifecycle'
        END
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
      yield* tx.run(`
        CREATE TRIGGER session_tool_request_receipt_dispatch_guard
        BEFORE UPDATE OF provider_state ON session_tool_request_receipt
        WHEN NEW.provider_state = 'dispatching' AND (
          NEW.final_request_hash IS NULL OR
          NEW.adapter_prepared_at IS NULL OR
          NEW.prompt_epoch IS NULL OR
          NEW.prompt_window_id IS NULL OR
          NEW.effective_history_hash IS NULL
        )
        BEGIN
          SELECT RAISE(ABORT, 'provider dispatch requires final request authority');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER session_tool_request_receipt_binding_immutable
        BEFORE UPDATE ON session_tool_request_receipt
        WHEN NEW.receipt_id != OLD.receipt_id
          OR NEW.request_ordinal != OLD.request_ordinal
          OR NEW.session_id != OLD.session_id
          OR NEW.user_message_id != OLD.user_message_id
          OR NEW.assistant_message_id IS NOT OLD.assistant_message_id
          OR NEW.provider_id != OLD.provider_id
          OR NEW.model_id != OLD.model_id
          OR NEW.protocol IS NOT OLD.protocol
          OR NEW.prompt_epoch IS NOT OLD.prompt_epoch
          OR NEW.prompt_window_id IS NOT OLD.prompt_window_id
          OR NEW.effective_history_hash IS NOT OLD.effective_history_hash
          OR NEW.world_state_baseline_hash IS NOT OLD.world_state_baseline_hash
          OR NEW.request_input_hash IS NOT OLD.request_input_hash
          OR NEW.owner_token IS NOT OLD.owner_token
          OR NEW.created_at != OLD.created_at
          OR (OLD.final_request_hash IS NOT NULL AND NEW.final_request_hash IS NOT OLD.final_request_hash)
          OR (OLD.prompt_cache_key IS NOT NULL AND NEW.prompt_cache_key IS NOT OLD.prompt_cache_key)
          OR (OLD.response_fingerprint IS NOT NULL AND NEW.response_fingerprint IS NOT OLD.response_fingerprint)
        BEGIN
          SELECT RAISE(ABORT, 'provider receipt binding is immutable');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER session_tool_request_receipt_response_guard
        BEFORE UPDATE OF response_fingerprint ON session_tool_request_receipt
        WHEN NEW.response_fingerprint IS NOT OLD.response_fingerprint AND (
          OLD.response_fingerprint IS NOT NULL OR
          NEW.response_fingerprint IS NULL OR
          OLD.provider_state NOT IN ('settled', 'failed')
        )
        BEGIN
          SELECT RAISE(ABORT, 'provider response fingerprint requires terminal receipt');
        END
      `)
      yield* tx.run(`
        CREATE INDEX session_tool_request_receipt_provider_state_idx
        ON session_tool_request_receipt (session_id, provider_state, created_at)
      `)
    })
  },
} satisfies DatabaseMigration.Migration
