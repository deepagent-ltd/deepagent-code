import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261008210106_work_storage_cleanup",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`work_storage_cleanup\` (
          \`admission_id\` text PRIMARY KEY,
          \`instance_id\` text NOT NULL,
          \`work_id\` text NOT NULL,
          \`kind\` text NOT NULL,
          \`custody_id\` text NOT NULL,
          \`manifest\` text NOT NULL,
          \`manifest_hash\` text NOT NULL,
          \`manifest_mac\` text NOT NULL,
          \`phase\` text NOT NULL,
          \`revision\` integer NOT NULL,
          \`journal\` text,
          \`journal_hash\` text,
          \`journal_mac\` text,
          \`cleanup_id\` text,
          \`request_hash\` text,
          \`proof\` text,
          \`proof_hash\` text,
          \`proof_mac\` text,
          \`released_bytes\` integer NOT NULL,
          \`created_at\` integer NOT NULL,
          \`updated_at\` integer NOT NULL,
          CONSTRAINT \`fk_work_storage_cleanup_admission_id_session_v2_tool_effect_admission_admission_id_fk\` FOREIGN KEY (\`admission_id\`) REFERENCES \`session_v2_tool_effect_admission\`(\`admission_id\`) ON UPDATE RESTRICT ON DELETE RESTRICT,
          CONSTRAINT \`fk_work_storage_cleanup_work_id_work_execution_work_id_fk\` FOREIGN KEY (\`work_id\`) REFERENCES \`work_execution\`(\`work_id\`) ON UPDATE RESTRICT ON DELETE RESTRICT,
          CONSTRAINT "work_storage_cleanup_admission_id_text" CHECK(typeof("admission_id")='text' AND length(CAST("admission_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("admission_id",char(0))=0),
          CONSTRAINT "work_storage_cleanup_instance_id_text" CHECK(typeof("instance_id")='text' AND length(CAST("instance_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("instance_id",char(0))=0),
          CONSTRAINT "work_storage_cleanup_work_id_text" CHECK(typeof("work_id")='text' AND length(CAST("work_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("work_id",char(0))=0),
          CONSTRAINT "work_storage_cleanup_custody_id_text" CHECK(typeof("custody_id")='text' AND length(CAST("custody_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("custody_id",char(0))=0),
          CONSTRAINT "work_storage_cleanup_manifest_hash_digest" CHECK(typeof("manifest_hash")='text' AND length(CAST("manifest_hash" AS BLOB))=64 AND "manifest_hash" NOT GLOB '*[^0-9a-f]*'),
          CONSTRAINT "work_storage_cleanup_manifest_mac_digest" CHECK(typeof("manifest_mac")='text' AND length(CAST("manifest_mac" AS BLOB))=64 AND "manifest_mac" NOT GLOB '*[^0-9a-f]*'),
          CONSTRAINT "work_storage_cleanup_journal_hash_optional_digest" CHECK("journal_hash" IS NULL OR (typeof("journal_hash")='text' AND length(CAST("journal_hash" AS BLOB))=64 AND "journal_hash" NOT GLOB '*[^0-9a-f]*')),
          CONSTRAINT "work_storage_cleanup_journal_mac_optional_digest" CHECK("journal_mac" IS NULL OR (typeof("journal_mac")='text' AND length(CAST("journal_mac" AS BLOB))=64 AND "journal_mac" NOT GLOB '*[^0-9a-f]*')),
          CONSTRAINT "work_storage_cleanup_request_hash_optional_digest" CHECK("request_hash" IS NULL OR (typeof("request_hash")='text' AND length(CAST("request_hash" AS BLOB))=64 AND "request_hash" NOT GLOB '*[^0-9a-f]*')),
          CONSTRAINT "work_storage_cleanup_proof_hash_optional_digest" CHECK("proof_hash" IS NULL OR (typeof("proof_hash")='text' AND length(CAST("proof_hash" AS BLOB))=64 AND "proof_hash" NOT GLOB '*[^0-9a-f]*')),
          CONSTRAINT "work_storage_cleanup_proof_mac_optional_digest" CHECK("proof_mac" IS NULL OR (typeof("proof_mac")='text' AND length(CAST("proof_mac" AS BLOB))=64 AND "proof_mac" NOT GLOB '*[^0-9a-f]*')),
          CONSTRAINT "work_storage_cleanup_revision_integer" CHECK(typeof("revision")='integer' AND "revision" BETWEEN 1 AND 9007199254740991),
          CONSTRAINT "work_storage_cleanup_created_at_integer" CHECK(typeof("created_at")='integer' AND "created_at" BETWEEN 1 AND 9007199254740991),
          CONSTRAINT "work_storage_cleanup_updated_at_integer" CHECK(typeof("updated_at")='integer' AND "updated_at" BETWEEN 1 AND 9007199254740991),
          CONSTRAINT "work_storage_cleanup_cleanup_id_bound" CHECK("cleanup_id" IS NULL OR (typeof("cleanup_id")='text' AND length(CAST("cleanup_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("cleanup_id",char(0))=0)),
          CONSTRAINT "work_storage_cleanup_release_integer" CHECK(typeof("released_bytes")='integer' AND "released_bytes" BETWEEN 0 AND 9007199254740991 AND "updated_at">="created_at"),
          CONSTRAINT "work_storage_cleanup_manifest_mirror" CHECK(typeof("manifest")='text' AND length(CAST("manifest" AS BLOB)) BETWEEN 1 AND 65536 AND json_valid("manifest")
            AND json_type("manifest",'$.version') IS 'integer' AND json_extract("manifest",'$.version') IS 1
            AND json_type("manifest",'$.admissionID') IS 'text' AND json_extract("manifest",'$.admissionID') IS "admission_id"
            AND json_type("manifest",'$.instanceID') IS 'text' AND json_extract("manifest",'$.instanceID') IS "instance_id"
            AND json_type("manifest",'$.workID') IS 'text' AND json_extract("manifest",'$.workID') IS "work_id"
            AND json_type("manifest",'$.kind') IS 'text' AND json_extract("manifest",'$.kind') IS "kind"
            AND json_type("manifest",'$.custodyID') IS 'text' AND json_extract("manifest",'$.custodyID') IS "custody_id"
            AND json_type("manifest",'$.createdAt') IS 'integer' AND json_extract("manifest",'$.createdAt') IS "created_at"),
          CONSTRAINT "work_storage_cleanup_manifest_admissionID_bound" CHECK(json_type("manifest",'$.admissionID') IS 'text'
              AND length(CAST(json_extract("manifest",'$.admissionID') AS BLOB)) BETWEEN 1 AND 512
              AND instr(json_extract("manifest",'$.admissionID'),char(0))=0),
          CONSTRAINT "work_storage_cleanup_manifest_instanceID_bound" CHECK(json_type("manifest",'$.instanceID') IS 'text'
              AND length(CAST(json_extract("manifest",'$.instanceID') AS BLOB)) BETWEEN 1 AND 512
              AND instr(json_extract("manifest",'$.instanceID'),char(0))=0),
          CONSTRAINT "work_storage_cleanup_manifest_workID_bound" CHECK(json_type("manifest",'$.workID') IS 'text'
              AND length(CAST(json_extract("manifest",'$.workID') AS BLOB)) BETWEEN 1 AND 512
              AND instr(json_extract("manifest",'$.workID'),char(0))=0),
          CONSTRAINT "work_storage_cleanup_manifest_rootWorkID_bound" CHECK(json_type("manifest",'$.rootWorkID') IS 'text'
              AND length(CAST(json_extract("manifest",'$.rootWorkID') AS BLOB)) BETWEEN 1 AND 512
              AND instr(json_extract("manifest",'$.rootWorkID'),char(0))=0),
          CONSTRAINT "work_storage_cleanup_manifest_sessionID_bound" CHECK(json_type("manifest",'$.sessionID') IS 'text'
              AND length(CAST(json_extract("manifest",'$.sessionID') AS BLOB)) BETWEEN 1 AND 512
              AND instr(json_extract("manifest",'$.sessionID'),char(0))=0),
          CONSTRAINT "work_storage_cleanup_manifest_inputID_bound" CHECK(json_type("manifest",'$.inputID') IS 'text'
              AND length(CAST(json_extract("manifest",'$.inputID') AS BLOB)) BETWEEN 1 AND 512
              AND instr(json_extract("manifest",'$.inputID'),char(0))=0),
          CONSTRAINT "work_storage_cleanup_manifest_activityID_bound" CHECK(json_type("manifest",'$.activityID') IS 'text'
              AND length(CAST(json_extract("manifest",'$.activityID') AS BLOB)) BETWEEN 1 AND 512
              AND instr(json_extract("manifest",'$.activityID'),char(0))=0),
          CONSTRAINT "work_storage_cleanup_manifest_providerReceiptID_bound" CHECK(json_type("manifest",'$.providerReceiptID') IS 'text'
              AND length(CAST(json_extract("manifest",'$.providerReceiptID') AS BLOB)) BETWEEN 1 AND 512
              AND instr(json_extract("manifest",'$.providerReceiptID'),char(0))=0),
          CONSTRAINT "work_storage_cleanup_manifest_providerAttemptID_bound" CHECK(json_type("manifest",'$.providerAttemptID') IS 'text'
              AND length(CAST(json_extract("manifest",'$.providerAttemptID') AS BLOB)) BETWEEN 1 AND 512
              AND instr(json_extract("manifest",'$.providerAttemptID'),char(0))=0),
          CONSTRAINT "work_storage_cleanup_manifest_toolCallID_bound" CHECK(json_type("manifest",'$.toolCallID') IS 'text'
              AND length(CAST(json_extract("manifest",'$.toolCallID') AS BLOB)) BETWEEN 1 AND 512
              AND instr(json_extract("manifest",'$.toolCallID'),char(0))=0),
          CONSTRAINT "work_storage_cleanup_manifest_ownerToken_bound" CHECK(json_type("manifest",'$.ownerToken') IS 'text'
              AND length(CAST(json_extract("manifest",'$.ownerToken') AS BLOB)) BETWEEN 1 AND 512
              AND instr(json_extract("manifest",'$.ownerToken'),char(0))=0),
          CONSTRAINT "work_storage_cleanup_manifest_custodyID_bound" CHECK(json_type("manifest",'$.custodyID') IS 'text'
              AND length(CAST(json_extract("manifest",'$.custodyID') AS BLOB)) BETWEEN 1 AND 512
              AND instr(json_extract("manifest",'$.custodyID'),char(0))=0),
          CONSTRAINT "work_storage_cleanup_manifest_createdAt_count" CHECK(json_type("manifest",'$.createdAt') IS 'integer'
              AND json_extract("manifest",'$.createdAt') BETWEEN 1 AND 9007199254740991),
          CONSTRAINT "work_storage_cleanup_manifest_sessionClaimToken_count" CHECK(json_type("manifest",'$.sessionClaimToken') IS 'integer'
              AND json_extract("manifest",'$.sessionClaimToken') BETWEEN 1 AND 9007199254740991),
          CONSTRAINT "work_storage_cleanup_manifest_controlRevision_count" CHECK(json_type("manifest",'$.controlRevision') IS 'integer'
              AND json_extract("manifest",'$.controlRevision') BETWEEN 1 AND 9007199254740991),
          CONSTRAINT "work_storage_cleanup_manifest_inventory" CHECK(json_type("manifest",'$.files') IS 'array' AND json_array_length("manifest",'$.files')<=288
            AND json_type("manifest",'$.directories') IS 'array' AND json_array_length("manifest",'$.directories') BETWEEN 1 AND 4610
            AND json_type("manifest",'$.captureKind') IS 'text' AND json_extract("manifest",'$.captureKind') IN ('native_live','known_empty_legacy')
            AND (json_extract("manifest",'$.captureKind')!='known_empty_legacy' OR ("kind"='write' AND json_array_length("manifest",'$.files')=0))),
          CONSTRAINT "work_storage_cleanup_phase" CHECK("kind" IN ('write','command') AND "phase" IN ('retained','cleanup_pending','cleanup_recovery','cleanup_verified','released')),
          CONSTRAINT "work_storage_cleanup_journal_shape" CHECK(("phase"='retained' AND "journal" IS NULL AND "journal_hash" IS NULL AND "journal_mac" IS NULL AND "cleanup_id" IS NULL AND "request_hash" IS NULL AND "proof" IS NULL AND "proof_hash" IS NULL AND "proof_mac" IS NULL AND "released_bytes"=0)
            OR ("phase"!='retained' AND typeof("journal")='text' AND length(CAST("journal" AS BLOB)) BETWEEN 1 AND 131072 AND json_valid("journal")
              AND "journal_hash" IS NOT NULL AND "journal_mac" IS NOT NULL AND typeof("cleanup_id")='text' AND length(CAST("cleanup_id" AS BLOB)) BETWEEN 1 AND 512 AND "request_hash" IS NOT NULL
              AND json_type("journal",'$.version') IS 'integer' AND json_extract("journal",'$.version') IS 1
              AND json_type("journal",'$.cleanupID') IS 'text' AND json_extract("journal",'$.cleanupID') IS "cleanup_id"
              AND json_type("journal",'$.request.admissionID') IS 'text' AND json_extract("journal",'$.request.admissionID') IS "admission_id"
              AND json_type("journal",'$.requestHash') IS 'text' AND json_extract("journal",'$.requestHash') IS "request_hash"
              AND json_type("journal",'$.manifestHash') IS 'text' AND json_extract("journal",'$.manifestHash') IS "manifest_hash"
              AND json_type("journal",'$.instanceID') IS 'text' AND json_extract("journal",'$.instanceID') IS "instance_id")),
          CONSTRAINT "work_storage_cleanup_proof_shape" CHECK(("phase" IN ('retained','cleanup_pending','cleanup_recovery') AND "proof" IS NULL AND "proof_hash" IS NULL AND "proof_mac" IS NULL AND "released_bytes"=0)
            OR ("phase" IN ('cleanup_verified','released') AND typeof("proof")='text' AND length(CAST("proof" AS BLOB)) BETWEEN 1 AND 16384 AND json_valid("proof") AND "proof_hash" IS NOT NULL AND "proof_mac" IS NOT NULL
              AND json_type("proof",'$.version') IS 'integer' AND json_extract("proof",'$.version') IS 1
              AND json_type("proof",'$.cleanupID') IS 'text' AND json_extract("proof",'$.cleanupID') IS "cleanup_id"
              AND json_type("proof",'$.manifestHash') IS 'text' AND json_extract("proof",'$.manifestHash') IS "manifest_hash"
              AND json_type("proof",'$.state') IS 'text' AND json_extract("proof",'$.state') IS 'empty_verified'))
        );
      `)
      yield* tx.run(`CREATE INDEX \`work_storage_cleanup_instance_idx\` ON \`work_storage_cleanup\` (\`instance_id\`,\`phase\`,\`created_at\`);`)
      yield* tx.run(`CREATE INDEX \`work_storage_cleanup_work_idx\` ON \`work_storage_cleanup\` (\`work_id\`,\`admission_id\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`work_storage_cleanup_command_idx\` ON \`work_storage_cleanup\` (\`cleanup_id\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
