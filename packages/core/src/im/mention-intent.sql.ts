import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { sql } from "drizzle-orm"
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

/** Mirrors KernelReader.accounting: UTF-8 string bytes, eight bytes per number,
 * and one fixed record overhead. Aggregation never materializes prompt bodies. */
export const IMMentionIntentBytes = sql<number>`1024 + 16
  + CASE WHEN ${IMMentionIntentTable.conversation_type} IS NULL THEN 0 ELSE 8 END
  + ${sql.join([IMMentionIntentTable.id, IMMentionIntentTable.message_id, IMMentionIntentTable.agent_name,
    IMMentionIntentTable.directory, IMMentionIntentTable.workspace_id, IMMentionIntentTable.user_id,
    IMMentionIntentTable.origin, IMMentionIntentTable.receiver_id, IMMentionIntentTable.conversation_id,
    IMMentionIntentTable.resolved_agent, IMMentionIntentTable.session_id, IMMentionIntentTable.input_id,
    IMMentionIntentTable.status, IMMentionIntentTable.last_error].map((column) => sql`coalesce(length(CAST(${column} AS BLOB)),0)`), sql` + `)}`
