import { sql } from "drizzle-orm"
import { check, foreignKey, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { AttachmentTable, GroupTable, MessageTable } from "./sql"
import { IMKernelDeliveryTable } from "./kernel-delivery.sql"
import { MediaUploadCheckpointModel } from "./media-upload-checkpoint.model"

const hash = (value: unknown) => sql`length(${value})=64 AND ${value} NOT GLOB '*[^0-9a-f]*'`
const number = (value: unknown, minimum: number, maximum = Number.MAX_SAFE_INTEGER) => sql`typeof(${value})='integer' AND ${value} BETWEEN ${sql.raw(String(minimum))} AND ${sql.raw(String(maximum))}`
const uuid = (value: unknown) => sql`length(${value})=36 AND length(CAST(${value} AS BLOB))=36 AND ${value} NOT GLOB '*[^0-9a-f-]*' AND substr(${value},9,1)='-' AND substr(${value},14,1)='-' AND substr(${value},15,1)='4' AND substr(${value},19,1)='-' AND substr(${value},20,1) IN ('8','9','a','b') AND substr(${value},24,1)='-'`

export const IMMediaUploadMeterTable = sqliteTable("im_media_upload_meter", {
  meter_id: integer().primaryKey(), version: integer().notNull(), custody_id: text().notNull(), revision: integer().notNull(),
  used_records: integer().notNull(), used_bytes: integer().notNull(), created_at: integer().notNull(), updated_at: integer().notNull(),
}, (table) => [
  uniqueIndex("im_media_upload_meter_custody_idx").on(table.custody_id),
  check("im_media_upload_meter_identity_check", sql`${number(table.meter_id,1,1)} AND ${number(table.version,1,1)} AND ${uuid(table.custody_id)} AND ${number(table.revision,1)} AND ${number(table.created_at,0)} AND ${number(table.updated_at,0)}`),
  check("im_media_upload_meter_capacity_check", sql`${number(table.used_records,1,MediaUploadCheckpointModel.RECORD_LIMIT)} AND ${number(table.used_bytes,MediaUploadCheckpointModel.METER_BYTES,MediaUploadCheckpointModel.BYTE_LIMIT)}`),
])

/** A pre-Message continuation owns only bounded metadata. Successful handoff
 * deletes it in the same transaction as real receipt/media custody. */
export const IMMediaUploadCheckpointTable = sqliteTable("im_media_upload_checkpoint", {
  checkpoint_id: text().primaryKey().notNull(), meter_id: integer().notNull(), custody_id: text().notNull(),
  attachment_id: text().notNull(), group_id: text().notNull(), planned_message_id: text(),
  origin_hash: text().notNull(), plan_hash: text(), remote_hash: text(), record: text().notNull(), record_hash: text().notNull(),
  phase: text().$type<typeof MediaUploadCheckpointModel.Phase.Type>().notNull(),
  body_verified: integer().notNull(), begin_dispatched: integer().notNull(), attempt_owner: text(),
  attempt_revision: integer().notNull(), attempt_expires_at: integer(), current_source_hash: text(),
  original_local_expires_at: integer().notNull(), original_remote_expires_at: integer(),
  message_ref: text(), receipt_ref: text(), local_revision: integer().notNull(),
  accounted_records: integer().notNull(), accounted_bytes: integer().notNull(), created_at: integer().notNull(), updated_at: integer().notNull(),
}, (table) => [
  foreignKey({columns:[table.meter_id],foreignColumns:[IMMediaUploadMeterTable.meter_id]}).onDelete("restrict").onUpdate("restrict"),
  foreignKey({columns:[table.custody_id],foreignColumns:[IMMediaUploadMeterTable.custody_id]}).onDelete("restrict").onUpdate("restrict"),
  foreignKey({columns:[table.attachment_id],foreignColumns:[AttachmentTable.id]}).onDelete("restrict").onUpdate("restrict"),
  foreignKey({columns:[table.group_id],foreignColumns:[GroupTable.id]}).onDelete("restrict").onUpdate("restrict"),
  foreignKey({columns:[table.message_ref],foreignColumns:[MessageTable.id]}).onDelete("restrict").onUpdate("restrict"),
  foreignKey({columns:[table.receipt_ref],foreignColumns:[IMKernelDeliveryTable.message_id]}).onDelete("restrict").onUpdate("restrict"),
  uniqueIndex("im_media_upload_attachment_idx").on(table.attachment_id),
  index("im_media_upload_message_idx").on(table.planned_message_id,table.attachment_id),
  index("im_media_upload_expiry_idx").on(table.original_local_expires_at,table.checkpoint_id),
  check("im_media_upload_identity_check", sql`${hash(table.checkpoint_id)} AND ${number(table.meter_id,1,1)} AND ${uuid(table.custody_id)} AND ${hash(table.origin_hash)} AND ${hash(table.record_hash)} AND (${table.plan_hash} IS NULL OR ${hash(table.plan_hash)}) AND (${table.remote_hash} IS NULL OR ${hash(table.remote_hash)}) AND ${number(table.local_revision,1)}`),
  check("im_media_upload_accounting_check", sql`${number(table.accounted_records,1,1)} AND ${number(table.accounted_bytes,1,MediaUploadCheckpointModel.RECORD_BYTES)} AND ${number(table.created_at,0)} AND ${number(table.updated_at,0)} AND ${number(table.original_local_expires_at,1)} AND (${table.original_remote_expires_at} IS NULL OR ${number(table.original_remote_expires_at,1)})`),
  check("im_media_upload_attempt_check", sql`${number(table.body_verified,0,1)} AND ${number(table.begin_dispatched,0,1)} AND (${table.begin_dispatched}=0 OR ${table.body_verified}=1) AND ${number(table.attempt_revision,0)} AND ((${table.attempt_owner} IS NULL AND ${table.attempt_expires_at} IS NULL) OR (${uuid(table.attempt_owner)} AND ${number(table.attempt_expires_at,0)} AND ${table.attempt_revision}>0 AND ${table.current_source_hash} IS NOT NULL)) AND (${table.current_source_hash} IS NULL OR ${hash(table.current_source_hash)})`),
  check("im_media_upload_phase_check", sql`${table.phase} IN ('eligible','planned','uploading','uploaded','unknown_upload','attached','expired','cancelled') AND (${table.phase}!='eligible' OR (${table.planned_message_id} IS NULL AND ${table.plan_hash} IS NULL AND ${table.remote_hash} IS NULL AND ${table.original_remote_expires_at} IS NULL AND ${table.message_ref} IS NULL AND ${table.receipt_ref} IS NULL AND ${table.body_verified}=0 AND ${table.begin_dispatched}=0 AND ${table.attempt_owner} IS NULL AND ${table.attempt_revision}=0 AND ${table.current_source_hash} IS NULL)) AND (${table.phase}='eligible' OR (${table.planned_message_id} IS NOT NULL AND ${table.plan_hash} IS NOT NULL)) AND (${table.phase}='attached' OR (${table.message_ref} IS NULL AND ${table.receipt_ref} IS NULL)) AND (${table.phase}!='attached' OR ${table.message_ref}=${table.planned_message_id}) AND (${table.receipt_ref} IS NULL OR ${table.receipt_ref}=${table.message_ref})`),
  check("im_media_upload_record_check", sql`CASE WHEN json_valid(${table.record}) AND length(CAST(${table.record} AS BLOB)) BETWEEN 1 AND ${sql.raw(String(MediaUploadCheckpointModel.RECORD_BYTES))} THEN coalesce(json_extract(${table.record},'$.version')=1 AND json_extract(${table.record},'$.checkpointID')=${table.checkpoint_id} AND json_extract(${table.record},'$.origin.custodyID')=${table.custody_id} AND json_extract(${table.record},'$.origin.groupID')=${table.group_id} AND json_extract(${table.record},'$.origin.attachment.id')=${table.attachment_id} AND json_extract(${table.record},'$.origin.localExpiresAt')=${table.original_local_expires_at} AND json_extract(${table.record},'$.originHash')=${table.origin_hash} AND json_extract(${table.record},'$.plan.messageID') IS ${table.planned_message_id} AND json_extract(${table.record},'$.planHash') IS ${table.plan_hash} AND json_extract(${table.record},'$.remoteHash') IS ${table.remote_hash} AND json_extract(${table.record},'$.remote.expiresAt') IS ${table.original_remote_expires_at} AND json_extract(${table.record},'$.phase')=${table.phase} AND json_extract(${table.record},'$.bodyVerified')=${table.body_verified} AND json_extract(${table.record},'$.beginDispatched')=${table.begin_dispatched} AND json_extract(${table.record},'$.attemptOwner') IS ${table.attempt_owner} AND json_extract(${table.record},'$.attemptRevision')=${table.attempt_revision} AND json_extract(${table.record},'$.attemptExpiresAt') IS ${table.attempt_expires_at} AND json_extract(${table.record},'$.currentSourceHash') IS ${table.current_source_hash} AND json_extract(${table.record},'$.messageRef') IS ${table.message_ref} AND json_extract(${table.record},'$.receiptRef') IS ${table.receipt_ref},0) ELSE 0 END`),
])
