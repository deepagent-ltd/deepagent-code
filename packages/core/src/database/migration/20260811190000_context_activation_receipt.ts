import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260811190000_context_activation_receipt",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run("ALTER TABLE session_tool_request_receipt ADD COLUMN context_selection_id TEXT")
      yield* tx.run("ALTER TABLE session_tool_request_receipt ADD COLUMN context_eligibility TEXT")
      yield* tx.run("ALTER TABLE session_tool_request_receipt ADD COLUMN context_readiness TEXT")
      yield* tx.run("ALTER TABLE session_tool_request_receipt ADD COLUMN context_activation TEXT")
      yield* tx.run("ALTER TABLE session_tool_request_receipt ADD COLUMN context_activation_fingerprint TEXT")
      yield* tx.run(`
        CREATE INDEX session_tool_request_receipt_context_selection_idx
        ON session_tool_request_receipt (context_selection_id)
        WHERE context_selection_id IS NOT NULL
      `)
      yield* tx.run("DROP TRIGGER IF EXISTS session_tool_request_receipt_dispatch_guard")
      yield* tx.run(`
        CREATE TRIGGER session_tool_request_receipt_dispatch_guard
        BEFORE UPDATE OF provider_state ON session_tool_request_receipt
        WHEN NEW.provider_state = 'dispatching' AND (
          NEW.final_request_hash IS NULL OR
          NEW.adapter_prepared_at IS NULL OR
          NEW.prompt_epoch IS NULL OR
          NEW.prompt_window_id IS NULL OR
          NEW.effective_history_hash IS NULL OR
          NEW.context_eligibility IS NULL OR
          json_valid(NEW.context_eligibility) != 1 OR
          NEW.context_readiness IS NULL OR
          json_valid(NEW.context_readiness) != 1 OR
          NEW.context_activation IS NULL OR
          json_valid(NEW.context_activation) != 1 OR
          NEW.context_activation_fingerprint IS NULL OR
          length(NEW.context_activation_fingerprint) != 64 OR
          NEW.context_activation_fingerprint GLOB '*[^0-9a-f]*'
        )
        BEGIN
          SELECT RAISE(ABORT, 'provider dispatch requires final request and context activation authority');
        END
      `)
      yield* tx.run("DROP TRIGGER IF EXISTS session_tool_request_receipt_binding_immutable")
      yield* tx.run(`
        CREATE TRIGGER session_tool_request_receipt_binding_immutable
        BEFORE UPDATE ON session_tool_request_receipt
        WHEN NEW.receipt_id != OLD.receipt_id
          OR NEW.request_ordinal != OLD.request_ordinal
          OR NEW.session_id != OLD.session_id
          OR NEW.user_message_id != OLD.user_message_id
          OR NEW.assistant_message_id IS NOT OLD.assistant_message_id
          OR NEW.provider_attempt_id IS NOT OLD.provider_attempt_id
          OR NEW.provider_id != OLD.provider_id
          OR NEW.model_id != OLD.model_id
          OR NEW.protocol IS NOT OLD.protocol
          OR NEW.context_selection_id IS NOT OLD.context_selection_id
          OR NEW.context_eligibility IS NOT OLD.context_eligibility
          OR NEW.context_readiness IS NOT OLD.context_readiness
          OR NEW.context_activation IS NOT OLD.context_activation
          OR NEW.context_activation_fingerprint IS NOT OLD.context_activation_fingerprint
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
    })
  },
} satisfies DatabaseMigration.Migration
