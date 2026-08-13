ALTER TABLE `task_structured_output_evidence` ADD `owner_token` text NOT NULL;--> statement-breakpoint
ALTER TABLE `task_structured_output_evidence` ADD `claim_generation` integer NOT NULL;--> statement-breakpoint
ALTER TABLE `task_structured_output_evidence` ADD `expected_version` integer NOT NULL;