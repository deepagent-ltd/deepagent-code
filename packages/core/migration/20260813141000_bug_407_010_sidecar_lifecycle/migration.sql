CREATE TABLE `file_part_artifact_discard` (
	`event_id` text PRIMARY KEY,
	`aggregate_id` text NOT NULL,
	`seq` integer NOT NULL,
	`artifact_id` text NOT NULL,
	`original_data_hash` text NOT NULL,
	`canonical_data_hash` text NOT NULL,
	`canonical_data` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_file_part_artifact_discard_artifact_id_file_part_artifact_artifact_id_fk` FOREIGN KEY (`artifact_id`) REFERENCES `file_part_artifact`(`artifact_id`) ON DELETE CASCADE
);
--> statement-breakpoint
ALTER TABLE `event_snapshot_row` ADD `aggregate_id` text NOT NULL;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_event_snapshot_attempt` (
	`snapshot_id` text PRIMARY KEY,
	`aggregate_id` text NOT NULL,
	`through_seq` integer NOT NULL,
	`expected_latest` integer NOT NULL,
	`owner_id` text,
	`codec` text NOT NULL,
	`schema_version` integer NOT NULL,
	`projection_revision` text NOT NULL,
	`cursor` text,
	`row_count` integer NOT NULL,
	`encoded_bytes` integer NOT NULL,
	`content_hash` text NOT NULL,
	`tables` text NOT NULL,
	`state` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_event_snapshot_attempt_aggregate_id_event_sequence_aggregate_id_fk` FOREIGN KEY (`aggregate_id`) REFERENCES `event_sequence`(`aggregate_id`) ON DELETE CASCADE
);
--> statement-breakpoint
INSERT INTO `__new_event_snapshot_attempt`(`snapshot_id`, `aggregate_id`, `through_seq`, `expected_latest`, `owner_id`, `codec`, `schema_version`, `projection_revision`, `cursor`, `row_count`, `encoded_bytes`, `content_hash`, `tables`, `state`, `created_at`, `updated_at`) SELECT `snapshot_id`, `aggregate_id`, `through_seq`, `expected_latest`, `owner_id`, `codec`, `schema_version`, `projection_revision`, `cursor`, `row_count`, `encoded_bytes`, `content_hash`, `tables`, `state`, `created_at`, `updated_at` FROM `event_snapshot_attempt`;--> statement-breakpoint
DROP TABLE `event_snapshot_attempt`;--> statement-breakpoint
ALTER TABLE `__new_event_snapshot_attempt` RENAME TO `event_snapshot_attempt`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `file_part_artifact_discard_aggregate_seq_idx` ON `file_part_artifact_discard` (`aggregate_id`,`seq`);