import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260907020000_session_interrupt_barrier",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session\` ADD \`interrupt_seq\` integer;`)
    })
  },
} satisfies DatabaseMigration.Migration
