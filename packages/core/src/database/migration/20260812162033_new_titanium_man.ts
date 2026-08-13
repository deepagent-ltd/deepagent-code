import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260812162033_new_titanium_man",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`task_structured_output_evidence\` DROP COLUMN \`contract_hash\`;`)
      yield* tx.run(`ALTER TABLE \`task_structured_output_evidence\` DROP COLUMN \`raw_material_hash\`;`)
      yield* tx.run(`ALTER TABLE \`task_structured_output_evidence\` DROP COLUMN \`result_material_hash\`;`)
      yield* tx.run(`ALTER TABLE \`task_structured_output_evidence\` DROP COLUMN \`output_hash\`;`)
    })
  },
} satisfies DatabaseMigration.Migration
