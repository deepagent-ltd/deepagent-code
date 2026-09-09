import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260909044401_session_delete_tombstone_retention_index",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`CREATE INDEX \`event_aggregate_tombstone_retention_idx\` ON \`event_aggregate_tombstone\` (\`retention_until\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
