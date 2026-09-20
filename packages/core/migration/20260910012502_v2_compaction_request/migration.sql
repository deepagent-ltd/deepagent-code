CREATE TABLE `session_v2_compaction_request` (
	`request_id` text PRIMARY KEY,
	`session_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`model_id` text NOT NULL,
	`fence_message_count` integer NOT NULL,
	`fence_last_message_id` text NOT NULL,
	`status` text NOT NULL,
	`outcome` text,
	`summary_receipt_id` text,
	`created_at` integer NOT NULL,
	`settled_at` integer
);
--> statement-breakpoint
CREATE INDEX `session_v2_compaction_request_session_idx` ON `session_v2_compaction_request` (`session_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `session_v2_compaction_request_status_idx` ON `session_v2_compaction_request` (`status`);