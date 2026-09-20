import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import type { ContentLoadState, ContentPermissionBinding } from "../contract/capability-load"

// W4 — durable `session_capability_load` receipt table (design §7.5 "Durable receipt",
// docs/core-v2.0-beta/v2.0-design.md §W4 步骤 1/3). Each row is one durable load receipt:
// the frozen contract `CapabilityLoadReceipt` is stored field-by-field (snake_case
// columns; the tagged `state` union and the `permissionBinding` are JSON columns), plus
// the derived `capability_id` the receipt does not carry top-level (it is bound through
// `body_ref`/the request) — the unique index includes the catalog snapshot so each Context
// Epoch can restore its own load facts without mixing or suppressing another snapshot.
//
// The matching TypeScript migration is generated from this schema by
// `bun run script/migration.ts` (drizzle-kit; the generated id is the migration id in
// migration.gen.ts), so the table and the schema never drift.
export const SessionCapabilityLoadTable = sqliteTable(
  "session_capability_load",
  {
    load_id: text().primaryKey(),
    schema_version: text().notNull(),
    content_kind: text().notNull(),
    session_id: text().notNull(),
    activity_id: text().notNull(),
    turn_id: text().notNull(),
    catalog_snapshot_id: text().notNull(),
    /** Optional member-pack id (a capability load never carries one; the column is shared with the pack lane). */
    pack_id: text(),
    /** Derived from the load request (the frozen receipt binds identity through body_ref; the uniqueness key needs it columnar). */
    capability_id: text().notNull(),
    version: text().notNull(),
    body_hash: text().notNull(),
    runtime_hash: text().notNull(),
    permission_hash: text().notNull(),
    permission_binding: text({ mode: "json" }).$type<ContentPermissionBinding>().notNull(),
    runtime_compatibility_hash: text().notNull(),
    request_hash: text().notNull(),
    result_hash: text().notNull(),
    level: text().notNull(),
    body_ref: text().notNull(),
    supersedes: text(),
    token_count: integer().notNull(),
    byte_count: integer().notNull(),
    budget_state: text().notNull(),
    new_loads_this_turn: integer().notNull(),
    new_tokens_this_turn: integer().notNull(),
    context_epoch: text().notNull(),
    loaded_at: integer().notNull(),
    state: text({ mode: "json" }).$type<ContentLoadState>().notNull(),
  },
  (table) => [
    uniqueIndex("session_capability_load_snapshot_capability_body_idx").on(
      table.session_id,
      table.catalog_snapshot_id,
      table.capability_id,
      table.body_hash,
    ),
    index("session_capability_load_session_idx").on(table.session_id, table.loaded_at),
  ],
)
