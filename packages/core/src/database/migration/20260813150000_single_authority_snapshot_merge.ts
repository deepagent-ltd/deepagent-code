import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260813150000_single_authority_snapshot_merge",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        -- Merge the context-hardening and single-authority schema histories. Both
        -- branches have already applied their runtime migrations before this marker.
        SELECT 1;
      `)
    })
  },
} satisfies DatabaseMigration.Migration
