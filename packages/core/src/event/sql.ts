import { sqliteTable, text, integer, index, uniqueIndex, primaryKey, blob } from "drizzle-orm/sqlite-core"
import type { EventV2 } from "../event"

export const EventSequenceTable = sqliteTable("event_sequence", {
  aggregate_id: text().notNull().primaryKey(),
  seq: integer().notNull(),
  owner_id: text(),
  retention_floor_seq: integer(),
  snapshot_id: text(),
  write_fence_transfer_id: text(),
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
    index("event_snapshot_aggregate_seq_idx").on(table.aggregate_id, table.through_seq),
    index("event_snapshot_aggregate_created_idx").on(table.aggregate_id, table.created_at),
    uniqueIndex("event_snapshot_sync_seq_idx").on(table.sync_seq),
  ],
)

export const EventSnapshotRowTable = sqliteTable(
  "event_snapshot_row",
  {
    snapshot_id: text().notNull(),
    aggregate_id: text().notNull(),
    row_index: integer().notNull(),
    table_name: text().notNull(),
    row_key: text().notNull(),
    row_hash: text().notNull(),
    row_bytes: integer().notNull(),
    chunk_count: integer().notNull(),
    chain_hash: text().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.snapshot_id, table.row_index] }),
    uniqueIndex("event_snapshot_row_identity_idx").on(table.snapshot_id, table.table_name, table.row_key),
    index("event_snapshot_row_hash_idx").on(table.row_hash),
    index("event_snapshot_row_aggregate_idx").on(table.aggregate_id),
  ],
)

export const EventSnapshotChunkTable = sqliteTable(
  "event_snapshot_chunk",
  {
    row_hash: text().notNull(),
    chunk_index: integer().notNull(),
    data: blob({ mode: "buffer" }).notNull(),
    chunk_hash: text().notNull(),
  },
  (table) => [primaryKey({ columns: [table.row_hash, table.chunk_index] })],
)

export const EventSnapshotAttemptTable = sqliteTable("event_snapshot_attempt", {
  snapshot_id: text().primaryKey(),
  aggregate_id: text()
    .notNull()
    .references(() => EventSequenceTable.aggregate_id, { onDelete: "cascade" }),
  through_seq: integer().notNull(),
  expected_latest: integer().notNull(),
  owner_id: text(),
  codec: text().notNull(),
  schema_version: integer().notNull(),
  projection_revision: text().notNull(),
  cursor: text(),
  row_count: integer().notNull(),
  encoded_bytes: integer().notNull(),
  content_hash: text().notNull(),
  tables: text({ mode: "json" }).$type<Record<string, number>>().notNull(),
  state: text().$type<"prepared" | "staged" | "complete">().notNull(),
  created_at: integer().notNull(),
  updated_at: integer().notNull(),
}, (table) => [index("event_snapshot_attempt_aggregate_idx").on(table.aggregate_id)])

export const EventSyncSequenceTable = sqliteTable("event_sync_sequence", {
  id: integer().primaryKey(),
  seq: integer().notNull(),
  generation: text().notNull(),
  cursor_secret: text().notNull(),
  backfill_complete: integer({ mode: "boolean" }).notNull(),
})

export const EventSyncBackfillTable = sqliteTable("event_sync_backfill", {
  id: integer().primaryKey(),
  state: text().$type<"pending" | "complete">().notNull(),
  cursor_rowid: integer().notNull(),
  high_water_rowid: integer().notNull(),
  processed_count: integer().notNull(),
  started_at: integer().notNull(),
  updated_at: integer().notNull(),
  completed_at: integer(),
})

export const EventSyncIndexTable = sqliteTable(
  "event_sync_index",
  {
    sync_seq: integer().primaryKey(),
    event_id: text().$type<EventV2.ID>().notNull().unique(),
    aggregate_id: text().notNull(),
    seq: integer().notNull(),
  },
  (table) => [index("event_sync_index_aggregate_seq_idx").on(table.aggregate_id, table.seq)],
)

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
    source_data: text({ mode: "json" }).$type<Record<string, unknown>>(),
    compacted_at: integer().notNull(),
  },
  (table) => [
    uniqueIndex("event_dedupe_aggregate_seq_idx").on(table.aggregate_id, table.seq),
    uniqueIndex("event_dedupe_event_idx").on(table.event_id),
  ],
)

export const EventCompactionReceiptTable = sqliteTable("event_compaction_receipt", {
  aggregate_id: text()
    .primaryKey()
    .references(() => EventSequenceTable.aggregate_id, { onDelete: "cascade" }),
  snapshot_id: text().notNull(),
  through_seq: integer().notNull(),
  codec: text().notNull(),
  schema_version: integer().notNull(),
  cursor_seq: integer().notNull(),
  deleted_count: integer().notNull(),
  state: text().$type<"running" | "complete">().notNull(),
  updated_at: integer().notNull(),
})

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
