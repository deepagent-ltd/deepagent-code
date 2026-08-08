import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

// BUG-010: bounded evidence for each layer of the Provider argument pipeline.
// The table deliberately excludes raw payloads; payload_hash/length/keys are enough
// to correlate a damaged argument without persisting prompts, files, or secrets.
export default {
  id: "20260807090000_session_tool_argument_receipt",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE session_tool_argument_receipt (
          receipt_id        TEXT NOT NULL,
          layer             TEXT NOT NULL CHECK (layer IN ('raw_frame','ai_sdk_input','adapter_assembly','processor_decoded')),
          ordinal           INTEGER NOT NULL CHECK (ordinal >= 0),
          call_id           TEXT,
          tool_name         TEXT,
          event_type        TEXT NOT NULL,
          payload_hash      TEXT,
          payload_length    INTEGER CHECK (payload_length IS NULL OR payload_length >= 0),
          payload_keys      TEXT NOT NULL,
          unavailable_reason TEXT,
          created_at        INTEGER NOT NULL,
          PRIMARY KEY (receipt_id, layer, ordinal),
          FOREIGN KEY (receipt_id) REFERENCES session_tool_request_receipt(receipt_id) ON DELETE CASCADE,
          CHECK (call_id IS NULL OR length(trim(call_id)) > 0),
          CHECK (tool_name IS NULL OR length(trim(tool_name)) > 0),
          CHECK (
            (payload_hash IS NOT NULL AND length(payload_hash) = 64 AND payload_length IS NOT NULL AND unavailable_reason IS NULL)
            OR
            (payload_hash IS NULL AND payload_length IS NULL AND unavailable_reason IS NOT NULL AND length(trim(unavailable_reason)) > 0)
          )
        )
      `)
      yield* tx.run(
        `CREATE INDEX session_tool_argument_receipt_call_idx
           ON session_tool_argument_receipt(receipt_id, call_id, layer, ordinal)`,
      )
      yield* tx.run(
        `CREATE INDEX session_tool_argument_receipt_created_idx
           ON session_tool_argument_receipt(created_at)`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
