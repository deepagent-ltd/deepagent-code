import { sql } from "drizzle-orm"
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { EventWorkReceiptTable } from "./event-work-rule.sql"

// A controller holds no model receipt. Its source obligation survives Session/Event deletion.
export const EventWorkControllerTable = sqliteTable("event_work_controller", {
  controller_id: text().primaryKey().notNull(),
  receipt_id: text().notNull().references(() => EventWorkReceiptTable.receipt_id, { onDelete: "restrict", onUpdate: "restrict" }),
  root_work_id: text().notNull(), revision: integer().notNull(),
  state: text().$type<"pending" | "running" | "succeeded" | "failed" | "unknown">().notNull(),
  record: text().notNull(), record_hash: text().notNull(), record_bytes: integer().notNull(),
}, (table) => [
  uniqueIndex("event_work_controller_receipt_idx").on(table.receipt_id),
  uniqueIndex("event_work_controller_root_idx").on(table.root_work_id),
  index("event_work_controller_state_idx").on(table.state, table.controller_id),
  check("event_work_controller_state", sql`${table.revision}>0 AND ${table.state} IN ('pending','running','succeeded','failed','unknown')`),
  check("event_work_controller_body", sql`typeof(${table.record})='text' AND instr(${table.record},char(0))=0 AND
    typeof(${table.record_bytes})='integer' AND ${table.record_bytes} BETWEEN 2 AND 131072 AND
    ${table.record_bytes}=length(CAST(${table.record} AS BLOB)) AND CASE WHEN json_valid(${table.record}) THEN
    coalesce(json_type(${table.record})='object' AND json_extract(${table.record},'$.version')=1 AND
      json_extract(${table.record},'$.controllerID') IS ${table.controller_id} AND
      json_extract(${table.record},'$.receiptID') IS ${table.receipt_id} AND
      json_extract(${table.record},'$.rootWorkID') IS ${table.root_work_id} AND
      json_extract(${table.record},'$.revision') IS ${table.revision} AND
      json_extract(${table.record},'$.state') IS ${table.state},0) ELSE 0 END`),
  check("event_work_controller_hash", sql`typeof(${table.record_hash})='text' AND length(CAST(${table.record_hash} AS BLOB))=64
    AND ${table.record_hash} NOT GLOB '*[^0-9a-f]*'`),
])
