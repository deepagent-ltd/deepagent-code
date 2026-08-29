import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

// Capability port §16.3 order 1: tool effects gain a durable terminal authority bound to the
// provider attempt/receipt that offered them. Rows are admitted only in a terminal state, are
// immutable, and are append-only, so the table is trustworthy evidence for watermark proofs
// ("zero mutating tool effect after X") and for recovery classification.
export default {
  id: "20260825090000_v2_tool_effect_authority",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS session_v2_tool_effect (
          effect_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          provider_attempt_id TEXT NOT NULL,
          receipt_id TEXT NOT NULL,
          tool_call_id TEXT NOT NULL,
          tool_name TEXT NOT NULL,
          effect_kind TEXT NOT NULL,
          state TEXT NOT NULL,
          outcome_hash TEXT NOT NULL,
          error_code TEXT,
          owner_token TEXT NOT NULL,
          time_created INTEGER NOT NULL
        )
      `)
      yield* tx.run(`
        CREATE UNIQUE INDEX IF NOT EXISTS session_v2_tool_effect_call_idx
        ON session_v2_tool_effect (receipt_id, tool_call_id)
      `)
      yield* tx.run(`
        CREATE INDEX IF NOT EXISTS session_v2_tool_effect_session_idx
        ON session_v2_tool_effect (session_id, time_created)
      `)
      yield* tx.run(`
        CREATE TRIGGER IF NOT EXISTS session_v2_tool_effect_insert_guard
        BEFORE INSERT ON session_v2_tool_effect
        WHEN length(trim(NEW.effect_id)) = 0
          OR length(trim(NEW.session_id)) = 0
          OR length(trim(NEW.provider_attempt_id)) = 0
          OR length(trim(NEW.receipt_id)) = 0
          OR length(trim(NEW.tool_call_id)) = 0
          OR length(trim(NEW.tool_name)) = 0
          OR NEW.effect_kind NOT IN ('mutating', 'read_only')
          OR NEW.state NOT IN ('settled', 'failed')
          OR (NEW.state = 'failed' AND (NEW.error_code IS NULL OR length(trim(NEW.error_code)) = 0))
          OR (NEW.state = 'settled' AND NEW.error_code IS NOT NULL)
          OR length(NEW.outcome_hash) != 64
          OR NEW.outcome_hash GLOB '*[^0-9a-f]*'
          OR length(trim(NEW.owner_token)) = 0
        BEGIN
          SELECT RAISE(ABORT, 'invalid v2 tool effect');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER IF NOT EXISTS session_v2_tool_effect_update_guard
        BEFORE UPDATE ON session_v2_tool_effect
        BEGIN
          SELECT RAISE(ABORT, 'v2 tool effect is immutable');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER IF NOT EXISTS session_v2_tool_effect_delete_guard
        BEFORE DELETE ON session_v2_tool_effect
        BEGIN
          SELECT RAISE(ABORT, 'v2 tool effect is append only');
        END
      `)
    })
  },
} satisfies DatabaseMigration.Migration
