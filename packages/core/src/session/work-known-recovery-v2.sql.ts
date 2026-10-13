import { sql } from "drizzle-orm"
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"

// Recovery receipts survive Session/operator deletion and never cascade away
// an exact request identity or authorize a second release of a successor claim.
export const WorkKnownRecoveryV2Table = sqliteTable(
  "work_known_recovery_v2",
  {
    recovery_id: text().primaryKey().notNull(),
    version: integer().notNull(),
    instance_id: text().notNull(),
    operator_id: text().notNull(),
    work_id: text().notNull(),
    root_work_id: text().notNull(),
    session_id: text().notNull(),
    input_id: text().notNull(),
    request_id: text().notNull(),
    action: text().$type<"recover_only" | "recover_and_resume">().notNull(),
    old_claim_token: integer().notNull(),
    control_revision: integer().notNull(),
    operator_revision: integer().notNull(),
    source_revision: integer().notNull(),
    approval_revision: integer().notNull(),
    binding_hash: text().notNull(),
    request_hash: text().notNull(),
    evidence_hash: text().notNull(),
    record_hash: text().notNull(),
    mac: text().notNull(),
    created_at: integer().notNull(),
    record: text().notNull(),
  },
  (table) => [
    uniqueIndex("work_known_recovery_v2_request_idx").on(
      table.instance_id,
      table.operator_id,
      table.work_id,
      table.request_id,
    ),
    uniqueIndex("work_known_recovery_v2_claim_idx").on(table.work_id, table.old_claim_token),
    index("work_known_recovery_v2_session_idx").on(table.session_id, table.control_revision),
    index("work_known_recovery_v2_instance_idx").on(table.instance_id, table.recovery_id),
    check("work_known_recovery_v2_version_check", sql`typeof(${table.version})='integer' AND ${table.version}=2`),
    check("work_known_recovery_v2_action_check", sql`${table.action} IN ('recover_only','recover_and_resume')`),
    check(
      "work_known_recovery_v2_record_check",
      sql`typeof(${table.record})='text'
    AND length(CAST(${table.record} AS BLOB)) BETWEEN 1 AND 131072
    AND instr(${table.record},char(0))=0 AND json_valid(${table.record})
    AND json_type(${table.record},'$.evidence') IS 'object'
    AND json_type(${table.record},'$.evidence.providers') IS 'array'
    AND json_array_length(${table.record},'$.evidence.providers') BETWEEN 1 AND 32
    AND json_type(${table.record},'$.evidence.tools') IS 'array'
    AND json_array_length(${table.record},'$.evidence.tools') BETWEEN 0 AND 128
    AND json_type(${table.record},'$.evidence.tasks') IS 'array'
    AND json_array_length(${table.record},'$.evidence.tasks') BETWEEN 1 AND 128`,
    ),
    ...[
      table.recovery_id,
      table.instance_id,
      table.operator_id,
      table.work_id,
      table.root_work_id,
      table.session_id,
      table.input_id,
      table.request_id,
    ].map((column) =>
      check(
        `work_known_recovery_v2_${column.name}_text_check`,
        sql`typeof(${column})='text' AND length(CAST(${column} AS BLOB)) BETWEEN 1 AND 512 AND instr(${column},char(0))=0`,
      ),
    ),
    ...[
      table.old_claim_token,
      table.control_revision,
      table.operator_revision,
      table.source_revision,
      table.approval_revision,
      table.created_at,
    ].map((column) =>
      check(
        `work_known_recovery_v2_${column.name}_integer_check`,
        sql`typeof(${column})='integer' AND ${column} BETWEEN 1 AND 9007199254740991`,
      ),
    ),
    ...[table.binding_hash, table.request_hash, table.evidence_hash, table.record_hash, table.mac].map((column) =>
      check(
        `work_known_recovery_v2_${column.name}_digest_check`,
        sql`typeof(${column})='text'
      AND length(CAST(${column} AS BLOB))=64 AND ${column} NOT GLOB '*[^0-9a-f]*'`,
      ),
    ),
    ...(
      [
        [table.recovery_id, "recoveryID"],
        [table.instance_id, "instanceID"],
        [table.operator_id, "operatorID"],
        [table.work_id, "workID"],
        [table.root_work_id, "rootWorkID"],
        [table.session_id, "sessionID"],
        [table.input_id, "inputID"],
        [table.request_id, "requestID"],
        [table.action, "action"],
        [table.binding_hash, "bindingHash"],
        [table.request_hash, "requestHash"],
        [table.evidence_hash, "evidenceHash"],
      ] as const
    ).map(([column, field]) =>
      check(
        `work_known_recovery_v2_${column.name}_mirror_check`,
        sql`
    json_type(${table.record},${sql.raw(`'$.${field}'`)}) IS 'text'
    AND json_extract(${table.record},${sql.raw(`'$.${field}'`)}) IS ${column}`,
      ),
    ),
    ...(
      [
        [table.version, "version"],
        [table.old_claim_token, "oldClaimToken"],
        [table.control_revision, "controlRevision"],
        [table.operator_revision, "operatorRevision"],
        [table.source_revision, "sourceRevision"],
        [table.approval_revision, "approvalRevision"],
        [table.created_at, "createdAt"],
      ] as const
    ).map(([column, field]) =>
      check(
        `work_known_recovery_v2_${column.name}_mirror_check`,
        sql`
    json_type(${table.record},${sql.raw(`'$.${field}'`)}) IS 'integer'
    AND json_extract(${table.record},${sql.raw(`'$.${field}'`)}) IS ${column}`,
      ),
    ),
  ],
)

