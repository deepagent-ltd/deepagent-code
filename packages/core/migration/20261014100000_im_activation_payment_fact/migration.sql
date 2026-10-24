CREATE TABLE `im_activation_payment_fact` (
  `transaction_id` text PRIMARY KEY NOT NULL,
  `source_hash` text NOT NULL,
  `request_hash` text NOT NULL,
  `name` text NOT NULL,
  `method` text NOT NULL,
  `quote_id` text NOT NULL,
  `state` text NOT NULL,
  `charged_credits` integer,
  `credential_stored` integer NOT NULL,
  `code` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  CONSTRAINT "im_activation_state_check" CHECK (`state` IN ('pending','unknown','succeeded','rejected')),
  CONSTRAINT "im_activation_method_check" CHECK (`method` IN ('api_key','activation_code')),
  CONSTRAINT "im_activation_charge_check" CHECK ((`state` IN ('pending','unknown','rejected') AND (`charged_credits` IS NULL OR `charged_credits` IN (0,1))) OR (`state` = 'succeeded' AND `charged_credits` IN (0,1)))
);
--> statement-breakpoint
INSERT INTO `im_activation_payment_fact` SELECT * FROM `im_activation`;
--> statement-breakpoint
DROP TABLE `im_activation`;
--> statement-breakpoint
ALTER TABLE `im_activation_payment_fact` RENAME TO `im_activation`;
--> statement-breakpoint
CREATE UNIQUE INDEX `im_activation_pending_idx` ON `im_activation` (`source_hash`) WHERE `state` IN ('pending','unknown') OR (`state` = 'succeeded' AND `credential_stored` = 0) OR (`state` = 'rejected' AND `charged_credits` = 1);
--> statement-breakpoint
CREATE INDEX `im_activation_source_idx` ON `im_activation` (`source_hash`, `created_at`);
