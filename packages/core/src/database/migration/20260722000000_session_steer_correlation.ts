import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260722000000_session_steer_correlation",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE session_steer ADD COLUMN correlation_id TEXT`)
      yield* tx.run(`
        CREATE UNIQUE INDEX IF NOT EXISTS session_steer_session_correlation_idx
        ON session_steer (session_id, correlation_id)
        WHERE correlation_id IS NOT NULL
      `)
    })
  },
} satisfies DatabaseMigration.Migration
