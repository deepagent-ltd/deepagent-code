CREATE TABLE `im_sync_cursors` (
	`conversation_id` text PRIMARY KEY,
	`last_sync_time` integer NOT NULL,
	`last_sync_seq` integer,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `im_groups` ADD `kernel_conv_id` text;--> statement-breakpoint
ALTER TABLE `im_messages` ADD `kernel_msg_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_im_groups_kernel_conv` ON `im_groups` (`kernel_conv_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_im_messages_kernel_msg` ON `im_messages` (`kernel_msg_id`);