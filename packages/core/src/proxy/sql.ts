import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"

export const ProxyTenantTable = sqliteTable(
  "proxy_tenant",
  {
    id: text().primaryKey(),
    key_hash: text().notNull(),
    key_fingerprint: text().notNull(),
    directory: text().notNull(),
    model_allowlist: text({ mode: "json" }).$type<string[]>().notNull(),
    tier: text().$type<"passthrough" | "context" | "full">().notNull(),
    quota_requests_per_minute: integer().notNull(),
    quota_tokens_per_day: integer().notNull(),
    lane_limit: integer().notNull(),
    deadline_ms: integer().notNull(),
    enabled: integer({ mode: "boolean" }).notNull(),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
  },
  (table) => [uniqueIndex("proxy_tenant_key_hash_idx").on(table.key_hash)],
)

export const ProxyRequestLedgerTable = sqliteTable(
  "proxy_request_ledger",
  {
    request_id: text().primaryKey(),
    request_hash: text().notNull(),
    tenant_id: text().notNull().references(() => ProxyTenantTable.id),
    lane_session_id: text(),
    tier: text().$type<"passthrough" | "context" | "full">().notNull(),
    provider_id: text().notNull(),
    model_id: text().notNull(),
    usage_input: integer(),
    usage_output: integer(),
    usage_reasoning: integer(),
    usage_cache_read: integer(),
    usage_cache_write: integer(),
    usage_source: text().$type<"provider" | "estimated">(),
    cost_total: real(),
    finish_reason: text(),
    admitted_at: integer().notNull(),
    first_token_at: integer(),
    completed_at: integer(),
    stream: integer({ mode: "boolean" }).notNull(),
  },
  (table) => [index("proxy_request_ledger_tenant_admitted_idx").on(table.tenant_id, table.admitted_at)],
)
