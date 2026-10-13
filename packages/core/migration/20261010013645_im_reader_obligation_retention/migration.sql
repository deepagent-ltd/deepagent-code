CREATE TABLE `__im_reader_obligation_migration_guard` (`ok` INTEGER NOT NULL CHECK(`ok`=1));
--> statement-breakpoint
INSERT INTO __im_reader_obligation_migration_guard SELECT CASE WHEN EXISTS(
 SELECT 1 FROM sqlite_master source JOIN pragma_foreign_key_list(source.name) reference
 WHERE source.type='table' AND reference."table"='im_kernel_reader_message'
 AND reference.on_delete NOT IN ('NO ACTION','RESTRICT') LIMIT 1) THEN 0 ELSE 1 END;
--> statement-breakpoint
INSERT INTO __im_reader_obligation_migration_guard SELECT CASE WHEN
 (SELECT count(*) FROM (SELECT 1 FROM im_kernel_reader_message LIMIT 100001)) <= 100000
 AND (SELECT count(*) FROM (SELECT 1 FROM im_mention_intent i JOIN im_kernel_reader_message r ON r.local_message_id=i.message_id AND r.owns_message=1 LIMIT 100001)) <= 100000
 THEN 1 ELSE 0 END;
--> statement-breakpoint
CREATE TABLE __im_reader_obligation_totals (
 reader_key TEXT NOT NULL, effect_key TEXT NOT NULL,
 records INTEGER NOT NULL CHECK(typeof(records)='integer' AND records BETWEEN 0 AND 100000),
 bytes INTEGER NOT NULL CHECK(typeof(bytes)='integer' AND bytes BETWEEN 0 AND 268435456 AND bytes>=1024*records),
 PRIMARY KEY(reader_key,effect_key));
--> statement-breakpoint
INSERT INTO __im_reader_obligation_totals
 SELECT r.reader_key,r.effect_key,count(i.id),coalesce(sum(CASE WHEN i.id IS NULL THEN 0 ELSE 1024 + 16 + CASE WHEN i.conversation_type IS NULL THEN 0 ELSE 8 END + coalesce(length(CAST(i.id AS BLOB)),0) + coalesce(length(CAST(i.message_id AS BLOB)),0) + coalesce(length(CAST(i.agent_name AS BLOB)),0) + coalesce(length(CAST(i.directory AS BLOB)),0) + coalesce(length(CAST(i.workspace_id AS BLOB)),0) + coalesce(length(CAST(i.user_id AS BLOB)),0) + coalesce(length(CAST(i.origin AS BLOB)),0) + coalesce(length(CAST(i.receiver_id AS BLOB)),0) + coalesce(length(CAST(i.conversation_id AS BLOB)),0) + coalesce(length(CAST(i.resolved_agent AS BLOB)),0) + coalesce(length(CAST(i.session_id AS BLOB)),0) + coalesce(length(CAST(i.input_id AS BLOB)),0) + coalesce(length(CAST(i.status AS BLOB)),0) + coalesce(length(CAST(i.last_error AS BLOB)),0) END),0)
 FROM im_kernel_reader_message r LEFT JOIN im_mention_intent i ON r.owns_message=1 AND i.message_id=r.local_message_id
 GROUP BY r.reader_key,r.effect_key;
--> statement-breakpoint
UPDATE im_kernel_reader_meter SET
 used_records=used_records+(SELECT coalesce(sum(records),0) FROM __im_reader_obligation_totals),
 used_bytes=used_bytes+(SELECT coalesce(sum(16+bytes),0) FROM __im_reader_obligation_totals),
 revision=revision+1,updated_at=max(updated_at,CAST(unixepoch('subsec')*1000 AS INTEGER))
 WHERE id=1 AND EXISTS(SELECT 1 FROM __im_reader_obligation_totals)
 AND revision<9007199254740991
 AND used_records+(SELECT coalesce(sum(records),0) FROM __im_reader_obligation_totals)<=100000
 AND used_bytes+(SELECT coalesce(sum(16+bytes),0) FROM __im_reader_obligation_totals)<=268435456;
