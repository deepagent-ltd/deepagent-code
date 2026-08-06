import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260806060000_session_mutation_epoch",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run("ALTER TABLE session ADD COLUMN mutation_epoch INTEGER NOT NULL DEFAULT 0")
      yield* tx.run("ALTER TABLE session_intent ADD COLUMN mutation_epoch INTEGER NOT NULL DEFAULT 0")
      yield* tx.run("ALTER TABLE session_steer ADD COLUMN mutation_epoch INTEGER NOT NULL DEFAULT 0")
      yield* tx.run("ALTER TABLE session_steer ADD COLUMN superseded_at INTEGER")
      yield* tx.run(`
        CREATE INDEX session_steer_session_epoch_pending_idx
        ON session_steer (session_id, mutation_epoch, delivery, consumed_seq, superseded_at, seq)
      `)
    })
  },
} satisfies DatabaseMigration.Migration
