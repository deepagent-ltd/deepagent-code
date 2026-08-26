ALTER TABLE `session_v2_provider_turn_receipt` ADD `activity_id` text NOT NULL;--> statement-breakpoint
ALTER TABLE `session_v2_provider_turn_receipt` ADD `provider_turn_seq` integer NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `session_v2_provider_turn_receipt_activity_turn_idx` ON `session_v2_provider_turn_receipt` (`session_id`,`activity_id`,`provider_turn_seq`);