import { sql } from "drizzle-orm"
import { check, foreignKey, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { ProjectScopeIdentityTable, SecurityNamespaceTable } from "../context-federation/sql"

export const ReleasedKnowledgeEvaluationTable = sqliteTable(
  "released_knowledge_evaluation",
  {
    evaluation_id: text().primaryKey(),
    security_namespace_id: text()
      .notNull()
      .references(() => SecurityNamespaceTable.id),
    project_scope_key: text().notNull(),
    matrix_hash: text().notNull(),
    matrix_json: text().notNull(),
    document_manifest_json: text().notNull(),
    baseline_ref: text().notNull(),
    repetitions: integer().notNull(),
    evaluator_type: text().$type<"human" | "agent" | "system">().notNull(),
    evaluator_id: text().notNull(),
    created_at: integer().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.security_namespace_id, table.project_scope_key],
      foreignColumns: [ProjectScopeIdentityTable.security_namespace_id, ProjectScopeIdentityTable.project_scope_key],
    }),
    uniqueIndex("released_knowledge_evaluation_scope_identity_idx").on(
      table.security_namespace_id,
      table.project_scope_key,
      table.evaluation_id,
    ),
    index("released_knowledge_evaluation_matrix_idx").on(
      table.security_namespace_id,
      table.project_scope_key,
      table.matrix_hash,
    ),
    check(
      "released_knowledge_evaluation_matrix_hash_check",
      sql`length(${table.matrix_hash}) = 64 AND ${table.matrix_hash} NOT GLOB '*[^0-9a-f]*'`,
    ),
    check("released_knowledge_evaluation_matrix_json_check", sql`json_valid(${table.matrix_json})`),
    check(
      "released_knowledge_evaluation_document_manifest_json_check",
      sql`json_valid(${table.document_manifest_json}) AND json_type(${table.document_manifest_json}) = 'array'`,
    ),
    check("released_knowledge_evaluation_repetitions_check", sql`${table.repetitions} > 0`),
    check(
      "released_knowledge_evaluation_actor_type_check",
      sql`${table.evaluator_type} IN ('human', 'agent', 'system')`,
    ),
  ],
)

export const ReleasedKnowledgeSnapshotTable = sqliteTable(
  "released_knowledge_snapshot",
  {
    snapshot_id: text().primaryKey(),
    security_namespace_id: text()
      .notNull()
      .references(() => SecurityNamespaceTable.id),
    project_scope_key: text().notNull(),
    legacy_project_id: text().notNull(),
    parent_snapshot_id: text(),
    evaluation_id: text().notNull(),
    release_kind: text().$type<"legacy_baseline" | "evaluated" | "rollback">().notNull(),
    document_count: integer().notNull(),
    published_generation: integer().notNull(),
    verdict: text().$type<"passed" | "failed">().notNull(),
    failure_reason: text(),
    actor_type: text().$type<"human" | "agent" | "system">().notNull(),
    actor_id: text().notNull(),
    created_at: integer().notNull(),
    finalized_at: integer(),
  },
  (table) => [
    foreignKey({
      columns: [table.security_namespace_id, table.project_scope_key],
      foreignColumns: [ProjectScopeIdentityTable.security_namespace_id, ProjectScopeIdentityTable.project_scope_key],
    }),
    foreignKey({
      columns: [table.security_namespace_id, table.project_scope_key, table.parent_snapshot_id],
      foreignColumns: [table.security_namespace_id, table.project_scope_key, table.snapshot_id],
    }),
    foreignKey({
      columns: [table.security_namespace_id, table.project_scope_key, table.evaluation_id],
      foreignColumns: [
        ReleasedKnowledgeEvaluationTable.security_namespace_id,
        ReleasedKnowledgeEvaluationTable.project_scope_key,
        ReleasedKnowledgeEvaluationTable.evaluation_id,
      ],
    }),
    uniqueIndex("released_knowledge_snapshot_scope_identity_idx").on(
      table.security_namespace_id,
      table.project_scope_key,
      table.snapshot_id,
    ),
    index("released_knowledge_snapshot_parent_idx").on(table.parent_snapshot_id),
    check(
      "released_knowledge_snapshot_release_kind_check",
      sql`${table.release_kind} IN ('legacy_baseline', 'evaluated', 'rollback')`,
    ),
    check("released_knowledge_snapshot_document_count_check", sql`${table.document_count} >= 0`),
    check(
      "released_knowledge_snapshot_published_generation_check",
      sql`(${table.verdict} = 'passed' AND ${table.published_generation} > 0) OR (${table.verdict} = 'failed' AND ${table.published_generation} >= 0)`,
    ),
    check("released_knowledge_snapshot_verdict_check", sql`${table.verdict} IN ('passed', 'failed')`),
    check(
      "released_knowledge_snapshot_failure_reason_check",
      sql`(${table.verdict} = 'passed' AND ${table.failure_reason} IS NULL) OR (${table.verdict} = 'failed' AND length(trim(${table.failure_reason})) > 0)`,
    ),
    check(
      "released_knowledge_snapshot_release_chain_check",
      sql`(${table.release_kind} = 'legacy_baseline' AND ${table.parent_snapshot_id} IS NULL AND ${table.verdict} = 'passed') OR (${table.release_kind} <> 'legacy_baseline' AND ${table.parent_snapshot_id} IS NOT NULL)`,
    ),
    check(
      "released_knowledge_snapshot_evaluated_membership_check",
      sql`${table.release_kind} <> 'evaluated' OR ${table.verdict} = 'failed' OR ${table.document_count} > 0`,
    ),
    check("released_knowledge_snapshot_actor_type_check", sql`${table.actor_type} IN ('human', 'agent', 'system')`),
  ],
)

