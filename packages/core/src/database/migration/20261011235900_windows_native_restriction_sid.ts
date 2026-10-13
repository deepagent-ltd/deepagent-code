import { Effect } from "effect"
import { sql } from "drizzle-orm"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261011235900_windows_native_restriction_sid",
  up(tx) {
    return Effect.gen(function* () {
      if ((yield* tx.get<{ foreign_keys: number }>("PRAGMA foreign_keys"))?.foreign_keys !== 1 ||
        (yield* tx.get<{ defer_foreign_keys: number }>("PRAGMA defer_foreign_keys"))?.defer_foreign_keys !== 0)
        return yield* Effect.fail(new Error("Windows Native SID custody requires immediate foreign keys"))
      const incoming = yield* tx.all<{ on_delete: string; on_update: string }>(sql`
        SELECT f.on_delete,f.on_update FROM sqlite_master m,pragma_foreign_key_list(m.name) f
        WHERE m.type='table' AND f."table"='work_storage_cleanup'`)
      if (incoming.some((entry) => !["RESTRICT", "NO ACTION"].includes(entry.on_delete) ||
        !["RESTRICT", "NO ACTION"].includes(entry.on_update)))
        return yield* Effect.fail(new Error("Windows Native SID custody refuses mutating incoming references"))
      const retained = yield* tx.all<{ sql: string }>(sql`SELECT sql FROM sqlite_master
        WHERE tbl_name='work_storage_cleanup' AND type IN ('index','trigger') AND sql IS NOT NULL ORDER BY type,name`)
      // Only the restriction SID CHECK expands. Legacy capability-SID bytes and every historical JSON charge,
      // incoming RESTRICT/NO ACTION reference and independent audit object stays.
      yield* tx.run("PRAGMA defer_foreign_keys=ON")
      yield* tx.run(`
        CREATE TABLE \`__new_work_storage_cleanup\` (
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
    AND json_type("manifest",'$.version') IS 'integer'
    AND (json_extract("manifest",'$.version') IS 1 OR (json_extract("manifest",'$.version') IS 2
      AND json_extract("manifest",'$.captureKind') IS 'native_live'
      AND json_type("manifest",'$.target') IS 'text' AND json_extract("manifest",'$.target') IN ('win32-x64','win32-arm64')
      AND (("kind"='command' AND (json_type("manifest",'$.security') IS 'object'
    AND json_type("manifest",'$.security.leaseSetHash') IS 'text' AND length(json_extract("manifest",'$.security.leaseSetHash'))=64
    AND json_extract("manifest",'$.security.leaseSetHash') NOT GLOB '*[^0-9a-f]*'
    AND json_type("manifest",'$.security.appContainerSID') IS 'text' AND length(json_extract("manifest",'$.security.appContainerSID'))<=184
    AND json_extract("manifest",'$.security.appContainerSID') LIKE 'S-1-15-2-%'
    AND json_type("manifest",'$.security.restrictionSID') IS 'text' AND length(json_extract("manifest",'$.security.restrictionSID'))<=184
    AND (json_extract("manifest",'$.security.restrictionSID') LIKE 'S-1-15-3-%' OR
      (substr(json_extract("manifest",'$.security.restrictionSID'),1,9) IS 'S-1-5-21-'
        AND substr(json_extract("manifest",'$.security.restrictionSID'),10) NOT GLOB '*[^0-9-]*' AND
        CASE WHEN json_valid('['||replace(substr(json_extract("manifest",'$.security.restrictionSID'),10),'-',',')||']') THEN
          json_array_length('['||replace(substr(json_extract("manifest",'$.security.restrictionSID'),10),'-',',')||']')=4
          AND json_type('['||replace(substr(json_extract("manifest",'$.security.restrictionSID'),10),'-',',')||']','$[0]') IS 'integer' AND json_extract('['||replace(substr(json_extract("manifest",'$.security.restrictionSID'),10),'-',',')||']','$[0]') BETWEEN 0 AND 4294967295 AND json_type('['||replace(substr(json_extract("manifest",'$.security.restrictionSID'),10),'-',',')||']','$[1]') IS 'integer' AND json_extract('['||replace(substr(json_extract("manifest",'$.security.restrictionSID'),10),'-',',')||']','$[1]') BETWEEN 0 AND 4294967295 AND json_type('['||replace(substr(json_extract("manifest",'$.security.restrictionSID'),10),'-',',')||']','$[2]') IS 'integer' AND json_extract('['||replace(substr(json_extract("manifest",'$.security.restrictionSID'),10),'-',',')||']','$[2]') BETWEEN 0 AND 4294967295 AND json_type('['||replace(substr(json_extract("manifest",'$.security.restrictionSID'),10),'-',',')||']','$[3]') IS 'integer' AND json_extract('['||replace(substr(json_extract("manifest",'$.security.restrictionSID'),10),'-',',')||']','$[3]') BETWEEN 0 AND 4294967295
        ELSE 0 END)))) OR ("kind"='write' AND (json_type("manifest",'$.purpose') IS 'text' AND json_extract("manifest",'$.purpose') IS 'work_write'
    AND json_type("manifest",'$.security') IS NULL AND json_type("manifest",'$.snapshotHash') IS 'null'
    AND json_type("manifest",'$.basename') IS 'text' AND length(json_extract("manifest",'$.basename'))=32
    AND json_extract("manifest",'$.basename') NOT GLOB '*[^0-9a-f]*'
    AND json_type("manifest",'$.files') IS 'array' AND json_type("manifest",'$.stagePhase') IS 'text'
    AND ((json_extract("manifest",'$.stagePhase') IS 'refused_empty' AND json_array_length("manifest",'$.files')=0)
      OR (json_extract("manifest",'$.stagePhase') IN ('prepared_payload','refused_payload') AND json_array_length("manifest",'$.files')=1
        AND json_extract("manifest",'$.files[0].relative') IS 'payload' AND json_type("manifest",'$.files[0].retainedUnlinked') IS 'false'
        AND (json_type("manifest",'$.files[0].identity') IS 'object'
    AND json_type("manifest",'$.files[0].identity.kind') IS 'text' AND json_extract("manifest",'$.files[0].identity.kind') IS 'windows'
    AND json_type("manifest",'$.files[0].identity.volumeSerial') IS 'text'
    AND length(json_extract("manifest",'$.files[0].identity.volumeSerial'))=16 AND json_extract("manifest",'$.files[0].identity.volumeSerial') NOT GLOB '*[^0-9a-f]*'
    AND json_type("manifest",'$.files[0].identity.fileID') IS 'text'
    AND length(json_extract("manifest",'$.files[0].identity.fileID'))=32 AND json_extract("manifest",'$.files[0].identity.fileID') NOT GLOB '*[^0-9a-f]*')
        AND json_type("manifest",'$.files[0].sha256') IS 'text' AND length(json_extract("manifest",'$.files[0].sha256'))=64
        AND json_extract("manifest",'$.files[0].sha256') NOT GLOB '*[^0-9a-f]*'
        AND json_type("manifest",'$.files[0].bytes') IS 'integer' AND json_extract("manifest",'$.files[0].bytes') BETWEEN 0 AND 51200
        AND json_extract("manifest",'$.files[0].identity.volumeSerial') IS json_extract("manifest",'$.projectIdentity.volumeSerial')))
    AND json_type("manifest",'$.directories') IS 'array' AND json_array_length("manifest",'$.directories')=1
    AND json_extract("manifest",'$.directories[0].relative') IS ''
    AND (json_type("manifest",'$.directories[0].identity') IS 'object'
    AND json_type("manifest",'$.directories[0].identity.kind') IS 'text' AND json_extract("manifest",'$.directories[0].identity.kind') IS 'windows'
    AND json_type("manifest",'$.directories[0].identity.volumeSerial') IS 'text'
    AND length(json_extract("manifest",'$.directories[0].identity.volumeSerial'))=16 AND json_extract("manifest",'$.directories[0].identity.volumeSerial') NOT GLOB '*[^0-9a-f]*'
    AND json_type("manifest",'$.directories[0].identity.fileID') IS 'text'
    AND length(json_extract("manifest",'$.directories[0].identity.fileID'))=32 AND json_extract("manifest",'$.directories[0].identity.fileID') NOT GLOB '*[^0-9a-f]*')
    AND json_extract("manifest",'$.directories[0].identity.fileID') IS json_extract("manifest",'$.containerIdentity.fileID')
    AND json_extract("manifest",'$.dataIdentity.volumeSerial') IS json_extract("manifest",'$.projectIdentity.volumeSerial') AND json_extract("manifest",'$.baseIdentity.volumeSerial') IS json_extract("manifest",'$.projectIdentity.volumeSerial') AND json_extract("manifest",'$.containerIdentity.volumeSerial') IS json_extract("manifest",'$.projectIdentity.volumeSerial') AND json_extract("manifest",'$.directories[0].identity.volumeSerial') IS json_extract("manifest",'$.projectIdentity.volumeSerial'))))
      AND (json_type("manifest",'$.projectIdentity') IS 'object'
    AND json_type("manifest",'$.projectIdentity.kind') IS 'text' AND json_extract("manifest",'$.projectIdentity.kind') IS 'windows'
    AND json_type("manifest",'$.projectIdentity.volumeSerial') IS 'text'
    AND length(json_extract("manifest",'$.projectIdentity.volumeSerial'))=16 AND json_extract("manifest",'$.projectIdentity.volumeSerial') NOT GLOB '*[^0-9a-f]*'
    AND json_type("manifest",'$.projectIdentity.fileID') IS 'text'
    AND length(json_extract("manifest",'$.projectIdentity.fileID'))=32 AND json_extract("manifest",'$.projectIdentity.fileID') NOT GLOB '*[^0-9a-f]*') AND (json_type("manifest",'$.dataIdentity') IS 'object'
    AND json_type("manifest",'$.dataIdentity.kind') IS 'text' AND json_extract("manifest",'$.dataIdentity.kind') IS 'windows'
    AND json_type("manifest",'$.dataIdentity.volumeSerial') IS 'text'
    AND length(json_extract("manifest",'$.dataIdentity.volumeSerial'))=16 AND json_extract("manifest",'$.dataIdentity.volumeSerial') NOT GLOB '*[^0-9a-f]*'
    AND json_type("manifest",'$.dataIdentity.fileID') IS 'text'
    AND length(json_extract("manifest",'$.dataIdentity.fileID'))=32 AND json_extract("manifest",'$.dataIdentity.fileID') NOT GLOB '*[^0-9a-f]*') AND (json_type("manifest",'$.baseIdentity') IS 'object'
    AND json_type("manifest",'$.baseIdentity.kind') IS 'text' AND json_extract("manifest",'$.baseIdentity.kind') IS 'windows'
    AND json_type("manifest",'$.baseIdentity.volumeSerial') IS 'text'
    AND length(json_extract("manifest",'$.baseIdentity.volumeSerial'))=16 AND json_extract("manifest",'$.baseIdentity.volumeSerial') NOT GLOB '*[^0-9a-f]*'
    AND json_type("manifest",'$.baseIdentity.fileID') IS 'text'
    AND length(json_extract("manifest",'$.baseIdentity.fileID'))=32 AND json_extract("manifest",'$.baseIdentity.fileID') NOT GLOB '*[^0-9a-f]*') AND (json_type("manifest",'$.containerIdentity') IS 'object'
    AND json_type("manifest",'$.containerIdentity.kind') IS 'text' AND json_extract("manifest",'$.containerIdentity.kind') IS 'windows'
    AND json_type("manifest",'$.containerIdentity.volumeSerial') IS 'text'
    AND length(json_extract("manifest",'$.containerIdentity.volumeSerial'))=16 AND json_extract("manifest",'$.containerIdentity.volumeSerial') NOT GLOB '*[^0-9a-f]*'
    AND json_type("manifest",'$.containerIdentity.fileID') IS 'text'
    AND length(json_extract("manifest",'$.containerIdentity.fileID'))=32 AND json_extract("manifest",'$.containerIdentity.fileID') NOT GLOB '*[^0-9a-f]*')))
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
      AND json_type("journal",'$.version') IS 'integer' AND json_extract("journal",'$.version') IS json_extract("manifest",'$.version')
      AND (json_extract("manifest",'$.version') IS 1 OR (json_type("journal",'$.target') IS 'text' AND json_extract("journal",'$.target') IS json_extract("manifest",'$.target')
    AND ((json_extract("manifest",'$.kind') IS 'write' AND json_extract("manifest",'$.purpose') IS 'work_write'
      AND json_type("journal",'$.purpose') IS 'text' AND json_extract("journal",'$.purpose') IS 'work_write'
      AND json_type("journal",'$.security') IS NULL) OR (json_extract("manifest",'$.kind') IS 'command'
      AND (json_type("journal",'$.security') IS 'object'
    AND json_type("journal",'$.security.leaseSetHash') IS 'text' AND length(json_extract("journal",'$.security.leaseSetHash'))=64
    AND json_extract("journal",'$.security.leaseSetHash') NOT GLOB '*[^0-9a-f]*'
    AND json_type("journal",'$.security.appContainerSID') IS 'text' AND length(json_extract("journal",'$.security.appContainerSID'))<=184
    AND json_extract("journal",'$.security.appContainerSID') LIKE 'S-1-15-2-%'
    AND json_type("journal",'$.security.restrictionSID') IS 'text' AND length(json_extract("journal",'$.security.restrictionSID'))<=184
    AND (json_extract("journal",'$.security.restrictionSID') LIKE 'S-1-15-3-%' OR
      (substr(json_extract("journal",'$.security.restrictionSID'),1,9) IS 'S-1-5-21-'
        AND substr(json_extract("journal",'$.security.restrictionSID'),10) NOT GLOB '*[^0-9-]*' AND
        CASE WHEN json_valid('['||replace(substr(json_extract("journal",'$.security.restrictionSID'),10),'-',',')||']') THEN
          json_array_length('['||replace(substr(json_extract("journal",'$.security.restrictionSID'),10),'-',',')||']')=4
          AND json_type('['||replace(substr(json_extract("journal",'$.security.restrictionSID'),10),'-',',')||']','$[0]') IS 'integer' AND json_extract('['||replace(substr(json_extract("journal",'$.security.restrictionSID'),10),'-',',')||']','$[0]') BETWEEN 0 AND 4294967295 AND json_type('['||replace(substr(json_extract("journal",'$.security.restrictionSID'),10),'-',',')||']','$[1]') IS 'integer' AND json_extract('['||replace(substr(json_extract("journal",'$.security.restrictionSID'),10),'-',',')||']','$[1]') BETWEEN 0 AND 4294967295 AND json_type('['||replace(substr(json_extract("journal",'$.security.restrictionSID'),10),'-',',')||']','$[2]') IS 'integer' AND json_extract('['||replace(substr(json_extract("journal",'$.security.restrictionSID'),10),'-',',')||']','$[2]') BETWEEN 0 AND 4294967295 AND json_type('['||replace(substr(json_extract("journal",'$.security.restrictionSID'),10),'-',',')||']','$[3]') IS 'integer' AND json_extract('['||replace(substr(json_extract("journal",'$.security.restrictionSID'),10),'-',',')||']','$[3]') BETWEEN 0 AND 4294967295
        ELSE 0 END))) AND json_extract("journal",'$.security.leaseSetHash') IS json_extract("manifest",'$.security.leaseSetHash') AND json_extract("journal",'$.security.appContainerSID') IS json_extract("manifest",'$.security.appContainerSID') AND json_extract("journal",'$.security.restrictionSID') IS json_extract("manifest",'$.security.restrictionSID')))))
      AND json_type("journal",'$.cleanupID') IS 'text' AND json_extract("journal",'$.cleanupID') IS "cleanup_id"
      AND json_type("journal",'$.request.admissionID') IS 'text' AND json_extract("journal",'$.request.admissionID') IS "admission_id"
      AND json_type("journal",'$.requestHash') IS 'text' AND json_extract("journal",'$.requestHash') IS "request_hash"
      AND json_type("journal",'$.manifestHash') IS 'text' AND json_extract("journal",'$.manifestHash') IS "manifest_hash"
      AND json_type("journal",'$.instanceID') IS 'text' AND json_extract("journal",'$.instanceID') IS "instance_id")),
          CONSTRAINT "work_storage_cleanup_proof_shape" CHECK(("phase" IN ('retained','cleanup_pending','cleanup_recovery') AND "proof" IS NULL AND "proof_hash" IS NULL AND "proof_mac" IS NULL AND "released_bytes"=0)
    OR ("phase" IN ('cleanup_verified','released') AND typeof("proof")='text' AND length(CAST("proof" AS BLOB)) BETWEEN 1 AND 16384 AND json_valid("proof") AND "proof_hash" IS NOT NULL AND "proof_mac" IS NOT NULL
      AND json_type("proof",'$.version') IS 'integer' AND json_extract("proof",'$.version') IS json_extract("manifest",'$.version')
      AND (json_extract("manifest",'$.version') IS 1 OR ((json_type("proof",'$.target') IS 'text' AND json_extract("proof",'$.target') IS json_extract("manifest",'$.target')
    AND ((json_extract("manifest",'$.kind') IS 'write' AND json_extract("manifest",'$.purpose') IS 'work_write'
      AND json_type("proof",'$.purpose') IS 'text' AND json_extract("proof",'$.purpose') IS 'work_write'
      AND json_type("proof",'$.security') IS NULL) OR (json_extract("manifest",'$.kind') IS 'command'
      AND (json_type("proof",'$.security') IS 'object'
    AND json_type("proof",'$.security.leaseSetHash') IS 'text' AND length(json_extract("proof",'$.security.leaseSetHash'))=64
    AND json_extract("proof",'$.security.leaseSetHash') NOT GLOB '*[^0-9a-f]*'
    AND json_type("proof",'$.security.appContainerSID') IS 'text' AND length(json_extract("proof",'$.security.appContainerSID'))<=184
    AND json_extract("proof",'$.security.appContainerSID') LIKE 'S-1-15-2-%'
    AND json_type("proof",'$.security.restrictionSID') IS 'text' AND length(json_extract("proof",'$.security.restrictionSID'))<=184
    AND (json_extract("proof",'$.security.restrictionSID') LIKE 'S-1-15-3-%' OR
      (substr(json_extract("proof",'$.security.restrictionSID'),1,9) IS 'S-1-5-21-'
        AND substr(json_extract("proof",'$.security.restrictionSID'),10) NOT GLOB '*[^0-9-]*' AND
        CASE WHEN json_valid('['||replace(substr(json_extract("proof",'$.security.restrictionSID'),10),'-',',')||']') THEN
          json_array_length('['||replace(substr(json_extract("proof",'$.security.restrictionSID'),10),'-',',')||']')=4
          AND json_type('['||replace(substr(json_extract("proof",'$.security.restrictionSID'),10),'-',',')||']','$[0]') IS 'integer' AND json_extract('['||replace(substr(json_extract("proof",'$.security.restrictionSID'),10),'-',',')||']','$[0]') BETWEEN 0 AND 4294967295 AND json_type('['||replace(substr(json_extract("proof",'$.security.restrictionSID'),10),'-',',')||']','$[1]') IS 'integer' AND json_extract('['||replace(substr(json_extract("proof",'$.security.restrictionSID'),10),'-',',')||']','$[1]') BETWEEN 0 AND 4294967295 AND json_type('['||replace(substr(json_extract("proof",'$.security.restrictionSID'),10),'-',',')||']','$[2]') IS 'integer' AND json_extract('['||replace(substr(json_extract("proof",'$.security.restrictionSID'),10),'-',',')||']','$[2]') BETWEEN 0 AND 4294967295 AND json_type('['||replace(substr(json_extract("proof",'$.security.restrictionSID'),10),'-',',')||']','$[3]') IS 'integer' AND json_extract('['||replace(substr(json_extract("proof",'$.security.restrictionSID'),10),'-',',')||']','$[3]') BETWEEN 0 AND 4294967295
        ELSE 0 END))) AND json_extract("proof",'$.security.leaseSetHash') IS json_extract("manifest",'$.security.leaseSetHash') AND json_extract("proof",'$.security.appContainerSID') IS json_extract("manifest",'$.security.appContainerSID') AND json_extract("proof",'$.security.restrictionSID') IS json_extract("manifest",'$.security.restrictionSID'))))
        AND (json_type("proof",'$.dataIdentity') IS 'object'
    AND json_type("proof",'$.dataIdentity.kind') IS 'text' AND json_extract("proof",'$.dataIdentity.kind') IS 'windows'
    AND json_type("proof",'$.dataIdentity.volumeSerial') IS 'text'
    AND length(json_extract("proof",'$.dataIdentity.volumeSerial'))=16 AND json_extract("proof",'$.dataIdentity.volumeSerial') NOT GLOB '*[^0-9a-f]*'
    AND json_type("proof",'$.dataIdentity.fileID') IS 'text'
    AND length(json_extract("proof",'$.dataIdentity.fileID'))=32 AND json_extract("proof",'$.dataIdentity.fileID') NOT GLOB '*[^0-9a-f]*') AND (json_type("proof",'$.baseIdentity') IS 'object'
    AND json_type("proof",'$.baseIdentity.kind') IS 'text' AND json_extract("proof",'$.baseIdentity.kind') IS 'windows'
    AND json_type("proof",'$.baseIdentity.volumeSerial') IS 'text'
    AND length(json_extract("proof",'$.baseIdentity.volumeSerial'))=16 AND json_extract("proof",'$.baseIdentity.volumeSerial') NOT GLOB '*[^0-9a-f]*'
    AND json_type("proof",'$.baseIdentity.fileID') IS 'text'
    AND length(json_extract("proof",'$.baseIdentity.fileID'))=32 AND json_extract("proof",'$.baseIdentity.fileID') NOT GLOB '*[^0-9a-f]*') AND (json_type("proof",'$.containerIdentity') IS 'object'
    AND json_type("proof",'$.containerIdentity.kind') IS 'text' AND json_extract("proof",'$.containerIdentity.kind') IS 'windows'
    AND json_type("proof",'$.containerIdentity.volumeSerial') IS 'text'
    AND length(json_extract("proof",'$.containerIdentity.volumeSerial'))=16 AND json_extract("proof",'$.containerIdentity.volumeSerial') NOT GLOB '*[^0-9a-f]*'
    AND json_type("proof",'$.containerIdentity.fileID') IS 'text'
    AND length(json_extract("proof",'$.containerIdentity.fileID'))=32 AND json_extract("proof",'$.containerIdentity.fileID') NOT GLOB '*[^0-9a-f]*')
        AND (("kind"='write' AND json_type("proof",'$.originalStageRemoved') IS 'true'
          AND json_type("proof",'$.retainedHandlesClosed') IS 'true') OR ("kind"='command'
          AND json_type("proof",'$.aclRestoreHash') IS 'text' AND length(json_extract("proof",'$.aclRestoreHash'))=64
          AND json_extract("proof",'$.aclRestoreHash') NOT GLOB '*[^0-9a-f]*'
          AND json_type("proof",'$.jobRetired') IS 'true' AND json_type("proof",'$.appContainerRetired') IS 'true'
          AND json_type("proof",'$.aclRestored') IS 'true'))))
      AND json_type("proof",'$.cleanupID') IS 'text' AND json_extract("proof",'$.cleanupID') IS "cleanup_id"
      AND json_type("proof",'$.manifestHash') IS 'text' AND json_extract("proof",'$.manifestHash') IS "manifest_hash"
      AND json_type("proof",'$.state') IS 'text' AND json_extract("proof",'$.state') IS 'empty_verified'))
        );
      `)
      yield* tx.run(`INSERT INTO \`__new_work_storage_cleanup\` SELECT * FROM \`work_storage_cleanup\``)
      yield* tx.run(`DROP TABLE \`work_storage_cleanup\``)
      yield* tx.run(`ALTER TABLE \`__new_work_storage_cleanup\` RENAME TO \`work_storage_cleanup\``)
      yield* Effect.forEach(retained, (entry) => tx.run(entry.sql), { discard: true })
      if ((yield* tx.all("PRAGMA foreign_key_check")).length)
        return yield* Effect.fail(new Error("Windows Native SID custody changed foreign key integrity"))
      yield* tx.run("PRAGMA defer_foreign_keys=OFF")
    })
  },
} satisfies DatabaseMigration.Migration
