import { integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"

export const SecurityNamespaceTable = sqliteTable(
  "context_security_namespace",
  {
    id: text().primaryKey(),
    kind: text().$type<"implicit_local" | "workspace">().notNull(),
    binding_hash: text().notNull(),
    created_at: integer().notNull(),
    retired_at: integer(),
  },
  (table) => [uniqueIndex("context_security_namespace_binding_idx").on(table.kind, table.binding_hash)],
)

export const ProjectScopeIdentityTable = sqliteTable(
  "context_project_scope_identity",
  {
    security_namespace_id: text()
      .notNull()
      .references(() => SecurityNamespaceTable.id),
    project_scope_key: text().notNull(),
    project_kind: text().$type<"git" | "registered_root">().notNull(),
    project_identity_hash: text().notNull(),
    observed_project_id: text(),
    created_at: integer().notNull(),
    retired_at: integer(),
  },
  (table) => [
    primaryKey({ columns: [table.security_namespace_id, table.project_scope_key] }),
    uniqueIndex("context_project_scope_identity_value_idx").on(
      table.security_namespace_id,
      table.project_identity_hash,
    ),
  ],
)

export const ProjectScopeIdentityAliasTable = sqliteTable(
  "context_project_scope_identity_alias",
  {
    security_namespace_id: text()
      .notNull()
      .references(() => SecurityNamespaceTable.id),
    old_project_identity_hash: text().notNull(),
    project_scope_key: text().notNull(),
    reason: text().notNull(),
    created_at: integer().notNull(),
  },
  (table) => [primaryKey({ columns: [table.security_namespace_id, table.old_project_identity_hash] })],
)

export const LocationIdentityTable = sqliteTable(
  "context_location_identity",
  {
    security_namespace_id: text()
      .notNull()
      .references(() => SecurityNamespaceTable.id),
    location_key: text().notNull(),
    project_scope_key: text().notNull(),
    workspace_binding: text(),
    canonical_root: text().notNull(),
    observed_project_id: text(),
    created_at: integer().notNull(),
    retired_at: integer(),
  },
  (table) => [
    primaryKey({ columns: [table.security_namespace_id, table.location_key] }),
    uniqueIndex("context_location_identity_root_idx").on(table.security_namespace_id, table.canonical_root),
  ],
)

export const LocationIdentityAliasTable = sqliteTable(
  "context_location_identity_alias",
  {
    security_namespace_id: text()
      .notNull()
      .references(() => SecurityNamespaceTable.id),
    old_canonical_root: text().notNull(),
    location_key: text().notNull(),
    reason: text().notNull(),
    created_at: integer().notNull(),
  },
  (table) => [primaryKey({ columns: [table.security_namespace_id, table.old_canonical_root] })],
)

export const LocationIndexCoordinationTable = sqliteTable(
  "location_index_coordination",
  {
    security_namespace_id: text().notNull(),
    location_key: text().notNull(),
    index_space_id: text().notNull(),
    projection_kind: text().$type<"code" | "repo_documents">().notNull(),
    index_incarnation: integer().notNull(),
    db_locator: text().notNull(),
    owner_id: text(),
    fencing_token: integer().notNull(),
    expires_at: integer(),
    replacement_state: text().$type<"ready" | "replacing">().notNull(),
    updated_at: integer().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.index_space_id, table.projection_kind] }),
    uniqueIndex("location_index_coordination_location_idx").on(
      table.security_namespace_id,
      table.location_key,
      table.projection_kind,
    ),
  ],
)
