CREATE TABLE `event_work_controller` (
	`controller_id` text PRIMARY KEY,
	`receipt_id` text NOT NULL,
	`root_work_id` text NOT NULL,
	`revision` integer NOT NULL,
	`state` text NOT NULL,
	`record` text NOT NULL,
	`record_hash` text NOT NULL,
	`record_bytes` integer NOT NULL,
	CONSTRAINT `fk_event_work_controller_receipt_id_event_work_receipt_receipt_id_fk` FOREIGN KEY (`receipt_id`) REFERENCES `event_work_receipt`(`receipt_id`) ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT "event_work_controller_state" CHECK("revision">0 AND "state" IN ('pending','running','succeeded','failed','unknown')),
	CONSTRAINT "event_work_controller_body" CHECK(typeof("record")='text' AND instr("record",char(0))=0 AND
    typeof("record_bytes")='integer' AND "record_bytes" BETWEEN 2 AND 131072 AND
    "record_bytes"=length(CAST("record" AS BLOB)) AND CASE WHEN json_valid("record") THEN
    coalesce(json_type("record")='object' AND json_extract("record",'$.version')=1 AND
      json_extract("record",'$.controllerID') IS "controller_id" AND
      json_extract("record",'$.receiptID') IS "receipt_id" AND
      json_extract("record",'$.rootWorkID') IS "root_work_id" AND
      json_extract("record",'$.revision') IS "revision" AND
      json_extract("record",'$.state') IS "state",0) ELSE 0 END),
	CONSTRAINT "event_work_controller_hash" CHECK(typeof("record_hash")='text' AND length(CAST("record_hash" AS BLOB))=64
    AND "record_hash" NOT GLOB '*[^0-9a-f]*')
);
--> statement-breakpoint
ALTER TABLE `work_execution` ADD `execution_role` text DEFAULT 'agent' NOT NULL;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_work_execution` (
	`work_id` text PRIMARY KEY,
	`root_work_id` text NOT NULL,
	`parent_work_id` text,
	`execution_role` text DEFAULT 'agent' NOT NULL,
	`session_id` text NOT NULL,
	`input_id` text NOT NULL,
	`source_kind` text NOT NULL,
	`authority_id` text NOT NULL,
	`source_request_id` text NOT NULL,
	`source_revision` integer NOT NULL,
	`source_record_hash` text NOT NULL,
	`route_evidence_hash` text NOT NULL,
	`binding_hash` text NOT NULL,
	`binding_version` integer DEFAULT 1 NOT NULL,
	`binding` text NOT NULL,
	`security_namespace_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`admission_state` text NOT NULL,
	`control_state` text NOT NULL,
	`outcome` text NOT NULL,
	`control_revision` integer NOT NULL,
	`control_receipts` text NOT NULL,
	`admitted_seq` integer,
	`loopback_http` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "work_execution_revision_check" CHECK("source_revision" > 0 AND "control_revision" > 0),
	CONSTRAINT "work_execution_admission_check" CHECK("admission_state" IN ('reserved','ready','rejected')),
	CONSTRAINT "work_execution_control_check" CHECK("control_state" IN ('active','paused','revoked','cancelled','expired')),
	CONSTRAINT "work_execution_outcome_check" CHECK("outcome" IN ('pending','succeeded','failed','unknown')),
	CONSTRAINT "work_execution_source_check" CHECK("source_kind" IN ('server_operator','server_rule')),
	CONSTRAINT "work_execution_role_check" CHECK("execution_role"='agent' OR ("execution_role"='dag_controller'
      AND "parent_work_id" IS NULL AND "root_work_id"="work_id" AND "source_kind"='server_rule'
      AND json_extract("binding",'$.profile.id')='event_deepseek_dag_v1')),
	CONSTRAINT "work_execution_binding_check" CHECK(json_valid("binding") AND length("binding_hash") = 64 AND "binding_hash" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "work_execution_binding_version_check" CHECK(typeof("binding_version") = 'integer' AND "binding_version" IN (1,2)
      AND json_type("binding", '$.schemaVersion') IS 'text'
      AND (("binding_version"=1 AND json_extract("binding", '$.schemaVersion') IS 'work-execution.v1')
        OR ("binding_version"=2 AND json_extract("binding", '$.schemaVersion') IS 'work-execution.v2'
          AND length(CAST("binding" AS BLOB)) BETWEEN 1 AND 65536))),
	CONSTRAINT "work_execution_ready_check" CHECK("admission_state" != 'ready' OR "admitted_seq" IS NOT NULL)
);
--> statement-breakpoint
INSERT INTO `__new_work_execution`(`work_id`, `root_work_id`, `parent_work_id`, `session_id`, `input_id`, `source_kind`, `authority_id`, `source_request_id`, `source_revision`, `source_record_hash`, `route_evidence_hash`, `binding_hash`, `binding_version`, `binding`, `security_namespace_id`, `agent_id`, `admission_state`, `control_state`, `outcome`, `control_revision`, `control_receipts`, `admitted_seq`, `loopback_http`, `created_at`, `updated_at`) SELECT `work_id`, `root_work_id`, `parent_work_id`, `session_id`, `input_id`, `source_kind`, `authority_id`, `source_request_id`, `source_revision`, `source_record_hash`, `route_evidence_hash`, `binding_hash`, `binding_version`, `binding`, `security_namespace_id`, `agent_id`, `admission_state`, `control_state`, `outcome`, `control_revision`, `control_receipts`, `admitted_seq`, `loopback_http`, `created_at`, `updated_at` FROM `work_execution`;--> statement-breakpoint
DROP TABLE `work_execution`;--> statement-breakpoint
ALTER TABLE `__new_work_execution` RENAME TO `work_execution`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `work_execution_session_idx` ON `work_execution` (`session_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `work_execution_input_idx` ON `work_execution` (`input_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `work_execution_request_idx` ON `work_execution` (`source_kind`,`authority_id`,`source_request_id`);--> statement-breakpoint
CREATE INDEX `work_execution_root_idx` ON `work_execution` (`root_work_id`);--> statement-breakpoint
CREATE INDEX `work_execution_hour_idx` ON `work_execution` (`security_namespace_id`,`agent_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `event_work_controller_receipt_idx` ON `event_work_controller` (`receipt_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `event_work_controller_root_idx` ON `event_work_controller` (`root_work_id`);--> statement-breakpoint
CREATE INDEX `event_work_controller_state_idx` ON `event_work_controller` (`state`,`controller_id`);