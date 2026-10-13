import { sql } from "drizzle-orm"
import type { SQLWrapper } from "drizzle-orm"
import { check, foreignKey, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { WorkExecutionTable } from "./work-authority.sql"
import { V2ToolEffectAdmissionTable } from "./runner/v2-tool-effect.sql"
import { WorkWindowsIdentitySql } from "./work-windows-identity.sql"

/** An attested private-object manifest and its explicit cleanup journal. This is not an
 * execution grant or a second storage budget; the original custody meters remain authoritative. */
export const WorkStorageCleanupTable = sqliteTable("work_storage_cleanup", {
  admission_id: text().primaryKey().notNull(),
  instance_id: text().notNull(), work_id: text().notNull(), kind: text().$type<"write" | "command">().notNull(),
  custody_id: text().notNull(), manifest: text().notNull(), manifest_hash: text().notNull(), manifest_mac: text().notNull(),
  phase: text().$type<"retained" | "cleanup_pending" | "cleanup_recovery" | "cleanup_verified" | "released">().notNull(),
  revision: integer().notNull(), journal: text(), journal_hash: text(), journal_mac: text(),
  cleanup_id: text(), request_hash: text(), proof: text(), proof_hash: text(), proof_mac: text(),
  released_bytes: integer().notNull(), created_at: integer().notNull(), updated_at: integer().notNull(),
}, (table) => [
  index("work_storage_cleanup_instance_idx").on(table.instance_id, table.phase, table.created_at),
  index("work_storage_cleanup_work_idx").on(table.work_id, table.admission_id),
  uniqueIndex("work_storage_cleanup_command_idx").on(table.cleanup_id),
  foreignKey({ columns: [table.admission_id], foreignColumns: [V2ToolEffectAdmissionTable.admission_id] }).onDelete("restrict").onUpdate("restrict"),
  foreignKey({ columns: [table.work_id], foreignColumns: [WorkExecutionTable.work_id] }).onDelete("restrict").onUpdate("restrict"),
  ...[table.admission_id, table.instance_id, table.work_id, table.custody_id].map((column) => check(`work_storage_cleanup_${column.name}_text`,
    sql`typeof(${column})='text' AND length(CAST(${column} AS BLOB)) BETWEEN 1 AND 512 AND instr(${column},char(0))=0`)),
  ...[table.manifest_hash, table.manifest_mac].map((column) => check(`work_storage_cleanup_${column.name}_digest`,
    sql`typeof(${column})='text' AND length(CAST(${column} AS BLOB))=64 AND ${column} NOT GLOB '*[^0-9a-f]*'`)),
  ...[table.journal_hash, table.journal_mac, table.request_hash, table.proof_hash, table.proof_mac].map((column) => check(`work_storage_cleanup_${column.name}_optional_digest`,
    sql`${column} IS NULL OR (typeof(${column})='text' AND length(CAST(${column} AS BLOB))=64 AND ${column} NOT GLOB '*[^0-9a-f]*')`)),
  ...[table.revision, table.created_at, table.updated_at].map((column) => check(`work_storage_cleanup_${column.name}_integer`,
    sql`typeof(${column})='integer' AND ${column} BETWEEN 1 AND 9007199254740991`)),
  check("work_storage_cleanup_cleanup_id_bound", sql`${table.cleanup_id} IS NULL OR (typeof(${table.cleanup_id})='text' AND length(CAST(${table.cleanup_id} AS BLOB)) BETWEEN 1 AND 512 AND instr(${table.cleanup_id},char(0))=0)`),
  check("work_storage_cleanup_release_integer", sql`typeof(${table.released_bytes})='integer' AND ${table.released_bytes} BETWEEN 0 AND 9007199254740991 AND ${table.updated_at}>=${table.created_at}`),
  check("work_storage_cleanup_manifest_mirror", sql`typeof(${table.manifest})='text' AND length(CAST(${table.manifest} AS BLOB)) BETWEEN 1 AND 65536 AND json_valid(${table.manifest})
    AND json_type(${table.manifest},'$.version') IS 'integer'
    AND (json_extract(${table.manifest},'$.version') IS 1 OR (json_extract(${table.manifest},'$.version') IS 2
      AND json_extract(${table.manifest},'$.captureKind') IS 'native_live'
      AND json_type(${table.manifest},'$.target') IS 'text' AND json_extract(${table.manifest},'$.target') IN ('win32-x64','win32-arm64')
      AND ((${table.kind}='command' AND ${windowsSecurity(table.manifest)}) OR (${table.kind}='write' AND ${windowsWrite(table.manifest)}))
      AND ${sql.join(["projectIdentity", "dataIdentity", "baseIdentity", "containerIdentity"].map((key) =>
        WorkWindowsIdentitySql.check(table.manifest, `$.${key}`)), sql` AND `)}))
    AND json_type(${table.manifest},'$.admissionID') IS 'text' AND json_extract(${table.manifest},'$.admissionID') IS ${table.admission_id}
    AND json_type(${table.manifest},'$.instanceID') IS 'text' AND json_extract(${table.manifest},'$.instanceID') IS ${table.instance_id}
    AND json_type(${table.manifest},'$.workID') IS 'text' AND json_extract(${table.manifest},'$.workID') IS ${table.work_id}
    AND json_type(${table.manifest},'$.kind') IS 'text' AND json_extract(${table.manifest},'$.kind') IS ${table.kind}
    AND json_type(${table.manifest},'$.custodyID') IS 'text' AND json_extract(${table.manifest},'$.custodyID') IS ${table.custody_id}
    AND json_type(${table.manifest},'$.createdAt') IS 'integer' AND json_extract(${table.manifest},'$.createdAt') IS ${table.created_at}`),
  ...["admissionID", "instanceID", "workID", "rootWorkID", "sessionID", "inputID", "activityID", "providerReceiptID",
    "providerAttemptID", "toolCallID", "ownerToken", "custodyID"].map((key) => {
    const location = sql.raw(`'$.${key}'`)
    return check(`work_storage_cleanup_manifest_${key}_bound`, sql`json_type(${table.manifest},${location}) IS 'text'
      AND length(CAST(json_extract(${table.manifest},${location}) AS BLOB)) BETWEEN 1 AND 512
      AND instr(json_extract(${table.manifest},${location}),char(0))=0`)
  }),
  ...["createdAt", "sessionClaimToken", "controlRevision"].map((key) => {
    const location = sql.raw(`'$.${key}'`)
    return check(`work_storage_cleanup_manifest_${key}_count`, sql`json_type(${table.manifest},${location}) IS 'integer'
      AND json_extract(${table.manifest},${location}) BETWEEN 1 AND 9007199254740991`)
  }),
  check("work_storage_cleanup_manifest_inventory", sql`json_type(${table.manifest},'$.files') IS 'array' AND json_array_length(${table.manifest},'$.files')<=288
    AND json_type(${table.manifest},'$.directories') IS 'array' AND json_array_length(${table.manifest},'$.directories') BETWEEN 1 AND 4610
    AND json_type(${table.manifest},'$.captureKind') IS 'text' AND json_extract(${table.manifest},'$.captureKind') IN ('native_live','known_empty_legacy')
    AND (json_extract(${table.manifest},'$.captureKind')!='known_empty_legacy' OR (${table.kind}='write' AND json_array_length(${table.manifest},'$.files')=0))`),
  check("work_storage_cleanup_phase", sql`${table.kind} IN ('write','command') AND ${table.phase} IN ('retained','cleanup_pending','cleanup_recovery','cleanup_verified','released')`),
  check("work_storage_cleanup_journal_shape", sql`(${table.phase}='retained' AND ${table.journal} IS NULL AND ${table.journal_hash} IS NULL AND ${table.journal_mac} IS NULL AND ${table.cleanup_id} IS NULL AND ${table.request_hash} IS NULL AND ${table.proof} IS NULL AND ${table.proof_hash} IS NULL AND ${table.proof_mac} IS NULL AND ${table.released_bytes}=0)
    OR (${table.phase}!='retained' AND typeof(${table.journal})='text' AND length(CAST(${table.journal} AS BLOB)) BETWEEN 1 AND 131072 AND json_valid(${table.journal})
      AND ${table.journal_hash} IS NOT NULL AND ${table.journal_mac} IS NOT NULL AND typeof(${table.cleanup_id})='text' AND length(CAST(${table.cleanup_id} AS BLOB)) BETWEEN 1 AND 512 AND ${table.request_hash} IS NOT NULL
      AND json_type(${table.journal},'$.version') IS 'integer' AND json_extract(${table.journal},'$.version') IS json_extract(${table.manifest},'$.version')
      AND (json_extract(${table.manifest},'$.version') IS 1 OR ${sameWindowsContract(table.journal, table.manifest)})
      AND json_type(${table.journal},'$.cleanupID') IS 'text' AND json_extract(${table.journal},'$.cleanupID') IS ${table.cleanup_id}
      AND json_type(${table.journal},'$.request.admissionID') IS 'text' AND json_extract(${table.journal},'$.request.admissionID') IS ${table.admission_id}
      AND json_type(${table.journal},'$.requestHash') IS 'text' AND json_extract(${table.journal},'$.requestHash') IS ${table.request_hash}
      AND json_type(${table.journal},'$.manifestHash') IS 'text' AND json_extract(${table.journal},'$.manifestHash') IS ${table.manifest_hash}
      AND json_type(${table.journal},'$.instanceID') IS 'text' AND json_extract(${table.journal},'$.instanceID') IS ${table.instance_id})`),
  check("work_storage_cleanup_proof_shape", sql`(${table.phase} IN ('retained','cleanup_pending','cleanup_recovery') AND ${table.proof} IS NULL AND ${table.proof_hash} IS NULL AND ${table.proof_mac} IS NULL AND ${table.released_bytes}=0)
    OR (${table.phase} IN ('cleanup_verified','released') AND typeof(${table.proof})='text' AND length(CAST(${table.proof} AS BLOB)) BETWEEN 1 AND 16384 AND json_valid(${table.proof}) AND ${table.proof_hash} IS NOT NULL AND ${table.proof_mac} IS NOT NULL
      AND json_type(${table.proof},'$.version') IS 'integer' AND json_extract(${table.proof},'$.version') IS json_extract(${table.manifest},'$.version')
      AND (json_extract(${table.manifest},'$.version') IS 1 OR (${sameWindowsContract(table.proof, table.manifest)}
        AND ${sql.join(["dataIdentity", "baseIdentity", "containerIdentity"].map((key) => WorkWindowsIdentitySql.check(table.proof, `$.${key}`)), sql` AND `)}
        AND ((${table.kind}='write' AND json_type(${table.proof},'$.originalStageRemoved') IS 'true'
          AND json_type(${table.proof},'$.retainedHandlesClosed') IS 'true') OR (${table.kind}='command'
          AND json_type(${table.proof},'$.aclRestoreHash') IS 'text' AND length(json_extract(${table.proof},'$.aclRestoreHash'))=64
          AND json_extract(${table.proof},'$.aclRestoreHash') NOT GLOB '*[^0-9a-f]*'
          AND json_type(${table.proof},'$.jobRetired') IS 'true' AND json_type(${table.proof},'$.appContainerRetired') IS 'true'
          AND json_type(${table.proof},'$.aclRestored') IS 'true'))))
      AND json_type(${table.proof},'$.cleanupID') IS 'text' AND json_extract(${table.proof},'$.cleanupID') IS ${table.cleanup_id}
      AND json_type(${table.proof},'$.manifestHash') IS 'text' AND json_extract(${table.proof},'$.manifestHash') IS ${table.manifest_hash}
      AND json_type(${table.proof},'$.state') IS 'text' AND json_extract(${table.proof},'$.state') IS 'empty_verified')`),
])

function windowsSecurity(record: SQLWrapper) {
  return sql`(json_type(${record},'$.security') IS 'object'
    AND json_type(${record},'$.security.leaseSetHash') IS 'text' AND length(json_extract(${record},'$.security.leaseSetHash'))=64
    AND json_extract(${record},'$.security.leaseSetHash') NOT GLOB '*[^0-9a-f]*'
    AND json_type(${record},'$.security.appContainerSID') IS 'text' AND length(json_extract(${record},'$.security.appContainerSID'))<=184
    AND json_extract(${record},'$.security.appContainerSID') LIKE 'S-1-15-2-%'
    AND json_type(${record},'$.security.restrictionSID') IS 'text' AND length(json_extract(${record},'$.security.restrictionSID'))<=184
    AND (json_extract(${record},'$.security.restrictionSID') LIKE 'S-1-15-3-%' OR
      (substr(json_extract(${record},'$.security.restrictionSID'),1,9) IS 'S-1-5-21-'
        AND substr(json_extract(${record},'$.security.restrictionSID'),10) NOT GLOB '*[^0-9-]*' AND
        CASE WHEN json_valid('['||replace(substr(json_extract(${record},'$.security.restrictionSID'),10),'-',',')||']') THEN
          json_array_length('['||replace(substr(json_extract(${record},'$.security.restrictionSID'),10),'-',',')||']')=4
          AND ${sql.join([0, 1, 2, 3].map((index) => sql`
            json_type('['||replace(substr(json_extract(${record},'$.security.restrictionSID'),10),'-',',')||']',${sql.raw(`'$[${index}]'`)}) IS 'integer'
            AND json_extract('['||replace(substr(json_extract(${record},'$.security.restrictionSID'),10),'-',',')||']',${sql.raw(`'$[${index}]'`)}) BETWEEN 0 AND 4294967295`), sql` AND `)}
        ELSE 0 END)))`
}
function sameWindowsContract(record: SQLWrapper, manifest: SQLWrapper) {
  return sql`(json_type(${record},'$.target') IS 'text' AND json_extract(${record},'$.target') IS json_extract(${manifest},'$.target')
    AND ((json_extract(${manifest},'$.kind') IS 'write' AND json_extract(${manifest},'$.purpose') IS 'work_write'
      AND json_type(${record},'$.purpose') IS 'text' AND json_extract(${record},'$.purpose') IS 'work_write'
      AND json_type(${record},'$.security') IS NULL) OR (json_extract(${manifest},'$.kind') IS 'command'
      AND ${windowsSecurity(record)} AND ${sql.join(["leaseSetHash", "appContainerSID", "restrictionSID"].map((key) =>
        sql`json_extract(${record},${sql.raw(`'$.security.${key}'`)}) IS json_extract(${manifest},${sql.raw(`'$.security.${key}'`)})`), sql` AND `)})))`
}

function windowsWrite(record: SQLWrapper) {
  return sql`(json_type(${record},'$.purpose') IS 'text' AND json_extract(${record},'$.purpose') IS 'work_write'
    AND json_type(${record},'$.security') IS NULL AND json_type(${record},'$.snapshotHash') IS 'null'
    AND json_type(${record},'$.basename') IS 'text' AND length(json_extract(${record},'$.basename'))=32
    AND json_extract(${record},'$.basename') NOT GLOB '*[^0-9a-f]*'
    AND json_type(${record},'$.files') IS 'array' AND json_type(${record},'$.stagePhase') IS 'text'
    AND ((json_extract(${record},'$.stagePhase') IS 'refused_empty' AND json_array_length(${record},'$.files')=0)
      OR (json_extract(${record},'$.stagePhase') IN ('prepared_payload','refused_payload') AND json_array_length(${record},'$.files')=1
        AND json_extract(${record},'$.files[0].relative') IS 'payload' AND json_type(${record},'$.files[0].retainedUnlinked') IS 'false'
        AND ${WorkWindowsIdentitySql.check(record, "$.files[0].identity")}
        AND json_type(${record},'$.files[0].sha256') IS 'text' AND length(json_extract(${record},'$.files[0].sha256'))=64
        AND json_extract(${record},'$.files[0].sha256') NOT GLOB '*[^0-9a-f]*'
        AND json_type(${record},'$.files[0].bytes') IS 'integer' AND json_extract(${record},'$.files[0].bytes') BETWEEN 0 AND 51200
        AND json_extract(${record},'$.files[0].identity.volumeSerial') IS json_extract(${record},'$.projectIdentity.volumeSerial')))
    AND json_type(${record},'$.directories') IS 'array' AND json_array_length(${record},'$.directories')=1
    AND json_extract(${record},'$.directories[0].relative') IS ''
    AND ${WorkWindowsIdentitySql.check(record, "$.directories[0].identity")}
    AND json_extract(${record},'$.directories[0].identity.fileID') IS json_extract(${record},'$.containerIdentity.fileID')
    AND ${sql.join(["dataIdentity", "baseIdentity", "containerIdentity", "directories[0].identity"].map((key) =>
      sql`json_extract(${record},${sql.raw(`'$.${key}.volumeSerial'`)}) IS json_extract(${record},'$.projectIdentity.volumeSerial')`), sql` AND `)})`
}
