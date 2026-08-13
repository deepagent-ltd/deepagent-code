CREATE TABLE `task_structured_output_evidence` (
	`run_id` text PRIMARY KEY,
	`child_session_id` text NOT NULL,
	`terminal_state` text NOT NULL,
	`attempts` integer NOT NULL,
	`contract_json` text NOT NULL,
	`contract_hash` text NOT NULL,
	`raw_result_message_id` text NOT NULL,
	`raw_message_json` text NOT NULL,
	`raw_parts_json` text NOT NULL,
	`raw_material_hash` text NOT NULL,
	`result_message_id` text,
	`result_message_json` text,
	`result_parts_json` text,
	`result_material_hash` text,
	`output` text,
	`output_hash` text,
	`structured_output_receipt` text,
	`failure_code` text,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_task_structured_output_evidence_run_id_task_run_run_id_fk` FOREIGN KEY (`run_id`) REFERENCES `task_run`(`run_id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `task_structured_output_evidence_raw_message_idx` ON `task_structured_output_evidence` (`raw_result_message_id`);--> statement-breakpoint
CREATE INDEX `task_structured_output_evidence_result_message_idx` ON `task_structured_output_evidence` (`result_message_id`);