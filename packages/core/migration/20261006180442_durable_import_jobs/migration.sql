CREATE TABLE `import_batch_receipt` (
	`job_id` text NOT NULL,
	`batch_id` text NOT NULL,
	`source_id` text NOT NULL,
	`source_digest` text NOT NULL,
	`target_id` text NOT NULL,
	`result` text NOT NULL,
	`committed_at` integer NOT NULL,
	CONSTRAINT `import_batch_receipt_pk` PRIMARY KEY(`job_id`, `batch_id`),
	CONSTRAINT "import_batch_digest_check" CHECK(length("source_digest") = 64 AND "source_digest" NOT GLOB '*[^0-9a-f]*')
);
--> statement-breakpoint
CREATE TABLE `import_job` (
	`job_id` text PRIMARY KEY,
	`operator_id` text NOT NULL,
	`request_id` text NOT NULL,
	`request_digest` text NOT NULL,
	`request` text NOT NULL,
	`state` text NOT NULL,
	`revision` integer NOT NULL,
	`source_digest` text,
	`source_snapshot_path` text,
	`source_format_revision` integer NOT NULL,
	`total_sessions` integer NOT NULL,
	`target` text,
	`target_key` text NOT NULL,
	`migration_digest` text NOT NULL,
	`owner_id` text,
	`owner_lease_expires_at` integer,
	`active_batch_id` text,
	`committed_batches` integer NOT NULL,
	`failed_batches` integer NOT NULL,
	`cancel_requested_at` integer,
	`stop_confirmed_at` integer,
	`error_code` text,
	`error_detail` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`settled_at` integer,
	CONSTRAINT "import_job_operator_check" CHECK("operator_id" = 'server'),
	CONSTRAINT "import_job_state_check" CHECK("state" IN ('preflight','ready','running','cancel_requested','completed','failed','cancelled','cancelled_partial','recovery_required')),
	CONSTRAINT "import_job_counts_check" CHECK("revision" >= 0 AND "total_sessions" >= 0 AND "committed_batches" >= 0 AND "failed_batches" >= 0),
	CONSTRAINT "import_job_digest_check" CHECK(length("request_digest") = 64 AND "request_digest" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "import_job_stop_check" CHECK("state" NOT IN ('cancelled','cancelled_partial') OR "stop_confirmed_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX `import_batch_job_idx` ON `import_batch_receipt` (`job_id`,`committed_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `import_job_request_idx` ON `import_job` (`operator_id`,`request_id`);--> statement-breakpoint
CREATE INDEX `import_job_created_idx` ON `import_job` (`operator_id`,`created_at`,`job_id`);--> statement-breakpoint
CREATE INDEX `import_job_target_idx` ON `import_job` (`target_key`,`state`);