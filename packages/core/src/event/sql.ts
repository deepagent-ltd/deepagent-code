import { sqliteTable, text, integer, index, uniqueIndex, primaryKey, blob } from "drizzle-orm/sqlite-core"
import type { EventV2 } from "../event"

export const EventSequenceTable = sqliteTable("event_sequence", {
  aggregate_id: text().notNull().primaryKey(),
  seq: integer().notNull(),
  owner_id: text(),
  retention_floor_seq: integer(),
  snapshot_id: text(),
})

export const EventTable = sqliteTable(
  "event",
  {
    id: text().$type<EventV2.ID>().primaryKey(),
    aggregate_id: text()
      .notNull()
      .references(() => EventSequenceTable.aggregate_id, { onDelete: "cascade" }),
    seq: integer().notNull(),
    type: text().notNull(),
    data: text({ mode: "json" }).$type<Record<string, unknown>>().notNull(),
    sync_seq: integer(),
  },
  (table) => [
    uniqueIndex("event_aggregate_seq_idx").on(table.aggregate_id, table.seq),
    index("event_aggregate_type_seq_idx").on(table.aggregate_id, table.type, table.seq),
    uniqueIndex("event_sync_seq_idx").on(table.sync_seq),
  ],
)

export const EventSnapshotTable = sqliteTable(
  "event_snapshot",
  {
    snapshot_id: text().primaryKey(),
    aggregate_id: text()
      .notNull()
      .references(() => EventSequenceTable.aggregate_id, { onDelete: "cascade" }),
    through_seq: integer().notNull(),
    sync_seq: integer().notNull(),
    codec: text().notNull(),
    schema_version: integer().notNull(),
    snapshot_hash: text().notNull(),
    body: text({ mode: "json" }).$type<Record<string, unknown>>().notNull(),
    owner_id: text(),
    created_at: integer().notNull(),
  },
  (table) => [
    uniqueIndex("event_snapshot_aggregate_seq_idx").on(table.aggregate_id, table.through_seq),
    index("event_snapshot_aggregate_created_idx").on(table.aggregate_id, table.created_at),
    uniqueIndex("event_snapshot_sync_seq_idx").on(table.sync_seq),
  ],
)

export const EventSyncSequenceTable = sqliteTable("event_sync_sequence", {
  id: integer().primaryKey(),
  seq: integer().notNull(),
  generation: text().notNull(),
  cursor_secret: text().notNull(),
})

export const WorkspaceSyncCursorTable = sqliteTable(
  "workspace_sync_cursor",
  {
    workspace_id: text().notNull(),
    remote_fingerprint: text().notNull(),
    cursor: text().notNull(),
    updated_at: integer().notNull(),
  },
  (table) => [primaryKey({ columns: [table.workspace_id, table.remote_fingerprint] })],
)

export const EventDedupeTable = sqliteTable(
  "event_dedupe",
  {
    aggregate_id: text()
      .notNull()
      .references(() => EventSequenceTable.aggregate_id, { onDelete: "cascade" }),
    seq: integer().notNull(),
    event_id: text().$type<EventV2.ID>().notNull(),
    type: text().notNull(),
    data_hash: text().notNull(),
    compacted_at: integer().notNull(),
  },
  (table) => [
    uniqueIndex("event_dedupe_aggregate_seq_idx").on(table.aggregate_id, table.seq),
    uniqueIndex("event_dedupe_event_idx").on(table.event_id),
  ],
)

export const EventArtifactTable = sqliteTable(
  "event_artifact",
  {
    artifact_id: text().primaryKey(),
    event_id: text().$type<EventV2.ID>().notNull(),
    aggregate_id: text()
      .notNull()
      .references(() => EventSequenceTable.aggregate_id, { onDelete: "cascade" }),
    seq: integer().notNull(),
    kind: text().$type<"legacy_message_diff">().notNull(),
    original_data_hash: text().notNull(),
    canonical_data_hash: text().notNull(),
    canonical_data: text({ mode: "json" }).$type<Record<string, unknown>>().notNull(),
    body_hash: text().notNull(),
    body_bytes: integer().notNull(),
    chunk_count: integer().notNull(),
    codec_version: integer().notNull(),
    created_at: integer().notNull(),
  },
  (table) => [
    uniqueIndex("event_artifact_event_idx").on(table.event_id),
    uniqueIndex("event_artifact_aggregate_seq_idx").on(table.aggregate_id, table.seq),
  ],
)

export const EventArtifactChunkTable = sqliteTable(
  "event_artifact_chunk",
  {
    artifact_id: text()
      .notNull()
      .references(() => EventArtifactTable.artifact_id, { onDelete: "cascade" }),
    chunk_index: integer().notNull(),
    data: blob({ mode: "buffer" }).notNull(),
    chunk_hash: text().notNull(),
  },
  (table) => [primaryKey({ columns: [table.artifact_id, table.chunk_index] })],
)
