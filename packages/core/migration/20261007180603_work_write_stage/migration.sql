CREATE TABLE `work_write_stage_meter` (
	`instance_id` text PRIMARY KEY,
	`custody_count` integer NOT NULL,
	`retained_bytes` integer NOT NULL,
	`audit_count` integer NOT NULL,
	`revision` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "work_write_stage_meter_instance_check" CHECK(typeof("instance_id")='text' AND length(CAST("instance_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("instance_id",char(0))=0),
	CONSTRAINT "work_write_stage_meter_count_check" CHECK(typeof("custody_count")='integer' AND "custody_count" BETWEEN 0 AND 32 AND typeof("audit_count")='integer' AND "audit_count" BETWEEN 0 AND 10000 AND "custody_count"<="audit_count"),
	CONSTRAINT "work_write_stage_meter_bytes_check" CHECK(typeof("retained_bytes")='integer' AND "retained_bytes" BETWEEN 0 AND 9007199254740991),
	CONSTRAINT "work_write_stage_meter_time_check" CHECK(typeof("revision")='integer' AND "revision" BETWEEN 1 AND 9007199254740991 AND typeof("updated_at")='integer' AND "updated_at" BETWEEN 1 AND 9007199254740991)
);
--> statement-breakpoint
CREATE TABLE `work_write_stage` (
	`stage_id` text PRIMARY KEY,
	`instance_id` text NOT NULL,
	`work_id` text NOT NULL,
	`root_work_id` text NOT NULL,
	`session_id` text NOT NULL,
	`input_id` text NOT NULL,
	`provider_receipt_id` text NOT NULL,
	`provider_attempt_id` text NOT NULL,
	`admission_id` text NOT NULL,
	`tool_call_id` text NOT NULL,
	`binding_hash` text NOT NULL,
	`control_revision` integer NOT NULL,
	`request_hash` text NOT NULL,
	`state` text NOT NULL,
	`revision` integer NOT NULL,
	`reserved_bytes` integer NOT NULL,
	`observed_retained_bytes` integer NOT NULL,
	`record` text NOT NULL,
	`record_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`released_at` integer,
	CONSTRAINT `fk_work_write_stage_instance_id_work_write_stage_meter_instance_id_fk` FOREIGN KEY (`instance_id`) REFERENCES `work_write_stage_meter`(`instance_id`) ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT `fk_work_write_stage_admission_id_session_v2_tool_effect_admission_admission_id_fk` FOREIGN KEY (`admission_id`) REFERENCES `session_v2_tool_effect_admission`(`admission_id`) ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT "work_write_stage_stage_id_text_check" CHECK(typeof("stage_id")='text' AND length(CAST("stage_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("stage_id",char(0))=0),
	CONSTRAINT "work_write_stage_instance_id_text_check" CHECK(typeof("instance_id")='text' AND length(CAST("instance_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("instance_id",char(0))=0),
	CONSTRAINT "work_write_stage_work_id_text_check" CHECK(typeof("work_id")='text' AND length(CAST("work_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("work_id",char(0))=0),
	CONSTRAINT "work_write_stage_root_work_id_text_check" CHECK(typeof("root_work_id")='text' AND length(CAST("root_work_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("root_work_id",char(0))=0),
	CONSTRAINT "work_write_stage_session_id_text_check" CHECK(typeof("session_id")='text' AND length(CAST("session_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("session_id",char(0))=0),
	CONSTRAINT "work_write_stage_input_id_text_check" CHECK(typeof("input_id")='text' AND length(CAST("input_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("input_id",char(0))=0),
	CONSTRAINT "work_write_stage_provider_receipt_id_text_check" CHECK(typeof("provider_receipt_id")='text' AND length(CAST("provider_receipt_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("provider_receipt_id",char(0))=0),
	CONSTRAINT "work_write_stage_provider_attempt_id_text_check" CHECK(typeof("provider_attempt_id")='text' AND length(CAST("provider_attempt_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("provider_attempt_id",char(0))=0),
	CONSTRAINT "work_write_stage_admission_id_text_check" CHECK(typeof("admission_id")='text' AND length(CAST("admission_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("admission_id",char(0))=0),
	CONSTRAINT "work_write_stage_tool_call_id_text_check" CHECK(typeof("tool_call_id")='text' AND length(CAST("tool_call_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("tool_call_id",char(0))=0),
	CONSTRAINT "work_write_stage_binding_hash_hash_check" CHECK(typeof("binding_hash")='text' AND length(CAST("binding_hash" AS BLOB))=64 AND "binding_hash" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "work_write_stage_request_hash_hash_check" CHECK(typeof("request_hash")='text' AND length(CAST("request_hash" AS BLOB))=64 AND "request_hash" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "work_write_stage_record_hash_hash_check" CHECK(typeof("record_hash")='text' AND length(CAST("record_hash" AS BLOB))=64 AND "record_hash" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "work_write_stage_control_revision_integer_check" CHECK(typeof("control_revision")='integer' AND "control_revision" BETWEEN 1 AND 9007199254740991),
	CONSTRAINT "work_write_stage_revision_integer_check" CHECK(typeof("revision")='integer' AND "revision" BETWEEN 1 AND 9007199254740991),
	CONSTRAINT "work_write_stage_created_at_integer_check" CHECK(typeof("created_at")='integer' AND "created_at" BETWEEN 1 AND 9007199254740991),
	CONSTRAINT "work_write_stage_updated_at_integer_check" CHECK(typeof("updated_at")='integer' AND "updated_at" BETWEEN 1 AND 9007199254740991),
	CONSTRAINT "work_write_stage_reserved_bytes_bytes_check" CHECK(typeof("reserved_bytes")='integer' AND "reserved_bytes" BETWEEN 0 AND 9007199254740991),
	CONSTRAINT "work_write_stage_observed_retained_bytes_bytes_check" CHECK(typeof("observed_retained_bytes")='integer' AND "observed_retained_bytes" BETWEEN 0 AND 9007199254740991),
	CONSTRAINT "work_write_stage_time_check" CHECK("updated_at">="created_at" AND ("released_at" IS NULL OR (typeof("released_at")='integer' AND "released_at" BETWEEN "created_at" AND "updated_at"))),
	CONSTRAINT "work_write_stage_state_check" CHECK("state" IN ('reserved','prepared','publication_unknown','published','refused') AND (("released_at" IS NULL AND "reserved_bytes">0) OR ("released_at" IS NOT NULL AND "state" IN ('published','refused') AND "reserved_bytes"=0 AND "observed_retained_bytes"=0))),
	CONSTRAINT "work_write_stage_record_check" CHECK(typeof("record")='text' AND length(CAST("record" AS BLOB)) BETWEEN 1 AND 16384 AND instr("record",char(0))=0 AND json_valid("record") AND json_type("record") IS 'object' AND json_type("record",'$.version') IS 'integer' AND json_extract("record",'$.version') IS 1),
	CONSTRAINT "work_write_stage_stage_id_mirror_check" CHECK(json_type("record",'$.stageID') IS 'text' AND json_extract("record",'$.stageID') IS "stage_id"),
	CONSTRAINT "work_write_stage_instance_id_mirror_check" CHECK(json_type("record",'$.instanceID') IS 'text' AND json_extract("record",'$.instanceID') IS "instance_id"),
	CONSTRAINT "work_write_stage_work_id_mirror_check" CHECK(json_type("record",'$.workID') IS 'text' AND json_extract("record",'$.workID') IS "work_id"),
	CONSTRAINT "work_write_stage_root_work_id_mirror_check" CHECK(json_type("record",'$.rootWorkID') IS 'text' AND json_extract("record",'$.rootWorkID') IS "root_work_id"),
	CONSTRAINT "work_write_stage_session_id_mirror_check" CHECK(json_type("record",'$.sessionID') IS 'text' AND json_extract("record",'$.sessionID') IS "session_id"),
	CONSTRAINT "work_write_stage_input_id_mirror_check" CHECK(json_type("record",'$.inputID') IS 'text' AND json_extract("record",'$.inputID') IS "input_id"),
	CONSTRAINT "work_write_stage_provider_receipt_id_mirror_check" CHECK(json_type("record",'$.providerReceiptID') IS 'text' AND json_extract("record",'$.providerReceiptID') IS "provider_receipt_id"),
	CONSTRAINT "work_write_stage_provider_attempt_id_mirror_check" CHECK(json_type("record",'$.providerAttemptID') IS 'text' AND json_extract("record",'$.providerAttemptID') IS "provider_attempt_id"),
	CONSTRAINT "work_write_stage_admission_id_mirror_check" CHECK(json_type("record",'$.admissionID') IS 'text' AND json_extract("record",'$.admissionID') IS "admission_id"),
	CONSTRAINT "work_write_stage_tool_call_id_mirror_check" CHECK(json_type("record",'$.toolCallID') IS 'text' AND json_extract("record",'$.toolCallID') IS "tool_call_id"),
	CONSTRAINT "work_write_stage_binding_hash_mirror_check" CHECK(json_type("record",'$.bindingHash') IS 'text' AND json_extract("record",'$.bindingHash') IS "binding_hash"),
	CONSTRAINT "work_write_stage_request_hash_mirror_check" CHECK(json_type("record",'$.requestHash') IS 'text' AND json_extract("record",'$.requestHash') IS "request_hash"),
	CONSTRAINT "work_write_stage_state_mirror_check" CHECK(json_type("record",'$.state') IS 'text' AND json_extract("record",'$.state') IS "state"),
	CONSTRAINT "work_write_stage_control_revision_mirror_check" CHECK(json_type("record",'$.controlRevision') IS 'integer' AND json_extract("record",'$.controlRevision') IS "control_revision"),
	CONSTRAINT "work_write_stage_revision_mirror_check" CHECK(json_type("record",'$.revision') IS 'integer' AND json_extract("record",'$.revision') IS "revision"),
	CONSTRAINT "work_write_stage_reserved_bytes_mirror_check" CHECK(json_type("record",'$.reservedBytes') IS 'integer' AND json_extract("record",'$.reservedBytes') IS "reserved_bytes"),
	CONSTRAINT "work_write_stage_observed_retained_bytes_mirror_check" CHECK(json_type("record",'$.observedRetainedBytes') IS 'integer' AND json_extract("record",'$.observedRetainedBytes') IS "observed_retained_bytes"),
	CONSTRAINT "work_write_stage_created_at_mirror_check" CHECK(json_type("record",'$.createdAt') IS 'integer' AND json_extract("record",'$.createdAt') IS "created_at"),
	CONSTRAINT "work_write_stage_updated_at_mirror_check" CHECK(json_type("record",'$.updatedAt') IS 'integer' AND json_extract("record",'$.updatedAt') IS "updated_at"),
	CONSTRAINT "work_write_stage_release_mirror_check" CHECK((("released_at" IS NULL AND json_type("record",'$.releasedAt') IS 'null') OR ("released_at" IS NOT NULL AND json_type("record",'$.releasedAt') IS 'integer' AND json_extract("record",'$.releasedAt') IS "released_at")))
);
--> statement-breakpoint
ALTER TABLE `session_v2_tool_effect` ADD COLUMN `known_write_proof` text CONSTRAINT session_v2_tool_effect_known_write_proof_check CHECK("known_write_proof" IS NULL OR CASE WHEN typeof("known_write_proof") = 'text' AND length(CAST("known_write_proof" AS BLOB)) BETWEEN 1 AND 16384 AND instr("known_write_proof", char(0)) = 0 AND json_valid("known_write_proof") THEN coalesce(json_type("known_write_proof") = 'object' AND json_type("known_write_proof", '$.version') = 'integer' AND json_extract("known_write_proof", '$.version') = 1 AND "effect_kind" = 'mutating' AND "state" = 'settled' AND "error_code" IS NULL AND "known_read_proof" IS NULL, 0) ELSE 0 END);--> statement-breakpoint
CREATE UNIQUE INDEX `work_write_stage_admission_idx` ON `work_write_stage` (`admission_id`);--> statement-breakpoint
CREATE INDEX `work_write_stage_custody_idx` ON `work_write_stage` (`instance_id`,`released_at`,`stage_id`);--> statement-breakpoint
CREATE INDEX `work_write_stage_work_idx` ON `work_write_stage` (`work_id`,`created_at`,`stage_id`);
--> statement-breakpoint
CREATE TRIGGER work_write_stage_binding_insert BEFORE INSERT ON work_write_stage
BEGIN
 SELECT CASE WHEN NEW.state<>'reserved' OR NEW.revision<>1 OR NEW.released_at IS NOT NULL
  OR NEW.observed_retained_bytes<>0 OR json_type(NEW.record,'$.parentIdentity') IS NOT 'null'
  OR json_type(NEW.record,'$.stageIdentity') IS NOT 'null'
  OR NOT EXISTS (
   SELECT 1 FROM work_execution w JOIN session s ON s.id=w.session_id
    JOIN session_v2_tool_effect_admission a ON a.admission_id=NEW.admission_id
    JOIN session_v2_provider_turn_receipt r ON r.receipt_id=a.receipt_id
   WHERE w.work_id=NEW.work_id AND w.root_work_id=NEW.root_work_id AND w.session_id=NEW.session_id
    AND w.input_id=NEW.input_id AND w.binding_hash=NEW.binding_hash AND w.control_revision=NEW.control_revision
    AND w.binding_version=2 AND w.admission_state='ready' AND w.control_state='active' AND w.outcome='pending'
    AND json_extract(w.binding,'$.profile.id') IS 'project_work_v1'
    AND json_extract(w.binding,'$.projectScope.helperHash') IS json_extract(NEW.record,'$.helperHash')
    AND s.execution_claim_token IS json_extract(NEW.record,'$.sessionClaimToken')
    AND a.session_id=NEW.session_id AND a.receipt_id=NEW.provider_receipt_id
    AND a.provider_attempt_id=NEW.provider_attempt_id AND a.tool_call_id=NEW.tool_call_id
    AND a.tool_name='write' AND a.effect_kind='mutating'
    AND a.owner_token IS json_extract(NEW.record,'$.ownerToken')
    AND r.session_id=NEW.session_id AND r.provider_attempt_id=NEW.provider_attempt_id
    AND r.activity_id IS json_extract(NEW.record,'$.activityID') AND r.owner_token=a.owner_token
  ) THEN RAISE(ABORT,'work_write_stage_binding_conflict') END;
 SELECT CASE WHEN NOT EXISTS (
  SELECT 1 FROM work_write_stage_meter m WHERE m.instance_id=NEW.instance_id
   AND m.custody_count BETWEEN 1 AND 32 AND m.audit_count BETWEEN 1 AND 10000
   AND m.retained_bytes BETWEEN NEW.reserved_bytes AND 268435456
 ) THEN RAISE(ABORT,'work_write_stage_capacity') END;
END;
--> statement-breakpoint
CREATE TRIGGER work_write_stage_identity_update BEFORE UPDATE ON work_write_stage
WHEN NEW.stage_id IS NOT OLD.stage_id OR NEW.instance_id IS NOT OLD.instance_id
 OR NEW.work_id IS NOT OLD.work_id OR NEW.root_work_id IS NOT OLD.root_work_id
 OR NEW.session_id IS NOT OLD.session_id OR NEW.input_id IS NOT OLD.input_id
 OR NEW.provider_receipt_id IS NOT OLD.provider_receipt_id OR NEW.provider_attempt_id IS NOT OLD.provider_attempt_id
 OR NEW.admission_id IS NOT OLD.admission_id OR NEW.tool_call_id IS NOT OLD.tool_call_id
 OR NEW.binding_hash IS NOT OLD.binding_hash OR NEW.control_revision IS NOT OLD.control_revision
 OR NEW.request_hash IS NOT OLD.request_hash OR NEW.created_at IS NOT OLD.created_at
 OR NEW.revision<>OLD.revision+1 OR NEW.updated_at<OLD.updated_at OR OLD.released_at IS NOT NULL
 OR json_extract(NEW.record,'$.activityID') IS NOT json_extract(OLD.record,'$.activityID')
 OR json_extract(NEW.record,'$.ownerToken') IS NOT json_extract(OLD.record,'$.ownerToken')
 OR json_extract(NEW.record,'$.sessionClaimToken') IS NOT json_extract(OLD.record,'$.sessionClaimToken')
 OR json_extract(NEW.record,'$.definitionHash') IS NOT json_extract(OLD.record,'$.definitionHash')
 OR json_extract(NEW.record,'$.helperHash') IS NOT json_extract(OLD.record,'$.helperHash')
 OR json_extract(NEW.record,'$.relative') IS NOT json_extract(OLD.record,'$.relative')
 OR json_extract(NEW.record,'$.basename') IS NOT json_extract(OLD.record,'$.basename')
 OR json_extract(NEW.record,'$.rootIdentity') IS NOT json_extract(OLD.record,'$.rootIdentity')
 OR json_extract(NEW.record,'$.expected') IS NOT json_extract(OLD.record,'$.expected')
 OR json_extract(NEW.record,'$.nextHash') IS NOT json_extract(OLD.record,'$.nextHash')
 OR json_extract(NEW.record,'$.nextBytes') IS NOT json_extract(OLD.record,'$.nextBytes')
 OR (json_type(OLD.record,'$.parentIdentity') IS NOT 'null' AND json_extract(NEW.record,'$.parentIdentity') IS NOT json_extract(OLD.record,'$.parentIdentity'))
 OR (json_type(OLD.record,'$.stageIdentity') IS NOT 'null' AND json_extract(NEW.record,'$.stageIdentity') IS NOT json_extract(OLD.record,'$.stageIdentity'))
 OR (NEW.released_at IS NULL AND NEW.reserved_bytes IS NOT OLD.reserved_bytes)
BEGIN SELECT RAISE(ABORT,'work_write_stage_identity_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER work_write_stage_phase_update BEFORE UPDATE ON work_write_stage
WHEN NOT (
 (OLD.state='reserved' AND NEW.state IN ('reserved','prepared','refused'))
 OR (OLD.state='prepared' AND NEW.state IN ('prepared','publication_unknown','refused'))
 OR (OLD.state='publication_unknown' AND NEW.state IN ('publication_unknown','published','refused'))
 OR (OLD.state='published' AND NEW.state='published') OR (OLD.state='refused' AND NEW.state='refused')
) OR (NEW.state IN ('prepared','publication_unknown','published') AND
 (json_type(NEW.record,'$.parentIdentity') IS NOT 'object' OR json_type(NEW.record,'$.stageIdentity') IS NOT 'object'))
BEGIN SELECT RAISE(ABORT,'work_write_stage_phase_conflict'); END;
--> statement-breakpoint
CREATE TRIGGER work_write_stage_delete BEFORE DELETE ON work_write_stage
BEGIN SELECT RAISE(ABORT,'work_write_stage_audit_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER work_write_stage_meter_update BEFORE UPDATE ON work_write_stage_meter
WHEN NEW.instance_id IS NOT OLD.instance_id OR NEW.revision<>OLD.revision+1
 OR NEW.updated_at<OLD.updated_at OR NEW.audit_count<OLD.audit_count OR NEW.audit_count>OLD.audit_count+1
BEGIN SELECT RAISE(ABORT,'work_write_stage_meter_conflict'); END;
--> statement-breakpoint
CREATE TRIGGER work_write_stage_meter_delete BEFORE DELETE ON work_write_stage_meter
BEGIN SELECT RAISE(ABORT,'work_write_stage_meter_immutable'); END;
