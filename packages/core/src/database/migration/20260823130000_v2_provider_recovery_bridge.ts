import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

// V2 recovery bridge: links an explicit recovery resolution to the indeterminate V2 receipt and the
// command that authorized the recovery. The bridge is created AFTER resolve() records the decision;
// it is only valid when the attempt state already records that exact decision and the bound receipt
// is still indeterminate. A resolved attempt is only trustworthy through the resolution + bridge
// pair, never through its state alone.
export default {
  id: "20260823130000_v2_provider_recovery_bridge",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE session_v2_provider_recovery_bridge (
          resolution_id TEXT NOT NULL PRIMARY KEY,
          attempt_id TEXT NOT NULL UNIQUE
            REFERENCES session_provider_attempt(attempt_id) ON DELETE CASCADE,
          receipt_id TEXT NOT NULL UNIQUE
            REFERENCES session_v2_provider_turn_receipt(receipt_id) ON DELETE CASCADE,
          command_id TEXT NOT NULL UNIQUE,
          created_at INTEGER NOT NULL
        )
      `)
      yield* tx.run(`
        CREATE TRIGGER session_v2_provider_recovery_bridge_validate_insert
        BEFORE INSERT ON session_v2_provider_recovery_bridge
        BEGIN
          SELECT CASE WHEN NOT EXISTS (
            SELECT 1
            FROM session_v2_provider_turn_receipt receipt
            JOIN session_provider_attempt attempt
              ON attempt.attempt_id = receipt.provider_attempt_id
            JOIN session_provider_attempt_resolution resolution
              ON resolution.resolution_id = NEW.resolution_id
              AND resolution.attempt_id = attempt.attempt_id
            WHERE receipt.receipt_id = NEW.receipt_id
              AND receipt.provider_attempt_id = NEW.attempt_id
              AND receipt.state = 'indeterminate_after_crash'
              AND attempt.session_id = receipt.session_id
              AND attempt.state = 'resolved_' || resolution.decision
          ) THEN RAISE(ABORT, 'v2_provider_recovery_bridge_authority_invalid') END;
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER session_v2_provider_recovery_bridge_immutable_update
        BEFORE UPDATE ON session_v2_provider_recovery_bridge
        BEGIN
          SELECT RAISE(ABORT, 'v2_provider_recovery_bridge_immutable');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER session_v2_provider_recovery_bridge_immutable_delete
        BEFORE DELETE ON session_v2_provider_recovery_bridge
        WHEN EXISTS (
          SELECT 1
          FROM session_v2_provider_turn_receipt receipt
          JOIN session ON session.id = receipt.session_id
          WHERE receipt.receipt_id = OLD.receipt_id
        )
        BEGIN
          SELECT RAISE(ABORT, 'v2_provider_recovery_bridge_immutable');
        END
      `)
    })
  },
} satisfies DatabaseMigration.Migration
