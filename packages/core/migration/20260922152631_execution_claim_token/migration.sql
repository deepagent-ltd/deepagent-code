ALTER TABLE `session` RENAME COLUMN `time_suspended` TO `execution_claim_token`;
--> statement-breakpoint
DROP INDEX `session_time_suspended_idx`;
--> statement-breakpoint
CREATE INDEX `session_execution_claim_token_idx` ON `session` (`execution_claim_token`) WHERE "session"."execution_claim_token" is not null;
