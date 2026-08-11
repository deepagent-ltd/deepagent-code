import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260810110000_fork_side_effect_receipt",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run("ALTER TABLE session_fork_intent ADD COLUMN side_effects_completed_at INTEGER")
      yield* tx.run(`
        CREATE INDEX session_fork_intent_side_effects_idx
        ON session_fork_intent (state, side_effects_completed_at)
      `)
      yield* tx.run(`
        CREATE TRIGGER session_fork_intent_side_effects_insert_validate
        BEFORE INSERT ON session_fork_intent
        WHEN NEW.side_effects_completed_at IS NOT NULL
        BEGIN
          SELECT RAISE(ABORT, 'session_fork_intent_side_effects_insert_forbidden');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER session_fork_intent_side_effects_validate
        BEFORE UPDATE OF side_effects_completed_at ON session_fork_intent
        WHEN NEW.side_effects_completed_at IS NOT NULL AND NEW.state != 'complete'
        BEGIN
          SELECT RAISE(ABORT, 'session_fork_intent_side_effects_before_complete');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER session_fork_intent_side_effects_immutable
        BEFORE UPDATE OF side_effects_completed_at ON session_fork_intent
        WHEN OLD.side_effects_completed_at IS NOT NULL AND
          NEW.side_effects_completed_at IS NOT OLD.side_effects_completed_at
        BEGIN
          SELECT RAISE(ABORT, 'session_fork_intent_side_effects_immutable');
        END
      `)
    })
  },
} satisfies DatabaseMigration.Migration
