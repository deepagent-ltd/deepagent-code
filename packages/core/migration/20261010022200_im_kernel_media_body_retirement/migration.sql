CREATE TABLE `__new_im_kernel_delivery` (
	`message_id` text PRIMARY KEY,
	`binding` text,
	`body_state` text DEFAULT 'live' NOT NULL,
	`binding_hash` text NOT NULL,
	`wire_id` text NOT NULL,
	`state` text NOT NULL,
	`dispatch_owner` text,
	`kernel_message_id` text,
	`reason` text,
	`created_at` integer NOT NULL,
	`dispatched_at` integer,
	`acknowledged_at` integer,
	`updated_at` integer NOT NULL,
	CONSTRAINT "im_kernel_delivery_identity_check" CHECK("message_id" IS NOT NULL AND length("message_id") BETWEEN 1 AND 2048 AND length("wire_id") BETWEEN 1 AND 2048 AND ("dispatch_owner" IS NULL OR length("dispatch_owner") BETWEEN 1 AND 2048) AND ("kernel_message_id" IS NULL OR length("kernel_message_id") BETWEEN 1 AND 2048)),
	CONSTRAINT "im_kernel_delivery_time_check" CHECK("created_at" >= 0 AND "created_at" <= 9007199254740991 AND "updated_at" >= "created_at" AND "updated_at" <= 9007199254740991 AND ("dispatched_at" IS NULL OR ("dispatched_at" >= "created_at" AND "dispatched_at" <= "updated_at")) AND ("acknowledged_at" IS NULL OR ("acknowledged_at" >= "dispatched_at" AND "acknowledged_at" <= "updated_at"))),
	CONSTRAINT "im_kernel_delivery_binding_check" CHECK(("body_state" = 'live' AND "binding" IS NOT NULL AND json_valid("binding") AND json_type("binding") = 'object') OR ("body_state" = 'retired' AND "binding" IS NULL AND "state" = 'acknowledged')),
	CONSTRAINT "im_kernel_delivery_hash_check" CHECK(length("binding_hash") = 64 AND "binding_hash" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "im_kernel_delivery_state_check" CHECK("state" IN ('prepared','dispatched','acknowledged','unknown')),
	CONSTRAINT "im_kernel_delivery_dispatch_check" CHECK(("state" = 'prepared' AND "dispatch_owner" IS NULL AND "dispatched_at" IS NULL) OR ("state" <> 'prepared' AND "dispatch_owner" IS NOT NULL AND "dispatched_at" IS NOT NULL)),
	CONSTRAINT "im_kernel_delivery_ack_check" CHECK(("state" = 'acknowledged' AND "kernel_message_id" IS NOT NULL AND "acknowledged_at" IS NOT NULL) OR ("state" <> 'acknowledged' AND "kernel_message_id" IS NULL AND "acknowledged_at" IS NULL))
);
--> statement-breakpoint
INSERT INTO `__new_im_kernel_delivery`(`message_id`,`binding`,`binding_hash`,`wire_id`,`state`,`dispatch_owner`,`kernel_message_id`,`reason`,`created_at`,`dispatched_at`,`acknowledged_at`,`updated_at`) SELECT `message_id`,`binding`,`binding_hash`,`wire_id`,`state`,`dispatch_owner`,`kernel_message_id`,`reason`,`created_at`,`dispatched_at`,`acknowledged_at`,`updated_at` FROM `im_kernel_delivery`;
--> statement-breakpoint
DROP TABLE `im_kernel_delivery`;
--> statement-breakpoint
ALTER TABLE `__new_im_kernel_delivery` RENAME TO `im_kernel_delivery`;
--> statement-breakpoint
CREATE TABLE `im_kernel_media_meter` (
	`meter_id` integer PRIMARY KEY,
	`version` integer NOT NULL,
	`custody_id` text NOT NULL,
	`revision` integer NOT NULL,
	`used_records` integer NOT NULL,
	`used_bytes` integer NOT NULL,
	CONSTRAINT "im_kernel_media_meter_identity_check" CHECK(typeof("meter_id") = 'integer' AND "meter_id" BETWEEN 1 AND 1 AND typeof("version") = 'integer' AND "version" BETWEEN 1 AND 1 AND length("custody_id") = 36 AND length(CAST("custody_id" AS BLOB)) = 36 AND "custody_id" NOT GLOB '*[^0-9a-f-]*' AND substr("custody_id",9,1)='-' AND substr("custody_id",14,1)='-' AND substr("custody_id",15,1)='4' AND substr("custody_id",19,1)='-' AND substr("custody_id",20,1) IN ('8','9','a','b') AND substr("custody_id",24,1)='-'),
	CONSTRAINT "im_kernel_media_meter_capacity_check" CHECK(typeof("revision") = 'integer' AND "revision" BETWEEN 1 AND 9007199254740991 AND typeof("used_records") = 'integer' AND "used_records" BETWEEN 1 AND 100000 AND typeof("used_bytes") = 'integer' AND "used_bytes" BETWEEN 76 AND 268435456)
);
--> statement-breakpoint
CREATE TABLE `im_kernel_media_body` (
	`message_id` text PRIMARY KEY,
	`meter_id` integer NOT NULL,
	`version` integer NOT NULL,
	`workspace_id` text NOT NULL,
	`group_id` text NOT NULL,
	`source_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`body_state` text NOT NULL,
	`local_revision` integer NOT NULL,
	`retired_at` integer,
	`record` text NOT NULL,
	`record_hash` text NOT NULL,
	`identity_hash` text NOT NULL,
	`accounted_records` integer NOT NULL,
	`accounted_bytes` integer NOT NULL,
	CONSTRAINT `fk_im_kernel_media_body_meter_id_im_kernel_media_meter_meter_id_fk` FOREIGN KEY (`meter_id`) REFERENCES `im_kernel_media_meter`(`meter_id`) ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT `fk_im_kernel_media_body_message_id_im_kernel_delivery_message_id_fk` FOREIGN KEY (`message_id`) REFERENCES `im_kernel_delivery`(`message_id`) ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT `fk_im_kernel_media_body_message_id_im_messages_id_fk` FOREIGN KEY (`message_id`) REFERENCES `im_messages`(`id`) ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT `fk_im_kernel_media_body_group_id_im_groups_id_fk` FOREIGN KEY (`group_id`) REFERENCES `im_groups`(`id`) ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT "im_kernel_media_body_identity_check" CHECK(typeof("meter_id") = 'integer' AND "meter_id" BETWEEN 1 AND 1 AND typeof("version") = 'integer' AND "version" BETWEEN 1 AND 1 AND typeof("local_revision") = 'integer' AND "local_revision" BETWEEN 1 AND 9007199254740991 AND typeof("source_hash") = 'text' AND length("source_hash") = 64 AND length(CAST("source_hash" AS BLOB)) = 64 AND "source_hash" NOT GLOB '*[^0-9a-f]*' AND typeof("record_hash") = 'text' AND length("record_hash") = 64 AND length(CAST("record_hash" AS BLOB)) = 64 AND "record_hash" NOT GLOB '*[^0-9a-f]*' AND typeof("identity_hash") = 'text' AND length("identity_hash") = 64 AND length(CAST("identity_hash" AS BLOB)) = 64 AND "identity_hash" NOT GLOB '*[^0-9a-f]*' AND length("message_id") BETWEEN 1 AND 2048 AND length("group_id") BETWEEN 1 AND 2048 AND length("workspace_id") BETWEEN 1 AND 2048),
	CONSTRAINT "im_kernel_media_body_lifecycle_check" CHECK(typeof("expires_at") = 'integer' AND "expires_at" BETWEEN 0 AND 9007199254740991 AND (("body_state"='live' AND "retired_at" IS NULL) OR ("body_state"='retired' AND typeof("retired_at") = 'integer' AND "retired_at" BETWEEN 0 AND 9007199254740991 AND "retired_at">="expires_at"))),
	CONSTRAINT "im_kernel_media_body_accounting_check" CHECK(typeof("accounted_records") = 'integer' AND "accounted_records" BETWEEN 3 AND 3 AND typeof("accounted_bytes") = 'integer' AND "accounted_bytes" BETWEEN 1 AND 268435456),
	CONSTRAINT "im_kernel_media_body_record_check" CHECK(CASE WHEN typeof("record")='text' AND length(CAST("record" AS BLOB)) BETWEEN 1 AND 65536 AND json_valid("record") THEN coalesce(json_type("record")='object' AND json_type("record",'$.version')='integer' AND json_extract("record",'$.version')=1 AND json_extract("record",'$.identity.originalBindingVersion')=2 AND json_extract("record",'$.identity.messageID')="message_id" AND json_extract("record",'$.identity.groupID')="group_id" AND json_extract("record",'$.identity.workspaceID')="workspace_id" AND json_extract("record",'$.identity.sourceHash')="source_hash" AND json_extract("record",'$.identity.expiresAt')="expires_at" AND json_extract("record",'$.identityHash')="identity_hash" AND json_extract("record",'$.bodyState')="body_state" AND json_extract("record",'$.retiredAt') IS "retired_at",0) ELSE 0 END)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `im_kernel_delivery_wire_idx` ON `im_kernel_delivery` (`wire_id`);
--> statement-breakpoint
CREATE INDEX `im_kernel_delivery_prepared_idx` ON `im_kernel_delivery` (`state`,`created_at`,`message_id`);
--> statement-breakpoint
CREATE INDEX `im_kernel_delivery_result_lookup_idx` ON `im_kernel_delivery` (`kernel_message_id`,`state`);
--> statement-breakpoint
CREATE INDEX `im_kernel_media_body_expiry_idx` ON `im_kernel_media_body` (`body_state`,`expires_at`,`message_id`);
--> statement-breakpoint
CREATE INDEX `im_kernel_media_body_scope_idx` ON `im_kernel_media_body` (`workspace_id`,`source_hash`,`body_state`,`expires_at`,`message_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `im_kernel_media_meter_custody_idx` ON `im_kernel_media_meter` (`custody_id`);
