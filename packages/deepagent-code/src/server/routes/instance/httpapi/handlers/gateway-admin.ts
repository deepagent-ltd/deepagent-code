import { createHash } from "node:crypto"
import path from "node:path"
import { and, desc, eq, like, sql } from "drizzle-orm"
import { Effect, Option, Schema } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Database } from "@deepagent-code/core/database/database"
import { ProxyRequestLedgerTable, ProxyTenantTable } from "@deepagent-code/core/proxy/sql"
import { SessionTable } from "@deepagent-code/core/session/sql"
import { GatewayAdminApi, TenantCreate, TenantUpdate } from "../groups/gateway-admin"
import { proxyError } from "../middleware/proxy-authorization"

export const gatewayAdminHandlers = HttpApiBuilder.group(GatewayAdminApi, "proxyAdmin", (handlers) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    const tenantCreate = (input: { request: HttpServerRequest.HttpServerRequest }) => Effect.gen(function* () {
      const payload = Schema.decodeUnknownOption(TenantCreate)(yield* input.request.json.pipe(Effect.catch(() => Effect.succeed(null))))
      if (Option.isNone(payload) || !validTenant(payload.value))
        return proxyError(400, "invalid_tenant", "Invalid proxy tenant configuration")
      const keyHash = createHash("sha256").update(payload.value.key).digest("hex")
      const now = Date.now()
      const inserted = yield* db.insert(ProxyTenantTable).values({
        id: payload.value.id,
        key_hash: keyHash,
        key_fingerprint: keyHash.slice(0, 16),
        directory: path.resolve(payload.value.directory),
        model_allowlist: [...payload.value.model_allowlist],
        tier: payload.value.tier,
        permission_policy: payload.value.permission_policy,
        quota_requests_per_minute: payload.value.quota_requests_per_minute,
        quota_tokens_per_day: payload.value.quota_tokens_per_day,
        lane_limit: payload.value.lane_limit,
        deadline_ms: payload.value.deadline_ms,
        enabled: payload.value.enabled ?? true,
        created_at: now,
        updated_at: now,
      }).onConflictDoNothing().returning({ id: ProxyTenantTable.id }).get()
      if (!inserted) return proxyError(409, "tenant_conflict", "Proxy tenant or key already exists")
      return HttpServerResponse.jsonUnsafe({ id: inserted.id, key_fingerprint: keyHash.slice(0, 16) }, { status: 201 })
    }).pipe(Effect.catchCause(() => Effect.succeed(proxyError(503, "admin_unavailable", "Proxy admin is unavailable"))))

    const tenantList = () => db.select({
      id: ProxyTenantTable.id,
      key_fingerprint: ProxyTenantTable.key_fingerprint,
      directory: ProxyTenantTable.directory,
      model_allowlist: ProxyTenantTable.model_allowlist,
      tier: ProxyTenantTable.tier,
      permission_policy: ProxyTenantTable.permission_policy,
      quota_requests_per_minute: ProxyTenantTable.quota_requests_per_minute,
      quota_tokens_per_day: ProxyTenantTable.quota_tokens_per_day,
      lane_limit: ProxyTenantTable.lane_limit,
      deadline_ms: ProxyTenantTable.deadline_ms,
      enabled: ProxyTenantTable.enabled,
      created_at: ProxyTenantTable.created_at,
      updated_at: ProxyTenantTable.updated_at,
    }).from(ProxyTenantTable).orderBy(ProxyTenantTable.id).all().pipe(Effect.map((data) => ({ object: "list", data })), Effect.orDie)

    const tenantUpdate = (input: { params: { tenantID: string }; request: HttpServerRequest.HttpServerRequest }) => Effect.gen(function* () {
      const payload = Schema.decodeUnknownOption(TenantUpdate)(yield* input.request.json.pipe(Effect.catch(() => Effect.succeed(null))))
      if (Option.isNone(payload)) return proxyError(400, "invalid_tenant", "Invalid proxy tenant update")
      const current = yield* db.select().from(ProxyTenantTable).where(eq(ProxyTenantTable.id, input.params.tenantID)).get()
      if (!current) return proxyError(404, "tenant_not_found", "Proxy tenant was not found")
      const updated = { ...current, ...payload.value }
      if (!validTenant({ ...updated, permission_policy: updated.permission_policy ?? undefined, key: "existing-key-placeholder" }))
        return proxyError(400, "invalid_tenant", "Invalid proxy tenant configuration")
      yield* db.update(ProxyTenantTable).set({
        ...(payload.value.model_allowlist ? { model_allowlist: [...payload.value.model_allowlist] } : {}),
        ...(payload.value.tier ? { tier: payload.value.tier } : {}),
        ...(payload.value.permission_policy ? { permission_policy: [...payload.value.permission_policy] } : {}),
        ...(payload.value.quota_requests_per_minute === undefined ? {} : { quota_requests_per_minute: payload.value.quota_requests_per_minute }),
        ...(payload.value.quota_tokens_per_day === undefined ? {} : { quota_tokens_per_day: payload.value.quota_tokens_per_day }),
        ...(payload.value.lane_limit === undefined ? {} : { lane_limit: payload.value.lane_limit }),
        ...(payload.value.deadline_ms === undefined ? {} : { deadline_ms: payload.value.deadline_ms }),
        ...(payload.value.enabled === undefined ? {} : { enabled: payload.value.enabled }),
        updated_at: Date.now(),
      }).where(eq(ProxyTenantTable.id, input.params.tenantID)).run()
      return HttpServerResponse.jsonUnsafe({ id: input.params.tenantID, updated: true })
    }).pipe(Effect.catchCause(() => Effect.succeed(proxyError(503, "admin_unavailable", "Proxy admin is unavailable"))))

    const ledgerList = (input: { query: { tenant?: string; limit?: number } }) =>
      db.select({
        request_id: ProxyRequestLedgerTable.request_id,
        tenant_id: ProxyRequestLedgerTable.tenant_id,
        lane_session_id: ProxyRequestLedgerTable.lane_session_id,
        tier: ProxyRequestLedgerTable.tier,
        provider_id: ProxyRequestLedgerTable.provider_id,
        model_id: ProxyRequestLedgerTable.model_id,
        usage_input: ProxyRequestLedgerTable.usage_input,
        usage_output: ProxyRequestLedgerTable.usage_output,
        usage_reasoning: ProxyRequestLedgerTable.usage_reasoning,
        usage_cache_read: ProxyRequestLedgerTable.usage_cache_read,
        usage_cache_write: ProxyRequestLedgerTable.usage_cache_write,
        usage_source: ProxyRequestLedgerTable.usage_source,
        cost_total: ProxyRequestLedgerTable.cost_total,
        finish_reason: ProxyRequestLedgerTable.finish_reason,
        admitted_at: ProxyRequestLedgerTable.admitted_at,
        first_token_at: ProxyRequestLedgerTable.first_token_at,
        completed_at: ProxyRequestLedgerTable.completed_at,
      }).from(ProxyRequestLedgerTable)
        .where(input.query.tenant ? eq(ProxyRequestLedgerTable.tenant_id, input.query.tenant) : undefined)
        .orderBy(desc(ProxyRequestLedgerTable.admitted_at))
        .limit(Math.min(Math.max(input.query.limit ?? 100, 1), 1000)).all()
        .pipe(Effect.map((data) => ({ object: "list", data })), Effect.orDie)

    const laneList = (input: { query: { tenant?: string; limit?: number } }) =>
      db.select({ id: SessionTable.id, title: SessionTable.title, metadata: SessionTable.metadata,
        time_archived: SessionTable.time_archived, time_updated: SessionTable.time_updated })
        .from(SessionTable).where(and(like(SessionTable.id, "ses_proxy_%"),
          input.query.tenant ? eq(sql<string>`json_extract(${SessionTable.metadata}, '$.proxy.tenant')`, input.query.tenant) : undefined))
        .orderBy(desc(SessionTable.time_updated))
        .limit(Math.min(Math.max(input.query.limit ?? 100, 1), 1000)).all()
        .pipe(Effect.map((rows) => ({ object: "list", data: rows.flatMap((row) => {
          const proxy = row.metadata?.proxy
          if (!proxy || typeof proxy !== "object") return []
          const info = proxy as Record<string, unknown>
          if (input.query.tenant && info.tenant !== input.query.tenant) return []
          return [{ id: row.id, tenant: info.tenant, hint: info.hint, tier: info.tier,
            title: row.title, archived_at: row.time_archived, updated_at: row.time_updated }]
        }) })), Effect.orDie)

    return handlers.handleRaw("tenantCreate", tenantCreate)
      .handle("tenantList", tenantList)
      .handleRaw("tenantUpdate", tenantUpdate)
      .handleRaw("tenantDelete", (input: { params: { tenantID: string } }) =>
        Effect.gen(function* () {
          const revoked = yield* db.update(ProxyTenantTable).set({ enabled: false, updated_at: Date.now() })
            .where(eq(ProxyTenantTable.id, input.params.tenantID)).returning({ id: ProxyTenantTable.id }).get()
          if (!revoked) return proxyError(404, "tenant_not_found", "Proxy tenant was not found")
          return HttpServerResponse.empty({ status: 204 })
        }).pipe(Effect.catchCause(() => Effect.succeed(proxyError(503, "admin_unavailable", "Proxy admin is unavailable")))),
      )
      .handle("ledgerList", ledgerList)
      .handle("laneList", laneList)
  }),
)

function validTenant(input: typeof TenantCreate.Type) {
  return /^[A-Za-z0-9._:-]{1,128}$/.test(input.id) && input.key.length >= 16 &&
    path.isAbsolute(input.directory) && input.model_allowlist.every((model) => /^[^/]+\/[^/]+$/.test(model)) &&
    input.quota_requests_per_minute > 0 && input.quota_tokens_per_day > 0 &&
    input.lane_limit > 0 && input.deadline_ms >= 1_000 && input.deadline_ms <= 600_000 &&
    (input.tier !== "full" || !!input.permission_policy?.length)
}
