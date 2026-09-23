import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260923200145_long_context_checkpoint",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_context_checkpoint\` (
          \`checkpoint_id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`activity_id\` text NOT NULL,
          \`prompt_epoch\` integer NOT NULL,
          \`content_hash\` text NOT NULL,
          \`content\` text NOT NULL,
          \`created_at\` integer NOT NULL,
          CONSTRAINT \`fk_session_context_checkpoint_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_model_policy_receipt\` (
          \`receipt_id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`activity_id\` text NOT NULL,
          \`user_message_id\` text NOT NULL,
          \`prompt_epoch\` integer NOT NULL,
          \`request_hash\` text NOT NULL,
          \`provider_id\` text NOT NULL,
          \`runtime_model_id\` text NOT NULL,
          \`api_model_id\` text NOT NULL,
          \`policy\` text NOT NULL,
          \`estimated_full_request_tokens\` integer NOT NULL,
          \`estimator_version\` text NOT NULL,
          \`reserved_output_tokens\` integer NOT NULL,
          \`context_selection_id\` text NOT NULL,
          \`context_projection_hash\` text NOT NULL,
          \`graph_snapshot_refs\` text NOT NULL,
          \`offered_tool_ids\` text NOT NULL,
          \`degraded_tool_ids\` text NOT NULL,
          \`provider_attempt_id\` text,
          \`trigger_source\` text NOT NULL,
          \`checkpoint_id\` text,
          \`checkpoint_hash\` text,
          \`blocked_reason\` text,
          \`created_at\` integer NOT NULL,
          CONSTRAINT \`fk_session_model_policy_receipt_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`CREATE INDEX \`session_context_checkpoint_session_idx\` ON \`session_context_checkpoint\` (\`session_id\`,\`created_at\`);`)
      yield* tx.run(`CREATE INDEX \`session_model_policy_receipt_session_idx\` ON \`session_model_policy_receipt\` (\`session_id\`,\`created_at\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
