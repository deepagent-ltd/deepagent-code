CREATE TABLE `runtime_integrity_evidence_artifact` (
	`artifact_id` text PRIMARY KEY,
	`receipt_id` text NOT NULL UNIQUE,
	`session_id` text NOT NULL,
	`attempt_id` text NOT NULL,
	`evidence_hash` text NOT NULL,
	`evidence` text NOT NULL,
	`signature` text,
	`created_at` integer NOT NULL,
	`signed_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `runtime_integrity_evidence_artifact_hash_idx` ON `runtime_integrity_evidence_artifact` (`evidence_hash`);--> statement-breakpoint
CREATE INDEX `runtime_integrity_evidence_artifact_session_idx` ON `runtime_integrity_evidence_artifact` (`session_id`,`created_at`);