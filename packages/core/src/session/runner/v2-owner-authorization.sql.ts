import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"

export const V2OwnerAuthorizationTable = sqliteTable(
  "session_v2_owner_authorization",
  {
    authorization_id: text().primaryKey(),
    campaign_id: text().notNull(),
    subject_commit: text().notNull(),
    subject_tree: text().notNull(),
    schema_digest: text().notNull(),
    build_id: text().notNull(),
    package_digest: text().notNull(),
    valid_from: integer().notNull(),
    expires_at: integer().notNull(),
    status: text().$type<"active" | "revoked">().notNull(),
    signature_digest: text().notNull(),
    authorization_digest: text().notNull(),
    created_at: integer().notNull(),
    revoked_at: integer(),
  },
  (table) => [
    uniqueIndex("session_v2_owner_authorization_campaign_idx").on(table.campaign_id),
    index("session_v2_owner_authorization_active_idx").on(table.status, table.expires_at, table.campaign_id),
  ],
)
