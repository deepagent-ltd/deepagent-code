import { sql } from "drizzle-orm"
import { check, foreignKey, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { IMKernelDeliveryTable } from "./kernel-delivery.sql"
import { GroupTable, MessageTable } from "./sql"

const integerBetween = (column: unknown, min: number, max: number) => sql`typeof(${column}) = 'integer' AND ${column} BETWEEN ${sql.raw(String(min))} AND ${sql.raw(String(max))}`
const hash = (column: unknown) => sql`typeof(${column}) = 'text' AND length(${column}) = 64 AND length(CAST(${column} AS BLOB)) = 64 AND ${column} NOT GLOB '*[^0-9a-f]*'`

/** A separate domain. Reader quota cannot pay for canonical sender media. */
export const IMKernelMediaMeterTable = sqliteTable("im_kernel_media_meter", {
  meter_id: integer().primaryKey(),
  version: integer().notNull(),
  custody_id: text().notNull(),
  revision: integer().notNull(),
  used_records: integer().notNull(),
  used_bytes: integer().notNull(),
}, (table) => [
  check("im_kernel_media_meter_identity_check", sql`${integerBetween(table.meter_id, 1, 1)} AND ${integerBetween(table.version, 1, 1)} AND length(${table.custody_id}) = 36 AND length(CAST(${table.custody_id} AS BLOB)) = 36 AND ${table.custody_id} NOT GLOB '*[^0-9a-f-]*' AND substr(${table.custody_id},9,1)='-' AND substr(${table.custody_id},14,1)='-' AND substr(${table.custody_id},15,1)='4' AND substr(${table.custody_id},19,1)='-' AND substr(${table.custody_id},20,1) IN ('8','9','a','b') AND substr(${table.custody_id},24,1)='-'`),
  check("im_kernel_media_meter_capacity_check", sql`${integerBetween(table.revision, 1, Number.MAX_SAFE_INTEGER)} AND ${integerBetween(table.used_records, 1, 100000)} AND ${integerBetween(table.used_bytes, 76, 268435456)}`),
  uniqueIndex("im_kernel_media_meter_custody_idx").on(table.custody_id),
])

/** One ledger owns the raw receipt and its canonical Message for their whole
 * lifecycle. Restrict prevents group deletion or another ledger dropping custody. */
export const IMKernelMediaBodyTable = sqliteTable("im_kernel_media_body", {
  message_id: text().primaryKey().notNull(),
  meter_id: integer().notNull(),
  version: integer().notNull(),
  workspace_id: text().notNull(),
  group_id: text().notNull(),
  source_hash: text().notNull(),
  expires_at: integer().notNull(),
  body_state: text().$type<"live" | "retired">().notNull(),
  local_revision: integer().notNull(),
  retired_at: integer(),
  record: text().notNull(),
  record_hash: text().notNull(),
  identity_hash: text().notNull(),
  accounted_records: integer().notNull(),
  accounted_bytes: integer().notNull(),
}, (table) => [
  foreignKey({ columns: [table.meter_id], foreignColumns: [IMKernelMediaMeterTable.meter_id] }).onDelete("restrict").onUpdate("restrict"),
  foreignKey({ columns: [table.message_id], foreignColumns: [IMKernelDeliveryTable.message_id] }).onDelete("restrict").onUpdate("restrict"),
  foreignKey({ columns: [table.message_id], foreignColumns: [MessageTable.id] }).onDelete("restrict").onUpdate("restrict"),
  foreignKey({ columns: [table.group_id], foreignColumns: [GroupTable.id] }).onDelete("restrict").onUpdate("restrict"),
  check("im_kernel_media_body_identity_check", sql`${integerBetween(table.meter_id, 1, 1)} AND ${integerBetween(table.version, 1, 1)} AND ${integerBetween(table.local_revision, 1, Number.MAX_SAFE_INTEGER)} AND ${hash(table.source_hash)} AND ${hash(table.record_hash)} AND ${hash(table.identity_hash)} AND length(${table.message_id}) BETWEEN 1 AND 2048 AND length(${table.group_id}) BETWEEN 1 AND 2048 AND length(${table.workspace_id}) BETWEEN 1 AND 2048`),
  check("im_kernel_media_body_lifecycle_check", sql`${integerBetween(table.expires_at, 0, Number.MAX_SAFE_INTEGER)} AND ((${table.body_state}='live' AND ${table.retired_at} IS NULL) OR (${table.body_state}='retired' AND ${integerBetween(table.retired_at, 0, Number.MAX_SAFE_INTEGER)} AND ${table.retired_at}>=${table.expires_at}))`),
  check("im_kernel_media_body_accounting_check", sql`${integerBetween(table.accounted_records, 3, 3)} AND ${integerBetween(table.accounted_bytes, 1, 268435456)}`),
  check("im_kernel_media_body_record_check", sql`CASE WHEN typeof(${table.record})='text' AND length(CAST(${table.record} AS BLOB)) BETWEEN 1 AND 65536 AND json_valid(${table.record}) THEN coalesce(json_type(${table.record})='object' AND json_type(${table.record},'$.version')='integer' AND json_extract(${table.record},'$.version')=1 AND json_extract(${table.record},'$.identity.originalBindingVersion')=2 AND json_extract(${table.record},'$.identity.messageID')=${table.message_id} AND json_extract(${table.record},'$.identity.groupID')=${table.group_id} AND json_extract(${table.record},'$.identity.workspaceID')=${table.workspace_id} AND json_extract(${table.record},'$.identity.sourceHash')=${table.source_hash} AND json_extract(${table.record},'$.identity.expiresAt')=${table.expires_at} AND json_extract(${table.record},'$.identityHash')=${table.identity_hash} AND json_extract(${table.record},'$.bodyState')=${table.body_state} AND json_extract(${table.record},'$.retiredAt') IS ${table.retired_at},0) ELSE 0 END`),
  index("im_kernel_media_body_expiry_idx").on(table.body_state, table.expires_at, table.message_id),
  index("im_kernel_media_body_scope_idx").on(table.workspace_id, table.source_hash, table.body_state, table.expires_at, table.message_id),
])
