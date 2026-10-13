import { sql } from "drizzle-orm"
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"

// Reservation precedes child dispatch. Failed/unknown execution retains its entire reserved
// proof slot; only the original opaque Task settlement can populate the authenticated record.
export const WorkTaskKnownProofTable = sqliteTable(
  "work_task_known_proof",
  {
    proof_id: text().primaryKey().notNull(),
    version: integer().notNull(),
    instance_id: text().notNull(),
    root_work_id: text().notNull(),
    parent_work_id: text().notNull(),
    child_work_id: text().notNull(),
    task_run_id: text().notNull(),
    admission_id: text().notNull(),
    parent_binding_hash: text().notNull(),
    child_binding_hash: text().notNull(),
    grant_hash: text().notNull(),
    state: text().$type<"reserved" | "sealed">().notNull(),
    reserved_bytes: integer().notNull(),
    effect_id: text(),
    record_hash: text(),
    mac: text(),
    record: text(),
    created_at: integer().notNull(),
    sealed_at: integer(),
  },
  (table) => [
    uniqueIndex("work_task_known_proof_admission_idx").on(table.admission_id),
    uniqueIndex("work_task_known_proof_child_idx").on(table.child_work_id),
    uniqueIndex("work_task_known_proof_effect_idx").on(table.effect_id),
    index("work_task_known_proof_root_idx").on(table.root_work_id, table.proof_id),
    index("work_task_known_proof_instance_idx").on(table.instance_id, table.proof_id),
    check("work_task_known_proof_version_check", sql`typeof(${table.version})='integer' AND ${table.version}=2`),
    check("work_task_known_proof_state_check", sql`${table.state} IN ('reserved','sealed')`),
    check(
      "work_task_known_proof_capacity_check",
      sql`typeof(${table.reserved_bytes})='integer' AND ${table.reserved_bytes}=65536`,
    ),
    check(
      "work_task_known_proof_shape_check",
      sql`(${table.state}='reserved' AND ${table.effect_id} IS NULL
    AND ${table.record_hash} IS NULL AND ${table.mac} IS NULL AND ${table.record} IS NULL AND ${table.sealed_at} IS NULL)
    OR (${table.state}='sealed' AND typeof(${table.effect_id})='text' AND typeof(${table.record_hash})='text'
      AND typeof(${table.mac})='text' AND typeof(${table.record})='text' AND typeof(${table.sealed_at})='integer'
      AND ${table.sealed_at} BETWEEN ${table.created_at} AND 9007199254740991)`,
    ),
    ...[
      table.proof_id,
      table.instance_id,
      table.root_work_id,
      table.parent_work_id,
      table.child_work_id,
      table.task_run_id,
      table.admission_id,
    ].map((column) =>
      check(
        `work_task_known_proof_${column.name}_text_check`,
        sql`typeof(${column})='text' AND length(CAST(${column} AS BLOB)) BETWEEN 1 AND 512 AND instr(${column},char(0))=0`,
      ),
    ),
    check(
      "work_task_known_proof_effect_text_check",
      sql`${table.effect_id} IS NULL OR
    (typeof(${table.effect_id})='text' AND length(CAST(${table.effect_id} AS BLOB)) BETWEEN 1 AND 512 AND instr(${table.effect_id},char(0))=0)`,
    ),
    check(
      "work_task_known_proof_created_check",
      sql`typeof(${table.created_at})='integer' AND ${table.created_at} BETWEEN 1 AND 9007199254740991`,
    ),
    ...[table.parent_binding_hash, table.child_binding_hash, table.grant_hash].map((column) =>
      check(
        `work_task_known_proof_${column.name}_digest_check`,
        sql`typeof(${column})='text'
      AND length(CAST(${column} AS BLOB))=64 AND ${column} NOT GLOB '*[^0-9a-f]*'`,
      ),
    ),
    ...[table.record_hash, table.mac].map((column) =>
      check(
        `work_task_known_proof_${column.name}_digest_check`,
        sql`${column} IS NULL OR (typeof(${column})='text' AND length(CAST(${column} AS BLOB))=64 AND ${column} NOT GLOB '*[^0-9a-f]*')`,
      ),
    ),
    check(
      "work_task_known_proof_record_check",
      sql`${table.record} IS NULL OR (typeof(${table.record})='text'
    AND length(CAST(${table.record} AS BLOB)) BETWEEN 1 AND 65536 AND instr(${table.record},char(0))=0
    AND json_valid(${table.record}) AND json_type(${table.record},'$.version') IS 'integer'
    AND json_extract(${table.record},'$.version') IS ${table.version}
    AND json_type(${table.record},'$.providers') IS 'array' AND json_array_length(${table.record},'$.providers') BETWEEN 1 AND 32
    AND json_type(${table.record},'$.tools') IS 'array' AND json_array_length(${table.record},'$.tools') BETWEEN 0 AND 128)`,
    ),
    ...(
      [
        [table.proof_id, "proofID"],
        [table.instance_id, "instanceID"],
        [table.root_work_id, "rootWorkID"],
        [table.parent_work_id, "parentWorkID"],
        [table.child_work_id, "childWorkID"],
        [table.task_run_id, "taskRunID"],
        [table.admission_id, "admissionID"],
        [table.parent_binding_hash, "parentBindingHash"],
        [table.child_binding_hash, "childBindingHash"],
        [table.grant_hash, "grantHash"],
        [table.effect_id, "effectID"],
      ] as const
    ).map(([column, key]) =>
      check(
        `work_task_known_proof_${column.name}_mirror_check`,
        sql`${table.record} IS NULL OR
    (json_type(${table.record},${sql.raw(`'$.${key}'`)}) IS 'text' AND json_extract(${table.record},${sql.raw(`'$.${key}'`)}) IS ${column})`,
      ),
    ),
    check(
      "work_task_known_proof_time_mirror_check",
      sql`${table.record} IS NULL OR
    (json_type(${table.record},'$.createdAt') IS 'integer' AND json_extract(${table.record},'$.createdAt') IS ${table.sealed_at})`,
    ),
  ],
)
