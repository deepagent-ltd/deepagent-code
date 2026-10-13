import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261007154408_work_known_recovery",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`work_known_recovery\` (
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
          CONSTRAINT "work_known_recovery_version_check" CHECK(typeof("version")='integer' AND "version"=1),
          CONSTRAINT "work_known_recovery_action_check" CHECK("action" IN ('recover_only','recover_and_resume')),
          CONSTRAINT "work_known_recovery_record_check" CHECK(typeof("record")='text'
            AND length(CAST("record" AS BLOB)) BETWEEN 1 AND 65536
            AND instr("record",char(0))=0 AND json_valid("record")
            AND json_type("record",'$.evidence') IS 'object'
            AND json_type("record",'$.evidence.providers') IS 'array'
            AND json_array_length("record",'$.evidence.providers') BETWEEN 1 AND 32
            AND json_type("record",'$.evidence.tools') IS 'array'
            AND json_array_length("record",'$.evidence.tools') BETWEEN 0 AND 128),
          CONSTRAINT "work_known_recovery_recovery_id_text_check" CHECK(typeof("recovery_id")='text' AND length(CAST("recovery_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("recovery_id",char(0))=0),
          CONSTRAINT "work_known_recovery_instance_id_text_check" CHECK(typeof("instance_id")='text' AND length(CAST("instance_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("instance_id",char(0))=0),
          CONSTRAINT "work_known_recovery_operator_id_text_check" CHECK(typeof("operator_id")='text' AND length(CAST("operator_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("operator_id",char(0))=0),
          CONSTRAINT "work_known_recovery_work_id_text_check" CHECK(typeof("work_id")='text' AND length(CAST("work_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("work_id",char(0))=0),
          CONSTRAINT "work_known_recovery_root_work_id_text_check" CHECK(typeof("root_work_id")='text' AND length(CAST("root_work_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("root_work_id",char(0))=0),
          CONSTRAINT "work_known_recovery_session_id_text_check" CHECK(typeof("session_id")='text' AND length(CAST("session_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("session_id",char(0))=0),
          CONSTRAINT "work_known_recovery_input_id_text_check" CHECK(typeof("input_id")='text' AND length(CAST("input_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("input_id",char(0))=0),
          CONSTRAINT "work_known_recovery_request_id_text_check" CHECK(typeof("request_id")='text' AND length(CAST("request_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("request_id",char(0))=0),
          CONSTRAINT "work_known_recovery_old_claim_token_integer_check" CHECK(typeof("old_claim_token")='integer' AND "old_claim_token" BETWEEN 1 AND 9007199254740991),
          CONSTRAINT "work_known_recovery_control_revision_integer_check" CHECK(typeof("control_revision")='integer' AND "control_revision" BETWEEN 1 AND 9007199254740991),
          CONSTRAINT "work_known_recovery_operator_revision_integer_check" CHECK(typeof("operator_revision")='integer' AND "operator_revision" BETWEEN 1 AND 9007199254740991),
          CONSTRAINT "work_known_recovery_source_revision_integer_check" CHECK(typeof("source_revision")='integer' AND "source_revision" BETWEEN 1 AND 9007199254740991),
          CONSTRAINT "work_known_recovery_approval_revision_integer_check" CHECK(typeof("approval_revision")='integer' AND "approval_revision" BETWEEN 1 AND 9007199254740991),
          CONSTRAINT "work_known_recovery_created_at_integer_check" CHECK(typeof("created_at")='integer' AND "created_at" BETWEEN 1 AND 9007199254740991),
          CONSTRAINT "work_known_recovery_binding_hash_digest_check" CHECK(typeof("binding_hash")='text'
              AND length(CAST("binding_hash" AS BLOB))=64 AND "binding_hash" NOT GLOB '*[^0-9a-f]*'),
          CONSTRAINT "work_known_recovery_request_hash_digest_check" CHECK(typeof("request_hash")='text'
              AND length(CAST("request_hash" AS BLOB))=64 AND "request_hash" NOT GLOB '*[^0-9a-f]*'),
          CONSTRAINT "work_known_recovery_evidence_hash_digest_check" CHECK(typeof("evidence_hash")='text'
              AND length(CAST("evidence_hash" AS BLOB))=64 AND "evidence_hash" NOT GLOB '*[^0-9a-f]*'),
          CONSTRAINT "work_known_recovery_record_hash_digest_check" CHECK(typeof("record_hash")='text'
              AND length(CAST("record_hash" AS BLOB))=64 AND "record_hash" NOT GLOB '*[^0-9a-f]*'),
          CONSTRAINT "work_known_recovery_mac_digest_check" CHECK(typeof("mac")='text'
              AND length(CAST("mac" AS BLOB))=64 AND "mac" NOT GLOB '*[^0-9a-f]*'),
          CONSTRAINT "work_known_recovery_recovery_id_mirror_check" CHECK(
            json_type("record",'$.recoveryID') IS 'text'
            AND json_extract("record",'$.recoveryID') IS "recovery_id"),
          CONSTRAINT "work_known_recovery_instance_id_mirror_check" CHECK(
            json_type("record",'$.instanceID') IS 'text'
            AND json_extract("record",'$.instanceID') IS "instance_id"),
          CONSTRAINT "work_known_recovery_operator_id_mirror_check" CHECK(
            json_type("record",'$.operatorID') IS 'text'
            AND json_extract("record",'$.operatorID') IS "operator_id"),
          CONSTRAINT "work_known_recovery_work_id_mirror_check" CHECK(
            json_type("record",'$.workID') IS 'text'
            AND json_extract("record",'$.workID') IS "work_id"),
          CONSTRAINT "work_known_recovery_root_work_id_mirror_check" CHECK(
            json_type("record",'$.rootWorkID') IS 'text'
            AND json_extract("record",'$.rootWorkID') IS "root_work_id"),
          CONSTRAINT "work_known_recovery_session_id_mirror_check" CHECK(
            json_type("record",'$.sessionID') IS 'text'
            AND json_extract("record",'$.sessionID') IS "session_id"),
          CONSTRAINT "work_known_recovery_input_id_mirror_check" CHECK(
            json_type("record",'$.inputID') IS 'text'
            AND json_extract("record",'$.inputID') IS "input_id"),
          CONSTRAINT "work_known_recovery_request_id_mirror_check" CHECK(
            json_type("record",'$.requestID') IS 'text'
            AND json_extract("record",'$.requestID') IS "request_id"),
          CONSTRAINT "work_known_recovery_action_mirror_check" CHECK(
            json_type("record",'$.action') IS 'text'
            AND json_extract("record",'$.action') IS "action"),
          CONSTRAINT "work_known_recovery_binding_hash_mirror_check" CHECK(
            json_type("record",'$.bindingHash') IS 'text'
            AND json_extract("record",'$.bindingHash') IS "binding_hash"),
          CONSTRAINT "work_known_recovery_request_hash_mirror_check" CHECK(
            json_type("record",'$.requestHash') IS 'text'
            AND json_extract("record",'$.requestHash') IS "request_hash"),
          CONSTRAINT "work_known_recovery_evidence_hash_mirror_check" CHECK(
            json_type("record",'$.evidenceHash') IS 'text'
            AND json_extract("record",'$.evidenceHash') IS "evidence_hash"),
          CONSTRAINT "work_known_recovery_version_mirror_check" CHECK(
            json_type("record",'$.version') IS 'integer'
            AND json_extract("record",'$.version') IS "version"),
          CONSTRAINT "work_known_recovery_old_claim_token_mirror_check" CHECK(
            json_type("record",'$.oldClaimToken') IS 'integer'
            AND json_extract("record",'$.oldClaimToken') IS "old_claim_token"),
          CONSTRAINT "work_known_recovery_control_revision_mirror_check" CHECK(
            json_type("record",'$.controlRevision') IS 'integer'
            AND json_extract("record",'$.controlRevision') IS "control_revision"),
          CONSTRAINT "work_known_recovery_operator_revision_mirror_check" CHECK(
            json_type("record",'$.operatorRevision') IS 'integer'
            AND json_extract("record",'$.operatorRevision') IS "operator_revision"),
          CONSTRAINT "work_known_recovery_source_revision_mirror_check" CHECK(
            json_type("record",'$.sourceRevision') IS 'integer'
            AND json_extract("record",'$.sourceRevision') IS "source_revision"),
          CONSTRAINT "work_known_recovery_approval_revision_mirror_check" CHECK(
            json_type("record",'$.approvalRevision') IS 'integer'
            AND json_extract("record",'$.approvalRevision') IS "approval_revision"),
          CONSTRAINT "work_known_recovery_created_at_mirror_check" CHECK(
            json_type("record",'$.createdAt') IS 'integer'
            AND json_extract("record",'$.createdAt') IS "created_at")
        );
      `)
      yield* tx.run(`CREATE UNIQUE INDEX \`work_known_recovery_request_idx\` ON \`work_known_recovery\` (\`instance_id\`,\`operator_id\`,\`work_id\`,\`request_id\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`work_known_recovery_claim_idx\` ON \`work_known_recovery\` (\`work_id\`,\`old_claim_token\`);`)
      yield* tx.run(`CREATE INDEX \`work_known_recovery_session_idx\` ON \`work_known_recovery\` (\`session_id\`,\`control_revision\`);`)
      yield* tx.run(`CREATE INDEX \`work_known_recovery_instance_idx\` ON \`work_known_recovery\` (\`instance_id\`,\`recovery_id\`);`)
      yield* tx.run("CREATE TRIGGER work_known_recovery_binding_guard BEFORE INSERT ON work_known_recovery BEGIN\n SELECT CASE WHEN NOT EXISTS (\n   SELECT 1 FROM work_execution w JOIN session s ON s.id=w.session_id\n   WHERE w.work_id=NEW.work_id AND w.root_work_id=NEW.root_work_id AND w.session_id=NEW.session_id\n     AND w.input_id=NEW.input_id AND w.binding_hash=NEW.binding_hash AND w.source_revision=NEW.source_revision\n     AND w.control_revision=NEW.control_revision AND w.binding_version=2\n     AND w.admission_state='ready' AND w.control_state='active' AND w.outcome='pending'\n     AND s.execution_claim_token=NEW.old_claim_token\n ) THEN RAISE(ABORT,'work_known_recovery_binding_conflict') END;\nEND;")
      yield* tx.run("CREATE TRIGGER work_known_recovery_capacity_guard BEFORE INSERT ON work_known_recovery BEGIN\n SELECT CASE WHEN (SELECT count(*) FROM work_known_recovery WHERE work_id=NEW.work_id)>=32\n   OR (SELECT count(*) FROM work_known_recovery WHERE instance_id=NEW.instance_id)>=10000\n   THEN RAISE(ABORT,'work_known_recovery_capacity') END;\nEND;")
      yield* tx.run("CREATE TRIGGER work_known_recovery_immutable_update BEFORE UPDATE ON work_known_recovery BEGIN\n SELECT RAISE(ABORT,'work_known_recovery_immutable');\nEND;")
      yield* tx.run("CREATE TRIGGER work_known_recovery_immutable_delete BEFORE DELETE ON work_known_recovery BEGIN\n SELECT RAISE(ABORT,'work_known_recovery_immutable');\nEND;")
    })
  },
} satisfies DatabaseMigration.Migration
