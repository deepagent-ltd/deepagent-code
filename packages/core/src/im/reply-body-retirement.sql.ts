import { sql } from "drizzle-orm"
import { check, foreignKey, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { IMKernelDeliveryTable } from "./kernel-delivery.sql"
import { IMReplyOutboxTable } from "./reply-outbox.sql"
import { GroupTable, MessageTable } from "./sql"
import type { ReplyBodyRetirementModel } from "./reply-body-retirement.model"

const integerBetween = (column: unknown, min: number, max: number) =>
  sql`typeof(${column})='integer' AND ${column} BETWEEN ${sql.raw(String(min))} AND ${sql.raw(String(max))}`
const hash = (column: unknown) =>
  sql`typeof(${column})='text' AND length(CAST(${column} AS BLOB))=64 AND ${column} NOT GLOB '*[^0-9a-f]*'`
export const IMReplyBodyMeterTable = sqliteTable(
  "im_reply_body_meter",
  {
    meter_id: integer().primaryKey(),
    version: integer().notNull(),
    custody_id: text().notNull(),
    revision: integer().notNull(),
    used_records: integer().notNull(),
    used_bytes: integer().notNull(),
  },
  (table) => [
    check(
      "im_reply_body_meter_identity_check",
      sql`${integerBetween(table.meter_id, 1, 1)} AND ${integerBetween(table.version, 1, 1)} AND length(CAST(${table.custody_id} AS BLOB))=36 AND ${table.custody_id} NOT GLOB '*[^0-9a-f-]*' AND substr(${table.custody_id},9,1)='-' AND substr(${table.custody_id},14,1)='-' AND substr(${table.custody_id},15,1)='4' AND substr(${table.custody_id},19,1)='-' AND substr(${table.custody_id},20,1) IN ('8','9','a','b') AND substr(${table.custody_id},24,1)='-'`,
    ),
    check(
      "im_reply_body_meter_capacity_check",
      sql`${integerBetween(table.revision, 1, Number.MAX_SAFE_INTEGER)} AND ${integerBetween(table.used_records, 1, 100000)} AND ${integerBetween(table.used_bytes, 76, 268435456)}`,
    ),
    uniqueIndex("im_reply_body_meter_custody_idx").on(table.custody_id),
  ],
)
export const IMReplyBodyTable = sqliteTable(
  "im_reply_body",
  {
    outbox_id: text().primaryKey().notNull(),
    meter_id: integer().notNull(),
    version: integer().notNull(),
    origin_kind: text().$type<typeof ReplyBodyRetirementModel.OriginKind.Type>().notNull(),
    custody_state: text().$type<typeof ReplyBodyRetirementModel.Custody.Type>().notNull(),
    body_state: text().$type<"live" | "retired">().notNull(),
    group_ref: text(),
    local_message_id: text(),
    receipt_message_id: text(),
    original_expires_at: integer(),
    retired_at: integer(),
    origin_identity_hash: text().notNull(),
    message_identity_hash: text(),
    transport_identity_hash: text(),
    record: text().notNull(),
    record_hash: text().notNull(),
    mutable_facts_hash: text().notNull(),
    local_revision: integer().notNull(),
    accounted_records: integer().notNull(),
    accounted_bytes: integer().notNull(),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
  },
  (table) => [
    foreignKey({ columns: [table.outbox_id], foreignColumns: [IMReplyOutboxTable.id] })
      .onDelete("restrict")
      .onUpdate("restrict"),
    foreignKey({ columns: [table.meter_id], foreignColumns: [IMReplyBodyMeterTable.meter_id] })
      .onDelete("restrict")
      .onUpdate("restrict"),
    foreignKey({ columns: [table.group_ref], foreignColumns: [GroupTable.id] })
      .onDelete("restrict")
      .onUpdate("restrict"),
    foreignKey({ columns: [table.local_message_id], foreignColumns: [MessageTable.id] })
      .onDelete("restrict")
      .onUpdate("restrict"),
    foreignKey({ columns: [table.receipt_message_id], foreignColumns: [IMKernelDeliveryTable.message_id] })
      .onDelete("restrict")
      .onUpdate("restrict"),
    uniqueIndex("im_reply_body_message_idx").on(table.local_message_id),
    uniqueIndex("im_reply_body_receipt_idx").on(table.receipt_message_id),
    index("im_reply_body_expiry_idx").on(table.body_state, table.original_expires_at, table.outbox_id),
    check(
      "im_reply_body_identity_check",
      sql`${integerBetween(table.meter_id, 1, 1)} AND ${integerBetween(table.version, 1, 1)} AND ${integerBetween(table.local_revision, 1, Number.MAX_SAFE_INTEGER)} AND ${hash(table.origin_identity_hash)} AND ${hash(table.record_hash)} AND ${hash(table.mutable_facts_hash)} AND (${table.message_identity_hash} IS NULL OR ${hash(table.message_identity_hash)}) AND (${table.transport_identity_hash} IS NULL OR ${hash(table.transport_identity_hash)})`,
    ),
    check(
      "im_reply_body_custody_check",
      sql`(${table.custody_state}='kernel' AND ${table.group_ref} IS NOT NULL AND ${table.local_message_id} IS NOT NULL AND ${table.receipt_message_id}=${table.local_message_id} AND ${table.message_identity_hash} IS NOT NULL AND ${table.transport_identity_hash} IS NOT NULL AND ${table.original_expires_at} IS NOT NULL) OR (${table.custody_state}='local' AND ${table.group_ref} IS NOT NULL AND ${table.local_message_id} IS NOT NULL AND ${table.message_identity_hash} IS NOT NULL AND ${table.receipt_message_id} IS NULL AND ${table.transport_identity_hash} IS NULL AND ${table.original_expires_at} IS NULL) OR (${table.custody_state} IN ('unbound','legacy_unbound') AND ${table.local_message_id} IS NULL AND ${table.receipt_message_id} IS NULL AND ${table.message_identity_hash} IS NULL AND ${table.transport_identity_hash} IS NULL AND ${table.original_expires_at} IS NULL AND (${table.custody_state}!='legacy_unbound' OR ${table.origin_kind}='legacy_unbound'))`,
    ),
    check(
      "im_reply_body_lifecycle_check",
      sql`(${table.body_state}='live' AND ${table.retired_at} IS NULL) OR (${table.body_state}='retired' AND ${table.custody_state}='kernel' AND ${table.retired_at}=${table.original_expires_at})`,
    ),
    check(
      "im_reply_body_accounting_check",
      sql`${integerBetween(table.accounted_records, 2, 4)} AND ${table.accounted_records}=2+(${table.local_message_id} IS NOT NULL)+(${table.receipt_message_id} IS NOT NULL) AND ${integerBetween(table.accounted_bytes, 1, 268435456)} AND ${integerBetween(table.created_at, 0, Number.MAX_SAFE_INTEGER)} AND ${integerBetween(table.updated_at, 0, Number.MAX_SAFE_INTEGER)}`,
    ),
    check(
      "im_reply_body_record_check",
      sql`CASE WHEN json_valid(${table.record}) AND length(CAST(${table.record} AS BLOB)) BETWEEN 1 AND 65536 THEN coalesce(json_extract(${table.record},'$.version')=1 AND json_extract(${table.record},'$.origin.outboxID')=${table.outbox_id} AND json_extract(${table.record},'$.origin.kind')=${table.origin_kind} AND json_extract(${table.record},'$.originHash')=${table.origin_identity_hash} AND json_extract(${table.record},'$.custody')=${table.custody_state} AND json_extract(${table.record},'$.bodyState')=${table.body_state} AND json_extract(${table.record},'$.retiredAt') IS ${table.retired_at} AND json_extract(${table.record},'$.message.messageID') IS ${table.local_message_id} AND json_extract(${table.record},'$.transport.binding.messageID') IS ${table.receipt_message_id} AND json_extract(${table.record},'$.transport.binding.expiresAt') IS ${table.original_expires_at},0) ELSE 0 END`,
    ),
  ],
)
