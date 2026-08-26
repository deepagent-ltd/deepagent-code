CREATE TABLE `session_facade_activity` (
	`activity_id` text PRIMARY KEY,
	`subkind` text NOT NULL,
	`parent_session_id` text NOT NULL,
	`owner_session_id` text,
	`spawn_tool_call_id` text,
	`objective_text` text,
	`budget_json` text,
	`state` text NOT NULL,
	`reason_code` text,
	`source` text,
	`created_at` integer NOT NULL,
	`settled_at` integer,
	`mutation_epoch` integer NOT NULL,
	CONSTRAINT `fk_session_facade_activity_parent_session_id_session_id_fk` FOREIGN KEY (`parent_session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_session_facade_activity_owner_session_id_session_id_fk` FOREIGN KEY (`owner_session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_facade_activity_active_idx` ON `session_facade_activity` (`parent_session_id`,`subkind`) WHERE "session_facade_activity"."state" = 'active';--> statement-breakpoint
CREATE INDEX `session_facade_activity_parent_idx` ON `session_facade_activity` (`parent_session_id`,`state`,`created_at`);