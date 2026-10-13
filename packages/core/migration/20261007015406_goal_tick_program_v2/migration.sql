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
	CONSTRAINT "goal_tick_checkpoint_version_check" CHECK(typeof("version")='integer' AND "version" IN (1,2) AND typeof("revision")='integer' AND "revision" BETWEEN 0 AND 9007199254740991 AND typeof("tick_seq")='integer' AND "tick_seq" BETWEEN 0 AND 9007199254740991 AND typeof("parent_checked_through_seq")='integer' AND "parent_checked_through_seq" BETWEEN 0 AND 9007199254740991),
	CONSTRAINT "goal_tick_checkpoint_state_check" CHECK("state" IN ('prepared','running','mirror_pending','committed','halted','recovery_required')),
	CONSTRAINT "goal_tick_checkpoint_hash_check" CHECK(length("binding_hash")=64 AND "binding_hash" NOT GLOB '*[^0-9a-f]*' AND length("role_manifest_hash")=64 AND "role_manifest_hash" NOT GLOB '*[^0-9a-f]*' AND length("journal_hash")=64 AND "journal_hash" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "goal_tick_checkpoint_json_check" CHECK(json_valid("journal") AND json_type("journal")='object' AND length(CAST("journal" AS BLOB))<=1048576),
	CONSTRAINT "goal_tick_checkpoint_program_check" CHECK("version"=1 OR coalesce(json_type("journal",'$.version')='integer' AND json_extract("journal",'$.version')=2 AND json_type("journal",'$.program')='object' AND json_type("journal",'$.program.version')='integer' AND json_extract("journal",'$.program.version')=2 AND json_extract("journal",'$.program.contract')='owned-goal-v2' AND json_type("journal",'$.program.roles')='array' AND json_type("journal",'$.program.documents')='array' AND json_type("journal",'$.program.localEffectSlots')='integer' AND json_type("journal",'$.program.nextStateBytes')='integer' AND json_type("journal",'$.programHash')='text' AND json_type("journal",'$.parent')='object' AND json_type("journal",'$.cursor')='object' AND json_type("journal",'$.activations')='array' AND json_type("journal",'$.dispositions')='array' AND json_type("journal",'$.results')='array' AND json_type("journal",'$.localEffects')='array' AND json_type("journal",'$.documents')='array' AND json_type("journal",'$.nextState') IN ('text','null') AND json_type("journal",'$.nextStateHash') IN ('text','null'),0)),
	CONSTRAINT "goal_tick_checkpoint_capacity_check" CHECK(typeof("logical_bytes")='integer' AND typeof("reserved_bytes")='integer' AND "logical_bytes"=length(CAST("journal" AS BLOB)) AND "logical_bytes" BETWEEN 2 AND 1048576 AND "reserved_bytes">="logical_bytes" AND "reserved_bytes"<=1048576),
	CONSTRAINT "goal_tick_checkpoint_error_check" CHECK("error_code" IS NULL OR length("error_code")<=128),
	CONSTRAINT "goal_tick_checkpoint_time_check" CHECK(typeof("created_at")='integer' AND typeof("updated_at")='integer' AND "created_at" BETWEEN 0 AND 9007199254740991 AND "updated_at" BETWEEN "created_at" AND 9007199254740991)
);
--> statement-breakpoint
INSERT INTO `__new_goal_tick_checkpoint`(`permit_id`, `goal_id`, `tick_seq`, `version`, `revision`, `binding_hash`, `role_manifest_hash`, `parent_checked_through_seq`, `state`, `journal`, `journal_hash`, `logical_bytes`, `reserved_bytes`, `error_code`, `created_at`, `updated_at`) SELECT `permit_id`, `goal_id`, `tick_seq`, `version`, `revision`, `binding_hash`, `role_manifest_hash`, `parent_checked_through_seq`, `state`, `journal`, `journal_hash`, `logical_bytes`, `reserved_bytes`, `error_code`, `created_at`, `updated_at` FROM `goal_tick_checkpoint`;--> statement-breakpoint
DROP TABLE `goal_tick_checkpoint`;--> statement-breakpoint
ALTER TABLE `__new_goal_tick_checkpoint` RENAME TO `goal_tick_checkpoint`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `goal_tick_checkpoint_goal_tick_idx` ON `goal_tick_checkpoint` (`goal_id`,`tick_seq`);--> statement-breakpoint
CREATE INDEX `goal_tick_checkpoint_state_idx` ON `goal_tick_checkpoint` (`state`);