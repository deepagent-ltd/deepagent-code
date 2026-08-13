CREATE TABLE `learning_governance_compensation` (
	`compensation_id` text PRIMARY KEY,
	`plan_id` text NOT NULL,
	`action_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`kind` text NOT NULL,
	`source_payload_fingerprint` text NOT NULL,
	`state` text NOT NULL,
	`owner` text,
	`lease_expires_at` integer,
	`version` integer NOT NULL,
	`result_ref` text,
	`result_hash` text,
	`result_fingerprint` text,
	`error_code` text,
	`error_detail` text,
	`created_at` integer NOT NULL,
	`settled_at` integer,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_learning_governance_compensation_plan_id_learning_governance_plan_plan_id_fk` FOREIGN KEY (`plan_id`) REFERENCES `learning_governance_plan`(`plan_id`),
	CONSTRAINT `fk_learning_governance_compensation_action_id_learning_governance_action_action_id_fk` FOREIGN KEY (`action_id`) REFERENCES `learning_governance_action`(`action_id`),
	CONSTRAINT "learning_governance_compensation_sequence_check" CHECK("sequence" >= 0),
	CONSTRAINT "learning_governance_compensation_version_check" CHECK("version" >= 0),
	CONSTRAINT "learning_governance_compensation_kind_check" CHECK("kind" IN ('document_quarantine', 'memory_inbox_revoke')),
	CONSTRAINT "learning_governance_compensation_source_fingerprint_check" CHECK(length("source_payload_fingerprint") = 64 AND "source_payload_fingerprint" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "learning_governance_compensation_result_hash_check" CHECK("result_hash" IS NULL OR (length("result_hash") = 64 AND "result_hash" NOT GLOB '*[^0-9a-f]*')),
	CONSTRAINT "learning_governance_compensation_result_fingerprint_check" CHECK("result_fingerprint" IS NULL OR (length("result_fingerprint") = 64 AND "result_fingerprint" NOT GLOB '*[^0-9a-f]*')),
	CONSTRAINT "learning_governance_compensation_state_check" CHECK("state" IN ('prepared', 'running', 'settled', 'recovery_required')),
	CONSTRAINT "learning_governance_compensation_lifecycle_check" CHECK(("state" = 'prepared' AND "owner" IS NULL AND "lease_expires_at" IS NULL AND "result_ref" IS NULL AND "result_hash" IS NULL AND "result_fingerprint" IS NULL AND "error_code" IS NULL AND "settled_at" IS NULL) OR ("state" = 'running' AND length(trim("owner")) > 0 AND "lease_expires_at" IS NOT NULL AND "result_ref" IS NULL AND "result_hash" IS NULL AND "result_fingerprint" IS NULL AND "error_code" IS NULL AND "settled_at" IS NULL) OR ("state" = 'settled' AND "owner" IS NULL AND "lease_expires_at" IS NULL AND length(trim("result_ref")) > 0 AND "result_hash" IS NOT NULL AND "result_fingerprint" IS NOT NULL AND "error_code" IS NULL AND "settled_at" IS NOT NULL) OR ("state" = 'recovery_required' AND "owner" IS NULL AND "lease_expires_at" IS NULL AND length(trim("error_code")) > 0 AND "settled_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE `learning_lifecycle_trigger_receipt` (
	`receipt_id` text PRIMARY KEY,
	`trigger` text NOT NULL,
	`boundary_key` text NOT NULL,
	`session_id` text NOT NULL,
	`run_id` text NOT NULL,
	`source_admission_hash` text NOT NULL,
	`source_terminal_hash` text NOT NULL,
	`artifact_path` text NOT NULL,
	`artifact_hash` text NOT NULL,
	`artifact_json` text NOT NULL,
	`admission_fingerprint` text NOT NULL,
	`admission_json` text NOT NULL,
	`state` text NOT NULL,
	`error_detail` text,
	`created_at` integer NOT NULL,
	`settled_at` integer,
	`updated_at` integer NOT NULL,
	CONSTRAINT "learning_lifecycle_trigger_kind_check" CHECK("trigger" IN ('idle', 'pause', 'project_switch')),
	CONSTRAINT "learning_lifecycle_trigger_state_check" CHECK("state" IN ('prepared', 'admitted')),
	CONSTRAINT "learning_lifecycle_trigger_source_admission_hash_check" CHECK(length("source_admission_hash") = 64 AND "source_admission_hash" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "learning_lifecycle_trigger_source_terminal_hash_check" CHECK(length("source_terminal_hash") = 64 AND "source_terminal_hash" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "learning_lifecycle_trigger_artifact_hash_check" CHECK(length("artifact_hash") = 64 AND "artifact_hash" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "learning_lifecycle_trigger_admission_fingerprint_check" CHECK(length("admission_fingerprint") = 64 AND "admission_fingerprint" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "learning_lifecycle_trigger_admission_json_check" CHECK(json_valid("admission_json") AND json_type("admission_json") = 'object'),
	CONSTRAINT "learning_lifecycle_trigger_artifact_json_check" CHECK(json_valid("artifact_json") AND json_type("artifact_json") = 'object'),
	CONSTRAINT "learning_lifecycle_trigger_settlement_check" CHECK(("state" = 'prepared' AND "settled_at" IS NULL) OR ("state" = 'admitted' AND "settled_at" IS NOT NULL AND "error_detail" IS NULL))
);
--> statement-breakpoint
CREATE TABLE `learning_reviewer_attempt` (
	`attempt_id` text PRIMARY KEY,
	`job_id` text NOT NULL,
	`state` text NOT NULL,
	`version` integer NOT NULL,
	`owner` text,
	`review_session_id` text NOT NULL,
	`request_ref` text NOT NULL,
	`request_hash` text NOT NULL,
	`source_candidate_ids_json` text NOT NULL,
	`source_candidate_set_hash` text NOT NULL,
	`provider_id` text NOT NULL,
	`model_id` text NOT NULL,
	`policy_hash` text NOT NULL,
	`response_ref` text,
	`response_hash` text,
	`verdict` text,
	`selected_candidate_ids_json` text,
	`selected_subset_hash` text,
	`error_code` text,
	`error_detail` text,
	`created_at` integer NOT NULL,
	`dispatched_at` integer,
	`settled_at` integer,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_learning_reviewer_attempt_job_id_learning_job_job_id_fk` FOREIGN KEY (`job_id`) REFERENCES `learning_job`(`job_id`),
	CONSTRAINT "learning_reviewer_attempt_state_check" CHECK("state" IN ('prepared', 'dispatching', 'settled', 'failed', 'recovery_required')),
	CONSTRAINT "learning_reviewer_attempt_version_check" CHECK("version" >= 0),
	CONSTRAINT "learning_reviewer_attempt_hash_check" CHECK(length("request_hash") = 64 AND "request_hash" NOT GLOB '*[^0-9a-f]*' AND length("source_candidate_set_hash") = 64 AND "source_candidate_set_hash" NOT GLOB '*[^0-9a-f]*' AND length("policy_hash") = 64 AND "policy_hash" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "learning_reviewer_attempt_terminal_check" CHECK(("state" IN ('prepared', 'dispatching') AND "settled_at" IS NULL) OR ("state" IN ('settled', 'failed', 'recovery_required') AND "settled_at" IS NOT NULL)),
	CONSTRAINT "learning_reviewer_attempt_response_check" CHECK(("state" <> 'settled' AND "response_ref" IS NULL AND "response_hash" IS NULL AND "verdict" IS NULL AND "selected_candidate_ids_json" IS NULL AND "selected_subset_hash" IS NULL) OR ("state" = 'settled' AND length(trim("response_ref")) > 0 AND length("response_hash") = 64 AND "response_hash" NOT GLOB '*[^0-9a-f]*' AND "verdict" IN ('approve', 'reject', 'manual_review') AND length(trim("selected_candidate_ids_json")) > 0 AND length("selected_subset_hash") = 64 AND "selected_subset_hash" NOT GLOB '*[^0-9a-f]*')),
	CONSTRAINT "learning_reviewer_attempt_error_check" CHECK("state" NOT IN ('failed', 'recovery_required') OR length(trim("error_code")) > 0)
);
--> statement-breakpoint
CREATE TABLE `session_v2_provider_parity_receipt` (
	`campaign_id` text NOT NULL,
	`case_name` text NOT NULL,
	`legacy_receipt_id` text NOT NULL,
	`core_v2_receipt_id` text NOT NULL,
	`legacy_request_hash` text NOT NULL,
	`core_v2_request_hash` text NOT NULL,
	`legacy_outcome_hash` text NOT NULL,
	`core_v2_outcome_hash` text NOT NULL,
	`legacy_prepared_turn` text NOT NULL,
	`core_v2_prepared_turn` text NOT NULL,
	`diff_artifact` text NOT NULL,
	`allowlist_version` text NOT NULL,
	`allowlisted_differences` text NOT NULL,
	`disallowed_differences` text NOT NULL,
	`evidence` text NOT NULL,
	`verified` integer NOT NULL,
	`receipt_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `session_v2_provider_parity_receipt_pk` PRIMARY KEY(`campaign_id`, `case_name`),
	CONSTRAINT `fk_session_v2_provider_parity_receipt_core_v2_receipt_id_session_v2_provider_turn_receipt_receipt_id_fk` FOREIGN KEY (`core_v2_receipt_id`) REFERENCES `session_v2_provider_turn_receipt`(`receipt_id`)
);
--> statement-breakpoint
CREATE TABLE `session_v2_provider_turn_receipt` (
	`receipt_id` text PRIMARY KEY,
	`session_id` text NOT NULL,
	`request_ordinal` integer NOT NULL,
	`user_message_id` text NOT NULL,
	`history_prompt_epoch` integer NOT NULL,
	`history_source_end_message_id` text,
	`request_input_hash` text NOT NULL,
	`provider_id` text NOT NULL,
	`model_id` text NOT NULL,
	`protocol` text NOT NULL,
	`owner_mode` text NOT NULL,
	`owner_token` text NOT NULL,
	`state` text NOT NULL,
	`prepared_turn_hash` text,
	`wire_request_hash` text,
	`prepared_turn` text,
	`outcome_hash` text,
	`error_code` text,
	`created_at` integer NOT NULL,
	`dispatching_at` integer,
	`first_event_at` integer,
	`terminal_at` integer,
	CONSTRAINT `fk_session_v2_provider_turn_receipt_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_session_v2_provider_turn_receipt_owner_token_session_provider_owner_lease_owner_token_fk` FOREIGN KEY (`owner_token`) REFERENCES `session_provider_owner_lease`(`owner_token`)
);
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_learning_job` (
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
	`expected_result_ref` text,
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
	CONSTRAINT "learning_job_expected_result_check" CHECK(("side_effect_state" = 'not_started' AND "expected_result_ref" IS NULL) OR ("side_effect_kind" IN ('extraction', 'reviewer') AND "side_effect_state" IN ('started', 'settled') AND length(trim("expected_result_ref")) > 0) OR ("side_effect_kind" = 'governance' AND "expected_result_ref" IS NULL) OR ("side_effect_state" = 'unknown' AND "expected_result_ref" IS NULL)),
	CONSTRAINT "learning_job_settled_result_check" CHECK("side_effect_state" <> 'settled' OR (length(trim("result_ref")) > 0 AND ("expected_result_ref" IS NULL OR "side_effect_kind" = 'reviewer' OR "result_ref" = "expected_result_ref"))),
	CONSTRAINT "learning_job_active_phase_kind_check" CHECK("state" NOT IN ('running', 'reviewing', 'governance') OR "side_effect_state" = 'not_started' OR ("state" = 'running' AND "side_effect_kind" = 'extraction') OR ("state" = 'reviewing' AND "side_effect_kind" = 'reviewer') OR ("state" = 'governance' AND "side_effect_kind" = 'governance')),
	CONSTRAINT "learning_job_ownership_check" CHECK(("state" = 'queued' AND "owner" IS NULL AND "lease_expires_at" IS NULL AND "side_effect_state" = 'not_started') OR ("state" IN ('running', 'reviewing', 'governance') AND "started_at" IS NOT NULL AND "settled_at" IS NULL AND ((length(trim("owner")) > 0 AND "lease_expires_at" IS NOT NULL) OR ("state" IN ('reviewing', 'governance') AND "owner" IS NULL AND "lease_expires_at" IS NULL AND "side_effect_state" = 'not_started'))) OR ("state" IN ('completed', 'failed', 'cancelled', 'recovery_required') AND "owner" IS NULL AND "lease_expires_at" IS NULL AND "settled_at" IS NOT NULL)),
	CONSTRAINT "learning_job_recovery_check" CHECK("state" <> 'recovery_required' OR ("side_effect_state" <> 'not_started' AND "error_code" IS NOT NULL)),
	CONSTRAINT "learning_job_completed_check" CHECK("state" <> 'completed' OR ("side_effect_state" = 'settled' AND length(trim("result_ref")) > 0)),
	CONSTRAINT "learning_job_failed_check" CHECK("state" <> 'failed' OR length(trim("error_code")) > 0),
	CONSTRAINT "learning_job_terminal_side_effect_check" CHECK("state" NOT IN ('completed', 'failed', 'cancelled') OR "side_effect_state" IN ('not_started', 'settled')),
	CONSTRAINT "learning_job_settlement_fingerprint_check" CHECK("settlement_fingerprint" IS NULL OR (length("settlement_fingerprint") = 64 AND "settlement_fingerprint" NOT GLOB '*[^0-9a-f]*'))
);
--> statement-breakpoint
INSERT INTO `__new_learning_job`(`job_id`, `project_id`, `session_id`, `run_id`, `trigger`, `dedupe_key`, `candidate_input_ref`, `policy`, `max_attempts`, `admission_fingerprint`, `state`, `attempts`, `owner`, `lease_expires_at`, `version`, `side_effect_state`, `side_effect_kind`, `expected_result_ref`, `review_job_id`, `result_ref`, `error_code`, `error_detail`, `settlement_fingerprint`, `next_attempt_at`, `created_at`, `started_at`, `settled_at`, `updated_at`) SELECT `job_id`, `project_id`, `session_id`, `run_id`, `trigger`, `dedupe_key`, `candidate_input_ref`, `policy`, `max_attempts`, `admission_fingerprint`, `state`, `attempts`, `owner`, `lease_expires_at`, `version`, `side_effect_state`, `side_effect_kind`, `expected_result_ref`, `review_job_id`, `result_ref`, `error_code`, `error_detail`, `settlement_fingerprint`, `next_attempt_at`, `created_at`, `started_at`, `settled_at`, `updated_at` FROM `learning_job`;--> statement-breakpoint
DROP TABLE `learning_job`;--> statement-breakpoint
ALTER TABLE `__new_learning_job` RENAME TO `learning_job`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `learning_job_dedupe_idx` ON `learning_job` (`dedupe_key`);--> statement-breakpoint
CREATE INDEX `learning_job_due_idx` ON `learning_job` (`state`,`next_attempt_at`,`created_at`);--> statement-breakpoint
CREATE INDEX `learning_job_project_created_idx` ON `learning_job` (`project_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `learning_job_owner_lease_idx` ON `learning_job` (`owner`,`lease_expires_at`) WHERE "learning_job"."owner" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `learning_governance_compensation_action_idx` ON `learning_governance_compensation` (`action_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `learning_governance_compensation_plan_sequence_idx` ON `learning_governance_compensation` (`plan_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `learning_governance_compensation_claim_idx` ON `learning_governance_compensation` (`state`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `learning_lifecycle_trigger_identity_idx` ON `learning_lifecycle_trigger_receipt` (`trigger`,`session_id`,`run_id`);--> statement-breakpoint
CREATE INDEX `learning_lifecycle_trigger_pending_idx` ON `learning_lifecycle_trigger_receipt` (`created_at`,`receipt_id`) WHERE "learning_lifecycle_trigger_receipt"."state" = 'prepared';--> statement-breakpoint
CREATE UNIQUE INDEX `learning_reviewer_attempt_job_idx` ON `learning_reviewer_attempt` (`job_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `learning_reviewer_attempt_session_idx` ON `learning_reviewer_attempt` (`review_session_id`);--> statement-breakpoint
CREATE INDEX `learning_reviewer_attempt_state_idx` ON `learning_reviewer_attempt` (`state`,`updated_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `session_v2_provider_parity_receipt_hash_idx` ON `session_v2_provider_parity_receipt` (`receipt_hash`);--> statement-breakpoint
CREATE INDEX `session_v2_provider_parity_receipt_campaign_idx` ON `session_v2_provider_parity_receipt` (`campaign_id`,`verified`);--> statement-breakpoint
CREATE UNIQUE INDEX `session_v2_provider_turn_receipt_ordinal_idx` ON `session_v2_provider_turn_receipt` (`session_id`,`request_ordinal`);--> statement-breakpoint
CREATE INDEX `session_v2_provider_turn_receipt_input_idx` ON `session_v2_provider_turn_receipt` (`session_id`,`user_message_id`,`history_prompt_epoch`,`request_input_hash`);--> statement-breakpoint
CREATE INDEX `session_v2_provider_turn_receipt_owner_state_idx` ON `session_v2_provider_turn_receipt` (`owner_token`,`state`,`created_at`);