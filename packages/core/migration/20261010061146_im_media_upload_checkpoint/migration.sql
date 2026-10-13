CREATE TABLE `im_media_upload_checkpoint` (
	`checkpoint_id` text PRIMARY KEY,
	`meter_id` integer NOT NULL,
	`custody_id` text NOT NULL,
	`attachment_id` text NOT NULL,
	`group_id` text NOT NULL,
	`planned_message_id` text,
	`origin_hash` text NOT NULL,
	`plan_hash` text,
	`remote_hash` text,
	`record` text NOT NULL,
	`record_hash` text NOT NULL,
	`phase` text NOT NULL,
	`body_verified` integer NOT NULL,
	`begin_dispatched` integer NOT NULL,
	`attempt_owner` text,
	`attempt_revision` integer NOT NULL,
	`attempt_expires_at` integer,
	`current_source_hash` text,
	`original_local_expires_at` integer NOT NULL,
	`original_remote_expires_at` integer,
	`message_ref` text,
	`receipt_ref` text,
	`local_revision` integer NOT NULL,
	`accounted_records` integer NOT NULL,
	`accounted_bytes` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_im_media_upload_checkpoint_meter_id_im_media_upload_meter_meter_id_fk` FOREIGN KEY (`meter_id`) REFERENCES `im_media_upload_meter`(`meter_id`) ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT `fk_im_media_upload_checkpoint_custody_id_im_media_upload_meter_custody_id_fk` FOREIGN KEY (`custody_id`) REFERENCES `im_media_upload_meter`(`custody_id`) ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT `fk_im_media_upload_checkpoint_attachment_id_im_attachments_id_fk` FOREIGN KEY (`attachment_id`) REFERENCES `im_attachments`(`id`) ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT `fk_im_media_upload_checkpoint_group_id_im_groups_id_fk` FOREIGN KEY (`group_id`) REFERENCES `im_groups`(`id`) ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT `fk_im_media_upload_checkpoint_message_ref_im_messages_id_fk` FOREIGN KEY (`message_ref`) REFERENCES `im_messages`(`id`) ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT `fk_im_media_upload_checkpoint_receipt_ref_im_kernel_delivery_message_id_fk` FOREIGN KEY (`receipt_ref`) REFERENCES `im_kernel_delivery`(`message_id`) ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT "im_media_upload_identity_check" CHECK(length("checkpoint_id")=64 AND "checkpoint_id" NOT GLOB '*[^0-9a-f]*' AND typeof("meter_id")='integer' AND "meter_id" BETWEEN 1 AND 1 AND length("custody_id")=36 AND length(CAST("custody_id" AS BLOB))=36 AND "custody_id" NOT GLOB '*[^0-9a-f-]*' AND substr("custody_id",9,1)='-' AND substr("custody_id",14,1)='-' AND substr("custody_id",15,1)='4' AND substr("custody_id",19,1)='-' AND substr("custody_id",20,1) IN ('8','9','a','b') AND substr("custody_id",24,1)='-' AND length("origin_hash")=64 AND "origin_hash" NOT GLOB '*[^0-9a-f]*' AND length("record_hash")=64 AND "record_hash" NOT GLOB '*[^0-9a-f]*' AND ("plan_hash" IS NULL OR length("plan_hash")=64 AND "plan_hash" NOT GLOB '*[^0-9a-f]*') AND ("remote_hash" IS NULL OR length("remote_hash")=64 AND "remote_hash" NOT GLOB '*[^0-9a-f]*') AND typeof("local_revision")='integer' AND "local_revision" BETWEEN 1 AND 9007199254740991),
	CONSTRAINT "im_media_upload_accounting_check" CHECK(typeof("accounted_records")='integer' AND "accounted_records" BETWEEN 1 AND 1 AND typeof("accounted_bytes")='integer' AND "accounted_bytes" BETWEEN 1 AND 65536 AND typeof("created_at")='integer' AND "created_at" BETWEEN 0 AND 9007199254740991 AND typeof("updated_at")='integer' AND "updated_at" BETWEEN 0 AND 9007199254740991 AND typeof("original_local_expires_at")='integer' AND "original_local_expires_at" BETWEEN 1 AND 9007199254740991 AND ("original_remote_expires_at" IS NULL OR typeof("original_remote_expires_at")='integer' AND "original_remote_expires_at" BETWEEN 1 AND 9007199254740991)),
	CONSTRAINT "im_media_upload_attempt_check" CHECK(typeof("body_verified")='integer' AND "body_verified" BETWEEN 0 AND 1 AND typeof("begin_dispatched")='integer' AND "begin_dispatched" BETWEEN 0 AND 1 AND ("begin_dispatched"=0 OR "body_verified"=1) AND typeof("attempt_revision")='integer' AND "attempt_revision" BETWEEN 0 AND 9007199254740991 AND (("attempt_owner" IS NULL AND "attempt_expires_at" IS NULL) OR (length("attempt_owner")=36 AND length(CAST("attempt_owner" AS BLOB))=36 AND "attempt_owner" NOT GLOB '*[^0-9a-f-]*' AND substr("attempt_owner",9,1)='-' AND substr("attempt_owner",14,1)='-' AND substr("attempt_owner",15,1)='4' AND substr("attempt_owner",19,1)='-' AND substr("attempt_owner",20,1) IN ('8','9','a','b') AND substr("attempt_owner",24,1)='-' AND typeof("attempt_expires_at")='integer' AND "attempt_expires_at" BETWEEN 0 AND 9007199254740991 AND "attempt_revision">0 AND "current_source_hash" IS NOT NULL)) AND ("current_source_hash" IS NULL OR length("current_source_hash")=64 AND "current_source_hash" NOT GLOB '*[^0-9a-f]*')),
	CONSTRAINT "im_media_upload_phase_check" CHECK("phase" IN ('eligible','planned','uploading','uploaded','unknown_upload','attached','expired','cancelled') AND ("phase"!='eligible' OR ("planned_message_id" IS NULL AND "plan_hash" IS NULL AND "remote_hash" IS NULL AND "original_remote_expires_at" IS NULL AND "message_ref" IS NULL AND "receipt_ref" IS NULL AND "body_verified"=0 AND "begin_dispatched"=0 AND "attempt_owner" IS NULL AND "attempt_revision"=0 AND "current_source_hash" IS NULL)) AND ("phase"='eligible' OR ("planned_message_id" IS NOT NULL AND "plan_hash" IS NOT NULL)) AND ("phase"='attached' OR ("message_ref" IS NULL AND "receipt_ref" IS NULL)) AND ("phase"!='attached' OR "message_ref"="planned_message_id") AND ("receipt_ref" IS NULL OR "receipt_ref"="message_ref")),
	CONSTRAINT "im_media_upload_record_check" CHECK(CASE WHEN json_valid("record") AND length(CAST("record" AS BLOB)) BETWEEN 1 AND 65536 THEN coalesce(json_extract("record",'$.version')=1 AND json_extract("record",'$.checkpointID')="checkpoint_id" AND json_extract("record",'$.origin.custodyID')="custody_id" AND json_extract("record",'$.origin.groupID')="group_id" AND json_extract("record",'$.origin.attachment.id')="attachment_id" AND json_extract("record",'$.origin.localExpiresAt')="original_local_expires_at" AND json_extract("record",'$.originHash')="origin_hash" AND json_extract("record",'$.plan.messageID') IS "planned_message_id" AND json_extract("record",'$.planHash') IS "plan_hash" AND json_extract("record",'$.remoteHash') IS "remote_hash" AND json_extract("record",'$.remote.expiresAt') IS "original_remote_expires_at" AND json_extract("record",'$.phase')="phase" AND json_extract("record",'$.bodyVerified')="body_verified" AND json_extract("record",'$.beginDispatched')="begin_dispatched" AND json_extract("record",'$.attemptOwner') IS "attempt_owner" AND json_extract("record",'$.attemptRevision')="attempt_revision" AND json_extract("record",'$.attemptExpiresAt') IS "attempt_expires_at" AND json_extract("record",'$.currentSourceHash') IS "current_source_hash" AND json_extract("record",'$.messageRef') IS "message_ref" AND json_extract("record",'$.receiptRef') IS "receipt_ref",0) ELSE 0 END)
);
--> statement-breakpoint
CREATE TABLE `im_media_upload_meter` (
	`meter_id` integer PRIMARY KEY,
	`version` integer NOT NULL,
	`custody_id` text NOT NULL,
	`revision` integer NOT NULL,
	`used_records` integer NOT NULL,
	`used_bytes` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "im_media_upload_meter_identity_check" CHECK(typeof("meter_id")='integer' AND "meter_id" BETWEEN 1 AND 1 AND typeof("version")='integer' AND "version" BETWEEN 1 AND 1 AND length("custody_id")=36 AND length(CAST("custody_id" AS BLOB))=36 AND "custody_id" NOT GLOB '*[^0-9a-f-]*' AND substr("custody_id",9,1)='-' AND substr("custody_id",14,1)='-' AND substr("custody_id",15,1)='4' AND substr("custody_id",19,1)='-' AND substr("custody_id",20,1) IN ('8','9','a','b') AND substr("custody_id",24,1)='-' AND typeof("revision")='integer' AND "revision" BETWEEN 1 AND 9007199254740991 AND typeof("created_at")='integer' AND "created_at" BETWEEN 0 AND 9007199254740991 AND typeof("updated_at")='integer' AND "updated_at" BETWEEN 0 AND 9007199254740991),
	CONSTRAINT "im_media_upload_meter_capacity_check" CHECK(typeof("used_records")='integer' AND "used_records" BETWEEN 1 AND 100000 AND typeof("used_bytes")='integer' AND "used_bytes" BETWEEN 92 AND 268435456)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `im_media_upload_attachment_idx` ON `im_media_upload_checkpoint` (`attachment_id`);--> statement-breakpoint
CREATE INDEX `im_media_upload_message_idx` ON `im_media_upload_checkpoint` (`planned_message_id`,`attachment_id`);--> statement-breakpoint
CREATE INDEX `im_media_upload_expiry_idx` ON `im_media_upload_checkpoint` (`original_local_expires_at`,`checkpoint_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `im_media_upload_meter_custody_idx` ON `im_media_upload_meter` (`custody_id`);