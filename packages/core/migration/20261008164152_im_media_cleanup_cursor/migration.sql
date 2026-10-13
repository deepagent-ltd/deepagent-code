CREATE TABLE `im_media_cleanup_cursor` (
	`workspace_id` text PRIMARY KEY,
	`after_created_at` integer,
	`after_id` text,
	`revision` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "im_media_cleanup_cursor_workspace_check" CHECK(typeof("workspace_id") = 'text' AND length(CAST("workspace_id" AS BLOB)) BETWEEN 1 AND 16384 AND instr("workspace_id", char(0)) = 0),
	CONSTRAINT "im_media_cleanup_cursor_position_check" CHECK(("after_created_at" IS NULL AND "after_id" IS NULL) OR (typeof("after_created_at") = 'integer' AND "after_created_at" BETWEEN 0 AND 9007199254740991 AND typeof("after_id") = 'text' AND length(CAST("after_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("after_id", char(0)) = 0)),
	CONSTRAINT "im_media_cleanup_cursor_revision_check" CHECK(typeof("revision") = 'integer' AND "revision" BETWEEN 0 AND 9007199254740991 AND typeof("updated_at") = 'integer' AND "updated_at" BETWEEN 0 AND 9007199254740991)
);
