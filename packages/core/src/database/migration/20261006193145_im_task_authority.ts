import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261006193145_im_task_authority",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`im_task_grant\` (
          \`grant_id\` text PRIMARY KEY,
          \`request_id\` text NOT NULL,
          \`ordinal\` integer NOT NULL,
          \`instance_id\` text NOT NULL,
          \`actor_id\` text NOT NULL,
          \`principal\` text NOT NULL,
          \`target_proof\` text NOT NULL,
          \`source_proof_hash\` text NOT NULL,
          \`source_snapshot_hash\` text NOT NULL,
          \`request_hash\` text NOT NULL,
          \`binding\` text NOT NULL,
          \`record_hash\` text NOT NULL,
          \`work_id\` text NOT NULL,
          \`session_id\` text NOT NULL,
          \`input_id\` text NOT NULL,
          \`result_key\` text NOT NULL,
          \`state\` text NOT NULL,
          \`revision\` integer NOT NULL,
          \`accept_request_id\` text NOT NULL,
          \`accept_expected_revision\` integer NOT NULL,
          \`revoke_request_id\` text,
          \`revoke_expected_revision\` integer,
          \`revoked_at\` integer,
          \`created_at\` integer NOT NULL,
          \`expires_at\` integer NOT NULL,
          CONSTRAINT "im_task_grant_state_check" CHECK("state" IN ('active','revoked') AND "revision" > 0 AND "ordinal" = 1),
          CONSTRAINT "im_task_grant_json_check" CHECK(json_valid("principal") AND json_valid("target_proof") AND json_valid("binding")),
          CONSTRAINT "im_task_grant_revoke_check" CHECK("state" != 'revoked' OR ("revoke_request_id" IS NOT NULL AND "revoked_at" IS NOT NULL))
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`im_task_request\` (
          \`request_id\` text PRIMARY KEY,
          \`client_request_id\` text NOT NULL,
          \`source_id\` text NOT NULL,
          \`instance_id\` text NOT NULL,
          \`actor_id\` text NOT NULL,
          \`request_hash\` text NOT NULL,
          \`audited_text\` text NOT NULL,
          \`audited_text_hash\` text NOT NULL,
          \`target\` text NOT NULL,
          \`result_key\` text NOT NULL,
          \`state\` text NOT NULL,
          \`revision\` integer NOT NULL,
          \`created_at\` integer NOT NULL,
          \`expires_at\` integer NOT NULL,
          CONSTRAINT "im_task_request_state_check" CHECK("state" IN ('proposed','accepted') AND "revision" > 0),
          CONSTRAINT "im_task_request_json_check" CHECK(json_valid("target") AND "expires_at" > "created_at")
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`im_task_source\` (
          \`source_id\` text PRIMARY KEY,
          \`message_id\` text NOT NULL,
          \`instance_id\` text NOT NULL,
          \`proof\` text NOT NULL,
          \`proof_hash\` text NOT NULL,
          \`snapshot\` text NOT NULL,
          \`snapshot_hash\` text NOT NULL,
          \`created_at\` integer NOT NULL,
          CONSTRAINT "im_task_source_json_check" CHECK(json_valid("proof") AND json_valid("snapshot"))
        );
      `)
      yield* tx.run(`CREATE UNIQUE INDEX \`im_task_grant_request_idx\` ON \`im_task_grant\` (\`request_id\`,\`ordinal\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`im_task_grant_work_idx\` ON \`im_task_grant\` (\`work_id\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`im_task_grant_session_idx\` ON \`im_task_grant\` (\`session_id\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`im_task_grant_input_idx\` ON \`im_task_grant\` (\`input_id\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`im_task_grant_result_idx\` ON \`im_task_grant\` (\`result_key\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`im_task_request_client_idx\` ON \`im_task_request\` (\`instance_id\`,\`actor_id\`,\`client_request_id\`);`)
      yield* tx.run(`CREATE INDEX \`im_task_source_message_idx\` ON \`im_task_source\` (\`instance_id\`,\`message_id\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
