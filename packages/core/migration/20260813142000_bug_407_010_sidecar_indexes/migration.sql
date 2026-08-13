CREATE INDEX `file_part_artifact_binding_artifact_idx` ON `file_part_artifact_binding` (`artifact_id`);--> statement-breakpoint
CREATE INDEX `file_part_artifact_import_artifact_idx` ON `file_part_artifact_import` (`artifact_id`);--> statement-breakpoint
CREATE INDEX `event_snapshot_row_hash_idx` ON `event_snapshot_row` (`row_hash`);