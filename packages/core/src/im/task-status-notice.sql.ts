import { sql } from "drizzle-orm"
import { check, foreignKey, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import type { IMTaskStatusNoticeSchema } from "./task-status-notice.schema"
import { IMTaskRequestTable } from "./task-authority.sql"

// Immutable disposition and disclosure identity. Outbox/transport rows follow this insert;
// no FK to those not-yet-created rows or to a possibly absent execution Session is valid.
export const IMTaskStatusNoticeTable = sqliteTable("im_task_status_notice", {
  notice_id: text().primaryKey().notNull(), instance_id: text().notNull(), actor_id: text().notNull(),
  request_id: text().notNull(), request_revision: integer().notNull(), request_hash: text().notNull(),
  source_id: text().notNull(), source_message_id: text().notNull(), source_proof_hash: text().notNull(), source_snapshot_hash: text().notNull(),
  kind: text().$type<IMTaskStatusNoticeSchema.Kind>().notNull(), occurrence_key: text().notNull(), basis_hash: text().notNull(),
  grant_id: text(), grant_revision: integer(), work_id: text(), session_id: text(), control_revision: integer(),
  group_id: text().notNull(), agent_id: text().notNull(), outbox_id: text().notNull(), delivery_message_id: text().notNull(),
  record: text().notNull(), record_hash: text().notNull(), record_bytes: integer().notNull(), created_at: integer().notNull(),
}, (table) => [
  foreignKey({ columns: [table.request_id], foreignColumns: [IMTaskRequestTable.request_id] }).onDelete("restrict").onUpdate("restrict"),
  uniqueIndex("im_task_notice_occurrence_idx").on(table.instance_id, table.request_id, table.occurrence_key),
  uniqueIndex("im_task_notice_refused_idx").on(table.request_id).where(sql`${table.kind}='refused'`),
  uniqueIndex("im_task_notice_outbox_idx").on(table.outbox_id),
  uniqueIndex("im_task_notice_delivery_idx").on(table.delivery_message_id),
  index("im_task_notice_instance_idx").on(table.instance_id, table.created_at, table.notice_id),
  index("im_task_notice_request_idx").on(table.request_id, table.created_at, table.notice_id),
  check("im_task_notice_kind_check", sql`${table.kind} IN ('cancel_requested','recovery_required','refused')`),
  check("im_task_notice_record_check", sql`json_valid(${table.record}) AND typeof(${table.record_bytes})='integer' AND ${table.record_bytes} BETWEEN 2 AND 32768 AND ${table.record_bytes}=length(CAST(${table.record} AS BLOB))`),
  check("im_task_notice_revision_check", sql`${table.request_revision}>0 AND ${table.created_at}>=0 AND (${table.grant_revision} IS NULL OR ${table.grant_revision}>0) AND (${table.control_revision} IS NULL OR ${table.control_revision}>0)`),
  check("im_task_notice_refused_check", sql`${table.kind}!='refused' OR (${table.grant_id} IS NULL AND ${table.grant_revision} IS NULL AND ${table.work_id} IS NULL AND ${table.session_id} IS NULL AND ${table.control_revision} IS NULL)`),
])
