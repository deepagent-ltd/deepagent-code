CREATE TABLE `browser_shared_action` (
	`action_id` text PRIMARY KEY,
	`admission_id` text NOT NULL,
	`resource_id` text NOT NULL,
	`lease_id` text NOT NULL,
	`outcome` text NOT NULL,
	`record` text NOT NULL,
	`record_hash` text NOT NULL,
	CONSTRAINT "browser_shared_action_outcome_check" CHECK("outcome" IN ('pending','completed','cancelled','unknown')),
	CONSTRAINT "browser_shared_action_record_check" CHECK(json_valid("record") AND length(CAST("record" AS BLOB)) BETWEEN 1 AND 131072)
);
--> statement-breakpoint
CREATE TABLE `browser_shared_lease` (
	`lease_id` text PRIMARY KEY,
	`resource_id` text NOT NULL,
	`request_id` text NOT NULL,
	`session_id` text NOT NULL,
	`main_incarnation` text NOT NULL,
	`sidecar_incarnation` text NOT NULL,
	`lease_epoch` integer NOT NULL,
	`manual_epoch` integer NOT NULL,
	`state` text NOT NULL,
	`origin_input_id` text,
	`record` text NOT NULL,
	`record_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "browser_shared_lease_state_check" CHECK("state" IN ('pending','active','revoked','unknown')),
	CONSTRAINT "browser_shared_lease_record_check" CHECK(json_valid("record") AND length(CAST("record" AS BLOB)) BETWEEN 1 AND 16384)
);
--> statement-breakpoint
CREATE TABLE `browser_shared_request` (
	`resource_id` text NOT NULL,
	`request_id` text NOT NULL,
	`kind` text NOT NULL,
	`request_digest` text NOT NULL,
	`manual_epoch` integer NOT NULL,
	`state` text NOT NULL,
	`lease_id` text,
	`record` text NOT NULL,
	`record_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `browser_shared_request_pk` PRIMARY KEY(`resource_id`, `request_id`),
	CONSTRAINT "browser_shared_request_kind_check" CHECK("kind" IN ('takeover','acquire','close')),
	CONSTRAINT "browser_shared_request_state_check" CHECK("state" IN ('pending','completed','unknown')),
	CONSTRAINT "browser_shared_request_record_check" CHECK(json_valid("record") AND length(CAST("record" AS BLOB)) BETWEEN 1 AND 16384)
);
--> statement-breakpoint
CREATE TABLE `browser_shared_resource` (
	`resource_id` text PRIMARY KEY,
	`request_id` text NOT NULL,
	`request_digest` text NOT NULL,
	`principal` text NOT NULL,
	`session_id` text NOT NULL,
	`main_incarnation` text NOT NULL,
	`state` text NOT NULL,
	`revision` integer NOT NULL,
	`manual_epoch` integer NOT NULL,
	`barrier_order` integer NOT NULL,
	`core_cutoff` integer NOT NULL,
	`live_lease_id` text,
	`record` text NOT NULL,
	`record_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "browser_shared_resource_state_check" CHECK("state" IN ('creating','agent_owned','takeover_pending','human_owned','acquire_pending','fenced_blocked','recovery_required','resource_lost','closing','closed')),
	CONSTRAINT "browser_shared_resource_revision_check" CHECK("revision">0 AND "manual_epoch">=0 AND "barrier_order">=0 AND "core_cutoff">=-1),
	CONSTRAINT "browser_shared_resource_record_check" CHECK(json_valid("record") AND length(CAST("record" AS BLOB)) BETWEEN 1 AND 16384)
);
--> statement-breakpoint
CREATE TABLE `browser_user_selection` (
	`receipt_id` text PRIMARY KEY,
	`selection_id` text NOT NULL,
	`session_id` text NOT NULL,
	`activity_id` text NOT NULL,
	`request_ordinal` integer NOT NULL,
	`projection_hash` text NOT NULL,
	`input_id` text,
	`origin_hash` text,
	`promoted_seq` integer,
	`created_at` integer NOT NULL,
	CONSTRAINT "browser_user_selection_null_check" CHECK(("input_id" IS NULL AND "origin_hash" IS NULL AND "promoted_seq" IS NULL) OR ("input_id" IS NOT NULL AND "origin_hash" IS NOT NULL AND "promoted_seq" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE `session_user_input_origin` (
	`input_id` text PRIMARY KEY,
	`session_id` text NOT NULL,
	`original_submission_id` text NOT NULL,
	`main_incarnation` text NOT NULL,
	`submission_order` integer NOT NULL,
	`admitted_seq` integer NOT NULL,
	`record` text NOT NULL,
	`record_hash` text NOT NULL,
	CONSTRAINT "session_user_input_origin_seq_check" CHECK("submission_order">0 AND "admitted_seq">=0),
	CONSTRAINT "session_user_input_origin_record_check" CHECK(json_valid("record") AND length(CAST("record" AS BLOB)) BETWEEN 1 AND 4096)
);
--> statement-breakpoint
CREATE TABLE `goal_pause_boundary` (
	`permit_id` text PRIMARY KEY,
	`goal_id` text NOT NULL,
	`command_id` text NOT NULL,
	`state` text NOT NULL,
	`record` text NOT NULL,
	`record_hash` text NOT NULL,
	`logical_bytes` integer NOT NULL,
	`reserved_bytes` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "goal_pause_boundary_state_check" CHECK("state" IN ('prepared','committed')),
	CONSTRAINT "goal_pause_boundary_record_check" CHECK(json_valid("record") AND json_type("record")='object' AND length(CAST("record" AS BLOB)) BETWEEN 2 AND 1048576),
	CONSTRAINT "goal_pause_boundary_size_check" CHECK("logical_bytes"=length(CAST("record" AS BLOB)) AND "reserved_bytes"=1048576),
	CONSTRAINT "goal_pause_boundary_hash_check" CHECK(length("record_hash")=64 AND "record_hash" NOT GLOB '*[^0-9a-f]*')
);
--> statement-breakpoint
ALTER TABLE `browser_file_artifact` ADD `binding_version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `browser_file_artifact` ADD `shared_resource_id` text REFERENCES browser_shared_resource(resource_id);--> statement-breakpoint
ALTER TABLE `browser_file_artifact` ADD `shared_lease_id` text REFERENCES browser_shared_lease(lease_id);--> statement-breakpoint
ALTER TABLE `browser_file_artifact` ADD `shared_action_id` text REFERENCES browser_shared_action(action_id);--> statement-breakpoint
ALTER TABLE `browser_file_grant` ADD `binding_version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `browser_file_grant` ADD `shared_resource_id` text REFERENCES browser_shared_resource(resource_id);--> statement-breakpoint
ALTER TABLE `browser_file_grant` ADD `shared_lease_id` text REFERENCES browser_shared_lease(lease_id);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_browser_file_artifact` (
	`artifact_id` text PRIMARY KEY,
	`instance_id` text NOT NULL,
	`grant_id` text NOT NULL,
	`grant_hash` text NOT NULL,
	`binding_version` integer DEFAULT 1 NOT NULL,
	`action_id` text,
	`control_id` text,
	`shared_resource_id` text,
	`shared_lease_id` text,
	`shared_action_id` text,
	`scope_hash` text NOT NULL,
	`ordinal` integer NOT NULL,
	`state` text NOT NULL,
	`revision` integer NOT NULL,
	`reserved_bytes` integer NOT NULL,
	`record` text NOT NULL,
	`record_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`released_at` integer,
	CONSTRAINT `fk_browser_file_artifact_instance_id_browser_file_capacity_instance_id_fk` FOREIGN KEY (`instance_id`) REFERENCES `browser_file_capacity`(`instance_id`) ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT `fk_browser_file_artifact_grant_id_browser_file_grant_grant_id_fk` FOREIGN KEY (`grant_id`) REFERENCES `browser_file_grant`(`grant_id`) ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT `fk_browser_file_artifact_action_id_browser_action_action_id_fk` FOREIGN KEY (`action_id`) REFERENCES `browser_action`(`action_id`) ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT `fk_browser_file_artifact_control_id_browser_control_control_id_fk` FOREIGN KEY (`control_id`) REFERENCES `browser_control`(`control_id`) ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT `fk_browser_file_artifact_shared_resource_id_browser_shared_resource_resource_id_fk` FOREIGN KEY (`shared_resource_id`) REFERENCES `browser_shared_resource`(`resource_id`) ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT `fk_browser_file_artifact_shared_lease_id_browser_shared_lease_lease_id_fk` FOREIGN KEY (`shared_lease_id`) REFERENCES `browser_shared_lease`(`lease_id`) ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT `fk_browser_file_artifact_shared_action_id_browser_shared_action_action_id_fk` FOREIGN KEY (`shared_action_id`) REFERENCES `browser_shared_action`(`action_id`) ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT "browser_file_artifact_binding_check" CHECK(typeof("binding_version")='integer' AND (("binding_version"=1 AND "control_id" IS NOT NULL AND "action_id" IS NOT NULL AND "shared_resource_id" IS NULL AND "shared_lease_id" IS NULL AND "shared_action_id" IS NULL) OR ("binding_version"=2 AND "control_id" IS NULL AND "action_id" IS NULL AND "shared_resource_id" IS NOT NULL AND "shared_lease_id" IS NOT NULL AND "shared_action_id" IS NOT NULL))),
	CONSTRAINT "browser_file_artifact_artifact_id_text_check" CHECK(typeof("artifact_id")='text' AND length(CAST("artifact_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("artifact_id",char(0))=0),
	CONSTRAINT "browser_file_artifact_instance_id_text_check" CHECK(typeof("instance_id")='text' AND length(CAST("instance_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("instance_id",char(0))=0),
	CONSTRAINT "browser_file_artifact_grant_id_text_check" CHECK(typeof("grant_id")='text' AND length(CAST("grant_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("grant_id",char(0))=0),
	CONSTRAINT "browser_file_artifact_action_id_text_check" CHECK("action_id" IS NULL OR (typeof("action_id")='text' AND length(CAST("action_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("action_id",char(0))=0)),
	CONSTRAINT "browser_file_artifact_control_id_text_check" CHECK("control_id" IS NULL OR (typeof("control_id")='text' AND length(CAST("control_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("control_id",char(0))=0)),
	CONSTRAINT "browser_file_artifact_shared_resource_id_text_check" CHECK("shared_resource_id" IS NULL OR (typeof("shared_resource_id")='text' AND length(CAST("shared_resource_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("shared_resource_id",char(0))=0)),
	CONSTRAINT "browser_file_artifact_shared_lease_id_text_check" CHECK("shared_lease_id" IS NULL OR (typeof("shared_lease_id")='text' AND length(CAST("shared_lease_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("shared_lease_id",char(0))=0)),
	CONSTRAINT "browser_file_artifact_shared_action_id_text_check" CHECK("shared_action_id" IS NULL OR (typeof("shared_action_id")='text' AND length(CAST("shared_action_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("shared_action_id",char(0))=0)),
	CONSTRAINT "browser_file_artifact_grant_hash_digest_check" CHECK(typeof("grant_hash")='text' AND length(CAST("grant_hash" AS BLOB))=64 AND "grant_hash" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "browser_file_artifact_scope_hash_digest_check" CHECK(typeof("scope_hash")='text' AND length(CAST("scope_hash" AS BLOB))=64 AND "scope_hash" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "browser_file_artifact_record_hash_digest_check" CHECK(typeof("record_hash")='text' AND length(CAST("record_hash" AS BLOB))=64 AND "record_hash" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "browser_file_artifact_revision_integer_check" CHECK(typeof("revision")='integer' AND "revision" BETWEEN 1 AND 9007199254740991),
	CONSTRAINT "browser_file_artifact_created_at_integer_check" CHECK(typeof("created_at")='integer' AND "created_at" BETWEEN 1 AND 9007199254740991),
	CONSTRAINT "browser_file_artifact_updated_at_integer_check" CHECK(typeof("updated_at")='integer' AND "updated_at" BETWEEN 1 AND 9007199254740991),
	CONSTRAINT "browser_file_artifact_ordinal_check" CHECK(typeof("ordinal")='integer' AND "ordinal" BETWEEN 0 AND 3),
	CONSTRAINT "browser_file_artifact_reserved_check" CHECK(typeof("reserved_bytes")='integer' AND "reserved_bytes" BETWEEN 0 AND 1073741824),
	CONSTRAINT "browser_file_artifact_state_check" CHECK("state" IN ('reserved','staged','selected','published','refused','unknown')),
	CONSTRAINT "browser_file_artifact_time_check" CHECK("updated_at">="created_at" AND ("released_at" IS NULL OR (typeof("released_at")='integer' AND "released_at" BETWEEN "created_at" AND "updated_at"))),
	CONSTRAINT "browser_file_artifact_release_check" CHECK(("released_at" IS NULL AND "reserved_bytes">0) OR ("released_at" IS NOT NULL AND "state" IN ('selected','published','refused') AND "reserved_bytes"=0)),
	CONSTRAINT "browser_file_artifact_record_check" CHECK(typeof("record")='text' AND length(CAST("record" AS BLOB)) BETWEEN 1 AND 8192 AND json_valid("record") AND json_type("record") IS 'object' AND json_type("record",'$.version') IS 'integer' AND json_extract("record",'$.version') IS "binding_version"),
	CONSTRAINT "browser_file_artifact_artifact_id_mirror_check" CHECK(json_type("record",'$.artifactID') IS 'text' AND json_extract("record",'$.artifactID') IS "artifact_id"),
	CONSTRAINT "browser_file_artifact_instance_id_mirror_check" CHECK(json_type("record",'$.instanceID') IS 'text' AND json_extract("record",'$.instanceID') IS "instance_id"),
	CONSTRAINT "browser_file_artifact_grant_id_mirror_check" CHECK(json_type("record",'$.grantID') IS 'text' AND json_extract("record",'$.grantID') IS "grant_id"),
	CONSTRAINT "browser_file_artifact_grant_hash_mirror_check" CHECK(json_type("record",'$.grantHash') IS 'text' AND json_extract("record",'$.grantHash') IS "grant_hash"),
	CONSTRAINT "browser_file_artifact_scope_hash_mirror_check" CHECK(json_type("record",'$.scopeHash') IS 'text' AND json_extract("record",'$.scopeHash') IS "scope_hash"),
	CONSTRAINT "browser_file_artifact_state_mirror_check" CHECK(json_type("record",'$.state') IS 'text' AND json_extract("record",'$.state') IS "state"),
	CONSTRAINT "browser_file_artifact_action_id_mirror_check" CHECK("binding_version"<>1 OR (json_type("record",'$.actionID') IS 'text' AND json_extract("record",'$.actionID') IS "action_id")),
	CONSTRAINT "browser_file_artifact_control_id_mirror_check" CHECK("binding_version"<>1 OR (json_type("record",'$.controlID') IS 'text' AND json_extract("record",'$.controlID') IS "control_id")),
	CONSTRAINT "browser_file_artifact_shared_mirror_check" CHECK("binding_version"<>2 OR (json_type("record",'$.binding') IS 'object' AND json_extract("record",'$.binding.kind') IS 'shared-v2' AND json_type("record",'$.binding.resourceID') IS 'text' AND json_extract("record",'$.binding.resourceID') IS "shared_resource_id" AND json_type("record",'$.binding.leaseID') IS 'text' AND json_extract("record",'$.binding.leaseID') IS "shared_lease_id" AND json_type("record",'$.binding.scopeHash') IS 'text' AND json_extract("record",'$.binding.scopeHash') IS "scope_hash" AND json_type("record",'$.actionID') IS 'text' AND json_extract("record",'$.actionID') IS "shared_action_id" AND json_type("record",'$.bindingHash') IS 'text' AND length(CAST(json_extract("record",'$.bindingHash') AS BLOB))=64 AND json_extract("record",'$.bindingHash') NOT GLOB '*[^0-9a-f]*')),
	CONSTRAINT "browser_file_artifact_ordinal_mirror_check" CHECK(json_type("record",'$.ordinal') IS 'integer' AND json_extract("record",'$.ordinal') IS "ordinal"),
	CONSTRAINT "browser_file_artifact_revision_mirror_check" CHECK(json_type("record",'$.revision') IS 'integer' AND json_extract("record",'$.revision') IS "revision"),
	CONSTRAINT "browser_file_artifact_reserved_bytes_mirror_check" CHECK(json_type("record",'$.reservedBytes') IS 'integer' AND json_extract("record",'$.reservedBytes') IS "reserved_bytes"),
	CONSTRAINT "browser_file_artifact_created_at_mirror_check" CHECK(json_type("record",'$.createdAt') IS 'integer' AND json_extract("record",'$.createdAt') IS "created_at"),
	CONSTRAINT "browser_file_artifact_updated_at_mirror_check" CHECK(json_type("record",'$.updatedAt') IS 'integer' AND json_extract("record",'$.updatedAt') IS "updated_at"),
	CONSTRAINT "browser_file_artifact_release_mirror_check" CHECK(("released_at" IS NULL AND json_type("record",'$.releasedAt') IS 'null') OR ("released_at" IS NOT NULL AND json_type("record",'$.releasedAt') IS 'integer' AND json_extract("record",'$.releasedAt') IS "released_at"))
);
--> statement-breakpoint
INSERT INTO `__new_browser_file_artifact`(`artifact_id`, `instance_id`, `grant_id`, `grant_hash`, `action_id`, `control_id`, `scope_hash`, `ordinal`, `state`, `revision`, `reserved_bytes`, `record`, `record_hash`, `created_at`, `updated_at`, `released_at`) SELECT `artifact_id`, `instance_id`, `grant_id`, `grant_hash`, `action_id`, `control_id`, `scope_hash`, `ordinal`, `state`, `revision`, `reserved_bytes`, `record`, `record_hash`, `created_at`, `updated_at`, `released_at` FROM `browser_file_artifact`;--> statement-breakpoint
DROP TABLE `browser_file_artifact`;--> statement-breakpoint
ALTER TABLE `__new_browser_file_artifact` RENAME TO `browser_file_artifact`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_browser_file_grant` (
	`grant_id` text PRIMARY KEY,
	`instance_id` text NOT NULL,
	`binding_version` integer DEFAULT 1 NOT NULL,
	`control_id` text,
	`shared_resource_id` text,
	`shared_lease_id` text,
	`request_id` text NOT NULL,
	`command_hash` text NOT NULL,
	`scope_hash` text NOT NULL,
	`control_epoch` integer,
	`policy_revision` integer,
	`direction` text NOT NULL,
	`expires_at` integer NOT NULL,
	`record` text NOT NULL,
	`record_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_browser_file_grant_instance_id_browser_file_capacity_instance_id_fk` FOREIGN KEY (`instance_id`) REFERENCES `browser_file_capacity`(`instance_id`) ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT `fk_browser_file_grant_control_id_browser_control_control_id_fk` FOREIGN KEY (`control_id`) REFERENCES `browser_control`(`control_id`) ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT `fk_browser_file_grant_shared_resource_id_browser_shared_resource_resource_id_fk` FOREIGN KEY (`shared_resource_id`) REFERENCES `browser_shared_resource`(`resource_id`) ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT `fk_browser_file_grant_shared_lease_id_browser_shared_lease_lease_id_fk` FOREIGN KEY (`shared_lease_id`) REFERENCES `browser_shared_lease`(`lease_id`) ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT "browser_file_grant_binding_check" CHECK(typeof("binding_version")='integer' AND (("binding_version"=1 AND "control_id" IS NOT NULL AND "control_epoch" IS NOT NULL AND "policy_revision" IS NOT NULL AND "shared_resource_id" IS NULL AND "shared_lease_id" IS NULL) OR ("binding_version"=2 AND "control_id" IS NULL AND "control_epoch" IS NULL AND "policy_revision" IS NULL AND "shared_resource_id" IS NOT NULL AND "shared_lease_id" IS NOT NULL))),
	CONSTRAINT "browser_file_grant_grant_id_text_check" CHECK(typeof("grant_id")='text' AND length(CAST("grant_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("grant_id",char(0))=0),
	CONSTRAINT "browser_file_grant_instance_id_text_check" CHECK(typeof("instance_id")='text' AND length(CAST("instance_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("instance_id",char(0))=0),
	CONSTRAINT "browser_file_grant_request_id_text_check" CHECK(typeof("request_id")='text' AND length(CAST("request_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("request_id",char(0))=0),
	CONSTRAINT "browser_file_grant_control_id_text_check" CHECK("control_id" IS NULL OR (typeof("control_id")='text' AND length(CAST("control_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("control_id",char(0))=0)),
	CONSTRAINT "browser_file_grant_shared_resource_id_text_check" CHECK("shared_resource_id" IS NULL OR (typeof("shared_resource_id")='text' AND length(CAST("shared_resource_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("shared_resource_id",char(0))=0)),
	CONSTRAINT "browser_file_grant_shared_lease_id_text_check" CHECK("shared_lease_id" IS NULL OR (typeof("shared_lease_id")='text' AND length(CAST("shared_lease_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("shared_lease_id",char(0))=0)),
	CONSTRAINT "browser_file_grant_command_hash_digest_check" CHECK(typeof("command_hash")='text' AND length(CAST("command_hash" AS BLOB))=64 AND "command_hash" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "browser_file_grant_scope_hash_digest_check" CHECK(typeof("scope_hash")='text' AND length(CAST("scope_hash" AS BLOB))=64 AND "scope_hash" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "browser_file_grant_record_hash_digest_check" CHECK(typeof("record_hash")='text' AND length(CAST("record_hash" AS BLOB))=64 AND "record_hash" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "browser_file_grant_expires_at_integer_check" CHECK(typeof("expires_at")='integer' AND "expires_at" BETWEEN 1 AND 9007199254740991),
	CONSTRAINT "browser_file_grant_created_at_integer_check" CHECK(typeof("created_at")='integer' AND "created_at" BETWEEN 1 AND 9007199254740991),
	CONSTRAINT "browser_file_grant_control_epoch_integer_check" CHECK("control_epoch" IS NULL OR (typeof("control_epoch")='integer' AND "control_epoch" BETWEEN 1 AND 9007199254740991)),
	CONSTRAINT "browser_file_grant_policy_revision_integer_check" CHECK("policy_revision" IS NULL OR (typeof("policy_revision")='integer' AND "policy_revision" BETWEEN 1 AND 9007199254740991)),
	CONSTRAINT "browser_file_grant_direction_check" CHECK("direction" IN ('upload','download')),
	CONSTRAINT "browser_file_grant_time_check" CHECK("expires_at">"created_at"),
	CONSTRAINT "browser_file_grant_record_check" CHECK(typeof("record")='text' AND length(CAST("record" AS BLOB)) BETWEEN 1 AND 8192 AND json_valid("record") AND json_type("record") IS 'object' AND json_type("record",'$.version') IS 'integer' AND json_extract("record",'$.version') IS "binding_version"),
	CONSTRAINT "browser_file_grant_grant_id_mirror_check" CHECK(json_type("record",'$.grantID') IS 'text' AND json_extract("record",'$.grantID') IS "grant_id"),
	CONSTRAINT "browser_file_grant_instance_id_mirror_check" CHECK(json_type("record",'$.instanceID') IS 'text' AND json_extract("record",'$.instanceID') IS "instance_id"),
	CONSTRAINT "browser_file_grant_command_hash_mirror_check" CHECK(json_type("record",'$.commandHash') IS 'text' AND json_extract("record",'$.commandHash') IS "command_hash"),
	CONSTRAINT "browser_file_grant_scope_hash_mirror_check" CHECK(json_type("record",'$.scopeHash') IS 'text' AND json_extract("record",'$.scopeHash') IS "scope_hash"),
	CONSTRAINT "browser_file_grant_control_id_mirror_check" CHECK("binding_version"<>1 OR (json_type("record",'$.controlID') IS 'text' AND json_extract("record",'$.controlID') IS "control_id")),
	CONSTRAINT "browser_file_grant_control_epoch_mirror_check" CHECK("binding_version"<>1 OR (json_type("record",'$.controlEpoch') IS 'integer' AND json_extract("record",'$.controlEpoch') IS "control_epoch")),
	CONSTRAINT "browser_file_grant_policy_revision_mirror_check" CHECK("binding_version"<>1 OR (json_type("record",'$.policyRevision') IS 'integer' AND json_extract("record",'$.policyRevision') IS "policy_revision")),
	CONSTRAINT "browser_file_grant_expires_at_mirror_check" CHECK(json_type("record",'$.expiresAt') IS 'integer' AND json_extract("record",'$.expiresAt') IS "expires_at"),
	CONSTRAINT "browser_file_grant_created_at_mirror_check" CHECK(json_type("record",'$.createdAt') IS 'integer' AND json_extract("record",'$.createdAt') IS "created_at"),
	CONSTRAINT "browser_file_grant_request_mirror_check" CHECK(json_type("record",'$.command.requestID') IS 'text' AND json_extract("record",'$.command.requestID') IS "request_id" AND json_type("record",'$.preview.direction') IS 'text' AND json_extract("record",'$.preview.direction') IS "direction"),
	CONSTRAINT "browser_file_grant_shared_mirror_check" CHECK("binding_version"<>2 OR (json_type("record",'$.binding') IS 'object' AND json_extract("record",'$.binding.kind') IS 'shared-v2' AND json_type("record",'$.binding.resourceID') IS 'text' AND json_extract("record",'$.binding.resourceID') IS "shared_resource_id" AND json_type("record",'$.binding.leaseID') IS 'text' AND json_extract("record",'$.binding.leaseID') IS "shared_lease_id" AND json_type("record",'$.binding.scopeHash') IS 'text' AND json_extract("record",'$.binding.scopeHash') IS "scope_hash" AND json_type("record",'$.bindingHash') IS 'text' AND length(CAST(json_extract("record",'$.bindingHash') AS BLOB))=64 AND json_extract("record",'$.bindingHash') NOT GLOB '*[^0-9a-f]*'))
);
--> statement-breakpoint
INSERT INTO `__new_browser_file_grant`(`grant_id`, `instance_id`, `control_id`, `request_id`, `command_hash`, `scope_hash`, `control_epoch`, `policy_revision`, `direction`, `expires_at`, `record`, `record_hash`, `created_at`) SELECT `grant_id`, `instance_id`, `control_id`, `request_id`, `command_hash`, `scope_hash`, `control_epoch`, `policy_revision`, `direction`, `expires_at`, `record`, `record_hash`, `created_at` FROM `browser_file_grant`;--> statement-breakpoint
DROP TABLE `browser_file_grant`;--> statement-breakpoint
ALTER TABLE `__new_browser_file_grant` RENAME TO `browser_file_grant`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `browser_file_artifact_action_ordinal_idx` ON `browser_file_artifact` (`action_id`,`ordinal`);--> statement-breakpoint
CREATE UNIQUE INDEX `browser_file_artifact_shared_action_ordinal_idx` ON `browser_file_artifact` (`shared_action_id`,`ordinal`) WHERE "browser_file_artifact"."binding_version"=2;--> statement-breakpoint
CREATE UNIQUE INDEX `browser_file_artifact_grant_idx` ON `browser_file_artifact` (`grant_id`);--> statement-breakpoint
CREATE INDEX `browser_file_artifact_control_idx` ON `browser_file_artifact` (`control_id`,`created_at`,`artifact_id`);--> statement-breakpoint
CREATE INDEX `browser_file_artifact_shared_idx` ON `browser_file_artifact` (`shared_resource_id`,`created_at`,`artifact_id`);--> statement-breakpoint
CREATE INDEX `browser_file_artifact_custody_idx` ON `browser_file_artifact` (`instance_id`,`released_at`,`artifact_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `browser_file_grant_request_idx` ON `browser_file_grant` (`control_id`,`request_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `browser_file_grant_shared_request_idx` ON `browser_file_grant` (`shared_resource_id`,`request_id`) WHERE "browser_file_grant"."binding_version"=2;--> statement-breakpoint
CREATE INDEX `browser_file_grant_control_idx` ON `browser_file_grant` (`control_id`,`created_at`,`grant_id`);--> statement-breakpoint
CREATE INDEX `browser_file_grant_shared_idx` ON `browser_file_grant` (`shared_resource_id`,`created_at`,`grant_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `browser_shared_action_admission_idx` ON `browser_shared_action` (`admission_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `browser_shared_lease_live_idx` ON `browser_shared_lease` (`resource_id`) WHERE "browser_shared_lease"."state" IN ('pending','active');--> statement-breakpoint
CREATE UNIQUE INDEX `browser_shared_lease_epoch_idx` ON `browser_shared_lease` (`resource_id`,`lease_epoch`);--> statement-breakpoint
CREATE UNIQUE INDEX `browser_shared_lease_input_idx` ON `browser_shared_lease` (`resource_id`,`origin_input_id`) WHERE "browser_shared_lease"."origin_input_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `browser_shared_resource_request_idx` ON `browser_shared_resource` (`principal`,`session_id`,`request_id`);--> statement-breakpoint
CREATE INDEX `browser_shared_resource_live_idx` ON `browser_shared_resource` (`main_incarnation`,`state`);--> statement-breakpoint
CREATE INDEX `browser_user_selection_activity_idx` ON `browser_user_selection` (`session_id`,`activity_id`,`request_ordinal`);--> statement-breakpoint
CREATE UNIQUE INDEX `session_user_input_origin_submission_idx` ON `session_user_input_origin` (`main_incarnation`,`session_id`,`original_submission_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `session_user_input_origin_order_idx` ON `session_user_input_origin` (`main_incarnation`,`submission_order`);--> statement-breakpoint
CREATE INDEX `goal_pause_boundary_goal_idx` ON `goal_pause_boundary` (`goal_id`);