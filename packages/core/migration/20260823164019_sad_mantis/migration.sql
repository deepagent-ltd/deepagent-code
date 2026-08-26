CREATE TABLE `session_v2_provider_recovery_bridge` (
	`resolution_id` text PRIMARY KEY,
	`attempt_id` text NOT NULL UNIQUE,
	`receipt_id` text NOT NULL UNIQUE,
	`command_id` text NOT NULL UNIQUE,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_session_v2_provider_recovery_bridge_attempt_id_session_provider_attempt_attempt_id_fk` FOREIGN KEY (`attempt_id`) REFERENCES `session_provider_attempt`(`attempt_id`) ON DELETE CASCADE,
	CONSTRAINT `fk_session_v2_provider_recovery_bridge_receipt_id_session_v2_provider_turn_receipt_receipt_id_fk` FOREIGN KEY (`receipt_id`) REFERENCES `session_v2_provider_turn_receipt`(`receipt_id`) ON DELETE CASCADE
);
