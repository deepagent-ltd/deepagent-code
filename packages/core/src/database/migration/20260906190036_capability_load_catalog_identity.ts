import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260906190036_capability_load_catalog_identity",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`DROP INDEX IF EXISTS \`session_capability_load_session_capability_body_idx\`;`)
      yield* tx.run(`CREATE UNIQUE INDEX \`session_capability_load_snapshot_capability_body_idx\` ON \`session_capability_load\` (\`session_id\`,\`catalog_snapshot_id\`,\`capability_id\`,\`body_hash\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
