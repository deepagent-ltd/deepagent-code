import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260923170344_session_input_revert_epoch",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session_input\` ADD \`revert_epoch\` integer;`)
    })
  },
} satisfies DatabaseMigration.Migration
