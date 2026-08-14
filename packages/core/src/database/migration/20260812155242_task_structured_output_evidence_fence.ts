import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260812155242_task_structured_output_evidence_fence",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`task_structured_output_evidence\` ADD \`owner_token\` text NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`task_structured_output_evidence\` ADD \`claim_generation\` integer NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`task_structured_output_evidence\` ADD \`expected_version\` integer NOT NULL;`)
    })
  },
} satisfies DatabaseMigration.Migration
