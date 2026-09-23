import { createHash } from "node:crypto"
import { Context, Effect, Layer } from "effect"
import { eq } from "drizzle-orm"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiMiddleware } from "effect/unstable/httpapi"
import { Database } from "@deepagent-code/core/database/database"
import { ProxyTenantTable } from "@deepagent-code/core/proxy/sql"
import { RuntimeFlags } from "@/effect/runtime-flags"

export class ProxyTenantContext extends Context.Service<ProxyTenantContext, typeof ProxyTenantTable.$inferSelect>()(
  "@deepagent-code/ProxyTenantContext",
) {}

export class ProxyAuthorization extends HttpApiMiddleware.Service<
  ProxyAuthorization,
  { provides: ProxyTenantContext }
>()("@deepagent-code/ProxyAuthorization") {}

export function proxyError(status: number, code: string, message: string) {
  return HttpServerResponse.jsonUnsafe(
    {
      error: {
        message,
        type: status === 401 ? "authentication_error" : status >= 500 ? "api_error" : "invalid_request_error",
        code,
      },
    },
    { status, headers: { "cache-control": "no-store" } },
  )
}

export const proxyAuthorizationLayer = Layer.effect(
  ProxyAuthorization,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const flags = yield* RuntimeFlags.Service
    return ProxyAuthorization.of((effect) =>
      Effect.gen(function* () {
        if (!flags.gateway) return proxyError(404, "gateway_disabled", "Gateway is disabled")
        const request = yield* HttpServerRequest.HttpServerRequest
        const token = /^Bearer\s+([^\s]+)$/i.exec(request.headers.authorization ?? "")?.[1]
        if (!token) return proxyError(401, "invalid_api_key", "Invalid API key")
        const keyHash = createHash("sha256").update(token).digest("hex")
        const result = yield* db.select().from(ProxyTenantTable).where(eq(ProxyTenantTable.key_hash, keyHash)).get().pipe(
          Effect.match({
            onFailure: () => ({ unavailable: true as const }),
            onSuccess: (value) => ({ unavailable: false as const, value }),
          }),
        )
        if (result.unavailable) return proxyError(503, "gateway_unavailable", "Gateway is unavailable")
        const tenant = result.value
        if (!tenant?.enabled) return proxyError(401, "invalid_api_key", "Invalid API key")
        return yield* effect.pipe(Effect.provideService(ProxyTenantContext, tenant))
      }),
    )
  }),
)

export const proxyStartupGate = Layer.effectDiscard(
  Effect.gen(function* () {
    if (!(yield* RuntimeFlags.Service).gateway) return
    const { db } = yield* Database.Service
    const tenant = yield* db
      .select({ id: ProxyTenantTable.id })
      .from(ProxyTenantTable)
      .where(eq(ProxyTenantTable.enabled, true))
      .limit(1)
    if (tenant.length === 0) return yield* Effect.die(new Error("Gateway enabled without an active proxy tenant"))
  }),
)
