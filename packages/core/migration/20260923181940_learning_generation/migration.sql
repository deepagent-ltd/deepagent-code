CREATE TABLE `learning_generation` (
	`generation_id` text PRIMARY KEY,
	`session_id` text NOT NULL,
	`project_id` text NOT NULL,
	`activity_id` text NOT NULL,
	`workspace_path` text NOT NULL,
	`admission_json` text NOT NULL,
	`admission_hash` text NOT NULL,
	`settled_at` integer NOT NULL,
	`trigger` text,
	`claimed_at` integer,
	`admitted_at` integer,
	CONSTRAINT `fk_learning_generation_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`),
	CONSTRAINT `fk_learning_generation_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`),
	CONSTRAINT "learning_generation_payload_json_check" CHECK(json_valid("admission_json") AND json_type("admission_json") = 'object'),
	CONSTRAINT "learning_generation_payload_hash_check" CHECK(length("admission_hash") = 64 AND "admission_hash" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "learning_generation_trigger_check" CHECK("trigger" IS NULL OR "trigger" IN ('idle', 'pause', 'project_switch')),
	CONSTRAINT "learning_generation_claim_check" CHECK(("trigger" IS NULL AND "claimed_at" IS NULL AND "admitted_at" IS NULL) OR ("trigger" IS NOT NULL AND "claimed_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `learning_generation_activity_idx` ON `learning_generation` (`session_id`,`activity_id`);--> statement-breakpoint
CREATE INDEX `learning_generation_pending_idx` ON `learning_generation` (`trigger`,`settled_at`);