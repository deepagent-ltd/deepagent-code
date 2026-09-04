CREATE TABLE `session_wire_projection` (
	`session_id` text NOT NULL,
	`entity` text NOT NULL,
	`entity_id` text NOT NULL,
	`fingerprint` text NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `session_wire_projection_pk` PRIMARY KEY(`session_id`, `entity`, `entity_id`),
	CONSTRAINT `fk_session_wire_projection_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE
);
