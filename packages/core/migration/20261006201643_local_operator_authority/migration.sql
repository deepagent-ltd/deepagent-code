CREATE TABLE `local_operator_authority` (
	`instance_id` text PRIMARY KEY,
	`operator_id` text NOT NULL,
	`username` text NOT NULL,
	`credential_verifier` text NOT NULL,
	`credential_binding` text NOT NULL,
	`installation_key_hash` text NOT NULL,
	`state` text NOT NULL,
	`revision` integer NOT NULL,
	`credential_generation` integer NOT NULL,
	`policy_revision` integer NOT NULL,
	`policy` text NOT NULL,
	`policy_hash` text NOT NULL,
	`identity_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "local_operator_hash_check" CHECK(length("credential_binding") = 64 AND "credential_binding" NOT GLOB '*[^0-9a-f]*' AND length("installation_key_hash") = 64 AND "installation_key_hash" NOT GLOB '*[^0-9a-f]*' AND length("policy_hash") = 64 AND "policy_hash" NOT GLOB '*[^0-9a-f]*' AND length("identity_hash") = 64 AND "identity_hash" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "local_operator_verifier_check" CHECK(substr("credential_verifier", 1, 10) = '$argon2id$'),
	CONSTRAINT "local_operator_state_check" CHECK("state" IN ('active','revoked')),
	CONSTRAINT "local_operator_revision_check" CHECK("revision" > 0 AND "credential_generation" > 0 AND "policy_revision" > 0),
	CONSTRAINT "local_operator_policy_check" CHECK(json_valid("policy") AND json_type("policy") = 'object')
);
--> statement-breakpoint
CREATE TABLE `local_operator_command` (
	`command_id` text PRIMARY KEY,
	`instance_id` text NOT NULL,
	`operation_id` text NOT NULL,
	`action` text NOT NULL,
	`request_hash` text NOT NULL,
	`expected_revision` integer,
	`receipt` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT "local_operator_command_identity_check" CHECK(length("request_hash") = 64 AND "request_hash" NOT GLOB '*[^0-9a-f]*' AND ("expected_revision" IS NULL OR "expected_revision" >= 0)),
	CONSTRAINT "local_operator_command_action_check" CHECK("action" IN ('enroll','rotate','revoke','enable_conversation')),
	CONSTRAINT "local_operator_command_receipt_check" CHECK(json_valid("receipt") AND json_type("receipt") = 'object')
);
--> statement-breakpoint
CREATE TABLE `im_local_origin_receipt` (
	`message_id` text PRIMARY KEY,
	`instance_id` text NOT NULL,
	`operator_id` text NOT NULL,
	`operator_revision` integer NOT NULL,
	`credential_generation` integer NOT NULL,
	`group_id` text NOT NULL,
	`conversation_revision` integer NOT NULL,
	`raw_snapshot` text NOT NULL,
	`raw_snapshot_hash` text NOT NULL,
	`proof` text NOT NULL,
	`receipt_hash` text NOT NULL,
	`origin` text NOT NULL,
	`received_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	CONSTRAINT "im_local_origin_hash_check" CHECK(length("raw_snapshot_hash") = 64 AND "raw_snapshot_hash" NOT GLOB '*[^0-9a-f]*' AND length("receipt_hash") = 64 AND "receipt_hash" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "im_local_origin_revision_check" CHECK("operator_revision" > 0 AND "credential_generation" > 0 AND "conversation_revision" > 0),
	CONSTRAINT "im_local_origin_kind_check" CHECK("origin" = 'authenticated_local_text' AND "expires_at" > "received_at"),
	CONSTRAINT "im_local_origin_json_check" CHECK(json_valid("raw_snapshot") AND json_type("raw_snapshot") = 'object' AND json_valid("proof") AND json_type("proof") = 'object')
);
--> statement-breakpoint
CREATE TABLE `im_local_task_conversation` (
	`group_id` text PRIMARY KEY,
	`instance_id` text NOT NULL,
	`operator_id` text NOT NULL,
	`operator_revision` integer NOT NULL,
	`target_id` text NOT NULL,
	`revision` integer NOT NULL,
	`mode` text NOT NULL,
	`target` text NOT NULL,
	`target_hash` text NOT NULL,
	`location_key` text NOT NULL,
	`namespace_binding_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "im_local_task_conversation_hash_check" CHECK(length("target_hash") = 64 AND "target_hash" NOT GLOB '*[^0-9a-f]*' AND length("namespace_binding_hash") = 64 AND "namespace_binding_hash" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "im_local_task_conversation_mode_check" CHECK("mode" = 'explicit_task' AND "revision" > 0 AND "operator_revision" > 0),
	CONSTRAINT "im_local_task_conversation_target_check" CHECK(json_valid("target") AND json_type("target") = 'object')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `local_operator_identity_idx` ON `local_operator_authority` (`operator_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `local_operator_command_request_idx` ON `local_operator_command` (`instance_id`,`operation_id`);