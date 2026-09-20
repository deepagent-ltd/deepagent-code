CREATE TABLE `event_aggregate_tombstone` (
	`aggregate_id` text PRIMARY KEY,
	`deleted_at` integer NOT NULL,
	`retention_until` integer NOT NULL,
	`reason` text NOT NULL,
	`deletion_event_id` text
);
