CREATE TABLE `session_v2_structured_output_evidence` (
	`evidence_id` text PRIMARY KEY,
	`run_id` text NOT NULL,
	`session_id` text NOT NULL,
	`child_session_id` text NOT NULL,
	`output_message_id` text,
	`schema_name` text NOT NULL,
	`validation_outcome` text NOT NULL,
	`output_sha256` text NOT NULL,
	`schema_sha256` text NOT NULL,
	`raw_output` text NOT NULL,
	`owner_token` text NOT NULL,
	`time_created` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_v2_structured_output_evidence_run_idx` ON `session_v2_structured_output_evidence` (`run_id`);--> statement-breakpoint
CREATE INDEX `session_v2_structured_output_evidence_session_idx` ON `session_v2_structured_output_evidence` (`session_id`,`time_created`);