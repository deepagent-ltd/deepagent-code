import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { MessageTable } from "./sql"

// Only verified live delivery or a local authenticated send can create an intent. History writes
// never synthesize these rows. They compensate admission, while SessionV2 remains execution owner.
export const IMMentionIntentTable = sqliteTable(
  "im_mention_intent",
  {
    id: text().primaryKey(),
    message_id: text()
      .notNull()
      .references(() => MessageTable.id, { onDelete: "cascade" }),
    agent_name: text().notNull(),
    directory: text().notNull(),
    workspace_id: text().notNull(),
    user_id: text().notNull(),
    origin: text().$type<"local" | "kernel_live">().notNull(),
    receiver_id: text(),
    conversation_type: integer(),
    conversation_id: text(),
    resolved_agent: text(),
    session_id: text(),
    input_id: text(),
    status: text().$type<"pending" | "admitted" | "rejected">().notNull().default("pending"),
    last_error: text(),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
  },
  (table) => [
    uniqueIndex("im_mention_intent_source_agent").on(table.message_id, table.agent_name),
    index("im_mention_intent_pending").on(table.origin, table.status, table.receiver_id, table.updated_at),
  ],
)
