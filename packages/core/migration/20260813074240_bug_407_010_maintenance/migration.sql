CREATE TABLE `file_part_artifact_binding` (
	`event_id` text PRIMARY KEY,
	`aggregate_id` text NOT NULL,
	`seq` integer NOT NULL,
	`part_id` text NOT NULL,
	`artifact_id` text NOT NULL,
	`original_data_hash` text NOT NULL,
	`canonical_data_hash` text NOT NULL,
	`canonical_data` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_file_part_artifact_binding_aggregate_id_event_sequence_aggregate_id_fk` FOREIGN KEY (`aggregate_id`) REFERENCES `event_sequence`(`aggregate_id`) ON DELETE CASCADE,
	CONSTRAINT `fk_file_part_artifact_binding_artifact_id_file_part_artifact_artifact_id_fk` FOREIGN KEY (`artifact_id`) REFERENCES `file_part_artifact`(`artifact_id`) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE TABLE `file_part_artifact_chunk` (
	`artifact_id` text NOT NULL,
	`chunk_index` integer NOT NULL,
	`data` blob NOT NULL,
	`chunk_hash` text NOT NULL,
	CONSTRAINT `file_part_artifact_chunk_pk` PRIMARY KEY(`artifact_id`, `chunk_index`),
	CONSTRAINT `fk_file_part_artifact_chunk_artifact_id_file_part_artifact_artifact_id_fk` FOREIGN KEY (`artifact_id`) REFERENCES `file_part_artifact`(`artifact_id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `file_part_artifact_import` (
	`event_id` text PRIMARY KEY,
	`aggregate_id` text NOT NULL,
	`seq` integer NOT NULL,
	`artifact_id` text NOT NULL,
	`original_data_hash` text NOT NULL,
	`canonical_data_hash` text NOT NULL,
	`canonical_data` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_file_part_artifact_import_artifact_id_file_part_artifact_artifact_id_fk` FOREIGN KEY (`artifact_id`) REFERENCES `file_part_artifact`(`artifact_id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `file_part_artifact` (
	`artifact_id` text PRIMARY KEY,
	`body_hash` text NOT NULL UNIQUE,
	`body_bytes` integer NOT NULL,
	`chunk_bytes` integer NOT NULL,
	`chunk_count` integer NOT NULL,
	`codec_version` integer NOT NULL,
	`complete` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `session_transfer_operation` (
	`transfer_id` text PRIMARY KEY,
	`session_id` text NOT NULL,
	`source_workspace_id` text,
	`target_workspace_id` text,
	`source_owner_id` text,
	`target_owner_id` text,
	`source_event_seq` integer NOT NULL,
	`source_mutation_epoch` integer NOT NULL,
	`snapshot_id` text,
	`snapshot_hash` text,
	`state` text NOT NULL,
	`request_hash` text NOT NULL,
	`error_code` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`completed_at` integer,
	CONSTRAINT `fk_session_transfer_operation_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `session_transfer_target_receipt` (
	`transfer_id` text PRIMARY KEY,
	`session_id` text NOT NULL,
	`source_snapshot_id` text NOT NULL,
	`source_snapshot_hash` text NOT NULL,
	`source_event_seq` integer NOT NULL,
	`target_workspace_id` text,
	`target_owner_id` text,
	`state` text NOT NULL,
	`activated_snapshot_id` text,
	`activated_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `event_artifact_chunk` (
	`artifact_id` text NOT NULL,
	`chunk_index` integer NOT NULL,
	`data` blob NOT NULL,
	`chunk_hash` text NOT NULL,
	CONSTRAINT `event_artifact_chunk_pk` PRIMARY KEY(`artifact_id`, `chunk_index`),
	CONSTRAINT `fk_event_artifact_chunk_artifact_id_event_artifact_artifact_id_fk` FOREIGN KEY (`artifact_id`) REFERENCES `event_artifact`(`artifact_id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `event_artifact` (
	`artifact_id` text PRIMARY KEY,
	`event_id` text NOT NULL,
	`aggregate_id` text NOT NULL,
	`seq` integer NOT NULL,
	`kind` text NOT NULL,
	`original_data_hash` text NOT NULL,
	`canonical_data_hash` text NOT NULL,
	`canonical_data` text NOT NULL,
	`body_hash` text NOT NULL,
	`body_bytes` integer NOT NULL,
	`chunk_count` integer NOT NULL,
	`codec_version` integer NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_event_artifact_aggregate_id_event_sequence_aggregate_id_fk` FOREIGN KEY (`aggregate_id`) REFERENCES `event_sequence`(`aggregate_id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `event_compaction_receipt` (
	`aggregate_id` text PRIMARY KEY,
	`snapshot_id` text NOT NULL,
	`through_seq` integer NOT NULL,
	`codec` text NOT NULL,
	`schema_version` integer NOT NULL,
	`cursor_seq` integer NOT NULL,
	`deleted_count` integer NOT NULL,
	`state` text NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_event_compaction_receipt_aggregate_id_event_sequence_aggregate_id_fk` FOREIGN KEY (`aggregate_id`) REFERENCES `event_sequence`(`aggregate_id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `event_dedupe` (
	`aggregate_id` text NOT NULL,
	`seq` integer NOT NULL,
	`event_id` text NOT NULL,
	`type` text NOT NULL,
	`data_hash` text NOT NULL,
	`source_data` text,
	`compacted_at` integer NOT NULL,
	CONSTRAINT `fk_event_dedupe_aggregate_id_event_sequence_aggregate_id_fk` FOREIGN KEY (`aggregate_id`) REFERENCES `event_sequence`(`aggregate_id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `event_snapshot_attempt` (
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
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `event_snapshot_chunk` (
	`row_hash` text NOT NULL,
	`chunk_index` integer NOT NULL,
	`data` blob NOT NULL,
	`chunk_hash` text NOT NULL,
	CONSTRAINT `event_snapshot_chunk_pk` PRIMARY KEY(`row_hash`, `chunk_index`)
);
--> statement-breakpoint
CREATE TABLE `event_snapshot_row` (
	`snapshot_id` text NOT NULL,
	`row_index` integer NOT NULL,
	`table_name` text NOT NULL,
	`row_key` text NOT NULL,
	`row_hash` text NOT NULL,
	`row_bytes` integer NOT NULL,
	`chunk_count` integer NOT NULL,
	`chain_hash` text NOT NULL,
	CONSTRAINT `event_snapshot_row_pk` PRIMARY KEY(`snapshot_id`, `row_index`)
);
--> statement-breakpoint
CREATE TABLE `event_snapshot` (
	`snapshot_id` text PRIMARY KEY,
	`aggregate_id` text NOT NULL,
	`through_seq` integer NOT NULL,
	`sync_seq` integer NOT NULL,
	`codec` text NOT NULL,
	`schema_version` integer NOT NULL,
	`snapshot_hash` text NOT NULL,
	`body` text NOT NULL,
	`owner_id` text,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_event_snapshot_aggregate_id_event_sequence_aggregate_id_fk` FOREIGN KEY (`aggregate_id`) REFERENCES `event_sequence`(`aggregate_id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `event_sync_backfill` (
	`id` integer PRIMARY KEY,
	`state` text NOT NULL,
	`cursor_rowid` integer NOT NULL,
	`high_water_rowid` integer NOT NULL,
	`processed_count` integer NOT NULL,
	`started_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`completed_at` integer
);
--> statement-breakpoint
CREATE TABLE `event_sync_index` (
	`sync_seq` integer PRIMARY KEY,
	`event_id` text NOT NULL UNIQUE,
	`aggregate_id` text NOT NULL,
	`seq` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `event_sync_sequence` (
	`id` integer PRIMARY KEY,
	`seq` integer NOT NULL,
	`generation` text NOT NULL,
	`cursor_secret` text NOT NULL,
	`backfill_complete` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `workspace_sync_cursor` (
	`workspace_id` text NOT NULL,
	`remote_fingerprint` text NOT NULL,
	`cursor` text NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `workspace_sync_cursor_pk` PRIMARY KEY(`workspace_id`, `remote_fingerprint`)
);
--> statement-breakpoint
ALTER TABLE `event_sequence` ADD `retention_floor_seq` integer;--> statement-breakpoint
ALTER TABLE `event_sequence` ADD `snapshot_id` text;--> statement-breakpoint
ALTER TABLE `event_sequence` ADD `write_fence_transfer_id` text;--> statement-breakpoint
ALTER TABLE `event` ADD `sync_seq` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `file_part_artifact_binding_aggregate_seq_idx` ON `file_part_artifact_binding` (`aggregate_id`,`seq`);--> statement-breakpoint
CREATE INDEX `file_part_artifact_binding_part_idx` ON `file_part_artifact_binding` (`aggregate_id`,`part_id`,`seq`);--> statement-breakpoint
CREATE UNIQUE INDEX `file_part_artifact_import_aggregate_seq_idx` ON `file_part_artifact_import` (`aggregate_id`,`seq`);--> statement-breakpoint
CREATE UNIQUE INDEX `session_transfer_operation_session_request_idx` ON `session_transfer_operation` (`session_id`,`request_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `session_transfer_operation_active_idx` ON `session_transfer_operation` (`session_id`) WHERE "session_transfer_operation"."state" NOT IN ('target_activated', 'aborted');--> statement-breakpoint
CREATE UNIQUE INDEX `event_artifact_event_idx` ON `event_artifact` (`event_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `event_artifact_aggregate_seq_idx` ON `event_artifact` (`aggregate_id`,`seq`);--> statement-breakpoint
CREATE UNIQUE INDEX `event_dedupe_aggregate_seq_idx` ON `event_dedupe` (`aggregate_id`,`seq`);--> statement-breakpoint
CREATE UNIQUE INDEX `event_dedupe_event_idx` ON `event_dedupe` (`event_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `event_snapshot_row_identity_idx` ON `event_snapshot_row` (`snapshot_id`,`table_name`,`row_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `event_snapshot_aggregate_seq_idx` ON `event_snapshot` (`aggregate_id`,`through_seq`);--> statement-breakpoint
CREATE INDEX `event_snapshot_aggregate_created_idx` ON `event_snapshot` (`aggregate_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `event_snapshot_sync_seq_idx` ON `event_snapshot` (`sync_seq`);--> statement-breakpoint
CREATE INDEX `event_sync_index_aggregate_seq_idx` ON `event_sync_index` (`aggregate_id`,`seq`);