import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261005162725_im_delivery_authority",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`im_mention_intent\` (
          \`id\` text PRIMARY KEY,
          \`message_id\` text NOT NULL,
          \`agent_name\` text NOT NULL,
          \`directory\` text NOT NULL,
          \`workspace_id\` text NOT NULL,
          \`user_id\` text NOT NULL,
          \`origin\` text NOT NULL,
          \`receiver_id\` text,
          \`conversation_type\` integer,
          \`conversation_id\` text,
          \`resolved_agent\` text,
          \`session_id\` text,
          \`input_id\` text,
          \`status\` text DEFAULT 'pending' NOT NULL,
          \`last_error\` text,
          \`created_at\` integer NOT NULL,
          \`updated_at\` integer NOT NULL,
          CONSTRAINT \`fk_im_mention_intent_message_id_im_messages_id_fk\` FOREIGN KEY (\`message_id\`) REFERENCES \`im_messages\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`ALTER TABLE \`im_messages\` ADD \`client_request_id\` text;`)
      yield* tx.run(`CREATE UNIQUE INDEX \`im_mention_intent_source_agent\` ON \`im_mention_intent\` (\`message_id\`,\`agent_name\`);`)
      yield* tx.run(`CREATE INDEX \`im_mention_intent_pending\` ON \`im_mention_intent\` (\`origin\`,\`status\`,\`receiver_id\`,\`updated_at\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`idx_im_messages_client_request\` ON \`im_messages\` (\`sender_id\`,\`client_request_id\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
