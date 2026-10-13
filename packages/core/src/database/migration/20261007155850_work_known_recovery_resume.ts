import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261007155850_work_known_recovery_resume",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`work_known_recovery_resume\` (
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
          CONSTRAINT \`fk_work_known_recovery_resume_recovery_id_work_known_recovery_recovery_id_fk\` FOREIGN KEY (\`recovery_id\`) REFERENCES \`work_known_recovery\`(\`recovery_id\`) ON UPDATE RESTRICT ON DELETE RESTRICT,
          CONSTRAINT "work_known_recovery_resume_version_check" CHECK(typeof("version")='integer' AND "version"=1),
          CONSTRAINT "work_known_recovery_resume_record_check" CHECK(typeof("record")='text'
            AND length(CAST("record" AS BLOB)) BETWEEN 1 AND 8192
            AND instr("record",char(0))=0 AND json_valid("record")),
          CONSTRAINT "work_known_recovery_resume_recovery_id_text_check" CHECK(typeof("recovery_id")='text'
              AND length(CAST("recovery_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("recovery_id",char(0))=0),
          CONSTRAINT "work_known_recovery_resume_instance_id_text_check" CHECK(typeof("instance_id")='text'
              AND length(CAST("instance_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("instance_id",char(0))=0),
          CONSTRAINT "work_known_recovery_resume_operator_id_text_check" CHECK(typeof("operator_id")='text'
              AND length(CAST("operator_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("operator_id",char(0))=0),
          CONSTRAINT "work_known_recovery_resume_work_id_text_check" CHECK(typeof("work_id")='text'
              AND length(CAST("work_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("work_id",char(0))=0),
          CONSTRAINT "work_known_recovery_resume_session_id_text_check" CHECK(typeof("session_id")='text'
              AND length(CAST("session_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("session_id",char(0))=0),
          CONSTRAINT "work_known_recovery_resume_request_id_text_check" CHECK(typeof("request_id")='text'
              AND length(CAST("request_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("request_id",char(0))=0),
          CONSTRAINT "work_known_recovery_resume_control_revision_integer_check" CHECK(typeof("control_revision")='integer'
              AND "control_revision" BETWEEN 1 AND 9007199254740991),
          CONSTRAINT "work_known_recovery_resume_operator_revision_integer_check" CHECK(typeof("operator_revision")='integer'
              AND "operator_revision" BETWEEN 1 AND 9007199254740991),
          CONSTRAINT "work_known_recovery_resume_source_revision_integer_check" CHECK(typeof("source_revision")='integer'
              AND "source_revision" BETWEEN 1 AND 9007199254740991),
          CONSTRAINT "work_known_recovery_resume_approval_revision_integer_check" CHECK(typeof("approval_revision")='integer'
              AND "approval_revision" BETWEEN 1 AND 9007199254740991),
          CONSTRAINT "work_known_recovery_resume_created_at_integer_check" CHECK(typeof("created_at")='integer'
              AND "created_at" BETWEEN 1 AND 9007199254740991),
          CONSTRAINT "work_known_recovery_resume_binding_hash_digest_check" CHECK(typeof("binding_hash")='text'
              AND length(CAST("binding_hash" AS BLOB))=64 AND "binding_hash" NOT GLOB '*[^0-9a-f]*'),
          CONSTRAINT "work_known_recovery_resume_recovery_record_hash_digest_check" CHECK(typeof("recovery_record_hash")='text'
              AND length(CAST("recovery_record_hash" AS BLOB))=64 AND "recovery_record_hash" NOT GLOB '*[^0-9a-f]*'),
          CONSTRAINT "work_known_recovery_resume_request_hash_digest_check" CHECK(typeof("request_hash")='text'
              AND length(CAST("request_hash" AS BLOB))=64 AND "request_hash" NOT GLOB '*[^0-9a-f]*'),
          CONSTRAINT "work_known_recovery_resume_record_hash_digest_check" CHECK(typeof("record_hash")='text'
              AND length(CAST("record_hash" AS BLOB))=64 AND "record_hash" NOT GLOB '*[^0-9a-f]*'),
          CONSTRAINT "work_known_recovery_resume_mac_digest_check" CHECK(typeof("mac")='text'
              AND length(CAST("mac" AS BLOB))=64 AND "mac" NOT GLOB '*[^0-9a-f]*'),
          CONSTRAINT "work_known_recovery_resume_recovery_id_mirror_check" CHECK(
            json_type("record",'$.recoveryID') IS 'text'
            AND json_extract("record",'$.recoveryID') IS "recovery_id"),
          CONSTRAINT "work_known_recovery_resume_instance_id_mirror_check" CHECK(
            json_type("record",'$.instanceID') IS 'text'
            AND json_extract("record",'$.instanceID') IS "instance_id"),
          CONSTRAINT "work_known_recovery_resume_operator_id_mirror_check" CHECK(
            json_type("record",'$.operatorID') IS 'text'
            AND json_extract("record",'$.operatorID') IS "operator_id"),
          CONSTRAINT "work_known_recovery_resume_work_id_mirror_check" CHECK(
            json_type("record",'$.workID') IS 'text'
            AND json_extract("record",'$.workID') IS "work_id"),
          CONSTRAINT "work_known_recovery_resume_session_id_mirror_check" CHECK(
            json_type("record",'$.sessionID') IS 'text'
            AND json_extract("record",'$.sessionID') IS "session_id"),
          CONSTRAINT "work_known_recovery_resume_request_id_mirror_check" CHECK(
            json_type("record",'$.requestID') IS 'text'
            AND json_extract("record",'$.requestID') IS "request_id"),
          CONSTRAINT "work_known_recovery_resume_binding_hash_mirror_check" CHECK(
            json_type("record",'$.bindingHash') IS 'text'
            AND json_extract("record",'$.bindingHash') IS "binding_hash"),
          CONSTRAINT "work_known_recovery_resume_recovery_record_hash_mirror_check" CHECK(
            json_type("record",'$.recoveryRecordHash') IS 'text'
            AND json_extract("record",'$.recoveryRecordHash') IS "recovery_record_hash"),
          CONSTRAINT "work_known_recovery_resume_request_hash_mirror_check" CHECK(
            json_type("record",'$.requestHash') IS 'text'
            AND json_extract("record",'$.requestHash') IS "request_hash"),
          CONSTRAINT "work_known_recovery_resume_version_mirror_check" CHECK(
            json_type("record",'$.version') IS 'integer'
            AND json_extract("record",'$.version') IS "version"),
          CONSTRAINT "work_known_recovery_resume_control_revision_mirror_check" CHECK(
            json_type("record",'$.controlRevision') IS 'integer'
            AND json_extract("record",'$.controlRevision') IS "control_revision"),
          CONSTRAINT "work_known_recovery_resume_operator_revision_mirror_check" CHECK(
            json_type("record",'$.operatorRevision') IS 'integer'
            AND json_extract("record",'$.operatorRevision') IS "operator_revision"),
          CONSTRAINT "work_known_recovery_resume_source_revision_mirror_check" CHECK(
            json_type("record",'$.sourceRevision') IS 'integer'
            AND json_extract("record",'$.sourceRevision') IS "source_revision"),
          CONSTRAINT "work_known_recovery_resume_approval_revision_mirror_check" CHECK(
            json_type("record",'$.approvalRevision') IS 'integer'
            AND json_extract("record",'$.approvalRevision') IS "approval_revision"),
          CONSTRAINT "work_known_recovery_resume_created_at_mirror_check" CHECK(
            json_type("record",'$.createdAt') IS 'integer'
            AND json_extract("record",'$.createdAt') IS "created_at")
        );
      `)
      yield* tx.run(`CREATE UNIQUE INDEX \`work_known_recovery_resume_request_idx\` ON \`work_known_recovery_resume\` (\`instance_id\`,\`operator_id\`,\`work_id\`,\`request_id\`);`)
      yield* tx.run(`CREATE INDEX \`work_known_recovery_resume_session_idx\` ON \`work_known_recovery_resume\` (\`session_id\`,\`control_revision\`);`)
      yield* tx.run("CREATE TRIGGER work_known_recovery_resume_binding_guard BEFORE INSERT ON work_known_recovery_resume BEGIN\n SELECT CASE WHEN NOT EXISTS (\n   SELECT 1 FROM work_known_recovery r JOIN work_execution w ON w.work_id=r.work_id\n     JOIN session s ON s.id=w.session_id\n   WHERE r.recovery_id=NEW.recovery_id AND r.action='recover_only'\n     AND r.instance_id=NEW.instance_id AND r.operator_id=NEW.operator_id\n     AND r.work_id=NEW.work_id AND r.session_id=NEW.session_id\n     AND r.binding_hash=NEW.binding_hash AND r.record_hash=NEW.recovery_record_hash\n     AND r.source_revision=NEW.source_revision\n     AND w.session_id=NEW.session_id AND w.input_id=r.input_id\n     AND w.binding_hash=NEW.binding_hash AND w.source_revision=NEW.source_revision\n     AND w.control_revision=NEW.control_revision AND w.binding_version=2\n     AND w.admission_state='ready' AND w.control_state='active' AND w.outcome='pending'\n     AND s.execution_claim_token IS NULL\n ) THEN RAISE(ABORT,'work_known_recovery_resume_binding_conflict') END;\nEND;")
      yield* tx.run("CREATE TRIGGER work_known_recovery_resume_immutable_update BEFORE UPDATE ON work_known_recovery_resume BEGIN\n SELECT RAISE(ABORT,'work_known_recovery_resume_immutable');\nEND;")
      yield* tx.run("CREATE TRIGGER work_known_recovery_resume_immutable_delete BEFORE DELETE ON work_known_recovery_resume BEGIN\n SELECT RAISE(ABORT,'work_known_recovery_resume_immutable');\nEND;")
    })
  },
} satisfies DatabaseMigration.Migration