export const ReleasedKnowledgeSnapshotDocumentTable = sqliteTable(
  "released_knowledge_snapshot_document",
  {
    snapshot_id: text()
      .notNull()
      .references(() => ReleasedKnowledgeSnapshotTable.snapshot_id, { onDelete: "cascade" }),
    ordinal: integer().notNull(),
    source_store: text().$type<"user_global" | "project">().notNull(),
    doc_id: text().notNull(),
    doc_version: integer().notNull(),
    doc_hash: text().notNull(),
    doc_type: text().notNull(),
    doc_scope: text().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.snapshot_id, table.source_store, table.doc_id] }),
    uniqueIndex("released_knowledge_snapshot_document_ordinal_idx").on(table.snapshot_id, table.ordinal),
    check("released_knowledge_snapshot_document_ordinal_check", sql`${table.ordinal} >= 0`),
    check(
      "released_knowledge_snapshot_document_source_store_check",
      sql`${table.source_store} IN ('user_global', 'project')`,
    ),
    check("released_knowledge_snapshot_document_version_check", sql`${table.doc_version} > 0`),
    check(
      "released_knowledge_snapshot_document_hash_check",
      sql`length(${table.doc_hash}) = 71 AND substr(${table.doc_hash}, 1, 7) = 'sha256:' AND substr(${table.doc_hash}, 8) NOT GLOB '*[^0-9a-f]*'`,
    ),
    check(
      "released_knowledge_snapshot_document_type_check",
      sql`${table.doc_type} IN ('knowledge', 'strategy', 'methodology', 'memory', 'skill')`,
    ),
  ],
)

export const ReleasedKnowledgeSnapshotHeadTable = sqliteTable(
  "released_knowledge_snapshot_head",
  {
    security_namespace_id: text()
      .notNull()
      .references(() => SecurityNamespaceTable.id),
    project_scope_key: text().notNull(),
    snapshot_id: text(),
    generation: integer().notNull(),
    updated_at: integer().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.security_namespace_id, table.project_scope_key] }),
    foreignKey({
      columns: [table.security_namespace_id, table.project_scope_key],
      foreignColumns: [ProjectScopeIdentityTable.security_namespace_id, ProjectScopeIdentityTable.project_scope_key],
    }),
    foreignKey({
      columns: [table.security_namespace_id, table.project_scope_key, table.snapshot_id],
      foreignColumns: [
        ReleasedKnowledgeSnapshotTable.security_namespace_id,
        ReleasedKnowledgeSnapshotTable.project_scope_key,
        ReleasedKnowledgeSnapshotTable.snapshot_id,
      ],
    }),
    check(
      "released_knowledge_snapshot_head_generation_check",
      sql`(${table.snapshot_id} IS NULL AND ${table.generation} = 0) OR (${table.snapshot_id} IS NOT NULL AND ${table.generation} > 0)`,
    ),
  ],
)
