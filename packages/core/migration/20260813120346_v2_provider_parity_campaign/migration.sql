CREATE TABLE `session_v2_provider_parity_baseline` (
	`campaign_id` text NOT NULL,
	`case_name` text NOT NULL,
	`legacy_receipt_id` text NOT NULL UNIQUE,
	`state` text NOT NULL,
	`prepared_turn` text NOT NULL,
	`outcome_hash` text,
	`outcome_artifact` text,
	`evidence` text NOT NULL,
	`receipt_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`settled_at` integer,
	CONSTRAINT `session_v2_provider_parity_baseline_pk` PRIMARY KEY(`campaign_id`, `case_name`)
);
--> statement-breakpoint
ALTER TABLE `session_v2_provider_turn_receipt` ADD `outcome_artifact` text;--> statement-breakpoint
CREATE UNIQUE INDEX `session_v2_provider_parity_baseline_hash_idx` ON `session_v2_provider_parity_baseline` (`receipt_hash`);--> statement-breakpoint
CREATE INDEX `session_v2_provider_parity_baseline_campaign_idx` ON `session_v2_provider_parity_baseline` (`campaign_id`,`state`);
