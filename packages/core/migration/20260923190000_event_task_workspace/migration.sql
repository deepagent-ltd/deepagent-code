CREATE TABLE `event_task_workspace` (
	`event_id` text NOT NULL,
	`task_id` text NOT NULL,
	`generation` integer NOT NULL,
	`operation_key` text NOT NULL,
	`repository_root` text NOT NULL,
	`base_commit` text NOT NULL,
	`branch` text NOT NULL,
	`directory` text NOT NULL,
	`state` text NOT NULL,
	`continuation_ref` text,
	`error` text,
	`time_created` integer NOT NULL,
	`time_settled` integer,
	CONSTRAINT `event_task_workspace_pk` PRIMARY KEY(`event_id`, `task_id`, `generation`)
);
--> statement-breakpoint
CREATE INDEX `event_task_workspace_reclaim_idx` ON `event_task_workspace` (`state`,`time_settled`);