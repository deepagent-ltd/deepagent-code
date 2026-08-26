import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260823100000_v2_provider_turn_identity",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE session_v2_provider_turn_receipt ADD COLUMN activity_id TEXT`)
      yield* tx.run(`ALTER TABLE session_v2_provider_turn_receipt ADD COLUMN provider_turn_seq INTEGER`)
      yield* tx.run(`
        UPDATE session_v2_provider_turn_receipt
        SET activity_id = 'legacy:' || session_id,
            provider_turn_seq = request_ordinal
        WHERE activity_id IS NULL OR provider_turn_seq IS NULL
      `)
      yield* tx.run(`
        CREATE UNIQUE INDEX session_v2_provider_turn_receipt_activity_turn_idx
        ON session_v2_provider_turn_receipt (session_id, activity_id, provider_turn_seq)
      `)
      yield* tx.run(`
        CREATE TRIGGER session_v2_provider_turn_receipt_identity_insert_guard
        BEFORE INSERT ON session_v2_provider_turn_receipt
        WHEN NEW.activity_id IS NULL
          OR length(trim(NEW.activity_id)) = 0
          OR NEW.provider_turn_seq IS NULL
          OR NEW.provider_turn_seq < 1
        BEGIN
          SELECT RAISE(ABORT, 'v2 provider turn identity is required');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER session_v2_provider_turn_receipt_identity_update_guard
        BEFORE UPDATE ON session_v2_provider_turn_receipt
        WHEN NEW.activity_id IS NOT OLD.activity_id
          OR NEW.provider_turn_seq IS NOT OLD.provider_turn_seq
        BEGIN
          SELECT RAISE(ABORT, 'v2 provider turn identity is immutable');
        END
      `)
    })
  },
} satisfies DatabaseMigration.Migration
