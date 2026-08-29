import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260812140000_session_diff_manifest",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run("ALTER TABLE session ADD COLUMN summary_diff_manifest TEXT")
    })
  },
} satisfies DatabaseMigration.Migration
