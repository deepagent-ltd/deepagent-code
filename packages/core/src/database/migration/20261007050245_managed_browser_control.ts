import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261007050245_managed_browser_control",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`browser_action\` (
          \`action_id\` text PRIMARY KEY,
          \`control_id\` text NOT NULL,
          \`request_id\` text NOT NULL,
          \`command_digest\` text NOT NULL,
          \`admission_id\` text NOT NULL,
          \`provider_receipt_id\` text NOT NULL,
          \`provider_attempt_id\` text NOT NULL,
          \`tool_call_id\` text NOT NULL,
          \`session_id\` text NOT NULL,
          \`host_incarnation\` text NOT NULL,
          \`resource_id\` text NOT NULL,
          \`control_epoch\` integer NOT NULL,
          \`policy_revision\` integer NOT NULL,
          \`revision\` integer NOT NULL,
          \`deadline\` integer NOT NULL,
          \`outcome\` text NOT NULL,
          \`record\` text NOT NULL,
          \`record_hash\` text NOT NULL,
          \`created_at\` integer NOT NULL,
          \`updated_at\` integer NOT NULL,
          CONSTRAINT "browser_action_outcome_check" CHECK("outcome" IN ('pending','completed','failed','cancelled','unknown')),
          CONSTRAINT "browser_action_revision_check" CHECK("revision" > 0 AND "control_epoch" > 0 AND "policy_revision" > 0),
          CONSTRAINT "browser_action_time_check" CHECK("updated_at" >= "created_at" AND "deadline" > "created_at"),
          CONSTRAINT "browser_action_record_check" CHECK(typeof("record") = 'text' AND length(CAST("record" AS BLOB)) BETWEEN 1 AND 131072 AND json_valid("record")),
          CONSTRAINT "browser_action_action_id_text_check" CHECK(typeof("action_id") = 'text' AND length(CAST("action_id" AS BLOB)) BETWEEN 1 AND 512),
          CONSTRAINT "browser_action_control_id_text_check" CHECK(typeof("control_id") = 'text' AND length(CAST("control_id" AS BLOB)) BETWEEN 1 AND 512),
          CONSTRAINT "browser_action_request_id_text_check" CHECK(typeof("request_id") = 'text' AND length(CAST("request_id" AS BLOB)) BETWEEN 1 AND 512),
          CONSTRAINT "browser_action_admission_id_text_check" CHECK(typeof("admission_id") = 'text' AND length(CAST("admission_id" AS BLOB)) BETWEEN 1 AND 512),
          CONSTRAINT "browser_action_provider_receipt_id_text_check" CHECK(typeof("provider_receipt_id") = 'text' AND length(CAST("provider_receipt_id" AS BLOB)) BETWEEN 1 AND 512),
          CONSTRAINT "browser_action_provider_attempt_id_text_check" CHECK(typeof("provider_attempt_id") = 'text' AND length(CAST("provider_attempt_id" AS BLOB)) BETWEEN 1 AND 512),
          CONSTRAINT "browser_action_tool_call_id_text_check" CHECK(typeof("tool_call_id") = 'text' AND length(CAST("tool_call_id" AS BLOB)) BETWEEN 1 AND 512),
          CONSTRAINT "browser_action_session_id_text_check" CHECK(typeof("session_id") = 'text' AND length(CAST("session_id" AS BLOB)) BETWEEN 1 AND 512),
          CONSTRAINT "browser_action_host_incarnation_text_check" CHECK(typeof("host_incarnation") = 'text' AND length(CAST("host_incarnation" AS BLOB)) BETWEEN 1 AND 512),
          CONSTRAINT "browser_action_resource_id_text_check" CHECK(typeof("resource_id") = 'text' AND length(CAST("resource_id" AS BLOB)) BETWEEN 1 AND 512),
          CONSTRAINT "browser_action_revision_integer_check" CHECK(typeof("revision") = 'integer' AND "revision" >= 0 AND "revision" <= 9007199254740991),
          CONSTRAINT "browser_action_control_epoch_integer_check" CHECK(typeof("control_epoch") = 'integer' AND "control_epoch" >= 0 AND "control_epoch" <= 9007199254740991),
          CONSTRAINT "browser_action_policy_revision_integer_check" CHECK(typeof("policy_revision") = 'integer' AND "policy_revision" >= 0 AND "policy_revision" <= 9007199254740991),
          CONSTRAINT "browser_action_deadline_integer_check" CHECK(typeof("deadline") = 'integer' AND "deadline" >= 0 AND "deadline" <= 9007199254740991),
          CONSTRAINT "browser_action_created_at_integer_check" CHECK(typeof("created_at") = 'integer' AND "created_at" >= 0 AND "created_at" <= 9007199254740991),
          CONSTRAINT "browser_action_updated_at_integer_check" CHECK(typeof("updated_at") = 'integer' AND "updated_at" >= 0 AND "updated_at" <= 9007199254740991),
          CONSTRAINT "browser_action_command_digest_digest_check" CHECK(typeof("command_digest") = 'text' AND length(CAST("command_digest" AS BLOB)) = 64 AND "command_digest" NOT GLOB '*[^0-9a-f]*'),
          CONSTRAINT "browser_action_record_hash_digest_check" CHECK(typeof("record_hash") = 'text' AND length(CAST("record_hash" AS BLOB)) = 64 AND "record_hash" NOT GLOB '*[^0-9a-f]*')
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`browser_control\` (
          \`control_id\` text PRIMARY KEY,
          \`request_id\` text NOT NULL,
          \`request_digest\` text NOT NULL,
          \`principal\` text NOT NULL,
          \`security_namespace_id\` text NOT NULL,
          \`location_key\` text NOT NULL,
          \`project_scope_key\` text NOT NULL,
          \`namespace_binding_hash\` text NOT NULL,
          \`session_id\` text NOT NULL,
          \`project_id\` text NOT NULL,
          \`directory\` text NOT NULL,
          \`host_id\` text NOT NULL,
          \`host_incarnation\` text NOT NULL,
          \`resource_id\` text NOT NULL,
          \`credential_binding\` text NOT NULL,
          \`profile\` text NOT NULL,
          \`origin\` text NOT NULL,
          \`revision\` integer NOT NULL,
          \`epoch\` integer NOT NULL,
          \`policy_revision\` integer NOT NULL,
          \`state\` text NOT NULL,
          \`expires_at\` integer NOT NULL,
          \`record\` text NOT NULL,
          \`record_hash\` text NOT NULL,
          \`created_at\` integer NOT NULL,
          \`updated_at\` integer NOT NULL,
          CONSTRAINT "browser_control_state_check" CHECK("state" IN ('creating','active','cancel_requested','stopped','unknown')),
          CONSTRAINT "browser_control_profile_check" CHECK("profile" = 'managed-loopback-preview-v1'),
          CONSTRAINT "browser_control_revision_check" CHECK("revision" > 0 AND "epoch" > 0 AND "policy_revision" > 0),
          CONSTRAINT "browser_control_time_check" CHECK("updated_at" >= "created_at" AND "expires_at" > "created_at"),
          CONSTRAINT "browser_control_record_check" CHECK(typeof("record") = 'text' AND length(CAST("record" AS BLOB)) BETWEEN 1 AND 16384 AND json_valid("record")),
          CONSTRAINT "browser_control_control_id_text_check" CHECK(typeof("control_id") = 'text' AND length(CAST("control_id" AS BLOB)) BETWEEN 1 AND 512),
          CONSTRAINT "browser_control_request_id_text_check" CHECK(typeof("request_id") = 'text' AND length(CAST("request_id" AS BLOB)) BETWEEN 1 AND 512),
          CONSTRAINT "browser_control_principal_text_check" CHECK(typeof("principal") = 'text' AND length(CAST("principal" AS BLOB)) BETWEEN 1 AND 512),
          CONSTRAINT "browser_control_security_namespace_id_text_check" CHECK(typeof("security_namespace_id") = 'text' AND length(CAST("security_namespace_id" AS BLOB)) BETWEEN 1 AND 512),
          CONSTRAINT "browser_control_location_key_text_check" CHECK(typeof("location_key") = 'text' AND length(CAST("location_key" AS BLOB)) BETWEEN 1 AND 512),
          CONSTRAINT "browser_control_project_scope_key_text_check" CHECK(typeof("project_scope_key") = 'text' AND length(CAST("project_scope_key" AS BLOB)) BETWEEN 1 AND 512),
          CONSTRAINT "browser_control_session_id_text_check" CHECK(typeof("session_id") = 'text' AND length(CAST("session_id" AS BLOB)) BETWEEN 1 AND 512),
          CONSTRAINT "browser_control_project_id_text_check" CHECK(typeof("project_id") = 'text' AND length(CAST("project_id" AS BLOB)) BETWEEN 1 AND 512),
          CONSTRAINT "browser_control_host_id_text_check" CHECK(typeof("host_id") = 'text' AND length(CAST("host_id" AS BLOB)) BETWEEN 1 AND 512),
          CONSTRAINT "browser_control_host_incarnation_text_check" CHECK(typeof("host_incarnation") = 'text' AND length(CAST("host_incarnation" AS BLOB)) BETWEEN 1 AND 512),
          CONSTRAINT "browser_control_resource_id_text_check" CHECK(typeof("resource_id") = 'text' AND length(CAST("resource_id" AS BLOB)) BETWEEN 1 AND 512),
          CONSTRAINT "browser_control_profile_text_check" CHECK(typeof("profile") = 'text' AND length(CAST("profile" AS BLOB)) BETWEEN 1 AND 512),
          CONSTRAINT "browser_control_directory_text_check" CHECK(typeof("directory") = 'text' AND length(CAST("directory" AS BLOB)) BETWEEN 1 AND 2048),
          CONSTRAINT "browser_control_origin_text_check" CHECK(typeof("origin") = 'text' AND length(CAST("origin" AS BLOB)) BETWEEN 1 AND 2048),
          CONSTRAINT "browser_control_revision_integer_check" CHECK(typeof("revision") = 'integer' AND "revision" >= 0 AND "revision" <= 9007199254740991),
          CONSTRAINT "browser_control_epoch_integer_check" CHECK(typeof("epoch") = 'integer' AND "epoch" >= 0 AND "epoch" <= 9007199254740991),
          CONSTRAINT "browser_control_policy_revision_integer_check" CHECK(typeof("policy_revision") = 'integer' AND "policy_revision" >= 0 AND "policy_revision" <= 9007199254740991),
          CONSTRAINT "browser_control_expires_at_integer_check" CHECK(typeof("expires_at") = 'integer' AND "expires_at" >= 0 AND "expires_at" <= 9007199254740991),
          CONSTRAINT "browser_control_created_at_integer_check" CHECK(typeof("created_at") = 'integer' AND "created_at" >= 0 AND "created_at" <= 9007199254740991),
          CONSTRAINT "browser_control_updated_at_integer_check" CHECK(typeof("updated_at") = 'integer' AND "updated_at" >= 0 AND "updated_at" <= 9007199254740991),
          CONSTRAINT "browser_control_request_digest_digest_check" CHECK(typeof("request_digest") = 'text' AND length(CAST("request_digest" AS BLOB)) = 64 AND "request_digest" NOT GLOB '*[^0-9a-f]*'),
          CONSTRAINT "browser_control_record_hash_digest_check" CHECK(typeof("record_hash") = 'text' AND length(CAST("record_hash" AS BLOB)) = 64 AND "record_hash" NOT GLOB '*[^0-9a-f]*'),
          CONSTRAINT "browser_control_namespace_binding_hash_digest_check" CHECK(typeof("namespace_binding_hash") = 'text' AND length(CAST("namespace_binding_hash" AS BLOB)) = 64 AND "namespace_binding_hash" NOT GLOB '*[^0-9a-f]*'),
          CONSTRAINT "browser_control_credential_binding_digest_check" CHECK(typeof("credential_binding") = 'text' AND length(CAST("credential_binding" AS BLOB)) = 64 AND "credential_binding" NOT GLOB '*[^0-9a-f]*')
        );
      `)
      yield* tx.run(`CREATE UNIQUE INDEX \`browser_action_request_idx\` ON \`browser_action\` (\`control_id\`,\`request_id\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`browser_action_admission_idx\` ON \`browser_action\` (\`admission_id\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`browser_action_call_idx\` ON \`browser_action\` (\`provider_receipt_id\`,\`tool_call_id\`);`)
      yield* tx.run(`CREATE INDEX \`browser_action_control_outcome_idx\` ON \`browser_action\` (\`control_id\`,\`outcome\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`browser_control_request_idx\` ON \`browser_control\` (\`principal\`,\`session_id\`,\`request_id\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`browser_control_resource_idx\` ON \`browser_control\` (\`host_incarnation\`,\`resource_id\`);`)
      yield* tx.run(`CREATE INDEX \`browser_control_state_idx\` ON \`browser_control\` (\`host_incarnation\`,\`state\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
