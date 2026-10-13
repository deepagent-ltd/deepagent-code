import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261007143308_im_reader_action_lookup",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`CREATE INDEX \`im_kernel_reader_read_intent_lookup_idx\` ON \`im_kernel_reader_read_intent\` (\`reader_key\`,\`binding_key\`,\`projection_key\`,\`created_at\`,\`cut_index\`,\`action_id\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
