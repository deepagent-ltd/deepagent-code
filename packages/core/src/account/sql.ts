import { sqliteTable, text, integer, primaryKey, check } from "drizzle-orm/sqlite-core"

import { sql } from "drizzle-orm"

import { AccountV2 } from "../account"
import { Timestamps } from "../database/schema.sql"

export const AccountTable = sqliteTable(
  "account",
  {
    id: text().$type<AccountV2.ID>().primaryKey(),
    email: text().notNull(),
    url: text().notNull(),
    access_token: text().$type<AccountV2.AccessToken>().notNull(),
    refresh_token: text().$type<AccountV2.RefreshToken>().notNull(),
    token_expiry: integer(),
    identity_generation: text(),
    ...Timestamps,
  },
  (table) => [
    check(
      "account_identity_generation_check",
      sql`${table.identity_generation} IS NULL OR (typeof(${table.identity_generation}) = 'text' AND length(${table.identity_generation}) = 64 AND ${table.identity_generation} NOT GLOB '*[^0-9a-f]*')`,
    ),
  ],
)

export const AccountStateTable = sqliteTable(
  "account_state",
  {
    id: integer().primaryKey(),
    active_account_id: text()
      .$type<AccountV2.ID>()
      .references(() => AccountTable.id, { onDelete: "set null" }),
    active_org_id: text().$type<AccountV2.OrgID>(),
    selection_revision: integer().notNull().default(0),
  },
  (table) => [
    check(
      "account_selection_revision_check",
      sql`typeof(${table.selection_revision}) = 'integer' AND ${table.selection_revision} >= 0 AND ${table.selection_revision} <= 9007199254740991`,
    ),
  ],
)

// LEGACY
export const ControlAccountTable = sqliteTable(
  "control_account",
  {
    email: text().notNull(),
    url: text().notNull(),
    access_token: text().$type<AccountV2.AccessToken>().notNull(),
    refresh_token: text().$type<AccountV2.RefreshToken>().notNull(),
    token_expiry: integer(),
    active: integer({ mode: "boolean" })
      .notNull()
      .$default(() => false),
    ...Timestamps,
  },
  (table) => [primaryKey({ columns: [table.email, table.url] })],
)
