CREATE TABLE `session_activity_effect_receipt` (
	`activity_kind` text NOT NULL,
	`activity_id` text NOT NULL,
	`receipt_id` text NOT NULL,
	`effect_fingerprint` text NOT NULL,
	`first_observation_revision` integer NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `session_activity_effect_receipt_pk` PRIMARY KEY(`activity_kind`, `activity_id`, `receipt_id`)
);
--> statement-breakpoint
CREATE TABLE `session_activity_evidence` (
	`activity_kind` text NOT NULL,
	`activity_id` text NOT NULL,
	`evidence_fingerprint` text NOT NULL,
	`evidence_kind` text NOT NULL,
	`source_receipt_id` text,
	`first_observation_revision` integer NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `session_activity_evidence_pk` PRIMARY KEY(`activity_kind`, `activity_id`, `evidence_fingerprint`)
);
--> statement-breakpoint
CREATE TABLE `session_activity_objective` (
	`activity_kind` text NOT NULL,
	`activity_id` text NOT NULL,
	`session_id` text NOT NULL,
	`version` integer NOT NULL,
	`admission_fingerprint` text NOT NULL,
	`objective_fingerprint` text,
	`objective_text` text,
	`completion_criteria` text NOT NULL,
	`enforcement_state` text NOT NULL,
	`stall_threshold` integer,
	`state` text NOT NULL,
	`no_progress_count` integer NOT NULL,
	`latest_observation_revision` integer NOT NULL,
	`latest_vector_hash` text,
	`next_action` text,
	`terminal_reason` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`settled_at` integer,
	CONSTRAINT `session_activity_objective_pk` PRIMARY KEY(`activity_kind`, `activity_id`),
	CONSTRAINT `fk_session_activity_objective_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `session_activity_permission_decision` (
	`decision_id` text PRIMARY KEY,
	`request_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`decision` text NOT NULL,
	`actor_type` text NOT NULL,
	`actor_id` text NOT NULL,
	`scope` text NOT NULL,
	`authority_epoch` integer NOT NULL,
	`decided_at` integer NOT NULL,
	`expires_at` integer
);
--> statement-breakpoint
CREATE TABLE `session_activity_permission_once_consumption` (
	`request_id` text PRIMARY KEY,
	`consumer_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`consumed_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `session_activity_permission_request` (
	`request_id` text PRIMARY KEY,
	`activity_kind` text NOT NULL,
	`activity_id` text NOT NULL,
	`session_id` text NOT NULL,
	`project_id` text NOT NULL,
	`request_kind` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`permission` text NOT NULL,
	`patterns` text NOT NULL,
	`always_patterns` text NOT NULL,
	`metadata_hash` text NOT NULL,
	`tool_message_id` text,
	`tool_call_id` text,
	`state` text NOT NULL,
	`authority_epoch` integer NOT NULL,
	`requested_scope` text NOT NULL,
	`owner_type` text NOT NULL,
	`owner_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer,
	`decided_at` integer,
	CONSTRAINT `fk_session_activity_permission_request_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_session_activity_permission_request_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `session_activity_progress_observation` (
	`activity_kind` text NOT NULL,
	`activity_id` text NOT NULL,
	`revision` integer NOT NULL,
	`idempotency_key` text NOT NULL,
	`observation_fingerprint` text NOT NULL,
	`expected_objective_version` integer NOT NULL,
	`workspace_revision` text,
	`plan_version` integer,
	`validation_fingerprint` text,
	`evidence_set_hash` text NOT NULL,
	`effect_receipt_set_hash` text NOT NULL,
	`vector_hash` text NOT NULL,
	`next_action` text,
	`changed` integer NOT NULL,
	`no_progress_count` integer NOT NULL,
	`observed_at` integer NOT NULL,
	CONSTRAINT `session_activity_progress_observation_pk` PRIMARY KEY(`activity_kind`, `activity_id`, `revision`)
);
--> statement-breakpoint
CREATE TABLE `learning_job` (
	`job_id` text PRIMARY KEY,
	`project_id` text NOT NULL,
	`session_id` text,
	`run_id` text,
	`trigger` text NOT NULL,
	`dedupe_key` text NOT NULL,
	`candidate_input_ref` text NOT NULL,
	`policy` text NOT NULL,
	`max_attempts` integer NOT NULL,
	`admission_fingerprint` text NOT NULL,
	`state` text NOT NULL,
	`attempts` integer NOT NULL,
	`owner` text,
	`lease_expires_at` integer,
	`version` integer NOT NULL,
	`side_effect_state` text NOT NULL,
	`side_effect_kind` text,
	`review_job_id` text,
	`result_ref` text,
	`error_code` text,
	`error_detail` text,
	`settlement_fingerprint` text,
	`next_attempt_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`settled_at` integer,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_learning_job_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`),
	CONSTRAINT `fk_learning_job_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`),
	CONSTRAINT "learning_job_trigger_check" CHECK("trigger" IN ('idle', 'pause', 'project_switch', 'session_finalization')),
	CONSTRAINT "learning_job_policy_check" CHECK("policy" IN ('auto_merge_safe_project', 'manual_review')),
	CONSTRAINT "learning_job_state_check" CHECK("state" IN ('queued', 'running', 'reviewing', 'governance', 'completed', 'failed', 'cancelled', 'recovery_required')),
	CONSTRAINT "learning_job_attempts_check" CHECK("attempts" >= 0),
	CONSTRAINT "learning_job_max_attempts_check" CHECK("max_attempts" > 0),
	CONSTRAINT "learning_job_version_check" CHECK("version" >= 0),
	CONSTRAINT "learning_job_admission_fingerprint_check" CHECK(length("admission_fingerprint") = 64 AND "admission_fingerprint" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "learning_job_side_effect_check" CHECK(("side_effect_state" = 'not_started' AND "side_effect_kind" IS NULL) OR ("side_effect_state" IN ('started', 'settled', 'unknown') AND "side_effect_kind" IS NOT NULL)),
	CONSTRAINT "learning_job_settled_result_check" CHECK("side_effect_state" <> 'settled' OR length(trim("result_ref")) > 0),
	CONSTRAINT "learning_job_active_phase_kind_check" CHECK("state" NOT IN ('running', 'reviewing', 'governance') OR "side_effect_state" = 'not_started' OR ("state" = 'running' AND "side_effect_kind" = 'extraction') OR ("state" = 'reviewing' AND "side_effect_kind" = 'reviewer') OR ("state" = 'governance' AND "side_effect_kind" = 'governance')),
	CONSTRAINT "learning_job_ownership_check" CHECK(("state" = 'queued' AND "owner" IS NULL AND "lease_expires_at" IS NULL AND "side_effect_state" = 'not_started') OR ("state" IN ('running', 'reviewing', 'governance') AND "started_at" IS NOT NULL AND "settled_at" IS NULL AND ((length(trim("owner")) > 0 AND "lease_expires_at" IS NOT NULL) OR ("state" IN ('reviewing', 'governance') AND "owner" IS NULL AND "lease_expires_at" IS NULL AND "side_effect_state" = 'not_started'))) OR ("state" IN ('completed', 'failed', 'cancelled', 'recovery_required') AND "owner" IS NULL AND "lease_expires_at" IS NULL AND "settled_at" IS NOT NULL)),
	CONSTRAINT "learning_job_recovery_check" CHECK("state" <> 'recovery_required' OR ("side_effect_state" <> 'not_started' AND "error_code" IS NOT NULL)),
	CONSTRAINT "learning_job_completed_check" CHECK("state" <> 'completed' OR ("side_effect_state" = 'settled' AND length(trim("result_ref")) > 0)),
	CONSTRAINT "learning_job_failed_check" CHECK("state" <> 'failed' OR length(trim("error_code")) > 0),
	CONSTRAINT "learning_job_terminal_side_effect_check" CHECK("state" NOT IN ('completed', 'failed', 'cancelled') OR "side_effect_state" IN ('not_started', 'settled')),
	CONSTRAINT "learning_job_settlement_fingerprint_check" CHECK("settlement_fingerprint" IS NULL OR (length("settlement_fingerprint") = 64 AND "settlement_fingerprint" NOT GLOB '*[^0-9a-f]*'))
);
--> statement-breakpoint
CREATE TABLE `permission_saved_epoch` (
	`project_id` text PRIMARY KEY,
	`epoch` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_permission_saved_epoch_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `session_activity_effect_receipt_activity_idx` ON `session_activity_effect_receipt` (`activity_kind`,`activity_id`,`first_observation_revision`);--> statement-breakpoint
CREATE INDEX `session_activity_evidence_activity_idx` ON `session_activity_evidence` (`activity_kind`,`activity_id`,`first_observation_revision`);--> statement-breakpoint
CREATE INDEX `session_activity_objective_session_idx` ON `session_activity_objective` (`session_id`,`state`,`updated_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `session_activity_permission_decision_request_idx` ON `session_activity_permission_decision` (`request_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `session_activity_permission_decision_idempotency_idx` ON `session_activity_permission_decision` (`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `session_activity_permission_once_consumption_idempotency_idx` ON `session_activity_permission_once_consumption` (`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `session_activity_permission_request_idempotency_idx` ON `session_activity_permission_request` (`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `session_activity_permission_request_pending_no_progress_idx` ON `session_activity_permission_request` (`activity_kind`,`activity_id`) WHERE "session_activity_permission_request"."state" = 'pending' AND "session_activity_permission_request"."request_kind" = 'no_progress';--> statement-breakpoint
CREATE INDEX `session_activity_permission_request_pending_idx` ON `session_activity_permission_request` (`session_id`,`state`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `session_activity_progress_observation_idempotency_idx` ON `session_activity_progress_observation` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `session_activity_progress_observation_latest_idx` ON `session_activity_progress_observation` (`activity_kind`,`activity_id`,`observed_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `learning_job_dedupe_idx` ON `learning_job` (`dedupe_key`);--> statement-breakpoint
CREATE INDEX `learning_job_due_idx` ON `learning_job` (`state`,`next_attempt_at`,`created_at`);--> statement-breakpoint
CREATE INDEX `learning_job_project_created_idx` ON `learning_job` (`project_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `learning_job_owner_lease_idx` ON `learning_job` (`owner`,`lease_expires_at`) WHERE "learning_job"."owner" IS NOT NULL;
