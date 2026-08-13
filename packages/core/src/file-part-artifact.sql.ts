import { blob, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import type { EventV2 } from "./event"
import { EventSequenceTable } from "./event/sql"

export const FilePartArtifactTable = sqliteTable("file_part_artifact", {
  artifact_id: text().primaryKey(),
  body_hash: text().notNull().unique(),
  body_bytes: integer().notNull(),
  chunk_bytes: integer().notNull(),
  chunk_count: integer().notNull(),
  codec_version: integer().notNull(),
  complete: integer({ mode: "boolean" }).notNull(),
  created_at: integer().notNull(),
})

export const FilePartArtifactChunkTable = sqliteTable(
  "file_part_artifact_chunk",
  {
    artifact_id: text()
      .notNull()
      .references(() => FilePartArtifactTable.artifact_id, { onDelete: "cascade" }),
    chunk_index: integer().notNull(),
    data: blob({ mode: "buffer" }).notNull(),
    chunk_hash: text().notNull(),
  },
  (table) => [primaryKey({ columns: [table.artifact_id, table.chunk_index] })],
)

export const FilePartArtifactBindingTable = sqliteTable(
  "file_part_artifact_binding",
  {
    event_id: text().$type<EventV2.ID>().primaryKey(),
    aggregate_id: text()
      .notNull()
      .references(() => EventSequenceTable.aggregate_id, { onDelete: "cascade" }),
    seq: integer().notNull(),
    part_id: text().notNull(),
    artifact_id: text()
      .notNull()
      .references(() => FilePartArtifactTable.artifact_id, { onDelete: "restrict" }),
    original_data_hash: text().notNull(),
    canonical_data_hash: text().notNull(),
    canonical_data: text({ mode: "json" }).$type<Record<string, unknown>>().notNull(),
    created_at: integer().notNull(),
  },
  (table) => [
    uniqueIndex("file_part_artifact_binding_aggregate_seq_idx").on(table.aggregate_id, table.seq),
    index("file_part_artifact_binding_part_idx").on(table.aggregate_id, table.part_id, table.seq),
  ],
)

export const FilePartArtifactImportTable = sqliteTable(
  "file_part_artifact_import",
  {
    event_id: text().$type<EventV2.ID>().primaryKey(),
    aggregate_id: text().notNull(),
    seq: integer().notNull(),
    artifact_id: text()
      .notNull()
      .references(() => FilePartArtifactTable.artifact_id, { onDelete: "cascade" }),
    original_data_hash: text().notNull(),
    canonical_data_hash: text().notNull(),
    canonical_data: text({ mode: "json" }).$type<Record<string, unknown>>().notNull(),
    created_at: integer().notNull(),
  },
  (table) => [uniqueIndex("file_part_artifact_import_aggregate_seq_idx").on(table.aggregate_id, table.seq)],
)
