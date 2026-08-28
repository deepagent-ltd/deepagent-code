import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

// Capability port §16.3 order 1 (permission): a V2 tool effect row binds the permission effect
// grant that authorized the call, making the effect row the single durable terminal evidence for
// "permitted AND executed". Grant columns are all-or-nothing: either the whole grant identity is
// recorded or the row is grant-less (compositions without the V2 permission capability).
export default {
  id: "20260825120000_v2_tool_effect_permission_grant",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE session_v2_tool_effect ADD COLUMN grant_receipt_id TEXT`)
      yield* tx.run(`ALTER TABLE session_v2_tool_effect ADD COLUMN grant_owner_id TEXT`)
      yield* tx.run(`ALTER TABLE session_v2_tool_effect ADD COLUMN grant_state TEXT`)
      yield* tx.run(`ALTER TABLE session_v2_tool_effect ADD COLUMN grant_version INTEGER`)
      yield* tx.run(`DROP TRIGGER IF EXISTS session_v2_tool_effect_insert_guard`)
      yield* tx.run(`
        CREATE TRIGGER session_v2_tool_effect_insert_guard
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
          OR (
            (NEW.grant_receipt_id IS NULL) != (NEW.grant_owner_id IS NULL)
            OR (NEW.grant_receipt_id IS NULL) != (NEW.grant_state IS NULL)
            OR (NEW.grant_receipt_id IS NULL) != (NEW.grant_version IS NULL)
          )
          OR (NEW.grant_state IS NOT NULL AND NEW.grant_state NOT IN ('started', 'settled', 'unknown'))
          OR (NEW.grant_receipt_id IS NOT NULL AND length(trim(NEW.grant_receipt_id)) = 0)
          OR (NEW.grant_owner_id IS NOT NULL AND length(trim(NEW.grant_owner_id)) = 0)
          OR (NEW.grant_version IS NOT NULL AND NEW.grant_version < 0)
        BEGIN
          SELECT RAISE(ABORT, 'invalid v2 tool effect');
        END
      `)
    })
  },
} satisfies DatabaseMigration.Migration
