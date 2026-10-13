import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261005005816_im_kernel_sync",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`im_sync_cursors\` (
          \`conversation_id\` text PRIMARY KEY,
          \`last_sync_time\` integer NOT NULL,
          \`last_sync_seq\` integer,
          \`updated_at\` integer NOT NULL
        );
      `)
      yield* tx.run(`ALTER TABLE \`im_groups\` ADD \`kernel_conv_id\` text;`)
      yield* tx.run(`ALTER TABLE \`im_messages\` ADD \`kernel_msg_id\` text;`)
      yield* tx.run(`CREATE UNIQUE INDEX \`idx_im_groups_kernel_conv\` ON \`im_groups\` (\`kernel_conv_id\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`idx_im_messages_kernel_msg\` ON \`im_messages\` (\`kernel_msg_id\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
