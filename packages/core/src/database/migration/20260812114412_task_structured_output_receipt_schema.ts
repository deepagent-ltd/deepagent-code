import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260812114412_task_structured_output_receipt_schema",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`task_run\` ADD \`structured_output_receipt\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
