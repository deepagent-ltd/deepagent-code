import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core"

export const ChangeEventTable = sqliteTable(
  "location_change_event",
  {
    event_seq: integer().primaryKey({ autoIncrement: true }),
    index_space_id: text().notNull(),
    path: text().notNull(),
    previous_path: text(),
    rename_correlation_id: text(),
    change_kind: text()
      .$type<"create" | "update" | "delete" | "rename" | "config" | "checkout" | "overflow" | "reconcile">()
      .notNull(),
    observed_mtime_ns: text(),
    observed_sha: text(),
    source: text().$type<"watcher" | "tool" | "editor" | "git" | "fresh_query" | "reconciliation">().notNull(),
    observed_at: integer().notNull(),
  },
  (table) => [index("location_change_event_space_seq_idx").on(table.index_space_id, table.event_seq)],
)

export const ProjectionRegistrationTable = sqliteTable(
  "location_projection_registration",
  {
    index_space_id: text().notNull(),
    projection_kind: text().$type<"code" | "repo_documents">().notNull(),
    registration_epoch: integer().notNull(),
    state: text().$type<"active" | "paused" | "retired">().notNull(),
    consumed_event_seq: integer().notNull(),
    reconcile_required: integer({ mode: "boolean" }).notNull(),
    updated_at: integer().notNull(),
  },
  (table) => [primaryKey({ columns: [table.index_space_id, table.projection_kind] })],
)

export const ProjectionDirtyPathTable = sqliteTable(
  "location_projection_dirty_path",
  {
    index_space_id: text().notNull(),
    projection_kind: text().$type<"code" | "repo_documents">().notNull(),
    path: text().notNull(),
    latest_event_seq: integer().notNull(),
    previous_path: text(),
    rename_correlation_id: text(),
    change_kind: text()
      .$type<"create" | "update" | "delete" | "rename" | "config" | "checkout" | "overflow" | "reconcile">()
      .notNull(),
    observed_mtime_ns: text(),
    observed_sha: text(),
    updated_at: integer().notNull(),
  },
  (table) => [primaryKey({ columns: [table.index_space_id, table.projection_kind, table.path] })],
)
