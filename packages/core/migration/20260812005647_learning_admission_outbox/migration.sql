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
CREATE UNIQUE INDEX `learning_admission_outbox_dedupe_idx` ON `learning_admission_outbox` (`dedupe_key`);--> statement-breakpoint
CREATE INDEX `learning_admission_outbox_pending_idx` ON `learning_admission_outbox` (`created_at`) WHERE "learning_admission_outbox"."state" = 'pending';--> statement-breakpoint
CREATE TRIGGER learning_admission_outbox_identity_immutable
BEFORE UPDATE ON learning_admission_outbox
WHEN NEW.intent_id != OLD.intent_id
  OR NEW.session_id != OLD.session_id
  OR NEW.run_id != OLD.run_id
  OR NEW.trigger != OLD.trigger
  OR NEW.dedupe_key != OLD.dedupe_key
  OR NEW.payload_json != OLD.payload_json
  OR NEW.payload_fingerprint != OLD.payload_fingerprint
  OR NEW.created_at != OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'learning_admission_outbox_identity_immutable');
END;--> statement-breakpoint
CREATE TRIGGER learning_admission_outbox_transition_guard
BEFORE UPDATE OF state ON learning_admission_outbox
WHEN NOT (OLD.state = 'pending' AND NEW.state IN ('admitted', 'rejected'))
BEGIN
  SELECT RAISE(ABORT, 'learning_admission_outbox_transition_invalid');
END;--> statement-breakpoint
CREATE TRIGGER learning_admission_outbox_terminal_immutable
BEFORE UPDATE ON learning_admission_outbox
WHEN OLD.state IN ('admitted', 'rejected')
BEGIN
  SELECT RAISE(ABORT, 'learning_admission_outbox_terminal_immutable');
END;--> statement-breakpoint
CREATE TRIGGER learning_admission_outbox_job_binding
BEFORE UPDATE OF state ON learning_admission_outbox
WHEN NEW.state = 'admitted' AND NOT EXISTS (
  SELECT 1 FROM learning_job
  WHERE learning_job.job_id = NEW.job_id
    AND learning_job.session_id = NEW.session_id
    AND learning_job.run_id = NEW.run_id
    AND learning_job.trigger = NEW.trigger
    AND learning_job.candidate_input_ref = NEW.candidate_input_ref
)
BEGIN
  SELECT RAISE(ABORT, 'learning_admission_outbox_job_mismatch');
END;
