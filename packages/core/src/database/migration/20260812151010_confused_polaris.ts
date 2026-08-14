import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260812151010_confused_polaris",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_activity_permission_effect_dispatch\` (
          \`receipt_id\` text PRIMARY KEY,
          \`request_id\` text NOT NULL,
          \`activity_kind\` text NOT NULL,
          \`activity_id\` text NOT NULL,
          \`session_id\` text NOT NULL,
          \`project_id\` text NOT NULL,
          \`workspace_id\` text,
          \`tool_message_id\` text NOT NULL,
          \`tool_call_id\` text NOT NULL,
          \`tool_name\` text NOT NULL,
          \`consumer_id\` text NOT NULL,
          \`idempotency_key\` text NOT NULL,
          \`owner_id\` text NOT NULL,
          \`state\` text NOT NULL,
          \`version\` integer NOT NULL,
          \`outcome\` text,
          \`result_json\` text,
          \`result_hash\` text,
          \`started_at\` integer NOT NULL,
          \`settled_at\` integer,
          CONSTRAINT \`fk_session_activity_permission_effect_dispatch_request_id_session_activity_permission_request_request_id_fk\` FOREIGN KEY (\`request_id\`) REFERENCES \`session_activity_permission_request\`(\`request_id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_session_activity_permission_effect_dispatch_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_session_activity_permission_effect_dispatch_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`CREATE UNIQUE INDEX \`session_activity_permission_effect_dispatch_request_idx\` ON \`session_activity_permission_effect_dispatch\` (\`request_id\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`session_activity_permission_effect_dispatch_idempotency_idx\` ON \`session_activity_permission_effect_dispatch\` (\`idempotency_key\`);`)
      yield* tx.run(`CREATE INDEX \`session_activity_permission_effect_dispatch_activity_idx\` ON \`session_activity_permission_effect_dispatch\` (\`activity_kind\`,\`activity_id\`,\`state\`,\`started_at\`);`)
      yield* tx.run(`CREATE INDEX \`session_activity_permission_effect_dispatch_owner_idx\` ON \`session_activity_permission_effect_dispatch\` (\`owner_id\`,\`state\`,\`started_at\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
