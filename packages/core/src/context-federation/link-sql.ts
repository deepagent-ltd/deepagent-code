import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { sql } from "drizzle-orm"

export const ContextLinkBatchTable = sqliteTable(
  "context_link_batch",
  {
    batch_id: text().primaryKey(),
    security_namespace_id: text().notNull(),
    project_scope_key: text().notNull(),
    producer_id: text().notNull(),
    projection_kind: text().$type<"code" | "repo_documents">().notNull(),
    source_snapshot_revision: text().notNull(),
    state: text().$type<"staged" | "active" | "superseded">().notNull(),
    created_at: integer().notNull(),
    activated_at: integer(),
    superseded_at: integer(),
  },
  (table) => [
    uniqueIndex("context_link_batch_identity_idx").on(
      table.security_namespace_id,
      table.project_scope_key,
      table.producer_id,
      table.projection_kind,
      table.source_snapshot_revision,
    ),
    uniqueIndex("context_link_batch_active_idx")
      .on(table.security_namespace_id, table.project_scope_key, table.producer_id, table.projection_kind)
      .where(sql`${table.state} = 'active'`),
  ],
)

export const ContextLinkTable = sqliteTable(
  "context_link",
  {
    link_id: text().primaryKey(),
    security_namespace_id: text().notNull(),
    project_scope_key: text().notNull(),
    access_fingerprint: text().notNull(),
    access_constraints: text().notNull(),
    from_ref_hash: text().notNull(),
    to_ref_hash: text().notNull(),
    from_ref: text().notNull(),
    to_ref: text().notNull(),
    relation: text().notNull(),
    evidence_refs: text().notNull(),
    producer_kind: text().$type<"projection" | "runner" | "model" | "reviewed_promotion" | "human">().notNull(),
    producer_id: text().notNull(),
    batch_id: text().references(() => ContextLinkBatchTable.batch_id, { onDelete: "cascade" }),
    source: text().$type<"parser" | "runner" | "model" | "human">().notNull(),
    created_by: text().notNull(),
    state: text().$type<"candidate" | "active" | "broken" | "revoked">().notNull(),
    confidence: real().notNull(),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
    valid_until: integer(),
  },
  (table) => [
    index("context_link_from_partition_idx").on(
      table.security_namespace_id,
      table.project_scope_key,
      table.from_ref_hash,
      table.state,
    ),
    index("context_link_to_partition_idx").on(
      table.security_namespace_id,
      table.project_scope_key,
      table.to_ref_hash,
      table.state,
    ),
    index("context_link_access_partition_idx").on(
      table.security_namespace_id,
      table.project_scope_key,
      table.access_fingerprint,
    ),
  ],
)
