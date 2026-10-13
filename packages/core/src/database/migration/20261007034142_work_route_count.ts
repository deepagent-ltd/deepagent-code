import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261007034142_work_route_count",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`work_count_acquisition\` (
          \`acquisition_id\` text PRIMARY KEY,
          \`work_id\` text NOT NULL,
          \`input_id\` text NOT NULL,
          \`session_id\` text NOT NULL,
          \`provider_receipt_id\` text NOT NULL,
          \`provider_attempt_id\` text NOT NULL,
          \`binding_hash\` text NOT NULL,
          \`approval_id\` text NOT NULL,
          \`approval_revision\` integer NOT NULL,
          \`state\` text NOT NULL,
          \`revision\` integer NOT NULL,
          \`owner_token\` text NOT NULL,
          \`boot_id\` text NOT NULL,
          \`deadline\` integer NOT NULL,
          \`record\` text NOT NULL,
          \`record_hash\` text NOT NULL,
          \`record_mac\` text NOT NULL,
          \`created_at\` integer NOT NULL,
          \`updated_at\` integer NOT NULL,
          CONSTRAINT "work_count_acquisition_id_check" CHECK("acquisition_id" IS NOT NULL AND length("acquisition_id") > 0),
          CONSTRAINT "work_count_acquisition_state_check" CHECK("state" IN ('prepared','sending','settled','failed','unknown')),
          CONSTRAINT "work_count_acquisition_revision_check" CHECK("revision" > 0 AND "approval_revision" > 0),
          CONSTRAINT "work_count_acquisition_record_check" CHECK(json_valid("record") AND length("record_hash") = 64 AND length("record_mac") = 64),
          CONSTRAINT "work_count_acquisition_time_check" CHECK("created_at" >= 0 AND "updated_at" >= "created_at" AND "deadline" > "created_at"),
          CONSTRAINT "work_count_acquisition_revision_integer_check" CHECK(typeof("revision") = 'integer' AND "revision" >= 0 AND "revision" <= 9007199254740991),
          CONSTRAINT "work_count_acquisition_approval_revision_integer_check" CHECK(typeof("approval_revision") = 'integer' AND "approval_revision" >= 0 AND "approval_revision" <= 9007199254740991),
          CONSTRAINT "work_count_acquisition_deadline_integer_check" CHECK(typeof("deadline") = 'integer' AND "deadline" >= 0 AND "deadline" <= 9007199254740991),
          CONSTRAINT "work_count_acquisition_created_at_integer_check" CHECK(typeof("created_at") = 'integer' AND "created_at" >= 0 AND "created_at" <= 9007199254740991),
          CONSTRAINT "work_count_acquisition_updated_at_integer_check" CHECK(typeof("updated_at") = 'integer' AND "updated_at" >= 0 AND "updated_at" <= 9007199254740991),
          CONSTRAINT "work_count_acquisition_acquisition_id_text_check" CHECK(typeof("acquisition_id") = 'text' AND length(CAST("acquisition_id" AS BLOB)) BETWEEN 1 AND 512),
          CONSTRAINT "work_count_acquisition_work_id_text_check" CHECK(typeof("work_id") = 'text' AND length(CAST("work_id" AS BLOB)) BETWEEN 1 AND 512),
          CONSTRAINT "work_count_acquisition_input_id_text_check" CHECK(typeof("input_id") = 'text' AND length(CAST("input_id" AS BLOB)) BETWEEN 1 AND 512),
          CONSTRAINT "work_count_acquisition_session_id_text_check" CHECK(typeof("session_id") = 'text' AND length(CAST("session_id" AS BLOB)) BETWEEN 1 AND 512),
          CONSTRAINT "work_count_acquisition_provider_receipt_id_text_check" CHECK(typeof("provider_receipt_id") = 'text' AND length(CAST("provider_receipt_id" AS BLOB)) BETWEEN 1 AND 512),
          CONSTRAINT "work_count_acquisition_provider_attempt_id_text_check" CHECK(typeof("provider_attempt_id") = 'text' AND length(CAST("provider_attempt_id" AS BLOB)) BETWEEN 1 AND 512),
          CONSTRAINT "work_count_acquisition_approval_id_text_check" CHECK(typeof("approval_id") = 'text' AND length(CAST("approval_id" AS BLOB)) BETWEEN 1 AND 512),
          CONSTRAINT "work_count_acquisition_owner_token_text_check" CHECK(typeof("owner_token") = 'text' AND length(CAST("owner_token" AS BLOB)) BETWEEN 1 AND 512),
          CONSTRAINT "work_count_acquisition_boot_id_text_check" CHECK(typeof("boot_id") = 'text' AND length(CAST("boot_id" AS BLOB)) BETWEEN 1 AND 512),
          CONSTRAINT "work_count_acquisition_binding_hash_digest_check" CHECK(typeof("binding_hash") = 'text' AND length(CAST("binding_hash" AS BLOB)) = 64 AND "binding_hash" NOT GLOB '*[^0-9a-f]*'),
          CONSTRAINT "work_count_acquisition_record_hash_digest_check" CHECK(typeof("record_hash") = 'text' AND length(CAST("record_hash" AS BLOB)) = 64 AND "record_hash" NOT GLOB '*[^0-9a-f]*'),
          CONSTRAINT "work_count_acquisition_record_mac_digest_check" CHECK(typeof("record_mac") = 'text' AND length(CAST("record_mac" AS BLOB)) = 64 AND "record_mac" NOT GLOB '*[^0-9a-f]*'),
          CONSTRAINT "work_count_acquisition_record_bytes_check" CHECK(typeof("record") = 'text' AND length(CAST("record" AS BLOB)) BETWEEN 1 AND 32768)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`work_route_approval\` (
          \`approval_id\` text PRIMARY KEY,
          \`instance_id\` text NOT NULL,
          \`operator_id\` text NOT NULL,
          \`target_id\` text NOT NULL,
          \`security_namespace_id\` text NOT NULL,
          \`project_scope_key\` text NOT NULL,
          \`location_key\` text NOT NULL,
          \`canonical_root\` text NOT NULL,
          \`namespace_binding_hash\` text NOT NULL,
          \`state\` text NOT NULL,
          \`revision\` integer NOT NULL,
          \`operator_revision\` integer NOT NULL,
          \`policy_revision\` integer NOT NULL,
          \`credential_generation\` integer NOT NULL,
          \`evidence_hash\` text NOT NULL,
          \`configuration_stamp\` text NOT NULL,
          \`credential_fingerprint\` text NOT NULL,
          \`expires_at\` integer NOT NULL,
          \`record\` text NOT NULL,
          \`record_hash\` text NOT NULL,
          \`record_mac\` text NOT NULL,
          \`created_at\` integer NOT NULL,
          \`updated_at\` integer NOT NULL,
          CONSTRAINT "work_route_approval_id_check" CHECK("approval_id" IS NOT NULL AND length("approval_id") > 0),
          CONSTRAINT "work_route_approval_state_check" CHECK("state" IN ('active','revoked')),
          CONSTRAINT "work_route_approval_revision_check" CHECK("revision" > 0 AND "operator_revision" > 0 AND "policy_revision" > 0 AND "credential_generation" > 0),
          CONSTRAINT "work_route_approval_record_check" CHECK(json_valid("record") AND length("record_hash") = 64 AND length("record_mac") = 64),
          CONSTRAINT "work_route_approval_time_check" CHECK("created_at" >= 0 AND "updated_at" >= "created_at" AND "expires_at" > 0),
          CONSTRAINT "work_route_approval_revision_integer_check" CHECK(typeof("revision") = 'integer' AND "revision" >= 0 AND "revision" <= 9007199254740991),
          CONSTRAINT "work_route_approval_operator_revision_integer_check" CHECK(typeof("operator_revision") = 'integer' AND "operator_revision" >= 0 AND "operator_revision" <= 9007199254740991),
          CONSTRAINT "work_route_approval_policy_revision_integer_check" CHECK(typeof("policy_revision") = 'integer' AND "policy_revision" >= 0 AND "policy_revision" <= 9007199254740991),
          CONSTRAINT "work_route_approval_credential_generation_integer_check" CHECK(typeof("credential_generation") = 'integer' AND "credential_generation" >= 0 AND "credential_generation" <= 9007199254740991),
          CONSTRAINT "work_route_approval_expires_at_integer_check" CHECK(typeof("expires_at") = 'integer' AND "expires_at" >= 0 AND "expires_at" <= 9007199254740991),
          CONSTRAINT "work_route_approval_created_at_integer_check" CHECK(typeof("created_at") = 'integer' AND "created_at" >= 0 AND "created_at" <= 9007199254740991),
          CONSTRAINT "work_route_approval_updated_at_integer_check" CHECK(typeof("updated_at") = 'integer' AND "updated_at" >= 0 AND "updated_at" <= 9007199254740991),
          CONSTRAINT "work_route_approval_approval_id_text_check" CHECK(typeof("approval_id") = 'text' AND length(CAST("approval_id" AS BLOB)) BETWEEN 1 AND 512),
          CONSTRAINT "work_route_approval_instance_id_text_check" CHECK(typeof("instance_id") = 'text' AND length(CAST("instance_id" AS BLOB)) BETWEEN 1 AND 512),
          CONSTRAINT "work_route_approval_operator_id_text_check" CHECK(typeof("operator_id") = 'text' AND length(CAST("operator_id" AS BLOB)) BETWEEN 1 AND 512),
          CONSTRAINT "work_route_approval_target_id_text_check" CHECK(typeof("target_id") = 'text' AND length(CAST("target_id" AS BLOB)) BETWEEN 1 AND 512),
          CONSTRAINT "work_route_approval_security_namespace_id_text_check" CHECK(typeof("security_namespace_id") = 'text' AND length(CAST("security_namespace_id" AS BLOB)) BETWEEN 1 AND 512),
          CONSTRAINT "work_route_approval_project_scope_key_text_check" CHECK(typeof("project_scope_key") = 'text' AND length(CAST("project_scope_key" AS BLOB)) BETWEEN 1 AND 512),
          CONSTRAINT "work_route_approval_location_key_text_check" CHECK(typeof("location_key") = 'text' AND length(CAST("location_key" AS BLOB)) BETWEEN 1 AND 512),
          CONSTRAINT "work_route_approval_root_text_check" CHECK(typeof("canonical_root") = 'text' AND length(CAST("canonical_root" AS BLOB)) BETWEEN 1 AND 2048),
          CONSTRAINT "work_route_approval_namespace_binding_hash_digest_check" CHECK(typeof("namespace_binding_hash") = 'text' AND length(CAST("namespace_binding_hash" AS BLOB)) = 64 AND "namespace_binding_hash" NOT GLOB '*[^0-9a-f]*'),
          CONSTRAINT "work_route_approval_evidence_hash_digest_check" CHECK(typeof("evidence_hash") = 'text' AND length(CAST("evidence_hash" AS BLOB)) = 64 AND "evidence_hash" NOT GLOB '*[^0-9a-f]*'),
          CONSTRAINT "work_route_approval_configuration_stamp_digest_check" CHECK(typeof("configuration_stamp") = 'text' AND length(CAST("configuration_stamp" AS BLOB)) = 64 AND "configuration_stamp" NOT GLOB '*[^0-9a-f]*'),
          CONSTRAINT "work_route_approval_credential_fingerprint_digest_check" CHECK(typeof("credential_fingerprint") = 'text' AND length(CAST("credential_fingerprint" AS BLOB)) = 64 AND "credential_fingerprint" NOT GLOB '*[^0-9a-f]*'),
          CONSTRAINT "work_route_approval_record_hash_digest_check" CHECK(typeof("record_hash") = 'text' AND length(CAST("record_hash" AS BLOB)) = 64 AND "record_hash" NOT GLOB '*[^0-9a-f]*'),
          CONSTRAINT "work_route_approval_record_mac_digest_check" CHECK(typeof("record_mac") = 'text' AND length(CAST("record_mac" AS BLOB)) = 64 AND "record_mac" NOT GLOB '*[^0-9a-f]*'),
          CONSTRAINT "work_route_approval_record_bytes_check" CHECK(typeof("record") = 'text' AND length(CAST("record" AS BLOB)) BETWEEN 1 AND 262144)
        );
      `)
      yield* tx.run(`CREATE UNIQUE INDEX \`work_count_acquisition_work_idx\` ON \`work_count_acquisition\` (\`work_id\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`work_count_acquisition_input_idx\` ON \`work_count_acquisition\` (\`work_id\`,\`input_id\`);`)
      yield* tx.run(`CREATE INDEX \`work_count_acquisition_deadline_idx\` ON \`work_count_acquisition\` (\`state\`,\`deadline\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`work_route_approval_target_idx\` ON \`work_route_approval\` (\`instance_id\`,\`operator_id\`,\`target_id\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
