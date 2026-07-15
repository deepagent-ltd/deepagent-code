import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

/**
 * Migration: IM file attachments (§B3 文件上传 / §B4 im_attachments)
 *
 * A file record is decoupled from a message: `message_id` is nullable so a file can exist before, or
 * without, any message. `storage_path` is a server-derived absolute path on local disk (never the
 * client filename). `checksum` is the sha256 hex digest of the stored bytes. Soft delete via
 * `deleted_at` matches the rest of the IM schema.
 */
export default {
  id: "20260711080000_im_attachments",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`im_attachments\` (
          \`id\` text PRIMARY KEY NOT NULL,
          \`workspace_id\` text NOT NULL,
          \`project_id\` text,
          \`group_id\` text,
          \`message_id\` text,
          \`uploaded_by\` text NOT NULL,
          \`storage_path\` text NOT NULL,
          \`filename\` text NOT NULL,
          \`mime\` text NOT NULL,
          \`size_bytes\` integer NOT NULL,
          \`checksum\` text NOT NULL,
          \`created_at\` integer NOT NULL,
          \`deleted_at\` integer,
          FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
      `)

      yield* tx.run(`
        CREATE INDEX IF NOT EXISTS \`idx_im_attachments_workspace\`
        ON \`im_attachments\` (\`workspace_id\`, \`created_at\`);
      `)
      yield* tx.run(`
        CREATE INDEX IF NOT EXISTS \`idx_im_attachments_message\`
        ON \`im_attachments\` (\`message_id\`);
      `)
      yield* tx.run(`
        CREATE INDEX IF NOT EXISTS \`idx_im_attachments_group\`
        ON \`im_attachments\` (\`group_id\`);
      `)
    })
  },
} satisfies DatabaseMigration.Migration
