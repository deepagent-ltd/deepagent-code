import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261008220506_work_child_known_recovery",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`work_known_recovery_resume_v2\` (
          \`recovery_id\` text PRIMARY KEY,
          \`version\` integer NOT NULL,
          \`instance_id\` text NOT NULL,
          \`operator_id\` text NOT NULL,
          \`work_id\` text NOT NULL,
          \`session_id\` text NOT NULL,
          \`request_id\` text NOT NULL,
          \`control_revision\` integer NOT NULL,
          \`operator_revision\` integer NOT NULL,
          \`source_revision\` integer NOT NULL,
          \`approval_revision\` integer NOT NULL,
          \`binding_hash\` text NOT NULL,
          \`recovery_record_hash\` text NOT NULL,
          \`request_hash\` text NOT NULL,
          \`record_hash\` text NOT NULL,
          \`mac\` text NOT NULL,
          \`created_at\` integer NOT NULL,
          \`record\` text NOT NULL,
          CONSTRAINT \`fk_work_known_recovery_resume_v2_recovery_id_work_known_recovery_v2_recovery_id_fk\` FOREIGN KEY (\`recovery_id\`) REFERENCES \`work_known_recovery_v2\`(\`recovery_id\`) ON UPDATE RESTRICT ON DELETE RESTRICT,
          CONSTRAINT "work_known_recovery_resume_v2_version_check" CHECK(typeof("version")='integer' AND "version"=2),
          CONSTRAINT "work_known_recovery_resume_v2_record_check" CHECK(typeof("record")='text'
            AND length(CAST("record" AS BLOB)) BETWEEN 1 AND 8192
            AND instr("record",char(0))=0 AND json_valid("record")),
          CONSTRAINT "work_known_recovery_resume_v2_recovery_id_text_check" CHECK(typeof("recovery_id")='text'
              AND length(CAST("recovery_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("recovery_id",char(0))=0),
          CONSTRAINT "work_known_recovery_resume_v2_instance_id_text_check" CHECK(typeof("instance_id")='text'
              AND length(CAST("instance_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("instance_id",char(0))=0),
          CONSTRAINT "work_known_recovery_resume_v2_operator_id_text_check" CHECK(typeof("operator_id")='text'
              AND length(CAST("operator_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("operator_id",char(0))=0),
          CONSTRAINT "work_known_recovery_resume_v2_work_id_text_check" CHECK(typeof("work_id")='text'
              AND length(CAST("work_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("work_id",char(0))=0),
          CONSTRAINT "work_known_recovery_resume_v2_session_id_text_check" CHECK(typeof("session_id")='text'
              AND length(CAST("session_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("session_id",char(0))=0),
          CONSTRAINT "work_known_recovery_resume_v2_request_id_text_check" CHECK(typeof("request_id")='text'
              AND length(CAST("request_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("request_id",char(0))=0),
          CONSTRAINT "work_known_recovery_resume_v2_control_revision_integer_check" CHECK(typeof("control_revision")='integer'
              AND "control_revision" BETWEEN 1 AND 9007199254740991),
          CONSTRAINT "work_known_recovery_resume_v2_operator_revision_integer_check" CHECK(typeof("operator_revision")='integer'
              AND "operator_revision" BETWEEN 1 AND 9007199254740991),
          CONSTRAINT "work_known_recovery_resume_v2_source_revision_integer_check" CHECK(typeof("source_revision")='integer'
              AND "source_revision" BETWEEN 1 AND 9007199254740991),
          CONSTRAINT "work_known_recovery_resume_v2_approval_revision_integer_check" CHECK(typeof("approval_revision")='integer'
              AND "approval_revision" BETWEEN 1 AND 9007199254740991),
          CONSTRAINT "work_known_recovery_resume_v2_created_at_integer_check" CHECK(typeof("created_at")='integer'
              AND "created_at" BETWEEN 1 AND 9007199254740991),
          CONSTRAINT "work_known_recovery_resume_v2_binding_hash_digest_check" CHECK(typeof("binding_hash")='text'
              AND length(CAST("binding_hash" AS BLOB))=64 AND "binding_hash" NOT GLOB '*[^0-9a-f]*'),
          CONSTRAINT "work_known_recovery_resume_v2_recovery_record_hash_digest_check" CHECK(typeof("recovery_record_hash")='text'
              AND length(CAST("recovery_record_hash" AS BLOB))=64 AND "recovery_record_hash" NOT GLOB '*[^0-9a-f]*'),
          CONSTRAINT "work_known_recovery_resume_v2_request_hash_digest_check" CHECK(typeof("request_hash")='text'
              AND length(CAST("request_hash" AS BLOB))=64 AND "request_hash" NOT GLOB '*[^0-9a-f]*'),
          CONSTRAINT "work_known_recovery_resume_v2_record_hash_digest_check" CHECK(typeof("record_hash")='text'
              AND length(CAST("record_hash" AS BLOB))=64 AND "record_hash" NOT GLOB '*[^0-9a-f]*'),
          CONSTRAINT "work_known_recovery_resume_v2_mac_digest_check" CHECK(typeof("mac")='text'
              AND length(CAST("mac" AS BLOB))=64 AND "mac" NOT GLOB '*[^0-9a-f]*'),
          CONSTRAINT "work_known_recovery_resume_v2_recovery_id_mirror_check" CHECK(
            json_type("record",'$.recoveryID') IS 'text'
            AND json_extract("record",'$.recoveryID') IS "recovery_id"),
          CONSTRAINT "work_known_recovery_resume_v2_instance_id_mirror_check" CHECK(
            json_type("record",'$.instanceID') IS 'text'
            AND json_extract("record",'$.instanceID') IS "instance_id"),
          CONSTRAINT "work_known_recovery_resume_v2_operator_id_mirror_check" CHECK(
            json_type("record",'$.operatorID') IS 'text'
            AND json_extract("record",'$.operatorID') IS "operator_id"),
          CONSTRAINT "work_known_recovery_resume_v2_work_id_mirror_check" CHECK(
            json_type("record",'$.workID') IS 'text'
            AND json_extract("record",'$.workID') IS "work_id"),
          CONSTRAINT "work_known_recovery_resume_v2_session_id_mirror_check" CHECK(
            json_type("record",'$.sessionID') IS 'text'
            AND json_extract("record",'$.sessionID') IS "session_id"),
          CONSTRAINT "work_known_recovery_resume_v2_request_id_mirror_check" CHECK(
            json_type("record",'$.requestID') IS 'text'
            AND json_extract("record",'$.requestID') IS "request_id"),
          CONSTRAINT "work_known_recovery_resume_v2_binding_hash_mirror_check" CHECK(
            json_type("record",'$.bindingHash') IS 'text'
            AND json_extract("record",'$.bindingHash') IS "binding_hash"),
          CONSTRAINT "work_known_recovery_resume_v2_recovery_record_hash_mirror_check" CHECK(
            json_type("record",'$.recoveryRecordHash') IS 'text'
            AND json_extract("record",'$.recoveryRecordHash') IS "recovery_record_hash"),
          CONSTRAINT "work_known_recovery_resume_v2_request_hash_mirror_check" CHECK(
            json_type("record",'$.requestHash') IS 'text'
            AND json_extract("record",'$.requestHash') IS "request_hash"),
          CONSTRAINT "work_known_recovery_resume_v2_version_mirror_check" CHECK(
            json_type("record",'$.version') IS 'integer'
            AND json_extract("record",'$.version') IS "version"),
          CONSTRAINT "work_known_recovery_resume_v2_control_revision_mirror_check" CHECK(
            json_type("record",'$.controlRevision') IS 'integer'
            AND json_extract("record",'$.controlRevision') IS "control_revision"),
          CONSTRAINT "work_known_recovery_resume_v2_operator_revision_mirror_check" CHECK(
            json_type("record",'$.operatorRevision') IS 'integer'
            AND json_extract("record",'$.operatorRevision') IS "operator_revision"),
          CONSTRAINT "work_known_recovery_resume_v2_source_revision_mirror_check" CHECK(
            json_type("record",'$.sourceRevision') IS 'integer'
            AND json_extract("record",'$.sourceRevision') IS "source_revision"),
          CONSTRAINT "work_known_recovery_resume_v2_approval_revision_mirror_check" CHECK(
            json_type("record",'$.approvalRevision') IS 'integer'
            AND json_extract("record",'$.approvalRevision') IS "approval_revision"),
          CONSTRAINT "work_known_recovery_resume_v2_created_at_mirror_check" CHECK(
            json_type("record",'$.createdAt') IS 'integer'
            AND json_extract("record",'$.createdAt') IS "created_at")
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`work_known_recovery_v2\` (
          \`recovery_id\` text PRIMARY KEY,
          \`version\` integer NOT NULL,
          \`instance_id\` text NOT NULL,
          \`operator_id\` text NOT NULL,
          \`work_id\` text NOT NULL,
          \`root_work_id\` text NOT NULL,
          \`session_id\` text NOT NULL,
          \`input_id\` text NOT NULL,
          \`request_id\` text NOT NULL,
          \`action\` text NOT NULL,
          \`old_claim_token\` integer NOT NULL,
          \`control_revision\` integer NOT NULL,
          \`operator_revision\` integer NOT NULL,
          \`source_revision\` integer NOT NULL,
          \`approval_revision\` integer NOT NULL,
          \`binding_hash\` text NOT NULL,
          \`request_hash\` text NOT NULL,
          \`evidence_hash\` text NOT NULL,
          \`record_hash\` text NOT NULL,
          \`mac\` text NOT NULL,
          \`created_at\` integer NOT NULL,
          \`record\` text NOT NULL,
          CONSTRAINT "work_known_recovery_v2_version_check" CHECK(typeof("version")='integer' AND "version"=2),
          CONSTRAINT "work_known_recovery_v2_action_check" CHECK("action" IN ('recover_only','recover_and_resume')),
          CONSTRAINT "work_known_recovery_v2_record_check" CHECK(typeof("record")='text'
            AND length(CAST("record" AS BLOB)) BETWEEN 1 AND 131072
            AND instr("record",char(0))=0 AND json_valid("record")
            AND json_type("record",'$.evidence') IS 'object'
            AND json_type("record",'$.evidence.providers') IS 'array'
            AND json_array_length("record",'$.evidence.providers') BETWEEN 1 AND 32
            AND json_type("record",'$.evidence.tools') IS 'array'
            AND json_array_length("record",'$.evidence.tools') BETWEEN 0 AND 128
            AND json_type("record",'$.evidence.tasks') IS 'array'
            AND json_array_length("record",'$.evidence.tasks') BETWEEN 1 AND 128),
          CONSTRAINT "work_known_recovery_v2_recovery_id_text_check" CHECK(typeof("recovery_id")='text' AND length(CAST("recovery_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("recovery_id",char(0))=0),
          CONSTRAINT "work_known_recovery_v2_instance_id_text_check" CHECK(typeof("instance_id")='text' AND length(CAST("instance_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("instance_id",char(0))=0),
          CONSTRAINT "work_known_recovery_v2_operator_id_text_check" CHECK(typeof("operator_id")='text' AND length(CAST("operator_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("operator_id",char(0))=0),
          CONSTRAINT "work_known_recovery_v2_work_id_text_check" CHECK(typeof("work_id")='text' AND length(CAST("work_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("work_id",char(0))=0),
          CONSTRAINT "work_known_recovery_v2_root_work_id_text_check" CHECK(typeof("root_work_id")='text' AND length(CAST("root_work_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("root_work_id",char(0))=0),
          CONSTRAINT "work_known_recovery_v2_session_id_text_check" CHECK(typeof("session_id")='text' AND length(CAST("session_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("session_id",char(0))=0),
          CONSTRAINT "work_known_recovery_v2_input_id_text_check" CHECK(typeof("input_id")='text' AND length(CAST("input_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("input_id",char(0))=0),
          CONSTRAINT "work_known_recovery_v2_request_id_text_check" CHECK(typeof("request_id")='text' AND length(CAST("request_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("request_id",char(0))=0),
          CONSTRAINT "work_known_recovery_v2_old_claim_token_integer_check" CHECK(typeof("old_claim_token")='integer' AND "old_claim_token" BETWEEN 1 AND 9007199254740991),
          CONSTRAINT "work_known_recovery_v2_control_revision_integer_check" CHECK(typeof("control_revision")='integer' AND "control_revision" BETWEEN 1 AND 9007199254740991),
          CONSTRAINT "work_known_recovery_v2_operator_revision_integer_check" CHECK(typeof("operator_revision")='integer' AND "operator_revision" BETWEEN 1 AND 9007199254740991),
          CONSTRAINT "work_known_recovery_v2_source_revision_integer_check" CHECK(typeof("source_revision")='integer' AND "source_revision" BETWEEN 1 AND 9007199254740991),
          CONSTRAINT "work_known_recovery_v2_approval_revision_integer_check" CHECK(typeof("approval_revision")='integer' AND "approval_revision" BETWEEN 1 AND 9007199254740991),
          CONSTRAINT "work_known_recovery_v2_created_at_integer_check" CHECK(typeof("created_at")='integer' AND "created_at" BETWEEN 1 AND 9007199254740991),
          CONSTRAINT "work_known_recovery_v2_binding_hash_digest_check" CHECK(typeof("binding_hash")='text'
              AND length(CAST("binding_hash" AS BLOB))=64 AND "binding_hash" NOT GLOB '*[^0-9a-f]*'),
          CONSTRAINT "work_known_recovery_v2_request_hash_digest_check" CHECK(typeof("request_hash")='text'
              AND length(CAST("request_hash" AS BLOB))=64 AND "request_hash" NOT GLOB '*[^0-9a-f]*'),
          CONSTRAINT "work_known_recovery_v2_evidence_hash_digest_check" CHECK(typeof("evidence_hash")='text'
              AND length(CAST("evidence_hash" AS BLOB))=64 AND "evidence_hash" NOT GLOB '*[^0-9a-f]*'),
          CONSTRAINT "work_known_recovery_v2_record_hash_digest_check" CHECK(typeof("record_hash")='text'
              AND length(CAST("record_hash" AS BLOB))=64 AND "record_hash" NOT GLOB '*[^0-9a-f]*'),
          CONSTRAINT "work_known_recovery_v2_mac_digest_check" CHECK(typeof("mac")='text'
              AND length(CAST("mac" AS BLOB))=64 AND "mac" NOT GLOB '*[^0-9a-f]*'),
          CONSTRAINT "work_known_recovery_v2_recovery_id_mirror_check" CHECK(
            json_type("record",'$.recoveryID') IS 'text'
            AND json_extract("record",'$.recoveryID') IS "recovery_id"),
          CONSTRAINT "work_known_recovery_v2_instance_id_mirror_check" CHECK(
            json_type("record",'$.instanceID') IS 'text'
            AND json_extract("record",'$.instanceID') IS "instance_id"),
          CONSTRAINT "work_known_recovery_v2_operator_id_mirror_check" CHECK(
            json_type("record",'$.operatorID') IS 'text'
            AND json_extract("record",'$.operatorID') IS "operator_id"),
          CONSTRAINT "work_known_recovery_v2_work_id_mirror_check" CHECK(
            json_type("record",'$.workID') IS 'text'
            AND json_extract("record",'$.workID') IS "work_id"),
          CONSTRAINT "work_known_recovery_v2_root_work_id_mirror_check" CHECK(
            json_type("record",'$.rootWorkID') IS 'text'
            AND json_extract("record",'$.rootWorkID') IS "root_work_id"),
          CONSTRAINT "work_known_recovery_v2_session_id_mirror_check" CHECK(
            json_type("record",'$.sessionID') IS 'text'
            AND json_extract("record",'$.sessionID') IS "session_id"),
          CONSTRAINT "work_known_recovery_v2_input_id_mirror_check" CHECK(
            json_type("record",'$.inputID') IS 'text'
            AND json_extract("record",'$.inputID') IS "input_id"),
          CONSTRAINT "work_known_recovery_v2_request_id_mirror_check" CHECK(
            json_type("record",'$.requestID') IS 'text'
            AND json_extract("record",'$.requestID') IS "request_id"),
          CONSTRAINT "work_known_recovery_v2_action_mirror_check" CHECK(
            json_type("record",'$.action') IS 'text'
            AND json_extract("record",'$.action') IS "action"),
          CONSTRAINT "work_known_recovery_v2_binding_hash_mirror_check" CHECK(
            json_type("record",'$.bindingHash') IS 'text'
            AND json_extract("record",'$.bindingHash') IS "binding_hash"),
          CONSTRAINT "work_known_recovery_v2_request_hash_mirror_check" CHECK(
            json_type("record",'$.requestHash') IS 'text'
            AND json_extract("record",'$.requestHash') IS "request_hash"),
          CONSTRAINT "work_known_recovery_v2_evidence_hash_mirror_check" CHECK(
            json_type("record",'$.evidenceHash') IS 'text'
            AND json_extract("record",'$.evidenceHash') IS "evidence_hash"),
          CONSTRAINT "work_known_recovery_v2_version_mirror_check" CHECK(
            json_type("record",'$.version') IS 'integer'
            AND json_extract("record",'$.version') IS "version"),
          CONSTRAINT "work_known_recovery_v2_old_claim_token_mirror_check" CHECK(
            json_type("record",'$.oldClaimToken') IS 'integer'
            AND json_extract("record",'$.oldClaimToken') IS "old_claim_token"),
          CONSTRAINT "work_known_recovery_v2_control_revision_mirror_check" CHECK(
            json_type("record",'$.controlRevision') IS 'integer'
            AND json_extract("record",'$.controlRevision') IS "control_revision"),
          CONSTRAINT "work_known_recovery_v2_operator_revision_mirror_check" CHECK(
            json_type("record",'$.operatorRevision') IS 'integer'
            AND json_extract("record",'$.operatorRevision') IS "operator_revision"),
          CONSTRAINT "work_known_recovery_v2_source_revision_mirror_check" CHECK(
            json_type("record",'$.sourceRevision') IS 'integer'
            AND json_extract("record",'$.sourceRevision') IS "source_revision"),
          CONSTRAINT "work_known_recovery_v2_approval_revision_mirror_check" CHECK(
            json_type("record",'$.approvalRevision') IS 'integer'
            AND json_extract("record",'$.approvalRevision') IS "approval_revision"),
          CONSTRAINT "work_known_recovery_v2_created_at_mirror_check" CHECK(
            json_type("record",'$.createdAt') IS 'integer'
            AND json_extract("record",'$.createdAt') IS "created_at")
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`work_task_known_proof\` (
          \`proof_id\` text PRIMARY KEY,
          \`version\` integer NOT NULL,
          \`instance_id\` text NOT NULL,
          \`root_work_id\` text NOT NULL,
          \`parent_work_id\` text NOT NULL,
          \`child_work_id\` text NOT NULL,
          \`task_run_id\` text NOT NULL,
          \`admission_id\` text NOT NULL,
          \`parent_binding_hash\` text NOT NULL,
          \`child_binding_hash\` text NOT NULL,
          \`grant_hash\` text NOT NULL,
          \`state\` text NOT NULL,
          \`reserved_bytes\` integer NOT NULL,
          \`effect_id\` text,
          \`record_hash\` text,
          \`mac\` text,
          \`record\` text,
          \`created_at\` integer NOT NULL,
          \`sealed_at\` integer,
          CONSTRAINT "work_task_known_proof_version_check" CHECK(typeof("version")='integer' AND "version"=2),
          CONSTRAINT "work_task_known_proof_state_check" CHECK("state" IN ('reserved','sealed')),
          CONSTRAINT "work_task_known_proof_capacity_check" CHECK(typeof("reserved_bytes")='integer' AND "reserved_bytes"=65536),
          CONSTRAINT "work_task_known_proof_shape_check" CHECK(("state"='reserved' AND "effect_id" IS NULL
            AND "record_hash" IS NULL AND "mac" IS NULL AND "record" IS NULL AND "sealed_at" IS NULL)
            OR ("state"='sealed' AND typeof("effect_id")='text' AND typeof("record_hash")='text'
              AND typeof("mac")='text' AND typeof("record")='text' AND typeof("sealed_at")='integer'
              AND "sealed_at" BETWEEN "created_at" AND 9007199254740991)),
          CONSTRAINT "work_task_known_proof_proof_id_text_check" CHECK(typeof("proof_id")='text' AND length(CAST("proof_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("proof_id",char(0))=0),
          CONSTRAINT "work_task_known_proof_instance_id_text_check" CHECK(typeof("instance_id")='text' AND length(CAST("instance_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("instance_id",char(0))=0),
          CONSTRAINT "work_task_known_proof_root_work_id_text_check" CHECK(typeof("root_work_id")='text' AND length(CAST("root_work_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("root_work_id",char(0))=0),
          CONSTRAINT "work_task_known_proof_parent_work_id_text_check" CHECK(typeof("parent_work_id")='text' AND length(CAST("parent_work_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("parent_work_id",char(0))=0),
          CONSTRAINT "work_task_known_proof_child_work_id_text_check" CHECK(typeof("child_work_id")='text' AND length(CAST("child_work_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("child_work_id",char(0))=0),
          CONSTRAINT "work_task_known_proof_task_run_id_text_check" CHECK(typeof("task_run_id")='text' AND length(CAST("task_run_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("task_run_id",char(0))=0),
          CONSTRAINT "work_task_known_proof_admission_id_text_check" CHECK(typeof("admission_id")='text' AND length(CAST("admission_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("admission_id",char(0))=0),
          CONSTRAINT "work_task_known_proof_effect_text_check" CHECK("effect_id" IS NULL OR
            (typeof("effect_id")='text' AND length(CAST("effect_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("effect_id",char(0))=0)),
          CONSTRAINT "work_task_known_proof_created_check" CHECK(typeof("created_at")='integer' AND "created_at" BETWEEN 1 AND 9007199254740991),
          CONSTRAINT "work_task_known_proof_parent_binding_hash_digest_check" CHECK(typeof("parent_binding_hash")='text'
              AND length(CAST("parent_binding_hash" AS BLOB))=64 AND "parent_binding_hash" NOT GLOB '*[^0-9a-f]*'),
          CONSTRAINT "work_task_known_proof_child_binding_hash_digest_check" CHECK(typeof("child_binding_hash")='text'
              AND length(CAST("child_binding_hash" AS BLOB))=64 AND "child_binding_hash" NOT GLOB '*[^0-9a-f]*'),
          CONSTRAINT "work_task_known_proof_grant_hash_digest_check" CHECK(typeof("grant_hash")='text'
              AND length(CAST("grant_hash" AS BLOB))=64 AND "grant_hash" NOT GLOB '*[^0-9a-f]*'),
          CONSTRAINT "work_task_known_proof_record_hash_digest_check" CHECK("record_hash" IS NULL OR (typeof("record_hash")='text' AND length(CAST("record_hash" AS BLOB))=64 AND "record_hash" NOT GLOB '*[^0-9a-f]*')),
          CONSTRAINT "work_task_known_proof_mac_digest_check" CHECK("mac" IS NULL OR (typeof("mac")='text' AND length(CAST("mac" AS BLOB))=64 AND "mac" NOT GLOB '*[^0-9a-f]*')),
          CONSTRAINT "work_task_known_proof_record_check" CHECK("record" IS NULL OR (typeof("record")='text'
            AND length(CAST("record" AS BLOB)) BETWEEN 1 AND 65536 AND instr("record",char(0))=0
            AND json_valid("record") AND json_type("record",'$.version') IS 'integer'
            AND json_extract("record",'$.version') IS "version"
            AND json_type("record",'$.providers') IS 'array' AND json_array_length("record",'$.providers') BETWEEN 1 AND 32
            AND json_type("record",'$.tools') IS 'array' AND json_array_length("record",'$.tools') BETWEEN 0 AND 128)),
          CONSTRAINT "work_task_known_proof_proof_id_mirror_check" CHECK("record" IS NULL OR
            (json_type("record",'$.proofID') IS 'text' AND json_extract("record",'$.proofID') IS "proof_id")),
          CONSTRAINT "work_task_known_proof_instance_id_mirror_check" CHECK("record" IS NULL OR
            (json_type("record",'$.instanceID') IS 'text' AND json_extract("record",'$.instanceID') IS "instance_id")),
          CONSTRAINT "work_task_known_proof_root_work_id_mirror_check" CHECK("record" IS NULL OR
            (json_type("record",'$.rootWorkID') IS 'text' AND json_extract("record",'$.rootWorkID') IS "root_work_id")),
          CONSTRAINT "work_task_known_proof_parent_work_id_mirror_check" CHECK("record" IS NULL OR
            (json_type("record",'$.parentWorkID') IS 'text' AND json_extract("record",'$.parentWorkID') IS "parent_work_id")),
          CONSTRAINT "work_task_known_proof_child_work_id_mirror_check" CHECK("record" IS NULL OR
            (json_type("record",'$.childWorkID') IS 'text' AND json_extract("record",'$.childWorkID') IS "child_work_id")),
          CONSTRAINT "work_task_known_proof_task_run_id_mirror_check" CHECK("record" IS NULL OR
            (json_type("record",'$.taskRunID') IS 'text' AND json_extract("record",'$.taskRunID') IS "task_run_id")),
          CONSTRAINT "work_task_known_proof_admission_id_mirror_check" CHECK("record" IS NULL OR
            (json_type("record",'$.admissionID') IS 'text' AND json_extract("record",'$.admissionID') IS "admission_id")),
          CONSTRAINT "work_task_known_proof_parent_binding_hash_mirror_check" CHECK("record" IS NULL OR
            (json_type("record",'$.parentBindingHash') IS 'text' AND json_extract("record",'$.parentBindingHash') IS "parent_binding_hash")),
          CONSTRAINT "work_task_known_proof_child_binding_hash_mirror_check" CHECK("record" IS NULL OR
            (json_type("record",'$.childBindingHash') IS 'text' AND json_extract("record",'$.childBindingHash') IS "child_binding_hash")),
          CONSTRAINT "work_task_known_proof_grant_hash_mirror_check" CHECK("record" IS NULL OR
            (json_type("record",'$.grantHash') IS 'text' AND json_extract("record",'$.grantHash') IS "grant_hash")),
          CONSTRAINT "work_task_known_proof_effect_id_mirror_check" CHECK("record" IS NULL OR
            (json_type("record",'$.effectID') IS 'text' AND json_extract("record",'$.effectID') IS "effect_id")),
          CONSTRAINT "work_task_known_proof_time_mirror_check" CHECK("record" IS NULL OR
            (json_type("record",'$.createdAt') IS 'integer' AND json_extract("record",'$.createdAt') IS "sealed_at"))
        );
      `)
      yield* tx.run(`CREATE UNIQUE INDEX \`work_known_recovery_resume_v2_request_idx\` ON \`work_known_recovery_resume_v2\` (\`instance_id\`,\`operator_id\`,\`work_id\`,\`request_id\`);`)
      yield* tx.run(`CREATE INDEX \`work_known_recovery_resume_v2_session_idx\` ON \`work_known_recovery_resume_v2\` (\`session_id\`,\`control_revision\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`work_known_recovery_v2_request_idx\` ON \`work_known_recovery_v2\` (\`instance_id\`,\`operator_id\`,\`work_id\`,\`request_id\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`work_known_recovery_v2_claim_idx\` ON \`work_known_recovery_v2\` (\`work_id\`,\`old_claim_token\`);`)
      yield* tx.run(`CREATE INDEX \`work_known_recovery_v2_session_idx\` ON \`work_known_recovery_v2\` (\`session_id\`,\`control_revision\`);`)
      yield* tx.run(`CREATE INDEX \`work_known_recovery_v2_instance_idx\` ON \`work_known_recovery_v2\` (\`instance_id\`,\`recovery_id\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`work_task_known_proof_admission_idx\` ON \`work_task_known_proof\` (\`admission_id\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`work_task_known_proof_child_idx\` ON \`work_task_known_proof\` (\`child_work_id\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`work_task_known_proof_effect_idx\` ON \`work_task_known_proof\` (\`effect_id\`);`)
      yield* tx.run(`CREATE INDEX \`work_task_known_proof_root_idx\` ON \`work_task_known_proof\` (\`root_work_id\`,\`proof_id\`);`)
      yield* tx.run(`CREATE INDEX \`work_task_known_proof_instance_idx\` ON \`work_task_known_proof\` (\`instance_id\`,\`proof_id\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
