import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260811223000_prepared_provider_turn_receipt",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        ALTER TABLE session_tool_request_receipt ADD COLUMN prepared_turn_hash TEXT
        CHECK (prepared_turn_hash IS NULL OR (
          length(prepared_turn_hash) = 64 AND
          prepared_turn_hash NOT GLOB '*[^0-9a-f]*'
        ))
      `)
      yield* tx.run(`
        ALTER TABLE session_tool_request_receipt ADD COLUMN system_stable_hash TEXT
        CHECK (system_stable_hash IS NULL OR (
          length(system_stable_hash) = 64 AND
          system_stable_hash NOT GLOB '*[^0-9a-f]*'
        ))
      `)
      yield* tx.run(`
        ALTER TABLE session_tool_request_receipt ADD COLUMN system_volatile_hash TEXT
        CHECK (system_volatile_hash IS NULL OR (
          length(system_volatile_hash) = 64 AND
          system_volatile_hash NOT GLOB '*[^0-9a-f]*'
        ))
      `)
      yield* tx.run(`
        ALTER TABLE session_tool_request_receipt ADD COLUMN wire_request_hash TEXT
        CHECK (wire_request_hash IS NULL OR (
          length(wire_request_hash) = 64 AND
          wire_request_hash NOT GLOB '*[^0-9a-f]*'
        ))
      `)
      yield* tx.run(`
        ALTER TABLE session_tool_request_receipt ADD COLUMN tool_result_reference_ids TEXT NOT NULL DEFAULT '[]'
        CHECK (
          json_valid(tool_result_reference_ids) = 1 AND
          json_type(tool_result_reference_ids) = 'array'
        )
      `)
      yield* tx.run(`
        ALTER TABLE session_tool_request_receipt ADD COLUMN tool_result_reference_count INTEGER NOT NULL DEFAULT 0
        CHECK (tool_result_reference_count >= 0)
      `)

      yield* tx.run("DROP TRIGGER IF EXISTS session_tool_request_receipt_dispatch_guard")
      yield* tx.run(`
        CREATE TRIGGER session_tool_request_receipt_dispatch_guard
        BEFORE UPDATE OF provider_state ON session_tool_request_receipt
        WHEN NEW.provider_state IN ('prepared', 'dispatching') AND (
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
          NEW.context_activation_fingerprint GLOB '*[^0-9a-f]*' OR
          ${invalidPreparedTurn("NEW")}
        )
        BEGIN
          SELECT RAISE(ABORT, 'provider preparation and dispatch require a durable prepared turn');
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
          OR (OLD.provider_request_hash IS NOT NULL AND NEW.provider_request_hash IS NOT OLD.provider_request_hash)
          OR (OLD.adapter_prepared_at IS NOT NULL AND NEW.adapter_prepared_at IS NOT OLD.adapter_prepared_at)
          OR (OLD.prompt_cache_key IS NOT NULL AND NEW.prompt_cache_key IS NOT OLD.prompt_cache_key)
          OR (OLD.tool_definition_hash IS NOT NULL AND NEW.tool_definition_hash IS NOT OLD.tool_definition_hash)
          OR (OLD.response_fingerprint IS NOT NULL AND NEW.response_fingerprint IS NOT OLD.response_fingerprint)
          OR (OLD.prepared_turn_hash IS NOT NULL AND NEW.prepared_turn_hash IS NOT OLD.prepared_turn_hash)
          OR (OLD.prepared_turn_hash IS NOT NULL AND NEW.system_stable_hash IS NOT OLD.system_stable_hash)
          OR (OLD.prepared_turn_hash IS NOT NULL AND NEW.system_volatile_hash IS NOT OLD.system_volatile_hash)
          OR (OLD.prepared_turn_hash IS NOT NULL AND NEW.wire_request_hash IS NOT OLD.wire_request_hash)
          OR (OLD.prepared_turn_hash IS NOT NULL AND NEW.tool_result_reference_ids IS NOT OLD.tool_result_reference_ids)
          OR (OLD.prepared_turn_hash IS NOT NULL AND NEW.tool_result_reference_count IS NOT OLD.tool_result_reference_count)
        BEGIN
          SELECT RAISE(ABORT, 'provider receipt binding is immutable');
        END
      `)

      yield* tx.run(`
        CREATE TRIGGER session_tool_request_receipt_prepared_turn_insert_guard
        BEFORE INSERT ON session_tool_request_receipt
        WHEN NEW.final_request_hash IS NOT NULL
          OR NEW.provider_request_hash IS NOT NULL
          OR NEW.adapter_prepared_at IS NOT NULL
          OR NEW.prompt_cache_key IS NOT NULL
          OR NEW.tool_definition_hash IS NOT NULL
          OR NEW.final_offered_tool_ids != '[]'
          OR NEW.prepared_turn_hash IS NOT NULL
          OR NEW.system_stable_hash IS NOT NULL
          OR NEW.system_volatile_hash IS NOT NULL
          OR NEW.wire_request_hash IS NOT NULL
          OR NEW.tool_result_reference_ids != '[]'
          OR NEW.tool_result_reference_count != 0
        BEGIN
          SELECT RAISE(ABORT, 'prepared provider turn must be sealed after receipt admission');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER session_tool_request_receipt_prepared_turn_seal
        BEFORE UPDATE OF
          final_request_hash,
          provider_request_hash,
          adapter_prepared_at,
          prompt_cache_key,
          final_offered_tool_ids,
          tool_definition_hash,
          prepared_turn_hash,
          system_stable_hash,
          system_volatile_hash,
          wire_request_hash,
          tool_result_reference_ids,
          tool_result_reference_count
        ON session_tool_request_receipt
        WHEN (
          NEW.final_request_hash IS NOT OLD.final_request_hash OR
          NEW.provider_request_hash IS NOT OLD.provider_request_hash OR
          NEW.adapter_prepared_at IS NOT OLD.adapter_prepared_at OR
          NEW.prompt_cache_key IS NOT OLD.prompt_cache_key OR
          NEW.final_offered_tool_ids IS NOT OLD.final_offered_tool_ids OR
          NEW.tool_definition_hash IS NOT OLD.tool_definition_hash OR
          NEW.prepared_turn_hash IS NOT OLD.prepared_turn_hash OR
          NEW.system_stable_hash IS NOT OLD.system_stable_hash OR
          NEW.system_volatile_hash IS NOT OLD.system_volatile_hash OR
          NEW.wire_request_hash IS NOT OLD.wire_request_hash OR
          NEW.tool_result_reference_ids IS NOT OLD.tool_result_reference_ids OR
          NEW.tool_result_reference_count IS NOT OLD.tool_result_reference_count
        ) AND NOT (
          OLD.provider_state = 'preparing' AND
          NEW.provider_state = 'prepared' AND
          OLD.final_request_hash IS NULL AND
          OLD.provider_request_hash IS NULL AND
          OLD.adapter_prepared_at IS NULL AND
          OLD.prompt_cache_key IS NULL AND
          OLD.final_offered_tool_ids = '[]' AND
          OLD.tool_definition_hash IS NULL AND
          OLD.prepared_turn_hash IS NULL AND
          OLD.system_stable_hash IS NULL AND
          OLD.system_volatile_hash IS NULL AND
          OLD.wire_request_hash IS NULL AND
          OLD.tool_result_reference_ids = '[]' AND
          OLD.tool_result_reference_count = 0 AND
          NOT ${invalidPreparedTurn("NEW")}
        )
        BEGIN
          SELECT RAISE(ABORT, 'prepared provider turn may only be sealed once during adapter preparation');
        END
      `)
    })
  },
} satisfies DatabaseMigration.Migration

function invalidPreparedTurn(row: string) {
  return `(
    ${invalidHash(`${row}.prepared_turn_hash`)} OR
    ${invalidHash(`${row}.system_stable_hash`)} OR
    ${invalidHash(`${row}.system_volatile_hash`)} OR
    ${invalidHash(`${row}.wire_request_hash`)} OR
    ${row}.wire_request_hash IS NOT ${row}.final_request_hash OR
    ${row}.provider_request_hash IS NOT ${row}.final_request_hash OR
    ${row}.adapter_prepared_at IS NULL OR
    ${invalidHash(`${row}.tool_definition_hash`)} OR
    json_valid(${row}.final_offered_tool_ids) != 1 OR
    json_type(${row}.final_offered_tool_ids) != 'array' OR
    EXISTS (
      SELECT 1
      FROM json_each(${row}.final_offered_tool_ids) offered_tool
      WHERE offered_tool.type != 'text' OR offered_tool.value = ''
    ) OR
    (SELECT count(*) FROM json_each(${row}.final_offered_tool_ids)) !=
      (SELECT count(DISTINCT offered_tool.value) FROM json_each(${row}.final_offered_tool_ids) offered_tool) OR
    json_valid(${row}.tool_result_reference_ids) != 1 OR
    json_type(${row}.tool_result_reference_ids) != 'array' OR
    ${row}.tool_result_reference_count != json_array_length(${row}.tool_result_reference_ids) OR
    EXISTS (
      SELECT 1
      FROM json_each(${row}.tool_result_reference_ids) reference
      WHERE reference.type != 'text' OR reference.value = ''
    ) OR
    (SELECT count(*) FROM json_each(${row}.tool_result_reference_ids)) !=
      (SELECT count(DISTINCT reference.value) FROM json_each(${row}.tool_result_reference_ids) reference)
  )`
}

function invalidHash(value: string) {
  return `(
    ${value} IS NULL OR
    length(${value}) != 64 OR
    ${value} GLOB '*[^0-9a-f]*'
  )`
}
