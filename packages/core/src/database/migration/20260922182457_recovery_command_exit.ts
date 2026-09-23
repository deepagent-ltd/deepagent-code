import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260922182457_recovery_command_exit",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`recovery_command\` ADD \`command_kind\` text;`)
      yield* tx.run(`ALTER TABLE \`recovery_command\` ADD \`evidence\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
