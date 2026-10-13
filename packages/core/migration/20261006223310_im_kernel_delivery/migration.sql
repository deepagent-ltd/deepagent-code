CREATE TABLE `im_kernel_delivery` (
	`message_id` text PRIMARY KEY,
	`binding` text NOT NULL,
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
	CONSTRAINT "im_kernel_delivery_identity_check" CHECK(length("message_id") BETWEEN 1 AND 2048 AND length("wire_id") BETWEEN 1 AND 2048 AND ("dispatch_owner" IS NULL OR length("dispatch_owner") BETWEEN 1 AND 2048) AND ("kernel_message_id" IS NULL OR length("kernel_message_id") BETWEEN 1 AND 2048)),
	CONSTRAINT "im_kernel_delivery_time_check" CHECK("created_at" >= 0 AND "created_at" <= 9007199254740991 AND "updated_at" >= "created_at" AND "updated_at" <= 9007199254740991 AND ("dispatched_at" IS NULL OR ("dispatched_at" >= "created_at" AND "dispatched_at" <= "updated_at")) AND ("acknowledged_at" IS NULL OR ("acknowledged_at" >= "dispatched_at" AND "acknowledged_at" <= "updated_at"))),
	CONSTRAINT "im_kernel_delivery_binding_check" CHECK(json_valid("binding") AND json_type("binding") = 'object'),
	CONSTRAINT "im_kernel_delivery_hash_check" CHECK(length("binding_hash") = 64 AND "binding_hash" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "im_kernel_delivery_state_check" CHECK("state" IN ('prepared','dispatched','acknowledged','unknown')),
	CONSTRAINT "im_kernel_delivery_dispatch_check" CHECK(("state" = 'prepared' AND "dispatch_owner" IS NULL AND "dispatched_at" IS NULL) OR ("state" <> 'prepared' AND "dispatch_owner" IS NOT NULL AND "dispatched_at" IS NOT NULL)),
	CONSTRAINT "im_kernel_delivery_ack_check" CHECK(("state" = 'acknowledged' AND "kernel_message_id" IS NOT NULL AND "acknowledged_at" IS NOT NULL) OR ("state" <> 'acknowledged' AND "kernel_message_id" IS NULL AND "acknowledged_at" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `im_kernel_delivery_wire_idx` ON `im_kernel_delivery` (`wire_id`);--> statement-breakpoint
CREATE INDEX `im_kernel_delivery_prepared_idx` ON `im_kernel_delivery` (`state`,`created_at`,`message_id`);