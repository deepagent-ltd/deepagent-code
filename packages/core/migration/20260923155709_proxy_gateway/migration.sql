CREATE TABLE `proxy_request_ledger` (
	`request_id` text PRIMARY KEY,
	`request_hash` text NOT NULL,
	`tenant_id` text NOT NULL,
	`lane_session_id` text,
	`tier` text NOT NULL,
	`provider_id` text NOT NULL,
	`model_id` text NOT NULL,
	`usage_input` integer,
	`usage_output` integer,
	`usage_reasoning` integer,
	`usage_cache_read` integer,
	`usage_cache_write` integer,
	`usage_source` text,
	`cost_total` real,
	`finish_reason` text,
	`admitted_at` integer NOT NULL,
	`first_token_at` integer,
	`completed_at` integer,
	`stream` integer NOT NULL,
	CONSTRAINT `fk_proxy_request_ledger_tenant_id_proxy_tenant_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `proxy_tenant`(`id`)
);
--> statement-breakpoint
CREATE TABLE `proxy_tenant` (
	`id` text PRIMARY KEY,
	`key_hash` text NOT NULL,
	`key_fingerprint` text NOT NULL,
	`directory` text NOT NULL,
	`model_allowlist` text NOT NULL,
	`tier` text NOT NULL,
	`quota_requests_per_minute` integer NOT NULL,
	`quota_tokens_per_day` integer NOT NULL,
	`lane_limit` integer NOT NULL,
	`deadline_ms` integer NOT NULL,
	`enabled` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `proxy_request_ledger_tenant_admitted_idx` ON `proxy_request_ledger` (`tenant_id`,`admitted_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `proxy_tenant_key_hash_idx` ON `proxy_tenant` (`key_hash`);
