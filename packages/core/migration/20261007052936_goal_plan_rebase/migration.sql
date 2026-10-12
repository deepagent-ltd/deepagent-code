CREATE TABLE `goal_plan_rebase` (
	`edit_id` text PRIMARY KEY,
	`goal_id` text NOT NULL,
	`session_id` text NOT NULL,
	`version` integer NOT NULL,
	`revision` integer NOT NULL,
	`state` text NOT NULL,
	`source_plan_revision` integer NOT NULL,
	`target_plan_revision` integer NOT NULL,
	`source_control_revision` integer NOT NULL,
	`expected_control_revision` integer NOT NULL,
	`source_receipt_hash` text,
	`journal` text NOT NULL,
	`journal_hash` text NOT NULL,
	`logical_bytes` integer NOT NULL,
	`reserved_bytes` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_goal_plan_rebase_goal_id_goal_control_goal_id_fk` FOREIGN KEY (`goal_id`) REFERENCES `goal_control`(`goal_id`),
	CONSTRAINT "goal_plan_rebase_identity_check" CHECK("edit_id" IS NOT NULL AND typeof("edit_id")='text' AND length(CAST("edit_id" AS BLOB)) BETWEEN 1 AND 128 AND "edit_id" NOT GLOB '*[^A-Za-z0-9_.:~-]*' AND typeof("goal_id")='text' AND length(CAST("goal_id" AS BLOB)) BETWEEN 1 AND 512 AND typeof("session_id")='text' AND length(CAST("session_id" AS BLOB)) BETWEEN 1 AND 512),
	CONSTRAINT "goal_plan_rebase_version_check" CHECK(typeof("version")='integer' AND "version"=1 AND typeof("revision")='integer' AND "revision" BETWEEN 0 AND 9007199254740991),
	CONSTRAINT "goal_plan_rebase_cursor_check" CHECK(typeof("source_plan_revision")='integer' AND "source_plan_revision" BETWEEN 0 AND 9007199254740990 AND typeof("target_plan_revision")='integer' AND "target_plan_revision"="source_plan_revision"+1 AND typeof("source_control_revision")='integer' AND "source_control_revision" BETWEEN 0 AND 9007199254740991 AND typeof("expected_control_revision")='integer' AND "expected_control_revision" BETWEEN "source_control_revision" AND 9007199254740991),
	CONSTRAINT "goal_plan_rebase_state_check" CHECK("state" IN ('waiting_boundary','ready','prepared','mirror_pending','committed','cancelled','superseded','recovery_required')),
	CONSTRAINT "goal_plan_rebase_hash_check" CHECK(typeof("journal_hash")='text' AND length(CAST("journal_hash" AS BLOB))=64 AND "journal_hash" NOT GLOB '*[^0-9a-f]*' AND ("source_receipt_hash" IS NULL OR (typeof("source_receipt_hash")='text' AND length(CAST("source_receipt_hash" AS BLOB))=64 AND "source_receipt_hash" NOT GLOB '*[^0-9a-f]*'))),
	CONSTRAINT "goal_plan_rebase_json_check" CHECK(CASE WHEN typeof("journal")='text' AND length(CAST("journal" AS BLOB)) BETWEEN 1 AND 1048576 AND json_valid("journal") THEN coalesce(json_type("journal")='object' AND json_type("journal",'$.version')='integer' AND json_extract("journal",'$.version')=1 AND json_type("journal",'$.documents')='array' AND json_array_length("journal",'$.documents')<=8 AND json_type("journal",'$.commands')='array' AND json_array_length("journal",'$.commands') BETWEEN 1 AND 32,0) ELSE 0 END),
	CONSTRAINT "goal_plan_rebase_time_check" CHECK(typeof("created_at")='integer' AND "created_at" BETWEEN 0 AND 9007199254740991 AND typeof("updated_at")='integer' AND "updated_at" BETWEEN "created_at" AND 9007199254740991),
	CONSTRAINT "goal_plan_rebase_capacity_check" CHECK(typeof("logical_bytes")='integer' AND "logical_bytes"=length(CAST("journal" AS BLOB)) AND "logical_bytes" BETWEEN 1 AND 1048576 AND typeof("reserved_bytes")='integer' AND "reserved_bytes" BETWEEN "logical_bytes" AND 1048576)
);
--> statement-breakpoint
ALTER TABLE `goal_control` ADD `plan_revision` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `goal_control` ADD `plan_rebase_id` text;--> statement-breakpoint
ALTER TABLE `goal_control` ADD `pending_rebase_id` text;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_goal_control` (
	`goal_id` text PRIMARY KEY,
	`session_id` text NOT NULL,
	`is_current` integer NOT NULL,
	`plan_doc_id` text NOT NULL,
	`project_id` text NOT NULL,
	`directory` text NOT NULL,
	`workspace_id` text,
	`driver_mode` text NOT NULL,
	`initialization` text NOT NULL,
	`initialization_hash` text NOT NULL,
	`preparation` text NOT NULL,
	`revision` integer NOT NULL,
	`requested_phase` text NOT NULL,
	`observed_phase` text,
	`next_seq` integer NOT NULL,
	`plan_version` integer NOT NULL,
	`plan_revision` integer DEFAULT 0 NOT NULL,
	`plan_rebase_id` text,
	`pending_rebase_id` text,
	`recovery_reason` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "goal_control_phase_check" CHECK("requested_phase" IN ('running','paused','stopped','done','needs_human','rolled_back')),
	CONSTRAINT "goal_control_preparation_check" CHECK("preparation" IN ('preparing','ready','recovery_required')),
	CONSTRAINT "goal_control_mode_check" CHECK("driver_mode" IN ('event','resident')),
	CONSTRAINT "goal_control_counts_check" CHECK("revision" >= 0 AND "next_seq" >= 0 AND "plan_version" >= 0),
	CONSTRAINT "goal_control_current_check" CHECK("is_current" IN (0,1)),
	CONSTRAINT "goal_control_plan_revision_check" CHECK(typeof("plan_revision")='integer' AND "plan_revision" BETWEEN 0 AND 9007199254740991),
	CONSTRAINT "goal_control_plan_rebase_id_check" CHECK("plan_rebase_id" IS NULL OR (typeof("plan_rebase_id")='text' AND length(CAST("plan_rebase_id" AS BLOB)) BETWEEN 1 AND 128 AND "plan_rebase_id" NOT GLOB '*[^A-Za-z0-9_.:~-]*')),
	CONSTRAINT "goal_control_pending_rebase_id_check" CHECK("pending_rebase_id" IS NULL OR (typeof("pending_rebase_id")='text' AND length(CAST("pending_rebase_id" AS BLOB)) BETWEEN 1 AND 128 AND "pending_rebase_id" NOT GLOB '*[^A-Za-z0-9_.:~-]*')),
	CONSTRAINT "goal_control_initialization_check" CHECK(json_valid("initialization") AND json_type("initialization") = 'object'),
	CONSTRAINT "goal_control_hash_check" CHECK(length("initialization_hash") = 64 AND "initialization_hash" NOT GLOB '*[^0-9a-f]*')
);
--> statement-breakpoint
INSERT INTO `__new_goal_control`(`goal_id`, `session_id`, `is_current`, `plan_doc_id`, `project_id`, `directory`, `workspace_id`, `driver_mode`, `initialization`, `initialization_hash`, `preparation`, `revision`, `requested_phase`, `observed_phase`, `next_seq`, `plan_version`, `recovery_reason`, `created_at`, `updated_at`) SELECT `goal_id`, `session_id`, `is_current`, `plan_doc_id`, `project_id`, `directory`, `workspace_id`, `driver_mode`, `initialization`, `initialization_hash`, `preparation`, `revision`, `requested_phase`, `observed_phase`, `next_seq`, `plan_version`, `recovery_reason`, `created_at`, `updated_at` FROM `goal_control`;--> statement-breakpoint
DROP TABLE `goal_control`;--> statement-breakpoint
ALTER TABLE `__new_goal_control` RENAME TO `goal_control`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_goal_tick_checkpoint` (
	`permit_id` text PRIMARY KEY,
	`goal_id` text NOT NULL,
	`tick_seq` integer NOT NULL,
	`version` integer NOT NULL,
	`revision` integer NOT NULL,
	`binding_hash` text NOT NULL,
	`role_manifest_hash` text NOT NULL,
	`parent_checked_through_seq` integer NOT NULL,
	`state` text NOT NULL,
	`journal` text NOT NULL,
	`journal_hash` text NOT NULL,
	`logical_bytes` integer NOT NULL,
	`reserved_bytes` integer NOT NULL,
	`error_code` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_goal_tick_checkpoint_permit_id_goal_tick_permit_permit_id_fk` FOREIGN KEY (`permit_id`) REFERENCES `goal_tick_permit`(`permit_id`),
	CONSTRAINT `fk_goal_tick_checkpoint_goal_id_goal_control_goal_id_fk` FOREIGN KEY (`goal_id`) REFERENCES `goal_control`(`goal_id`),
	CONSTRAINT "goal_tick_checkpoint_identity_check" CHECK("permit_id" IS NOT NULL AND typeof("permit_id")='text' AND typeof("goal_id")='text' AND length("permit_id") BETWEEN 1 AND 512 AND length("goal_id") BETWEEN 1 AND 512),
	CONSTRAINT "goal_tick_checkpoint_version_check" CHECK(typeof("version")='integer' AND "version" IN (1,2,3) AND typeof("revision")='integer' AND "revision" BETWEEN 0 AND 9007199254740991 AND typeof("tick_seq")='integer' AND "tick_seq" BETWEEN 0 AND 9007199254740991 AND typeof("parent_checked_through_seq")='integer' AND "parent_checked_through_seq" BETWEEN 0 AND 9007199254740991),
	CONSTRAINT "goal_tick_checkpoint_state_check" CHECK("state" IN ('prepared','running','mirror_pending','committed','halted','recovery_required')),
	CONSTRAINT "goal_tick_checkpoint_hash_check" CHECK(length("binding_hash")=64 AND "binding_hash" NOT GLOB '*[^0-9a-f]*' AND length("role_manifest_hash")=64 AND "role_manifest_hash" NOT GLOB '*[^0-9a-f]*' AND length("journal_hash")=64 AND "journal_hash" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "goal_tick_checkpoint_json_check" CHECK(json_valid("journal") AND json_type("journal")='object' AND length(CAST("journal" AS BLOB))<=1048576),
	CONSTRAINT "goal_tick_checkpoint_program_check" CHECK("version"=1 OR coalesce(json_type("journal",'$.version')='integer' AND json_extract("journal",'$.version')="version" AND json_type("journal",'$.program')='object' AND json_type("journal",'$.program.version')='integer' AND json_extract("journal",'$.program.version')="version" AND json_extract("journal",'$.program.contract')='owned-goal-v2' AND json_type("journal",'$.program.roles')='array' AND json_type("journal",'$.program.documents')='array' AND json_type("journal",'$.program.localEffectSlots')='integer' AND json_type("journal",'$.program.nextStateBytes')='integer' AND json_type("journal",'$.programHash')='text' AND json_type("journal",'$.parent')='object' AND json_type("journal",'$.cursor')='object' AND json_type("journal",'$.activations')='array' AND json_type("journal",'$.dispositions')='array' AND json_type("journal",'$.results')='array' AND json_type("journal",'$.localEffects')='array' AND json_type("journal",'$.documents')='array' AND json_type("journal",'$.nextState') IN ('text','null') AND json_type("journal",'$.nextStateHash') IN ('text','null'),0)),
	CONSTRAINT "goal_tick_checkpoint_plan_lineage_check" CHECK("version"<>3 OR coalesce(json_type("journal",'$.program.planLineage')='object' AND json_type("journal",'$.program.planLineage.version')='integer' AND json_extract("journal",'$.program.planLineage.version')=1 AND json_type("journal",'$.program.planLineage.planRevision')='integer' AND json_extract("journal",'$.program.planLineage.planRevision') BETWEEN 0 AND 9007199254740991 AND (json_type("journal",'$.program.planLineage.rebaseID')='null' OR (json_type("journal",'$.program.planLineage.rebaseID')='text' AND length(CAST(json_extract("journal",'$.program.planLineage.rebaseID') AS BLOB)) BETWEEN 1 AND 128 AND json_extract("journal",'$.program.planLineage.rebaseID') NOT GLOB '*[^A-Za-z0-9_.:~-]*')) AND json_type("journal",'$.program.planLineage.planDocID')='text' AND length(CAST(json_extract("journal",'$.program.planLineage.planDocID') AS BLOB)) BETWEEN 1 AND 128 AND json_type("journal",'$.program.planLineage.planDocVersion')='integer' AND json_extract("journal",'$.program.planLineage.planDocVersion') BETWEEN 1 AND 9007199254740991 AND json_type("journal",'$.program.planLineage.sourceReceiptHash')='text' AND length(CAST(json_extract("journal",'$.program.planLineage.sourceReceiptHash') AS BLOB))=64 AND json_extract("journal",'$.program.planLineage.sourceReceiptHash') NOT GLOB '*[^0-9a-f]*' AND json_type("journal",'$.program.planLineage.planDocHash')='text' AND length(CAST(json_extract("journal",'$.program.planLineage.planDocHash') AS BLOB))=64 AND json_extract("journal",'$.program.planLineage.planDocHash') NOT GLOB '*[^0-9a-f]*' AND json_type("journal",'$.program.planLineage.baselineDocsHash')='text' AND length(CAST(json_extract("journal",'$.program.planLineage.baselineDocsHash') AS BLOB))=64 AND json_extract("journal",'$.program.planLineage.baselineDocsHash') NOT GLOB '*[^0-9a-f]*',0)),
	CONSTRAINT "goal_tick_checkpoint_capacity_check" CHECK(typeof("logical_bytes")='integer' AND typeof("reserved_bytes")='integer' AND "logical_bytes"=length(CAST("journal" AS BLOB)) AND "logical_bytes" BETWEEN 2 AND 1048576 AND "reserved_bytes">="logical_bytes" AND "reserved_bytes"<=1048576),
	CONSTRAINT "goal_tick_checkpoint_error_check" CHECK("error_code" IS NULL OR length("error_code")<=128),
	CONSTRAINT "goal_tick_checkpoint_time_check" CHECK(typeof("created_at")='integer' AND typeof("updated_at")='integer' AND "created_at" BETWEEN 0 AND 9007199254740991 AND "updated_at" BETWEEN "created_at" AND 9007199254740991)
);
--> statement-breakpoint
INSERT INTO `__new_goal_tick_checkpoint`(`permit_id`, `goal_id`, `tick_seq`, `version`, `revision`, `binding_hash`, `role_manifest_hash`, `parent_checked_through_seq`, `state`, `journal`, `journal_hash`, `logical_bytes`, `reserved_bytes`, `error_code`, `created_at`, `updated_at`) SELECT `permit_id`, `goal_id`, `tick_seq`, `version`, `revision`, `binding_hash`, `role_manifest_hash`, `parent_checked_through_seq`, `state`, `journal`, `journal_hash`, `logical_bytes`, `reserved_bytes`, `error_code`, `created_at`, `updated_at` FROM `goal_tick_checkpoint`;--> statement-breakpoint
DROP TABLE `goal_tick_checkpoint`;--> statement-breakpoint
ALTER TABLE `__new_goal_tick_checkpoint` RENAME TO `goal_tick_checkpoint`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_goal_control_command` (
	`command_id` text PRIMARY KEY,
	`session_id` text NOT NULL,
	`goal_id` text NOT NULL,
	`request_id` text NOT NULL,
	`request_hash` text NOT NULL,
	`action` text NOT NULL,
	`revision` integer NOT NULL,
	`receipt` text,
	`wake_state` text NOT NULL,
	`wake_key` text NOT NULL,
	`tick_seq` integer NOT NULL,
	`plan_version` integer NOT NULL,
	`publish_attempts` integer NOT NULL,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_goal_control_command_goal_id_goal_control_goal_id_fk` FOREIGN KEY (`goal_id`) REFERENCES `goal_control`(`goal_id`),
	CONSTRAINT "goal_control_command_action_check" CHECK("action" IN ('start','pause','resume','stop','rebase_begin','rebase_apply','rebase_cancel','rebase_reconcile')),
	CONSTRAINT "goal_control_command_wake_check" CHECK("wake_state" IN ('none','pending','published','superseded')),
	CONSTRAINT "goal_control_command_receipt_check" CHECK("receipt" IS NULL OR (json_valid("receipt") AND json_type("receipt") = 'object'))
);
--> statement-breakpoint
INSERT INTO `__new_goal_control_command`(`command_id`, `session_id`, `goal_id`, `request_id`, `request_hash`, `action`, `revision`, `receipt`, `wake_state`, `wake_key`, `tick_seq`, `plan_version`, `publish_attempts`, `last_error`, `created_at`, `updated_at`) SELECT `command_id`, `session_id`, `goal_id`, `request_id`, `request_hash`, `action`, `revision`, `receipt`, `wake_state`, `wake_key`, `tick_seq`, `plan_version`, `publish_attempts`, `last_error`, `created_at`, `updated_at` FROM `goal_control_command`;--> statement-breakpoint
DROP TABLE `goal_control_command`;--> statement-breakpoint
ALTER TABLE `__new_goal_control_command` RENAME TO `goal_control_command`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `goal_control_current_idx` ON `goal_control` (`session_id`) WHERE "goal_control"."is_current" = 1;--> statement-breakpoint
CREATE UNIQUE INDEX `goal_tick_checkpoint_goal_tick_idx` ON `goal_tick_checkpoint` (`goal_id`,`tick_seq`);--> statement-breakpoint
CREATE INDEX `goal_tick_checkpoint_state_idx` ON `goal_tick_checkpoint` (`state`);--> statement-breakpoint
CREATE UNIQUE INDEX `goal_control_command_request_idx` ON `goal_control_command` (`session_id`,`request_id`);--> statement-breakpoint
CREATE INDEX `goal_control_command_wake_idx` ON `goal_control_command` (`wake_state`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `goal_plan_rebase_active_idx` ON `goal_plan_rebase` (`goal_id`) WHERE "goal_plan_rebase"."state" NOT IN ('committed','cancelled','superseded');--> statement-breakpoint
CREATE UNIQUE INDEX `goal_plan_rebase_target_idx` ON `goal_plan_rebase` (`goal_id`,`target_plan_revision`) WHERE "goal_plan_rebase"."state" = 'committed';--> statement-breakpoint
CREATE INDEX `goal_plan_rebase_session_idx` ON `goal_plan_rebase` (`session_id`,`created_at`);