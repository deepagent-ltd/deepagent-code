CREATE TABLE `attention_seen` (
	`scope_key` text NOT NULL,
	`actor_id` text NOT NULL,
	`item_id` text NOT NULL,
	`source_revision` text NOT NULL,
	`session_id` text NOT NULL,
	`seen_at` integer NOT NULL,
	CONSTRAINT `attention_seen_pk` PRIMARY KEY(`scope_key`, `actor_id`, `item_id`, `source_revision`),
	CONSTRAINT `fk_attention_seen_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE
);
