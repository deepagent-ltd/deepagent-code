import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260823110000_v2_provider_attempt_binding",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        ALTER TABLE session_v2_provider_turn_receipt
        ADD COLUMN provider_attempt_id TEXT REFERENCES session_provider_attempt(attempt_id)
      `)
      yield* tx.run(`
        CREATE UNIQUE INDEX session_v2_provider_turn_receipt_attempt_idx
        ON session_v2_provider_turn_receipt (provider_attempt_id)
        WHERE provider_attempt_id IS NOT NULL
      `)
      yield* tx.run(`
        CREATE TRIGGER session_v2_provider_turn_receipt_attempt_binding_guard
        BEFORE UPDATE OF provider_attempt_id ON session_v2_provider_turn_receipt
        WHEN OLD.provider_attempt_id IS NOT NULL
          OR NEW.provider_attempt_id IS NULL
          OR NOT EXISTS (
            SELECT 1 FROM session_provider_attempt attempt
            WHERE attempt.attempt_id = NEW.provider_attempt_id
              AND attempt.session_id = NEW.session_id
              AND attempt.activity_id = NEW.activity_id
              AND attempt.provider_turn_seq = NEW.provider_turn_seq
              AND attempt.provider_id = NEW.provider_id
              AND attempt.owner_token = NEW.owner_token
              AND attempt.request_hash = NEW.request_input_hash
          )
        BEGIN
          SELECT RAISE(ABORT, 'invalid v2 provider attempt binding');
        END
      `)
    })
  },
} satisfies DatabaseMigration.Migration
