import { sql } from "drizzle-orm"
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"

// Payment credentials and receipt secrets live in the Host credential store.
export const IMActivationTable = sqliteTable("im_activation", {
  transaction_id: text().primaryKey(),
  source_hash: text().notNull(),
  request_hash: text().notNull(),
  name: text().notNull(),
  method: text().$type<"api_key" | "activation_code">().notNull(),
  quote_id: text().notNull(),
  state: text().$type<"pending" | "unknown" | "succeeded" | "rejected">().notNull(),
  charged_credits: integer().$type<0 | 1>(),
  credential_stored: integer({ mode: "boolean" }).notNull(),
  code: text(),
  created_at: integer().notNull(),
  updated_at: integer().notNull(),
}, (table) => [
  uniqueIndex("im_activation_pending_idx").on(table.source_hash).where(sql`${table.state} IN ('pending','unknown') OR (${table.state} = 'succeeded' AND ${table.credential_stored} = 0)`),
  index("im_activation_source_idx").on(table.source_hash, table.created_at),
  check("im_activation_state_check", sql`${table.state} IN ('pending','unknown','succeeded','rejected')`),
  check("im_activation_method_check", sql`${table.method} IN ('api_key','activation_code')`),
  check("im_activation_charge_check", sql`(${table.state} IN ('pending','unknown') AND ${table.charged_credits} IS NULL) OR (${table.state} = 'rejected' AND ${table.charged_credits} = 0) OR (${table.state} = 'succeeded' AND ${table.charged_credits} IN (0,1))`),
])
