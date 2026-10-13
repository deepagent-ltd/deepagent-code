CREATE TABLE `goal_control_command` (
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
	CONSTRAINT "goal_control_command_action_check" CHECK("action" IN ('start','pause','resume','stop')),
	CONSTRAINT "goal_control_command_wake_check" CHECK("wake_state" IN ('none','pending','published','superseded')),
	CONSTRAINT "goal_control_command_receipt_check" CHECK("receipt" IS NULL OR (json_valid("receipt") AND json_type("receipt") = 'object'))
);
--> statement-breakpoint
CREATE TABLE `goal_control` (
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
	`recovery_reason` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "goal_control_phase_check" CHECK("requested_phase" IN ('running','paused','stopped','done','needs_human','rolled_back')),
	CONSTRAINT "goal_control_preparation_check" CHECK("preparation" IN ('preparing','ready','recovery_required')),
	CONSTRAINT "goal_control_mode_check" CHECK("driver_mode" IN ('event','resident')),
	CONSTRAINT "goal_control_counts_check" CHECK("revision" >= 0 AND "next_seq" >= 0 AND "plan_version" >= 0),
	CONSTRAINT "goal_control_current_check" CHECK("is_current" IN (0,1)),
	CONSTRAINT "goal_control_initialization_check" CHECK(json_valid("initialization") AND json_type("initialization") = 'object'),
	CONSTRAINT "goal_control_hash_check" CHECK(length("initialization_hash") = 64 AND "initialization_hash" NOT GLOB '*[^0-9a-f]*')
);
--> statement-breakpoint
CREATE TABLE `goal_tick_permit` (
	`permit_id` text PRIMARY KEY,
	`goal_id` text NOT NULL,
	`tick_seq` integer NOT NULL,
	`control_revision` integer NOT NULL,
	`plan_version` integer NOT NULL,
	`owner_id` text NOT NULL,
	`token` text NOT NULL,
	`state` text NOT NULL,
	`next_seq` integer,
	`next_plan_version` integer,
	`outcome` text,
	`child_sessions` text NOT NULL,
	`interrupt_state` text NOT NULL,
	`created_at` integer NOT NULL,
	`settled_at` integer,
	CONSTRAINT `fk_goal_tick_permit_goal_id_goal_control_goal_id_fk` FOREIGN KEY (`goal_id`) REFERENCES `goal_control`(`goal_id`),
	CONSTRAINT "goal_tick_permit_state_check" CHECK("state" IN ('issued','settled','unknown')),
	CONSTRAINT "goal_tick_permit_interrupt_check" CHECK("interrupt_state" IN ('none','requested','unconfirmed')),
	CONSTRAINT "goal_tick_permit_children_check" CHECK(json_valid("child_sessions") AND json_type("child_sessions") = 'array'),
	CONSTRAINT "goal_tick_permit_outcome_check" CHECK("outcome" IS NULL OR "outcome" IN ('running','paused','stopped','done','needs_human','rolled_back'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `goal_control_command_request_idx` ON `goal_control_command` (`session_id`,`request_id`);
--> statement-breakpoint
CREATE INDEX `goal_control_command_wake_idx` ON `goal_control_command` (`wake_state`,`created_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `goal_control_current_idx` ON `goal_control` (`session_id`) WHERE "goal_control"."is_current" = 1;
--> statement-breakpoint
CREATE UNIQUE INDEX `goal_tick_permit_cursor_idx` ON `goal_tick_permit` (`goal_id`,`tick_seq`);
--> statement-breakpoint
CREATE INDEX `goal_tick_permit_active_idx` ON `goal_tick_permit` (`goal_id`,`state`);
