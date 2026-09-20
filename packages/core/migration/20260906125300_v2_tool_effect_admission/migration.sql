CREATE TABLE `session_v2_tool_effect_admission` (
	`admission_id` text PRIMARY KEY,
	`session_id` text NOT NULL,
	`provider_attempt_id` text NOT NULL,
	`receipt_id` text NOT NULL,
	`tool_call_id` text NOT NULL,
	`tool_name` text NOT NULL,
	`effect_kind` text NOT NULL,
	`owner_token` text NOT NULL,
	`time_created` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_v2_tool_effect_admission_call_idx` ON `session_v2_tool_effect_admission` (`receipt_id`,`tool_call_id`);--> statement-breakpoint
CREATE INDEX `session_v2_tool_effect_admission_session_idx` ON `session_v2_tool_effect_admission` (`session_id`,`time_created`);