--> statement-breakpoint
INSERT INTO __im_reader_obligation_migration_guard SELECT CASE WHEN
 NOT EXISTS(SELECT 1 FROM __im_reader_obligation_totals) OR changes()=1 THEN 1 ELSE 0 END;
--> statement-breakpoint
CREATE TABLE `__new_im_kernel_reader_message` (
	`reader_key` text NOT NULL,
	`effect_key` text NOT NULL,
	`binding_key` text NOT NULL,
	`projection_key` text NOT NULL,
	`message_id` text NOT NULL,
	`sequence` text NOT NULL,
	`delivery_cursor` text NOT NULL,
	`sender_id` text NOT NULL,
	`target_id` text NOT NULL,
	`body_hash` text NOT NULL,
	`immutable_hash` text NOT NULL,
	`storage_state` text NOT NULL,
	`metadata` text NOT NULL,
	`message_time` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`conversation_type` integer NOT NULL,
	`owns_message` integer NOT NULL,
	`body_bytes` integer NOT NULL,
	`obligation_records` integer DEFAULT 0 NOT NULL,
	`obligation_bytes` integer DEFAULT 0 NOT NULL,
	`version` integer NOT NULL,
	`local_revision` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`accounted_records` integer NOT NULL,
	`accounted_bytes` integer NOT NULL,
	`local_message_id` text,
	CONSTRAINT `im_kernel_reader_message_pk` PRIMARY KEY(`reader_key`, `effect_key`),
	CONSTRAINT `fk_im_kernel_reader_message_local_message_id_im_messages_id_fk` FOREIGN KEY (`local_message_id`) REFERENCES `im_messages`(`id`) ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT `fk_im_kernel_reader_message_reader_key_binding_key_projection_key_im_kernel_reader_projection_reader_key_binding_key_projection_key_fk` FOREIGN KEY (`reader_key`,`binding_key`,`projection_key`) REFERENCES `im_kernel_reader_projection`(`reader_key`,`binding_key`,`projection_key`) ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT "im_kernel_reader_message_version_check" CHECK(typeof("version") = 'integer' AND "version" BETWEEN 1 AND 1),
	CONSTRAINT "im_kernel_reader_message_time_check" CHECK(typeof("local_revision") = 'integer' AND "local_revision" BETWEEN 1 AND 9007199254740991 AND typeof("created_at") = 'integer' AND "created_at" BETWEEN 0 AND 9007199254740991 AND typeof("updated_at") = 'integer' AND "updated_at" BETWEEN 0 AND 9007199254740991 AND "updated_at" >= "created_at"),
	CONSTRAINT "im_kernel_reader_message_accounting_check" CHECK(typeof("accounted_records") = 'integer' AND "accounted_records" BETWEEN 1 AND 100000 AND typeof("accounted_bytes") = 'integer' AND "accounted_bytes" BETWEEN 1024 AND 268435456),
	CONSTRAINT "im_kernel_reader_message_identity_check" CHECK((typeof("reader_key") = 'text' AND length(CAST("reader_key" AS BLOB)) BETWEEN 1 AND 64 AND instr("reader_key", char(0)) = 0 AND length("reader_key") = 64 AND length(CAST("reader_key" AS BLOB)) = 64 AND "reader_key" NOT GLOB '*[^0-9a-f]*') AND (typeof("effect_key") = 'text' AND length(CAST("effect_key" AS BLOB)) BETWEEN 1 AND 64 AND instr("effect_key", char(0)) = 0 AND length("effect_key") = 64 AND length(CAST("effect_key" AS BLOB)) = 64 AND "effect_key" NOT GLOB '*[^0-9a-f]*') AND (typeof("binding_key") = 'text' AND length(CAST("binding_key" AS BLOB)) BETWEEN 1 AND 64 AND instr("binding_key", char(0)) = 0 AND length("binding_key") = 64 AND length(CAST("binding_key" AS BLOB)) = 64 AND "binding_key" NOT GLOB '*[^0-9a-f]*') AND (typeof("projection_key") = 'text' AND length(CAST("projection_key" AS BLOB)) BETWEEN 1 AND 64 AND instr("projection_key", char(0)) = 0 AND length("projection_key") = 64 AND length(CAST("projection_key" AS BLOB)) = 64 AND "projection_key" NOT GLOB '*[^0-9a-f]*') AND (typeof("body_hash") = 'text' AND length(CAST("body_hash" AS BLOB)) BETWEEN 1 AND 64 AND instr("body_hash", char(0)) = 0 AND length("body_hash") = 64 AND length(CAST("body_hash" AS BLOB)) = 64 AND "body_hash" NOT GLOB '*[^0-9a-f]*') AND (typeof("immutable_hash") = 'text' AND length(CAST("immutable_hash" AS BLOB)) BETWEEN 1 AND 64 AND instr("immutable_hash", char(0)) = 0 AND length("immutable_hash") = 64 AND length(CAST("immutable_hash" AS BLOB)) = 64 AND "immutable_hash" NOT GLOB '*[^0-9a-f]*') AND (typeof("message_id") = 'text' AND length(CAST("message_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("message_id", char(0)) = 0) AND (typeof("sender_id") = 'text' AND length(CAST("sender_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("sender_id", char(0)) = 0) AND (typeof("target_id") = 'text' AND length(CAST("target_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("target_id", char(0)) = 0) AND ("local_message_id" IS NULL OR typeof("local_message_id") = 'text' AND length(CAST("local_message_id" AS BLOB)) BETWEEN 1 AND 128 AND instr("local_message_id", char(0)) = 0)),
	CONSTRAINT "im_kernel_reader_message_sequence_check" CHECK(typeof("sequence") = 'text' AND length(CAST("sequence" AS BLOB)) BETWEEN 1 AND 19 AND instr("sequence", char(0)) = 0 AND length("sequence") = length(CAST("sequence" AS BLOB)) AND "sequence" NOT GLOB '*[^0-9]*' AND ("sequence" = '0' OR substr("sequence", 1, 1) BETWEEN '1' AND '9') AND (length("sequence") < 19 OR "sequence" COLLATE BINARY <= '9223372036854775807') AND ("sequence" <> '0') AND typeof("delivery_cursor") = 'text' AND length(CAST("delivery_cursor" AS BLOB)) BETWEEN 1 AND 19 AND instr("delivery_cursor", char(0)) = 0 AND length("delivery_cursor") = length(CAST("delivery_cursor" AS BLOB)) AND "delivery_cursor" NOT GLOB '*[^0-9]*' AND ("delivery_cursor" = '0' OR substr("delivery_cursor", 1, 1) BETWEEN '1' AND '9') AND (length("delivery_cursor") < 19 OR "delivery_cursor" COLLATE BINARY <= '9223372036854775807') AND ("delivery_cursor" <> '0')),
	CONSTRAINT "im_kernel_reader_message_message_time_check" CHECK(typeof("message_time") = 'integer' AND "message_time" BETWEEN 0 AND 9007199254740991 AND typeof("expires_at") = 'integer' AND "expires_at" BETWEEN 0 AND 9007199254740991 AND "expires_at" > "message_time"),
	CONSTRAINT "im_kernel_reader_message_body_check" CHECK(typeof("conversation_type") = 'integer' AND "conversation_type" BETWEEN 1 AND 2 AND typeof("owns_message") = 'integer' AND "owns_message" BETWEEN 0 AND 1 AND typeof("body_bytes") = 'integer' AND "body_bytes" BETWEEN 0 AND 65536 AND typeof("obligation_records") = 'integer' AND "obligation_records" BETWEEN 0 AND 100000 AND typeof("obligation_bytes") = 'integer' AND "obligation_bytes" BETWEEN 0 AND 268435456 AND (("obligation_records" = 0 AND "obligation_bytes" = 0) OR ("obligation_records" > 0 AND "obligation_bytes" >= 1024 * "obligation_records" AND "owns_message" = 1)) AND "accounted_records" = 1 + "owns_message" + "obligation_records"),
	CONSTRAINT "im_kernel_reader_message_metadata_check" CHECK(CASE WHEN typeof("metadata") = 'text' AND length(CAST("metadata" AS BLOB)) BETWEEN 1 AND 2048 AND instr("metadata", char(0)) = 0 AND json_valid("metadata") THEN coalesce(json_type("metadata") = 'object' AND json_type("metadata", '$.version') = 'integer' AND json_extract("metadata", '$.version') = 1, 0) ELSE 0 END),
	CONSTRAINT "im_kernel_reader_message_storage_check" CHECK(("storage_state" = 'present' AND "local_message_id" IS NOT NULL) OR ("storage_state" IN ('expired','redacted') AND "local_message_id" IS NULL AND "body_bytes" = 0 AND "owns_message" = 0 AND "obligation_records" = 0) OR ("storage_state" IN ('expired_obligation','redacted_obligation') AND "local_message_id" IS NOT NULL AND "body_bytes" = 0 AND "owns_message" = 1 AND "obligation_records" > 0))
);
--> statement-breakpoint
INSERT INTO `__new_im_kernel_reader_message`(`reader_key`, `effect_key`, `binding_key`, `projection_key`, `message_id`, `sequence`, `delivery_cursor`, `sender_id`, `target_id`, `body_hash`, `immutable_hash`, `storage_state`, `metadata`, `message_time`, `expires_at`, `conversation_type`, `owns_message`, `body_bytes`, `version`, `local_revision`, `created_at`, `updated_at`, `accounted_records`, `accounted_bytes`, `local_message_id`, `obligation_records`, `obligation_bytes`) SELECT r.`reader_key`, r.`effect_key`, r.`binding_key`, r.`projection_key`, r.`message_id`, r.`sequence`, r.`delivery_cursor`, r.`sender_id`, r.`target_id`, r.`body_hash`, r.`immutable_hash`, r.`storage_state`, r.`metadata`, r.`message_time`, r.`expires_at`, r.`conversation_type`, r.`owns_message`, r.`body_bytes`, r.`version`, r.`local_revision`, r.`created_at`, r.`updated_at`, r.`accounted_records` + t.records, r.`accounted_bytes` + 16 + t.bytes, r.`local_message_id`, t.records, t.bytes FROM im_kernel_reader_message r JOIN __im_reader_obligation_totals t ON t.reader_key=r.reader_key AND t.effect_key=r.effect_key;
--> statement-breakpoint
DROP TABLE `im_kernel_reader_message`;
--> statement-breakpoint
ALTER TABLE `__new_im_kernel_reader_message` RENAME TO `im_kernel_reader_message`;
--> statement-breakpoint
CREATE UNIQUE INDEX `im_kernel_reader_message_original_idx` ON `im_kernel_reader_message` (`reader_key`,`projection_key`,`message_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `im_kernel_reader_message_cursor_idx` ON `im_kernel_reader_message` (`reader_key`,`projection_key`,`delivery_cursor`);
--> statement-breakpoint
CREATE UNIQUE INDEX `im_kernel_reader_message_local_idx` ON `im_kernel_reader_message` (`local_message_id`);
--> statement-breakpoint
CREATE INDEX `im_kernel_reader_message_page_idx` ON `im_kernel_reader_message` (`reader_key`,`projection_key`,length("delivery_cursor"),`delivery_cursor`,`effect_key`);
--> statement-breakpoint
CREATE INDEX `im_kernel_reader_message_expiry_idx` ON `im_kernel_reader_message` (`expires_at`,`reader_key`,`effect_key`);
--> statement-breakpoint
INSERT INTO __im_reader_obligation_migration_guard SELECT CASE WHEN EXISTS(SELECT 1 FROM pragma_foreign_key_check) THEN 0 ELSE 1 END;
--> statement-breakpoint
DROP TABLE __im_reader_obligation_totals;
--> statement-breakpoint
DROP TABLE __im_reader_obligation_migration_guard;
