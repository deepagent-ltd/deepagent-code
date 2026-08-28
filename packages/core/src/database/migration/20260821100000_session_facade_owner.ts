import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

/** Persist the process owner so a new facade service can recover rows left active by a dead process. */
export default {
  id: "20260821100000_session_facade_owner",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run("ALTER TABLE session_facade_activity ADD COLUMN owner_token text")
      yield* tx.run(
        "CREATE INDEX session_facade_activity_owner_idx ON session_facade_activity (owner_token, state, created_at)",
      )
      yield* tx.run(`
        CREATE TRIGGER session_facade_activity_owner_immutable
        BEFORE UPDATE OF owner_token ON session_facade_activity
        WHEN COALESCE(NEW.owner_token, '') != COALESCE(OLD.owner_token, '')
        BEGIN
          SELECT RAISE(ABORT, 'facade owner_token is immutable');
        END
      `)
    })
  },
} satisfies DatabaseMigration.Migration
