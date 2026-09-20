CREATE TABLE `recovery_command` (
	`command_id` text PRIMARY KEY,
	`descriptor_id` text,
	`attempt` text NOT NULL,
	`state` text NOT NULL,
	`expected_owner_token` text,
	`result_hash` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_recovery_command_descriptor_id_session_provider_recovery_descriptor_descriptor_id_fk` FOREIGN KEY (`descriptor_id`) REFERENCES `session_provider_recovery_descriptor`(`descriptor_id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `recovery_evidence_export` (
	`export_id` text PRIMARY KEY,
	`descriptor_id` text,
	`manifest_hash` text NOT NULL,
	`state` text NOT NULL,
	`created_at` integer NOT NULL,
	`payload` text NOT NULL,
	CONSTRAINT `fk_recovery_evidence_export_descriptor_id_session_provider_recovery_descriptor_descriptor_id_fk` FOREIGN KEY (`descriptor_id`) REFERENCES `session_provider_recovery_descriptor`(`descriptor_id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE TABLE `session_provider_recovery_descriptor` (
	`descriptor_id` text PRIMARY KEY,
	`session_id` text NOT NULL,
	`activity_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	`content_hash` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `session_provider_recovery_descriptor_session_idx` ON `session_provider_recovery_descriptor` (`session_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `session_provider_recovery_descriptor_attempt_idx` ON `session_provider_recovery_descriptor` (`session_id`,`activity_id`,`turn_id`);