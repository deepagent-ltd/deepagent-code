import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

// BUG-009: per-turn final-request receipt.
// One row per physical Provider dispatch, recording the tool candidate/filter/offer pipeline
// so failures can be attributed to a specific stage (registry, permission, adapter).
// This table intentionally does NOT duplicate Tool.Called/Success/Failed events; it relates
// to those events via (assistant_message_id, call_id).
export default {
  id: "20260806080000_session_tool_request_receipt",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE session_tool_request_receipt (
          receipt_id          TEXT NOT NULL PRIMARY KEY,
          request_ordinal     INTEGER NOT NULL CHECK (request_ordinal >= 1),
          session_id          TEXT NOT NULL,
          user_message_id     TEXT NOT NULL,
          assistant_message_id TEXT,
          provider_attempt_id TEXT,
          provider_id         TEXT NOT NULL,
          model_id            TEXT NOT NULL,
          protocol            TEXT,
          registry_tool_ids   TEXT NOT NULL,      -- JSON array of all registered tool IDs
          permission_filtered_tool_ids TEXT NOT NULL, -- JSON array after permission check
          final_offered_tool_ids TEXT NOT NULL,   -- JSON array in final wire request
          call_ids            TEXT NOT NULL DEFAULT '[]', -- JSON array of provider tool call IDs observed in this turn
          tool_definition_hash TEXT,              -- stable hash of offered schema bytes
          tool_choice_mode    TEXT,               -- "auto"|"required"|"none"|null
          adapter_tool_capability TEXT,           -- "supported"|"unsupported"|"unknown"
          adapter_lowering_outcome TEXT,          -- "ok"|"schema_rejected"|"omitted_no_support"
          estimated_input_tokens INTEGER,
          physical_input_budget INTEGER,
          reserved_output_tokens INTEGER,
          safety_margin_tokens INTEGER,
          context_limit_provenance TEXT,          -- "model_limit"|"host_guard"
          request_state       TEXT NOT NULL CHECK (request_state IN ('prepared','dispatched','rejected')),
          request_error_code  TEXT,
          created_at          INTEGER NOT NULL
        )
      `)
      yield* tx.run(
        `CREATE UNIQUE INDEX session_tool_request_receipt_session_ordinal_idx
           ON session_tool_request_receipt(session_id, request_ordinal)`,
      )
      yield* tx.run(
        `CREATE INDEX session_tool_request_receipt_session_idx ON session_tool_request_receipt(session_id, created_at)`,
      )
      yield* tx.run(
        `CREATE INDEX session_tool_request_receipt_msg_idx ON session_tool_request_receipt(assistant_message_id)`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
