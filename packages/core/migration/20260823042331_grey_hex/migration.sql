CREATE TABLE `session_v2_owner_authorization` (
	`authorization_id` text PRIMARY KEY,
	`campaign_id` text NOT NULL,
	`subject_commit` text NOT NULL,
	`subject_tree` text NOT NULL,
	`schema_digest` text NOT NULL,
	`build_id` text NOT NULL,
	`package_digest` text NOT NULL,
	`valid_from` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`status` text NOT NULL,
	`signature_digest` text NOT NULL,
	`authorization_digest` text NOT NULL,
	`created_at` integer NOT NULL,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_v2_owner_authorization_campaign_idx` ON `session_v2_owner_authorization` (`campaign_id`);--> statement-breakpoint
CREATE INDEX `session_v2_owner_authorization_active_idx` ON `session_v2_owner_authorization` (`status`,`expires_at`,`campaign_id`);