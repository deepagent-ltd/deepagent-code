import { sql } from "drizzle-orm"
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"

// A binding selects an ordinary Session; command rows retain the original Session
// when the owner explicitly starts a new conversation Session.
export const IMDacBindingTable = sqliteTable("im_dac_binding", {
  id: text().primaryKey(),
  identity_key: text().notNull(),
  owner_id: text().notNull(),
  account_key: text().notNull(),
  executor_id: text().notNull(),
  conversation_key: text().notNull(),
  group_id: text().notNull(),
  project_id: text().notNull(),
  directory: text().notNull(),
  workspace_id: text(),
  current_session_id: text().notNull(),
  generation: integer().notNull(),
  created_at: integer().notNull(),
  updated_at: integer().notNull(),
}, (table) => [uniqueIndex("im_dac_binding_identity_idx").on(table.identity_key), check("im_dac_binding_generation_check", sql`${table.generation} >= 1`)])

export const IMDacCommandTable = sqliteTable("im_dac_command", {
  id: text().primaryKey(),
  command_id: text().notNull(),
  binding_id: text().notNull().references(() => IMDacBindingTable.id, { onDelete: "restrict" }),
  request_hash: text().notNull(),
  text: text().notNull(),
  model: text({ mode: "json" }).$type<{ id: string; providerID: string }>(),
  reference_ids: text({ mode: "json" }).$type<readonly string[]>().notNull(),
  references: text({ mode: "json" }).$type<readonly { messageID: string; content: string }[]>().notNull(),
  new_session: integer({ mode: "boolean" }).notNull(),
  session_id: text().notNull(),
  input_id: text().notNull(),
  delivery: text().$type<"queue" | "steer">().notNull(),
  state: text().$type<"pending" | "admitted" | "rejected">().notNull(),
  created_at: integer().notNull(),
  admitted_at: integer(),
}, (table) => [
  uniqueIndex("im_dac_command_input_idx").on(table.input_id),
  uniqueIndex("im_dac_command_exact_idx").on(table.binding_id, table.command_id),
  index("im_dac_command_pending_idx").on(table.state, table.created_at),
  check("im_dac_command_state_check", sql`${table.state} IN ('pending','admitted','rejected')`),
  check("im_dac_command_delivery_check", sql`${table.delivery} IN ('queue','steer')`),
])
