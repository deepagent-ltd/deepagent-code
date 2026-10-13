import { sql } from "drizzle-orm"
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"

// Session and trigger IDs are polymorphic (Activity InputID and notice RequestID
// are legal). A mandatory Session/Message FK would fabricate their authority.
export const IMReplyOutboxTable = sqliteTable(
  "im_reply_outbox",
  {
    id: text().primaryKey(),
    session_id: text().notNull(),
    group_id: text().notNull(),
    agent_id: text().notNull(),
    trigger_message_id: text(),
    reply_message_id: text().notNull(),
    delivery_message_id: text(),
    reply_text: text().notNull(),
    body_state: text().$type<"live" | "retired">().notNull().default("live"),
    status: text().$type<"pending" | "delivering" | "delivered" | "dead">().notNull().default("pending"),
    attempts: integer().notNull().default(0),
    available_at: integer().notNull().default(0),
    lease_owner: text(),
    lease_expires_at: integer(),
    last_error: text(),
    time_created: integer().notNull(),
    time_updated: integer().notNull(),
    time_delivered: integer(),
  },
  (table) => [
    index("im_reply_outbox_due_idx").on(table.status, table.available_at, table.lease_expires_at),
    uniqueIndex("im_reply_outbox_session_reply_idx").on(table.session_id, table.reply_message_id),
    uniqueIndex("im_reply_outbox_delivery_message_idx").on(table.delivery_message_id),
    check("im_reply_outbox_status_check", sql`${table.status} IN ('pending','delivering','delivered','dead')`),
    check(
      "im_reply_outbox_delivery_identity_check",
      sql`${table.delivery_message_id} IS NOT NULL AND typeof(${table.delivery_message_id})='text' AND length(${table.delivery_message_id})=51 AND substr(${table.delivery_message_id},1,11)='imsg_reply_' AND substr(${table.delivery_message_id},12) NOT GLOB '*[^0-9a-f]*'`,
    ),
    check(
      "im_reply_outbox_body_check",
      sql`${table.body_state}='live' OR (${table.body_state}='retired' AND ${table.reply_text}='' AND ${table.status}='delivered' AND ${table.time_delivered} IS NOT NULL AND ${table.lease_owner} IS NULL AND ${table.lease_expires_at} IS NULL)`,
    ),
  ],
)
