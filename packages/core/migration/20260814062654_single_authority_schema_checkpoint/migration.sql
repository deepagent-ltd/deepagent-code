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
	`expires_at` integer,
	`feedback` text
);
--> statement-breakpoint
CREATE TABLE `session_activity_permission_effect_dispatch` (
	`receipt_id` text PRIMARY KEY,
	`request_id` text NOT NULL,
	`activity_kind` text NOT NULL,
	`activity_id` text NOT NULL,
	`session_id` text NOT NULL,
	`project_id` text NOT NULL,
	`workspace_id` text,
	`tool_message_id` text NOT NULL,
	`tool_call_id` text NOT NULL,
	`tool_name` text NOT NULL,
	`consumer_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`owner_id` text NOT NULL,
	`state` text NOT NULL,
	`version` integer NOT NULL,
	`outcome` text,
	`result_json` text,
	`result_hash` text,
	`started_at` integer NOT NULL,
	`settled_at` integer,
	CONSTRAINT `fk_session_activity_permission_effect_dispatch_request_id_session_activity_permission_request_request_id_fk` FOREIGN KEY (`request_id`) REFERENCES `session_activity_permission_request`(`request_id`) ON DELETE CASCADE,
	CONSTRAINT `fk_session_activity_permission_effect_dispatch_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_session_activity_permission_effect_dispatch_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `session_activity_permission_once_consumption` (
	`request_id` text PRIMARY KEY,
	`consumer_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`consumed_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `session_activity_permission_owner_lease` (
	`owner_id` text PRIMARY KEY,
	`lease_expires_at` integer NOT NULL,
	`heartbeat_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `session_activity_permission_request` (
	`request_id` text PRIMARY KEY,
	`activity_kind` text NOT NULL,
	`activity_id` text NOT NULL,
	`session_id` text NOT NULL,
	`project_id` text NOT NULL,
	`workspace_id` text,
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
CREATE TABLE `learning_admission_outbox` (
	`intent_id` text PRIMARY KEY,
	`session_id` text NOT NULL,
	`run_id` text NOT NULL,
	`trigger` text NOT NULL,
	`dedupe_key` text NOT NULL,
	`payload_json` text NOT NULL,
	`payload_fingerprint` text NOT NULL,
	`state` text NOT NULL,
	`job_id` text,
	`candidate_input_ref` text,
	`rejection_code` text,
	`rejection_detail` text,
	`created_at` integer NOT NULL,
	`settled_at` integer,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_learning_admission_outbox_job_id_learning_job_job_id_fk` FOREIGN KEY (`job_id`) REFERENCES `learning_job`(`job_id`),
	CONSTRAINT "learning_admission_outbox_trigger_check" CHECK("trigger" IN ('idle', 'pause', 'project_switch', 'session_finalization')),
	CONSTRAINT "learning_admission_outbox_payload_json_check" CHECK(json_valid("payload_json") AND json_type("payload_json") = 'object'),
	CONSTRAINT "learning_admission_outbox_payload_fingerprint_check" CHECK(length("payload_fingerprint") = 64 AND "payload_fingerprint" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "learning_admission_outbox_state_check" CHECK("state" IN ('pending', 'admitted', 'rejected')),
	CONSTRAINT "learning_admission_outbox_settlement_check" CHECK(("state" = 'pending' AND "job_id" IS NULL AND "candidate_input_ref" IS NULL AND "rejection_code" IS NULL AND "rejection_detail" IS NULL AND "settled_at" IS NULL) OR ("state" = 'admitted' AND "job_id" IS NOT NULL AND length(trim("candidate_input_ref")) > 0 AND "rejection_code" IS NULL AND "rejection_detail" IS NULL AND "settled_at" IS NOT NULL) OR ("state" = 'rejected' AND "job_id" IS NULL AND length(trim("rejection_code")) > 0 AND length(trim("rejection_detail")) > 0 AND "settled_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE `learning_governance_action` (
	`action_id` text PRIMARY KEY,
	`plan_id` text NOT NULL,
	`candidate_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`kind` text NOT NULL,
	`predecessor_action_id` text,
	`payload_json` text NOT NULL,
	`payload_fingerprint` text NOT NULL,
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
	CONSTRAINT `fk_learning_governance_action_plan_id_learning_governance_plan_plan_id_fk` FOREIGN KEY (`plan_id`) REFERENCES `learning_governance_plan`(`plan_id`),
	CONSTRAINT "learning_governance_action_sequence_check" CHECK("sequence" >= 0),
	CONSTRAINT "learning_governance_action_version_check" CHECK("version" >= 0),
	CONSTRAINT "learning_governance_action_candidate_check" CHECK(length(trim("candidate_id")) > 0),
	CONSTRAINT "learning_governance_action_payload_json_check" CHECK(json_valid("payload_json")),
	CONSTRAINT "learning_governance_action_kind_check" CHECK("kind" IN ('document_stage', 'memory_inbox')),
	CONSTRAINT "learning_governance_action_payload_fingerprint_check" CHECK(length("payload_fingerprint") = 64 AND "payload_fingerprint" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "learning_governance_action_result_hash_check" CHECK("result_hash" IS NULL OR (length("result_hash") = 64 AND "result_hash" NOT GLOB '*[^0-9a-f]*')),
	CONSTRAINT "learning_governance_action_result_fingerprint_check" CHECK("result_fingerprint" IS NULL OR (length("result_fingerprint") = 64 AND "result_fingerprint" NOT GLOB '*[^0-9a-f]*')),
	CONSTRAINT "learning_governance_action_state_check" CHECK("state" IN ('prepared', 'running', 'settled', 'recovery_required')),
	CONSTRAINT "learning_governance_action_lifecycle_check" CHECK(("state" = 'prepared' AND "owner" IS NULL AND "lease_expires_at" IS NULL AND "result_ref" IS NULL AND "result_hash" IS NULL AND "result_fingerprint" IS NULL AND "error_code" IS NULL AND "settled_at" IS NULL) OR ("state" = 'running' AND length(trim("owner")) > 0 AND "lease_expires_at" IS NOT NULL AND "result_ref" IS NULL AND "result_hash" IS NULL AND "result_fingerprint" IS NULL AND "error_code" IS NULL AND "settled_at" IS NULL) OR ("state" = 'settled' AND "owner" IS NULL AND "lease_expires_at" IS NULL AND length(trim("result_ref")) > 0 AND "result_hash" IS NOT NULL AND "result_fingerprint" IS NOT NULL AND "error_code" IS NULL AND "settled_at" IS NOT NULL) OR ("state" = 'recovery_required' AND "owner" IS NULL AND "lease_expires_at" IS NULL AND length(trim("error_code")) > 0 AND "settled_at" IS NOT NULL))
);
--> statement-breakpoint
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
CREATE TABLE `learning_governance_plan` (
	`plan_id` text PRIMARY KEY,
	`job_id` text NOT NULL,
	`policy` text NOT NULL,
	`payload_json` text NOT NULL,
	`payload_fingerprint` text NOT NULL,
	`action_count` integer NOT NULL,
	`job_owner` text NOT NULL,
	`source_job_version` integer NOT NULL,
	`job_started_version` integer NOT NULL,
	`state` text NOT NULL,
	`version` integer NOT NULL,
	`result_ref` text,
	`result_hash` text,
	`result_fingerprint` text,
	`error_code` text,
	`error_detail` text,
	`created_at` integer NOT NULL,
	`settled_at` integer,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_learning_governance_plan_job_id_learning_job_job_id_fk` FOREIGN KEY (`job_id`) REFERENCES `learning_job`(`job_id`),
	CONSTRAINT "learning_governance_plan_policy_check" CHECK("policy" = 'manual_review'),
	CONSTRAINT "learning_governance_plan_action_count_check" CHECK("action_count" >= 0),
	CONSTRAINT "learning_governance_plan_version_check" CHECK("version" >= 0),
	CONSTRAINT "learning_governance_plan_payload_json_check" CHECK(json_valid("payload_json")),
	CONSTRAINT "learning_governance_plan_payload_fingerprint_check" CHECK(length("payload_fingerprint") = 64 AND "payload_fingerprint" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "learning_governance_plan_result_hash_check" CHECK("result_hash" IS NULL OR (length("result_hash") = 64 AND "result_hash" NOT GLOB '*[^0-9a-f]*')),
	CONSTRAINT "learning_governance_plan_result_fingerprint_check" CHECK("result_fingerprint" IS NULL OR (length("result_fingerprint") = 64 AND "result_fingerprint" NOT GLOB '*[^0-9a-f]*')),
	CONSTRAINT "learning_governance_plan_state_check" CHECK("state" IN ('prepared', 'settled', 'recovery_required')),
	CONSTRAINT "learning_governance_plan_settlement_check" CHECK(("state" = 'prepared' AND "result_ref" IS NULL AND "result_hash" IS NULL AND "result_fingerprint" IS NULL AND "error_code" IS NULL AND "settled_at" IS NULL) OR ("state" = 'settled' AND length(trim("result_ref")) > 0 AND "result_hash" IS NOT NULL AND "result_fingerprint" IS NOT NULL AND "error_code" IS NULL AND "settled_at" IS NOT NULL) OR ("state" = 'recovery_required' AND length(trim("error_code")) > 0 AND "settled_at" IS NOT NULL))
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
CREATE TABLE `released_knowledge_evaluation` (
	`evaluation_id` text PRIMARY KEY,
	`security_namespace_id` text NOT NULL,
	`project_scope_key` text NOT NULL,
	`matrix_hash` text NOT NULL,
	`matrix_json` text NOT NULL,
	`document_manifest_json` text NOT NULL,
	`baseline_ref` text NOT NULL,
	`repetitions` integer NOT NULL,
	`evaluator_type` text NOT NULL,
	`evaluator_id` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_released_knowledge_evaluation_security_namespace_id_context_security_namespace_id_fk` FOREIGN KEY (`security_namespace_id`) REFERENCES `context_security_namespace`(`id`),
	CONSTRAINT `fk_released_knowledge_evaluation_security_namespace_id_project_scope_key_context_project_scope_identity_security_namespace_id_project_scope_key_fk` FOREIGN KEY (`security_namespace_id`,`project_scope_key`) REFERENCES `context_project_scope_identity`(`security_namespace_id`,`project_scope_key`),
	CONSTRAINT "released_knowledge_evaluation_matrix_hash_check" CHECK(length("matrix_hash") = 64 AND "matrix_hash" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "released_knowledge_evaluation_matrix_json_check" CHECK(json_valid("matrix_json")),
	CONSTRAINT "released_knowledge_evaluation_document_manifest_json_check" CHECK(json_valid("document_manifest_json") AND json_type("document_manifest_json") = 'array'),
	CONSTRAINT "released_knowledge_evaluation_repetitions_check" CHECK("repetitions" > 0),
	CONSTRAINT "released_knowledge_evaluation_actor_type_check" CHECK("evaluator_type" IN ('human', 'agent', 'system'))
);
--> statement-breakpoint
CREATE TABLE `released_knowledge_snapshot_document` (
	`snapshot_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`source_store` text NOT NULL,
	`doc_id` text NOT NULL,
	`doc_version` integer NOT NULL,
	`doc_hash` text NOT NULL,
	`doc_type` text NOT NULL,
	`doc_scope` text NOT NULL,
	CONSTRAINT `released_knowledge_snapshot_document_pk` PRIMARY KEY(`snapshot_id`, `source_store`, `doc_id`),
	CONSTRAINT `fk_released_knowledge_snapshot_document_snapshot_id_released_knowledge_snapshot_snapshot_id_fk` FOREIGN KEY (`snapshot_id`) REFERENCES `released_knowledge_snapshot`(`snapshot_id`) ON DELETE CASCADE,
	CONSTRAINT "released_knowledge_snapshot_document_ordinal_check" CHECK("ordinal" >= 0),
	CONSTRAINT "released_knowledge_snapshot_document_source_store_check" CHECK("source_store" IN ('user_global', 'project')),
	CONSTRAINT "released_knowledge_snapshot_document_version_check" CHECK("doc_version" > 0),
	CONSTRAINT "released_knowledge_snapshot_document_hash_check" CHECK(length("doc_hash") = 71 AND substr("doc_hash", 1, 7) = 'sha256:' AND substr("doc_hash", 8) NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "released_knowledge_snapshot_document_type_check" CHECK("doc_type" IN ('knowledge', 'strategy', 'methodology', 'memory', 'skill'))
);
--> statement-breakpoint
CREATE TABLE `released_knowledge_snapshot_head` (
	`security_namespace_id` text NOT NULL,
	`project_scope_key` text NOT NULL,
	`snapshot_id` text,
	`generation` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `released_knowledge_snapshot_head_pk` PRIMARY KEY(`security_namespace_id`, `project_scope_key`),
	CONSTRAINT `fk_released_knowledge_snapshot_head_security_namespace_id_context_security_namespace_id_fk` FOREIGN KEY (`security_namespace_id`) REFERENCES `context_security_namespace`(`id`),
	CONSTRAINT `fk_released_knowledge_snapshot_head_security_namespace_id_project_scope_key_context_project_scope_identity_security_namespace_id_project_scope_key_fk` FOREIGN KEY (`security_namespace_id`,`project_scope_key`) REFERENCES `context_project_scope_identity`(`security_namespace_id`,`project_scope_key`),
	CONSTRAINT `fk_released_knowledge_snapshot_head_security_namespace_id_project_scope_key_snapshot_id_released_knowledge_snapshot_security_namespace_id_project_scope_key_snapshot_id_fk` FOREIGN KEY (`security_namespace_id`,`project_scope_key`,`snapshot_id`) REFERENCES `released_knowledge_snapshot`(`security_namespace_id`,`project_scope_key`,`snapshot_id`),
	CONSTRAINT "released_knowledge_snapshot_head_generation_check" CHECK(("snapshot_id" IS NULL AND "generation" = 0) OR ("snapshot_id" IS NOT NULL AND "generation" > 0))
);
--> statement-breakpoint
CREATE TABLE `released_knowledge_snapshot` (
	`snapshot_id` text PRIMARY KEY,
	`security_namespace_id` text NOT NULL,
	`project_scope_key` text NOT NULL,
	`legacy_project_id` text NOT NULL,
	`parent_snapshot_id` text,
	`evaluation_id` text NOT NULL,
	`release_kind` text NOT NULL,
	`document_count` integer NOT NULL,
	`published_generation` integer NOT NULL,
	`verdict` text NOT NULL,
	`failure_reason` text,
	`actor_type` text NOT NULL,
	`actor_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`finalized_at` integer,
	CONSTRAINT `fk_released_knowledge_snapshot_security_namespace_id_context_security_namespace_id_fk` FOREIGN KEY (`security_namespace_id`) REFERENCES `context_security_namespace`(`id`),
	CONSTRAINT `fk_released_knowledge_snapshot_security_namespace_id_project_scope_key_context_project_scope_identity_security_namespace_id_project_scope_key_fk` FOREIGN KEY (`security_namespace_id`,`project_scope_key`) REFERENCES `context_project_scope_identity`(`security_namespace_id`,`project_scope_key`),
	CONSTRAINT `fk_released_knowledge_snapshot_security_namespace_id_project_scope_key_parent_snapshot_id_released_knowledge_snapshot_security_namespace_id_project_scope_key_snapshot_id_fk` FOREIGN KEY (`security_namespace_id`,`project_scope_key`,`parent_snapshot_id`) REFERENCES `released_knowledge_snapshot`(`security_namespace_id`,`project_scope_key`,`snapshot_id`),
	CONSTRAINT `fk_released_knowledge_snapshot_security_namespace_id_project_scope_key_evaluation_id_released_knowledge_evaluation_security_namespace_id_project_scope_key_evaluation_id_fk` FOREIGN KEY (`security_namespace_id`,`project_scope_key`,`evaluation_id`) REFERENCES `released_knowledge_evaluation`(`security_namespace_id`,`project_scope_key`,`evaluation_id`),
	CONSTRAINT "released_knowledge_snapshot_release_kind_check" CHECK("release_kind" IN ('legacy_baseline', 'evaluated', 'rollback')),
	CONSTRAINT "released_knowledge_snapshot_document_count_check" CHECK("document_count" >= 0),
	CONSTRAINT "released_knowledge_snapshot_published_generation_check" CHECK(("verdict" = 'passed' AND "published_generation" > 0) OR ("verdict" = 'failed' AND "published_generation" >= 0)),
	CONSTRAINT "released_knowledge_snapshot_verdict_check" CHECK("verdict" IN ('passed', 'failed')),
	CONSTRAINT "released_knowledge_snapshot_failure_reason_check" CHECK(("verdict" = 'passed' AND "failure_reason" IS NULL) OR ("verdict" = 'failed' AND length(trim("failure_reason")) > 0)),
	CONSTRAINT "released_knowledge_snapshot_release_chain_check" CHECK(("release_kind" = 'legacy_baseline' AND "parent_snapshot_id" IS NULL AND "verdict" = 'passed') OR ("release_kind" <> 'legacy_baseline' AND "parent_snapshot_id" IS NOT NULL)),
	CONSTRAINT "released_knowledge_snapshot_evaluated_membership_check" CHECK("release_kind" <> 'evaluated' OR "verdict" = 'failed' OR "document_count" > 0),
	CONSTRAINT "released_knowledge_snapshot_actor_type_check" CHECK("actor_type" IN ('human', 'agent', 'system'))
);
--> statement-breakpoint
CREATE TABLE `file_part_artifact_binding` (
	`event_id` text PRIMARY KEY,
	`aggregate_id` text NOT NULL,
	`seq` integer NOT NULL,
	`part_id` text NOT NULL,
	`artifact_id` text NOT NULL,
	`original_data_hash` text NOT NULL,
	`canonical_data_hash` text NOT NULL,
	`canonical_data` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_file_part_artifact_binding_aggregate_id_event_sequence_aggregate_id_fk` FOREIGN KEY (`aggregate_id`) REFERENCES `event_sequence`(`aggregate_id`) ON DELETE CASCADE,
	CONSTRAINT `fk_file_part_artifact_binding_artifact_id_file_part_artifact_artifact_id_fk` FOREIGN KEY (`artifact_id`) REFERENCES `file_part_artifact`(`artifact_id`) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE TABLE `file_part_artifact_chunk` (
	`artifact_id` text NOT NULL,
	`chunk_index` integer NOT NULL,
	`data` blob NOT NULL,
	`chunk_hash` text NOT NULL,
	CONSTRAINT `file_part_artifact_chunk_pk` PRIMARY KEY(`artifact_id`, `chunk_index`),
	CONSTRAINT `fk_file_part_artifact_chunk_artifact_id_file_part_artifact_artifact_id_fk` FOREIGN KEY (`artifact_id`) REFERENCES `file_part_artifact`(`artifact_id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `file_part_artifact_discard` (
	`event_id` text PRIMARY KEY,
	`aggregate_id` text NOT NULL,
	`seq` integer NOT NULL,
	`artifact_id` text NOT NULL,
	`original_data_hash` text NOT NULL,
	`canonical_data_hash` text NOT NULL,
	`canonical_data` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_file_part_artifact_discard_artifact_id_file_part_artifact_artifact_id_fk` FOREIGN KEY (`artifact_id`) REFERENCES `file_part_artifact`(`artifact_id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `file_part_artifact_import` (
	`event_id` text PRIMARY KEY,
	`aggregate_id` text NOT NULL,
	`seq` integer NOT NULL,
	`artifact_id` text NOT NULL,
	`original_data_hash` text NOT NULL,
	`canonical_data_hash` text NOT NULL,
	`canonical_data` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_file_part_artifact_import_artifact_id_file_part_artifact_artifact_id_fk` FOREIGN KEY (`artifact_id`) REFERENCES `file_part_artifact`(`artifact_id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `file_part_artifact` (
	`artifact_id` text PRIMARY KEY,
	`body_hash` text NOT NULL UNIQUE,
	`body_bytes` integer NOT NULL,
	`chunk_bytes` integer NOT NULL,
	`chunk_count` integer NOT NULL,
	`codec_version` integer NOT NULL,
	`complete` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `session_v2_provider_parity_baseline` (
	`campaign_id` text NOT NULL,
	`case_name` text NOT NULL,
	`legacy_receipt_id` text NOT NULL UNIQUE,
	`state` text NOT NULL,
	`prepared_turn` text NOT NULL,
	`outcome_hash` text,
	`outcome_artifact` text,
	`legacy_response_fingerprint` text,
	`evidence` text NOT NULL,
	`receipt_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`settled_at` integer,
	CONSTRAINT `session_v2_provider_parity_baseline_pk` PRIMARY KEY(`campaign_id`, `case_name`)
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
	`outcome_artifact` text,
	`error_code` text,
	`created_at` integer NOT NULL,
	`dispatching_at` integer,
	`first_event_at` integer,
	`terminal_at` integer,
	CONSTRAINT `fk_session_v2_provider_turn_receipt_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_session_v2_provider_turn_receipt_owner_token_session_provider_owner_lease_owner_token_fk` FOREIGN KEY (`owner_token`) REFERENCES `session_provider_owner_lease`(`owner_token`)
);
--> statement-breakpoint
CREATE TABLE `session_transfer_operation` (
	`transfer_id` text PRIMARY KEY,
	`session_id` text NOT NULL,
	`source_workspace_id` text,
	`target_workspace_id` text,
	`source_owner_id` text,
	`target_owner_id` text,
	`source_event_seq` integer NOT NULL,
	`source_mutation_epoch` integer NOT NULL,
	`snapshot_id` text,
	`snapshot_hash` text,
	`state` text NOT NULL,
	`request_hash` text NOT NULL,
	`error_code` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`completed_at` integer,
	CONSTRAINT `fk_session_transfer_operation_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `session_transfer_target_receipt` (
	`transfer_id` text PRIMARY KEY,
	`session_id` text NOT NULL,
	`source_snapshot_id` text NOT NULL,
	`source_snapshot_hash` text NOT NULL,
	`source_event_seq` integer NOT NULL,
	`target_workspace_id` text,
	`target_owner_id` text,
	`state` text NOT NULL,
	`activated_snapshot_id` text,
	`activated_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `event_artifact_chunk` (
	`artifact_id` text NOT NULL,
	`chunk_index` integer NOT NULL,
	`data` blob NOT NULL,
	`chunk_hash` text NOT NULL,
	CONSTRAINT `event_artifact_chunk_pk` PRIMARY KEY(`artifact_id`, `chunk_index`),
	CONSTRAINT `fk_event_artifact_chunk_artifact_id_event_artifact_artifact_id_fk` FOREIGN KEY (`artifact_id`) REFERENCES `event_artifact`(`artifact_id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `event_artifact` (
	`artifact_id` text PRIMARY KEY,
	`event_id` text NOT NULL,
	`aggregate_id` text NOT NULL,
	`seq` integer NOT NULL,
	`kind` text NOT NULL,
	`original_data_hash` text NOT NULL,
	`canonical_data_hash` text NOT NULL,
	`canonical_data` text NOT NULL,
	`body_hash` text NOT NULL,
	`body_bytes` integer NOT NULL,
	`chunk_count` integer NOT NULL,
	`codec_version` integer NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_event_artifact_aggregate_id_event_sequence_aggregate_id_fk` FOREIGN KEY (`aggregate_id`) REFERENCES `event_sequence`(`aggregate_id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `event_compaction_receipt` (
	`aggregate_id` text PRIMARY KEY,
	`snapshot_id` text NOT NULL,
	`through_seq` integer NOT NULL,
	`codec` text NOT NULL,
	`schema_version` integer NOT NULL,
	`cursor_seq` integer NOT NULL,
	`deleted_count` integer NOT NULL,
	`state` text NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_event_compaction_receipt_aggregate_id_event_sequence_aggregate_id_fk` FOREIGN KEY (`aggregate_id`) REFERENCES `event_sequence`(`aggregate_id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `event_dedupe` (
	`aggregate_id` text NOT NULL,
	`seq` integer NOT NULL,
	`event_id` text NOT NULL,
	`type` text NOT NULL,
	`data_hash` text NOT NULL,
	`source_data` text,
	`compacted_at` integer NOT NULL,
	CONSTRAINT `fk_event_dedupe_aggregate_id_event_sequence_aggregate_id_fk` FOREIGN KEY (`aggregate_id`) REFERENCES `event_sequence`(`aggregate_id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `event_snapshot_attempt` (
	`snapshot_id` text PRIMARY KEY,
	`aggregate_id` text NOT NULL,
	`through_seq` integer NOT NULL,
	`expected_latest` integer NOT NULL,
	`owner_id` text,
	`codec` text NOT NULL,
	`schema_version` integer NOT NULL,
	`projection_revision` text NOT NULL,
	`cursor` text,
	`row_count` integer NOT NULL,
	`encoded_bytes` integer NOT NULL,
	`content_hash` text NOT NULL,
	`tables` text NOT NULL,
	`state` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_event_snapshot_attempt_aggregate_id_event_sequence_aggregate_id_fk` FOREIGN KEY (`aggregate_id`) REFERENCES `event_sequence`(`aggregate_id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `event_snapshot_chunk` (
	`row_hash` text NOT NULL,
	`chunk_index` integer NOT NULL,
	`data` blob NOT NULL,
	`chunk_hash` text NOT NULL,
	CONSTRAINT `event_snapshot_chunk_pk` PRIMARY KEY(`row_hash`, `chunk_index`)
);
--> statement-breakpoint
CREATE TABLE `event_snapshot_row` (
	`snapshot_id` text NOT NULL,
	`aggregate_id` text NOT NULL,
	`row_index` integer NOT NULL,
	`table_name` text NOT NULL,
	`row_key` text NOT NULL,
	`row_hash` text NOT NULL,
	`row_bytes` integer NOT NULL,
	`chunk_count` integer NOT NULL,
	`chain_hash` text NOT NULL,
	CONSTRAINT `event_snapshot_row_pk` PRIMARY KEY(`snapshot_id`, `row_index`)
);
--> statement-breakpoint
CREATE TABLE `event_snapshot` (
	`snapshot_id` text PRIMARY KEY,
	`aggregate_id` text NOT NULL,
	`through_seq` integer NOT NULL,
	`sync_seq` integer NOT NULL,
	`codec` text NOT NULL,
	`schema_version` integer NOT NULL,
	`snapshot_hash` text NOT NULL,
	`body` text NOT NULL,
	`owner_id` text,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_event_snapshot_aggregate_id_event_sequence_aggregate_id_fk` FOREIGN KEY (`aggregate_id`) REFERENCES `event_sequence`(`aggregate_id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `event_sync_backfill` (
	`id` integer PRIMARY KEY,
	`state` text NOT NULL,
	`cursor_rowid` integer NOT NULL,
	`high_water_rowid` integer NOT NULL,
	`processed_count` integer NOT NULL,
	`started_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`completed_at` integer
);
--> statement-breakpoint
CREATE TABLE `event_sync_index` (
	`sync_seq` integer PRIMARY KEY,
	`event_id` text NOT NULL UNIQUE,
	`aggregate_id` text NOT NULL,
	`seq` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `event_sync_sequence` (
	`id` integer PRIMARY KEY,
	`seq` integer NOT NULL,
	`generation` text NOT NULL,
	`cursor_secret` text NOT NULL,
	`backfill_complete` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `workspace_sync_cursor` (
	`workspace_id` text NOT NULL,
	`remote_fingerprint` text NOT NULL,
	`cursor` text NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `workspace_sync_cursor_pk` PRIMARY KEY(`workspace_id`, `remote_fingerprint`)
);
--> statement-breakpoint
CREATE TABLE `permission_saved_epoch` (
	`project_id` text PRIMARY KEY,
	`epoch` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_permission_saved_epoch_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `session_part_integrity_quarantine` (
	`part_id` text PRIMARY KEY,
	`message_id` text NOT NULL,
	`part_session_id` text NOT NULL,
	`message_session_id` text NOT NULL,
	`reason` text NOT NULL,
	`quarantined_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `session_prompt_epoch_recovery` (
	`session_id` text NOT NULL,
	`prompt_epoch` integer NOT NULL,
	`resolution_id` text NOT NULL UNIQUE,
	`source_prompt_epoch` integer NOT NULL,
	`source_mutation_epoch` integer NOT NULL,
	`successor_mutation_epoch` integer NOT NULL,
	`ambiguity_message_id` text NOT NULL,
	`physical_message_high_water` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `session_prompt_epoch_recovery_pk` PRIMARY KEY(`session_id`, `prompt_epoch`)
);
--> statement-breakpoint
CREATE TABLE `session_tool_request_resolution_command` (
	`command_id` text PRIMARY KEY,
	`request_hash` text NOT NULL,
	`session_id` text NOT NULL,
	`receipt_id` text NOT NULL,
	`result_resolution_id` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `session_tool_request_resolution` (
	`resolution_id` text PRIMARY KEY,
	`receipt_id` text NOT NULL UNIQUE,
	`session_id` text NOT NULL,
	`legacy_activity_id` text,
	`assistant_message_id` text NOT NULL,
	`source_prompt_epoch` integer NOT NULL,
	`source_window_id` text NOT NULL,
	`source_effective_history_hash` text NOT NULL,
	`source_request_hash` text NOT NULL,
	`source_mutation_epoch` integer NOT NULL,
	`expected_provider_state` text NOT NULL,
	`decision` text NOT NULL,
	`actor_type` text NOT NULL,
	`actor_id` text NOT NULL,
	`reason` text NOT NULL,
	`risk_acknowledged` integer NOT NULL,
	`safe_end_message_id` text,
	`safe_history_hash` text NOT NULL,
	`safe_message_ids` text NOT NULL,
	`ambiguity_message_id` text NOT NULL,
	`physical_message_high_water` text NOT NULL,
	`successor_prompt_epoch` integer NOT NULL,
	`successor_window_id` text NOT NULL,
	`successor_history_hash` text NOT NULL,
	`successor_mutation_epoch` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `task_structured_finalizer_response` (
	`run_id` text NOT NULL,
	`attempt` integer NOT NULL,
	`child_session_id` text NOT NULL,
	`owner_token` text NOT NULL,
	`claim_generation` integer NOT NULL,
	`expected_version` integer NOT NULL,
	`source_message_id` text NOT NULL,
	`request_message_id` text NOT NULL,
	`response_message_id` text NOT NULL,
	`response_message_json` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `task_structured_finalizer_response_pk` PRIMARY KEY(`run_id`, `attempt`),
	CONSTRAINT `fk_task_structured_finalizer_response_run_id_task_run_run_id_fk` FOREIGN KEY (`run_id`) REFERENCES `task_run`(`run_id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `task_structured_output_evidence_part` (
	`run_id` text NOT NULL,
	`role` text NOT NULL,
	`ordinal` integer NOT NULL,
	`part_id` text NOT NULL,
	`message_id` text NOT NULL,
	`session_id` text NOT NULL,
	`part_json` text NOT NULL,
	CONSTRAINT `task_structured_output_evidence_part_pk` PRIMARY KEY(`run_id`, `role`, `part_id`),
	CONSTRAINT `fk_task_structured_output_evidence_part_run_id_task_structured_output_evidence_run_id_fk` FOREIGN KEY (`run_id`) REFERENCES `task_structured_output_evidence`(`run_id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `task_structured_output_evidence` (
	`run_id` text PRIMARY KEY,
	`child_session_id` text NOT NULL,
	`owner_token` text NOT NULL,
	`claim_generation` integer NOT NULL,
	`expected_version` integer NOT NULL,
	`terminal_state` text NOT NULL,
	`attempts` integer NOT NULL,
	`contract_json` text NOT NULL,
	`raw_result_message_id` text NOT NULL,
	`raw_message_json` text NOT NULL,
	`raw_parts_json` text NOT NULL,
	`result_message_id` text,
	`result_message_json` text,
	`result_parts_json` text,
	`output` text,
	`structured_output_receipt` text,
	`failure_code` text,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_task_structured_output_evidence_run_id_task_run_run_id_fk` FOREIGN KEY (`run_id`) REFERENCES `task_run`(`run_id`) ON DELETE CASCADE
);
--> statement-breakpoint
ALTER TABLE `event_sequence` ADD `retention_floor_seq` integer;--> statement-breakpoint
ALTER TABLE `event_sequence` ADD `snapshot_id` text;--> statement-breakpoint
ALTER TABLE `event_sequence` ADD `write_fence_transfer_id` text;--> statement-breakpoint
ALTER TABLE `event` ADD `sync_seq` integer;--> statement-breakpoint
ALTER TABLE `session_intent` ADD `execution_mode` text DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE `session_intent` ADD `execution_state` text DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE `session_intent` ADD `execution_claim_id` text;--> statement-breakpoint
ALTER TABLE `session_intent` ADD `execution_claimed_at` integer;--> statement-breakpoint
ALTER TABLE `session` ADD `summary_diff_manifest` text;--> statement-breakpoint
ALTER TABLE `task_run` ADD `structured_output_receipt` text;--> statement-breakpoint
CREATE INDEX `session_activity_effect_receipt_activity_idx` ON `session_activity_effect_receipt` (`activity_kind`,`activity_id`,`first_observation_revision`);--> statement-breakpoint
CREATE INDEX `session_activity_evidence_activity_idx` ON `session_activity_evidence` (`activity_kind`,`activity_id`,`first_observation_revision`);--> statement-breakpoint
CREATE INDEX `session_activity_objective_session_idx` ON `session_activity_objective` (`session_id`,`state`,`updated_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `session_activity_permission_decision_request_idx` ON `session_activity_permission_decision` (`request_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `session_activity_permission_decision_idempotency_idx` ON `session_activity_permission_decision` (`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `session_activity_permission_effect_dispatch_request_idx` ON `session_activity_permission_effect_dispatch` (`request_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `session_activity_permission_effect_dispatch_idempotency_idx` ON `session_activity_permission_effect_dispatch` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `session_activity_permission_effect_dispatch_activity_idx` ON `session_activity_permission_effect_dispatch` (`activity_kind`,`activity_id`,`state`,`started_at`);--> statement-breakpoint
CREATE INDEX `session_activity_permission_effect_dispatch_owner_idx` ON `session_activity_permission_effect_dispatch` (`owner_id`,`state`,`started_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `session_activity_permission_once_consumption_idempotency_idx` ON `session_activity_permission_once_consumption` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `session_activity_permission_owner_lease_expiry_idx` ON `session_activity_permission_owner_lease` (`lease_expires_at`,`owner_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `session_activity_permission_request_idempotency_idx` ON `session_activity_permission_request` (`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `session_activity_permission_request_pending_no_progress_idx` ON `session_activity_permission_request` (`activity_kind`,`activity_id`) WHERE "session_activity_permission_request"."state" = 'pending' AND "session_activity_permission_request"."request_kind" = 'no_progress';--> statement-breakpoint
CREATE INDEX `session_activity_permission_request_pending_idx` ON `session_activity_permission_request` (`session_id`,`state`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `session_activity_progress_observation_idempotency_idx` ON `session_activity_progress_observation` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `session_activity_progress_observation_latest_idx` ON `session_activity_progress_observation` (`activity_kind`,`activity_id`,`observed_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `learning_admission_outbox_dedupe_idx` ON `learning_admission_outbox` (`dedupe_key`);--> statement-breakpoint
CREATE INDEX `learning_admission_outbox_pending_idx` ON `learning_admission_outbox` (`created_at`) WHERE "learning_admission_outbox"."state" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX `learning_governance_action_plan_sequence_idx` ON `learning_governance_action` (`plan_id`,`sequence`);--> statement-breakpoint
CREATE UNIQUE INDEX `learning_governance_action_plan_candidate_kind_idx` ON `learning_governance_action` (`plan_id`,`candidate_id`,`kind`);--> statement-breakpoint
CREATE INDEX `learning_governance_action_claim_idx` ON `learning_governance_action` (`plan_id`,`state`,`sequence`);--> statement-breakpoint
CREATE UNIQUE INDEX `learning_governance_compensation_action_idx` ON `learning_governance_compensation` (`action_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `learning_governance_compensation_plan_sequence_idx` ON `learning_governance_compensation` (`plan_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `learning_governance_compensation_claim_idx` ON `learning_governance_compensation` (`state`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `learning_governance_plan_job_idx` ON `learning_governance_plan` (`job_id`);--> statement-breakpoint
CREATE INDEX `learning_governance_plan_state_idx` ON `learning_governance_plan` (`state`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `learning_job_dedupe_idx` ON `learning_job` (`dedupe_key`);--> statement-breakpoint
CREATE INDEX `learning_job_due_idx` ON `learning_job` (`state`,`next_attempt_at`,`created_at`);--> statement-breakpoint
CREATE INDEX `learning_job_project_created_idx` ON `learning_job` (`project_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `learning_job_owner_lease_idx` ON `learning_job` (`owner`,`lease_expires_at`) WHERE "learning_job"."owner" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `learning_lifecycle_trigger_identity_idx` ON `learning_lifecycle_trigger_receipt` (`trigger`,`session_id`,`run_id`);--> statement-breakpoint
CREATE INDEX `learning_lifecycle_trigger_pending_idx` ON `learning_lifecycle_trigger_receipt` (`created_at`,`receipt_id`) WHERE "learning_lifecycle_trigger_receipt"."state" = 'prepared';--> statement-breakpoint
CREATE UNIQUE INDEX `learning_reviewer_attempt_job_idx` ON `learning_reviewer_attempt` (`job_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `learning_reviewer_attempt_session_idx` ON `learning_reviewer_attempt` (`review_session_id`);--> statement-breakpoint
CREATE INDEX `learning_reviewer_attempt_state_idx` ON `learning_reviewer_attempt` (`state`,`updated_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `released_knowledge_evaluation_scope_identity_idx` ON `released_knowledge_evaluation` (`security_namespace_id`,`project_scope_key`,`evaluation_id`);--> statement-breakpoint
CREATE INDEX `released_knowledge_evaluation_matrix_idx` ON `released_knowledge_evaluation` (`security_namespace_id`,`project_scope_key`,`matrix_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `released_knowledge_snapshot_document_ordinal_idx` ON `released_knowledge_snapshot_document` (`snapshot_id`,`ordinal`);--> statement-breakpoint
CREATE UNIQUE INDEX `released_knowledge_snapshot_scope_identity_idx` ON `released_knowledge_snapshot` (`security_namespace_id`,`project_scope_key`,`snapshot_id`);--> statement-breakpoint
CREATE INDEX `released_knowledge_snapshot_parent_idx` ON `released_knowledge_snapshot` (`parent_snapshot_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `file_part_artifact_binding_aggregate_seq_idx` ON `file_part_artifact_binding` (`aggregate_id`,`seq`);--> statement-breakpoint
CREATE INDEX `file_part_artifact_binding_part_idx` ON `file_part_artifact_binding` (`aggregate_id`,`part_id`,`seq`);--> statement-breakpoint
CREATE INDEX `file_part_artifact_binding_artifact_idx` ON `file_part_artifact_binding` (`artifact_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `file_part_artifact_discard_aggregate_seq_idx` ON `file_part_artifact_discard` (`aggregate_id`,`seq`);--> statement-breakpoint
CREATE UNIQUE INDEX `file_part_artifact_import_aggregate_seq_idx` ON `file_part_artifact_import` (`aggregate_id`,`seq`);--> statement-breakpoint
CREATE INDEX `file_part_artifact_import_artifact_idx` ON `file_part_artifact_import` (`artifact_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `session_v2_provider_parity_baseline_hash_idx` ON `session_v2_provider_parity_baseline` (`receipt_hash`);--> statement-breakpoint
CREATE INDEX `session_v2_provider_parity_baseline_campaign_idx` ON `session_v2_provider_parity_baseline` (`campaign_id`,`state`);--> statement-breakpoint
CREATE UNIQUE INDEX `session_v2_provider_parity_receipt_hash_idx` ON `session_v2_provider_parity_receipt` (`receipt_hash`);--> statement-breakpoint
CREATE INDEX `session_v2_provider_parity_receipt_campaign_idx` ON `session_v2_provider_parity_receipt` (`campaign_id`,`verified`);--> statement-breakpoint
CREATE UNIQUE INDEX `session_v2_provider_turn_receipt_ordinal_idx` ON `session_v2_provider_turn_receipt` (`session_id`,`request_ordinal`);--> statement-breakpoint
CREATE INDEX `session_v2_provider_turn_receipt_input_idx` ON `session_v2_provider_turn_receipt` (`session_id`,`user_message_id`,`history_prompt_epoch`,`request_input_hash`);--> statement-breakpoint
CREATE INDEX `session_v2_provider_turn_receipt_owner_state_idx` ON `session_v2_provider_turn_receipt` (`owner_token`,`state`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `session_transfer_operation_session_request_idx` ON `session_transfer_operation` (`session_id`,`request_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `session_transfer_operation_active_idx` ON `session_transfer_operation` (`session_id`) WHERE "session_transfer_operation"."state" NOT IN ('target_activated', 'aborted');--> statement-breakpoint
CREATE UNIQUE INDEX `event_artifact_event_idx` ON `event_artifact` (`event_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `event_artifact_aggregate_seq_idx` ON `event_artifact` (`aggregate_id`,`seq`);--> statement-breakpoint
CREATE UNIQUE INDEX `event_dedupe_aggregate_seq_idx` ON `event_dedupe` (`aggregate_id`,`seq`);--> statement-breakpoint
CREATE UNIQUE INDEX `event_dedupe_event_idx` ON `event_dedupe` (`event_id`);--> statement-breakpoint
CREATE INDEX `event_snapshot_attempt_aggregate_idx` ON `event_snapshot_attempt` (`aggregate_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `event_snapshot_row_identity_idx` ON `event_snapshot_row` (`snapshot_id`,`table_name`,`row_key`);--> statement-breakpoint
CREATE INDEX `event_snapshot_row_hash_idx` ON `event_snapshot_row` (`row_hash`);--> statement-breakpoint
CREATE INDEX `event_snapshot_row_aggregate_idx` ON `event_snapshot_row` (`aggregate_id`);--> statement-breakpoint
CREATE INDEX `event_snapshot_aggregate_seq_idx` ON `event_snapshot` (`aggregate_id`,`through_seq`);--> statement-breakpoint
CREATE INDEX `event_snapshot_aggregate_created_idx` ON `event_snapshot` (`aggregate_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `event_snapshot_sync_seq_idx` ON `event_snapshot` (`sync_seq`);--> statement-breakpoint
CREATE INDEX `event_sync_index_aggregate_seq_idx` ON `event_sync_index` (`aggregate_id`,`seq`);--> statement-breakpoint
CREATE INDEX `session_tool_request_resolution_command_session_idx` ON `session_tool_request_resolution_command` (`session_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `session_tool_request_resolution_session_idx` ON `session_tool_request_resolution` (`session_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `task_structured_finalizer_response_message_idx` ON `task_structured_finalizer_response` (`response_message_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `task_structured_output_evidence_part_ordinal_idx` ON `task_structured_output_evidence_part` (`run_id`,`role`,`ordinal`);--> statement-breakpoint
CREATE INDEX `task_structured_output_evidence_part_part_idx` ON `task_structured_output_evidence_part` (`part_id`);--> statement-breakpoint
CREATE INDEX `task_structured_output_evidence_raw_message_idx` ON `task_structured_output_evidence` (`raw_result_message_id`);--> statement-breakpoint
CREATE INDEX `task_structured_output_evidence_result_message_idx` ON `task_structured_output_evidence` (`result_message_id`);