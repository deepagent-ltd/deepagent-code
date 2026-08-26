import { index, integer, primaryKey, sqliteTable, text, uniqueIndex, blob } from "drizzle-orm/sqlite-core"

export const SessionDiffMigrationReceiptTable = sqliteTable(
  "session_diff_migration_receipt",
  {
    message_id: text().notNull().primaryKey(),
    session_id: text().notNull(),
    artifact_id: text().notNull(),
    source_event_id: text().notNull(),
    expected_message_data_hash: text().notNull(),
    committed_message_data_hash: text(),
    expected_session_summary_hash: text().notNull(),
    committed_session_summary_hash: text(),
    canonicalizer_version: integer().notNull(),
    canonicalization_version: integer().notNull(),
    epoch_hashes: text({ mode: "json" })
      .$type<ReadonlyArray<{ epoch: number; before: string; after: string }>>()
      .notNull(),
    state: text().$type<"prepared" | "committed" | "migration_validation_failed">().notNull(),
    failure_reason: text(),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
    committed_at: integer(),
  },
  (table) => [
    uniqueIndex("session_diff_migration_receipt_artifact_idx").on(table.artifact_id),
    index("session_diff_migration_receipt_session_state_idx").on(table.session_id, table.state),
  ],
)

export const SessionDiffArtifactFileTable = sqliteTable(
  "session_diff_artifact_file",
  {
    artifact_id: text().notNull(),
    file_index: integer().notNull(),
    path: text().notNull(),
    path_key: text().notNull(),
    additions: integer().notNull(),
    deletions: integer().notNull(),
    status: text().$type<"added" | "deleted" | "modified" | null>(),
    patch_hash: text().notNull(),
    patch_bytes: integer().notNull(),
    patch_chunk_count: integer().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.artifact_id, table.file_index] }),
    uniqueIndex("session_diff_artifact_file_path_idx").on(table.artifact_id, table.path_key),
  ],
)

export const SessionDiffArtifactFileChunkTable = sqliteTable(
  "session_diff_artifact_file_chunk",
  {
    artifact_id: text().notNull(),
    file_index: integer().notNull(),
    chunk_index: integer().notNull(),
    data: blob({ mode: "buffer" }).notNull(),
    chunk_hash: text().notNull(),
  },
  (table) => [primaryKey({ columns: [table.artifact_id, table.file_index, table.chunk_index] })],
)