// The explicit continuation is a separate immutable intent. Reading or retrying
// the original recovery receipt never schedules another drain.
export const WorkKnownRecoveryResumeV2Table = sqliteTable(
  "work_known_recovery_resume_v2",
  {
    recovery_id: text()
      .primaryKey()
      .notNull()
      .references(() => WorkKnownRecoveryV2Table.recovery_id, { onDelete: "restrict", onUpdate: "restrict" }),
    version: integer().notNull(),
    instance_id: text().notNull(),
    operator_id: text().notNull(),
    work_id: text().notNull(),
    session_id: text().notNull(),
    request_id: text().notNull(),
    control_revision: integer().notNull(),
    operator_revision: integer().notNull(),
    source_revision: integer().notNull(),
    approval_revision: integer().notNull(),
    binding_hash: text().notNull(),
    recovery_record_hash: text().notNull(),
    request_hash: text().notNull(),
    record_hash: text().notNull(),
    mac: text().notNull(),
    created_at: integer().notNull(),
    record: text().notNull(),
  },
  (table) => [
    uniqueIndex("work_known_recovery_resume_v2_request_idx").on(
      table.instance_id,
      table.operator_id,
      table.work_id,
      table.request_id,
    ),
    index("work_known_recovery_resume_v2_session_idx").on(table.session_id, table.control_revision),
    check(
      "work_known_recovery_resume_v2_version_check",
      sql`typeof(${table.version})='integer' AND ${table.version}=2`,
    ),
    check(
      "work_known_recovery_resume_v2_record_check",
      sql`typeof(${table.record})='text'
    AND length(CAST(${table.record} AS BLOB)) BETWEEN 1 AND 8192
    AND instr(${table.record},char(0))=0 AND json_valid(${table.record})`,
    ),
    ...[table.recovery_id, table.instance_id, table.operator_id, table.work_id, table.session_id, table.request_id].map(
      (column) =>
        check(
          `work_known_recovery_resume_v2_${column.name}_text_check`,
          sql`typeof(${column})='text'
      AND length(CAST(${column} AS BLOB)) BETWEEN 1 AND 512 AND instr(${column},char(0))=0`,
        ),
    ),
    ...[
      table.control_revision,
      table.operator_revision,
      table.source_revision,
      table.approval_revision,
      table.created_at,
    ].map((column) =>
      check(
        `work_known_recovery_resume_v2_${column.name}_integer_check`,
        sql`typeof(${column})='integer'
      AND ${column} BETWEEN 1 AND 9007199254740991`,
      ),
    ),
    ...[table.binding_hash, table.recovery_record_hash, table.request_hash, table.record_hash, table.mac].map(
      (column) =>
        check(
          `work_known_recovery_resume_v2_${column.name}_digest_check`,
          sql`typeof(${column})='text'
      AND length(CAST(${column} AS BLOB))=64 AND ${column} NOT GLOB '*[^0-9a-f]*'`,
        ),
    ),
    ...(
      [
        [table.recovery_id, "recoveryID"],
        [table.instance_id, "instanceID"],
        [table.operator_id, "operatorID"],
        [table.work_id, "workID"],
        [table.session_id, "sessionID"],
        [table.request_id, "requestID"],
        [table.binding_hash, "bindingHash"],
        [table.recovery_record_hash, "recoveryRecordHash"],
        [table.request_hash, "requestHash"],
      ] as const
    ).map(([column, field]) =>
      check(
        `work_known_recovery_resume_v2_${column.name}_mirror_check`,
        sql`
    json_type(${table.record},${sql.raw(`'$.${field}'`)}) IS 'text'
    AND json_extract(${table.record},${sql.raw(`'$.${field}'`)}) IS ${column}`,
      ),
    ),
    ...(
      [
        [table.version, "version"],
        [table.control_revision, "controlRevision"],
        [table.operator_revision, "operatorRevision"],
        [table.source_revision, "sourceRevision"],
        [table.approval_revision, "approvalRevision"],
        [table.created_at, "createdAt"],
      ] as const
    ).map(([column, field]) =>
      check(
        `work_known_recovery_resume_v2_${column.name}_mirror_check`,
        sql`
    json_type(${table.record},${sql.raw(`'$.${field}'`)}) IS 'integer'
    AND json_extract(${table.record},${sql.raw(`'$.${field}'`)}) IS ${column}`,
      ),
    ),
  ],
)
