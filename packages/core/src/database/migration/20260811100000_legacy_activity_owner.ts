import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260811100000_legacy_activity_owner",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        ALTER TABLE session_legacy_activity
        ADD COLUMN owner_token TEXT NOT NULL DEFAULT 'pre-owner-migration'
      `)
      yield* tx.run(`DROP TRIGGER session_legacy_activity_legal_update`)
      yield* tx.run(`
        CREATE TRIGGER session_legacy_activity_legal_update
        BEFORE UPDATE ON session_legacy_activity
        WHEN NEW.activity_id != OLD.activity_id
          OR NEW.session_id != OLD.session_id
          OR NEW.ordinal != OLD.ordinal
          OR NEW.trigger_admission_id != OLD.trigger_admission_id
          OR NEW.owner_token != OLD.owner_token
          OR NEW.created_at != OLD.created_at
          OR OLD.state != 'active'
          OR NEW.state NOT IN ('settled', 'failed', 'interrupted', 'recovery_required')
          OR NEW.settled_at IS NULL
          OR NEW.terminal_reason IS NULL
        BEGIN
          SELECT RAISE(ABORT, 'illegal session_legacy_activity transition');
        END
      `)
    })
  },
} satisfies DatabaseMigration.Migration
