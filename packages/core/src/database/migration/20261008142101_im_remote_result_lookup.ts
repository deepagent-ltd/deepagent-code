import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261008142101_im_remote_result_lookup",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`CREATE INDEX \`im_kernel_delivery_result_lookup_idx\` ON \`im_kernel_delivery\` (\`kernel_message_id\`,\`state\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
