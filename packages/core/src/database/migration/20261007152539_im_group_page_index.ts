import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261007152539_im_group_page_index",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`CREATE INDEX \`im_groups_page_idx\` ON \`im_groups\` (\`workspace_id\`,\`deleted_at\`,\`created_at\`,\`id\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
