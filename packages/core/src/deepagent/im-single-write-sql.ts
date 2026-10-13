// Historical DDL helper imported by the immutable migration registry; no execution API.
import { Effect } from "effect"
import type { DatabaseMigration } from "../database/migration"

/** Idempotent migration that creates the IM single-write receipt ledger. */
export const imSingleWriteMigration: DatabaseMigration.Migration = {
  id: "20260829010000_deepagent_im_single_write",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`deepagent_im_single_write\` (
          \`im_message_id\` text PRIMARY KEY,
          \`event_ref\` text NOT NULL,
          \`owner_id\` text NOT NULL,
          \`generation\` integer NOT NULL,
          \`receipt_ref\` text NOT NULL,
          \`status\` text NOT NULL,
          \`created_at\` integer NOT NULL,
          \`updated_at\` integer NOT NULL,
          CONSTRAINT \`deepagent_im_single_write_status_check\` CHECK(\`status\` IN ('single_written', 'refused'))
        );
      `)
      yield* tx.run(`
        CREATE INDEX IF NOT EXISTS \`deepagent_im_single_write_event_idx\` ON \`deepagent_im_single_write\`(\`event_ref\`);
      `)
      yield* tx.run(`
        CREATE INDEX IF NOT EXISTS \`deepagent_im_single_write_owner_idx\` ON \`deepagent_im_single_write\`(\`owner_id\`);
      `)
    })
  },
}
