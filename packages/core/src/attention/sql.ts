import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { SessionTable } from "../session/sql"

export const AttentionSeenTable = sqliteTable(
  "attention_seen",
  {
    scope_key: text().notNull(),
    actor_id: text().notNull(),
    item_id: text().notNull(),
    source_revision: text().notNull(),
    session_id: text()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    seen_at: integer().notNull(),
  },
  (table) => [primaryKey({ columns: [table.scope_key, table.actor_id, table.item_id, table.source_revision] })],
)
