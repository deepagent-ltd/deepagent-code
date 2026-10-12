CREATE TABLE `im_reply_body_meter` (
	`meter_id` integer PRIMARY KEY,
	`version` integer NOT NULL,
	`custody_id` text NOT NULL,
	`revision` integer NOT NULL,
	`used_records` integer NOT NULL,
	`used_bytes` integer NOT NULL,
	CONSTRAINT "im_reply_body_meter_identity_check" CHECK(typeof("meter_id")='integer' AND "meter_id" BETWEEN 1 AND 1 AND typeof("version")='integer' AND "version" BETWEEN 1 AND 1 AND length(CAST("custody_id" AS BLOB))=36 AND "custody_id" NOT GLOB '*[^0-9a-f-]*' AND substr("custody_id",9,1)='-' AND substr("custody_id",14,1)='-' AND substr("custody_id",15,1)='4' AND substr("custody_id",19,1)='-' AND substr("custody_id",20,1) IN ('8','9','a','b') AND substr("custody_id",24,1)='-'),
	CONSTRAINT "im_reply_body_meter_capacity_check" CHECK(typeof("revision")='integer' AND "revision" BETWEEN 1 AND 9007199254740991 AND typeof("used_records")='integer' AND "used_records" BETWEEN 1 AND 100000 AND typeof("used_bytes")='integer' AND "used_bytes" BETWEEN 76 AND 268435456)
);
--> statement-breakpoint
CREATE TABLE `im_reply_body` (
	`outbox_id` text PRIMARY KEY,
	`meter_id` integer NOT NULL,
	`version` integer NOT NULL,
	`origin_kind` text NOT NULL,
	`custody_state` text NOT NULL,
	`body_state` text NOT NULL,
	`group_ref` text,
	`local_message_id` text,
	`receipt_message_id` text,
	`original_expires_at` integer,
	`retired_at` integer,
	`origin_identity_hash` text NOT NULL,
	`message_identity_hash` text,
	`transport_identity_hash` text,
	`record` text NOT NULL,
	`record_hash` text NOT NULL,
	`mutable_facts_hash` text NOT NULL,
	`local_revision` integer NOT NULL,
	`accounted_records` integer NOT NULL,
	`accounted_bytes` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_im_reply_body_outbox_id_im_reply_outbox_id_fk` FOREIGN KEY (`outbox_id`) REFERENCES `im_reply_outbox`(`id`) ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT `fk_im_reply_body_meter_id_im_reply_body_meter_meter_id_fk` FOREIGN KEY (`meter_id`) REFERENCES `im_reply_body_meter`(`meter_id`) ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT `fk_im_reply_body_group_ref_im_groups_id_fk` FOREIGN KEY (`group_ref`) REFERENCES `im_groups`(`id`) ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT `fk_im_reply_body_local_message_id_im_messages_id_fk` FOREIGN KEY (`local_message_id`) REFERENCES `im_messages`(`id`) ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT `fk_im_reply_body_receipt_message_id_im_kernel_delivery_message_id_fk` FOREIGN KEY (`receipt_message_id`) REFERENCES `im_kernel_delivery`(`message_id`) ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT "im_reply_body_identity_check" CHECK(typeof("meter_id")='integer' AND "meter_id" BETWEEN 1 AND 1 AND typeof("version")='integer' AND "version" BETWEEN 1 AND 1 AND typeof("local_revision")='integer' AND "local_revision" BETWEEN 1 AND 9007199254740991 AND typeof("origin_identity_hash")='text' AND length(CAST("origin_identity_hash" AS BLOB))=64 AND "origin_identity_hash" NOT GLOB '*[^0-9a-f]*' AND typeof("record_hash")='text' AND length(CAST("record_hash" AS BLOB))=64 AND "record_hash" NOT GLOB '*[^0-9a-f]*' AND typeof("mutable_facts_hash")='text' AND length(CAST("mutable_facts_hash" AS BLOB))=64 AND "mutable_facts_hash" NOT GLOB '*[^0-9a-f]*' AND ("message_identity_hash" IS NULL OR typeof("message_identity_hash")='text' AND length(CAST("message_identity_hash" AS BLOB))=64 AND "message_identity_hash" NOT GLOB '*[^0-9a-f]*') AND ("transport_identity_hash" IS NULL OR typeof("transport_identity_hash")='text' AND length(CAST("transport_identity_hash" AS BLOB))=64 AND "transport_identity_hash" NOT GLOB '*[^0-9a-f]*')),
	CONSTRAINT "im_reply_body_custody_check" CHECK(("custody_state"='kernel' AND "group_ref" IS NOT NULL AND "local_message_id" IS NOT NULL AND "receipt_message_id"="local_message_id" AND "message_identity_hash" IS NOT NULL AND "transport_identity_hash" IS NOT NULL AND "original_expires_at" IS NOT NULL) OR ("custody_state"='local' AND "group_ref" IS NOT NULL AND "local_message_id" IS NOT NULL AND "message_identity_hash" IS NOT NULL AND "receipt_message_id" IS NULL AND "transport_identity_hash" IS NULL AND "original_expires_at" IS NULL) OR ("custody_state" IN ('unbound','legacy_unbound') AND "local_message_id" IS NULL AND "receipt_message_id" IS NULL AND "message_identity_hash" IS NULL AND "transport_identity_hash" IS NULL AND "original_expires_at" IS NULL AND ("custody_state"!='legacy_unbound' OR "origin_kind"='legacy_unbound'))),
	CONSTRAINT "im_reply_body_lifecycle_check" CHECK(("body_state"='live' AND "retired_at" IS NULL) OR ("body_state"='retired' AND "custody_state"='kernel' AND "retired_at"="original_expires_at")),
	CONSTRAINT "im_reply_body_accounting_check" CHECK(typeof("accounted_records")='integer' AND "accounted_records" BETWEEN 2 AND 4 AND "accounted_records"=2+("local_message_id" IS NOT NULL)+("receipt_message_id" IS NOT NULL) AND typeof("accounted_bytes")='integer' AND "accounted_bytes" BETWEEN 1 AND 268435456 AND typeof("created_at")='integer' AND "created_at" BETWEEN 0 AND 9007199254740991 AND typeof("updated_at")='integer' AND "updated_at" BETWEEN 0 AND 9007199254740991),
	CONSTRAINT "im_reply_body_record_check" CHECK(CASE WHEN json_valid("record") AND length(CAST("record" AS BLOB)) BETWEEN 1 AND 65536 THEN coalesce(json_extract("record",'$.version')=1 AND json_extract("record",'$.origin.outboxID')="outbox_id" AND json_extract("record",'$.origin.kind')="origin_kind" AND json_extract("record",'$.originHash')="origin_identity_hash" AND json_extract("record",'$.custody')="custody_state" AND json_extract("record",'$.bodyState')="body_state" AND json_extract("record",'$.retiredAt') IS "retired_at" AND json_extract("record",'$.message.messageID') IS "local_message_id" AND json_extract("record",'$.transport.binding.messageID') IS "receipt_message_id" AND json_extract("record",'$.transport.binding.expiresAt') IS "original_expires_at",0) ELSE 0 END)
);
--> statement-breakpoint
ALTER TABLE im_reply_outbox ADD COLUMN body_state text NOT NULL DEFAULT 'live' CONSTRAINT im_reply_outbox_body_check CHECK(body_state='live' OR (body_state='retired' AND reply_text='' AND status='delivered' AND time_delivered IS NOT NULL AND lease_owner IS NULL AND lease_expires_at IS NULL));
--> statement-breakpoint
CREATE UNIQUE INDEX `im_reply_body_meter_custody_idx` ON `im_reply_body_meter` (`custody_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `im_reply_body_message_idx` ON `im_reply_body` (`local_message_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `im_reply_body_receipt_idx` ON `im_reply_body` (`receipt_message_id`);
--> statement-breakpoint
CREATE INDEX `im_reply_body_expiry_idx` ON `im_reply_body` (`body_state`,`original_expires_at`,`outbox_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `im_reply_outbox_due_idx` ON `im_reply_outbox` (`status`,`available_at`,`lease_expires_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `im_reply_outbox_session_reply_idx` ON `im_reply_outbox` (`session_id`,`reply_message_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `im_reply_outbox_delivery_message_idx` ON `im_reply_outbox` (`delivery_message_id`);
--> statement-breakpoint
CREATE TRIGGER im_reply_body_reply_exclusive_insert BEFORE INSERT ON im_reply_body
WHEN NEW.local_message_id IS NOT NULL AND EXISTS(SELECT 1 FROM im_kernel_media_body WHERE message_id=NEW.local_message_id)
BEGIN SELECT RAISE(ABORT,'Reply and media body custody conflict'); END;
--> statement-breakpoint
CREATE TRIGGER im_reply_body_reply_exclusive_update BEFORE UPDATE ON im_reply_body
WHEN NEW.local_message_id IS NOT NULL AND EXISTS(SELECT 1 FROM im_kernel_media_body WHERE message_id=NEW.local_message_id)
BEGIN SELECT RAISE(ABORT,'Reply and media body custody conflict'); END;
--> statement-breakpoint
CREATE TRIGGER im_kernel_media_body_reply_exclusive_insert BEFORE INSERT ON im_kernel_media_body
WHEN NEW.message_id IS NOT NULL AND EXISTS(SELECT 1 FROM im_reply_body WHERE local_message_id=NEW.message_id)
BEGIN SELECT RAISE(ABORT,'Reply and media body custody conflict'); END;
--> statement-breakpoint
CREATE TRIGGER im_kernel_media_body_reply_exclusive_update BEFORE UPDATE ON im_kernel_media_body
WHEN NEW.message_id IS NOT NULL AND EXISTS(SELECT 1 FROM im_reply_body WHERE local_message_id=NEW.message_id)
BEGIN SELECT RAISE(ABORT,'Reply and media body custody conflict'); END;
--> statement-breakpoint
CREATE TRIGGER im_reply_body_origin_immutable BEFORE UPDATE ON im_reply_body
WHEN NEW.origin_kind IS NOT OLD.origin_kind OR NEW.origin_identity_hash IS NOT OLD.origin_identity_hash OR NEW.outbox_id IS NOT OLD.outbox_id
OR (OLD.message_identity_hash IS NOT NULL AND NEW.message_identity_hash IS NOT OLD.message_identity_hash)
OR (OLD.transport_identity_hash IS NOT NULL AND NEW.transport_identity_hash IS NOT OLD.transport_identity_hash)
OR (OLD.origin_kind='legacy_unbound' AND (NEW.group_ref IS NOT OLD.group_ref OR NEW.local_message_id IS NOT OLD.local_message_id OR NEW.receipt_message_id IS NOT OLD.receipt_message_id))
BEGIN SELECT RAISE(ABORT,'Original reply body identity is immutable'); END;