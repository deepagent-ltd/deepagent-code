import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ConfigProvider, Effect, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { Database } from "@deepagent-code/core/database/database"
import { Flag } from "@deepagent-code/core/flag/flag"
import { ProxyTenantTable } from "@deepagent-code/core/proxy/sql"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"

describe("gateway release gate", () => {
  test("defaults off with a typed OpenAI 404 for declared and unknown /v1 routes", async () => {
    const handler = HttpRouter.toWebHandler(
      HttpApiApp.createRoutes().pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({})))),
      { disableLogger: true },
    ).handler

    for (const pathname of ["/v1/models", "/v1/embeddings"]) {
      const response = await handler(
        new Request(new URL(pathname, "http://localhost"), { headers: { authorization: "Bearer sk-test-secret" } }),
        HttpApiApp.context,
      )
      expect(response.status).toBe(404)
      expect(await response.json()).toEqual({
        error: { message: "Gateway is disabled", type: "invalid_request_error", code: "gateway_disabled" },
      })
    }
  }, 30_000)

  test("requires a durable tenant key and ignores caller-supplied directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "deepagent-proxy-test-"))
    const key = "sk-test-proxy-tenant"
    const originalDatabase = Flag.DEEPAGENT_CODE_DB
    Flag.DEEPAGENT_CODE_DB = join(directory, "proxy.sqlite")
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const { db } = yield* Database.Service
          yield* db.insert(ProxyTenantTable).values({
            id: "tenant-test",
            key_hash: createHash("sha256").update(key).digest("hex"),
            key_fingerprint: "test-fingerprint",
            directory,
            model_allowlist: [],
            tier: "passthrough",
            quota_requests_per_minute: 60,
            quota_tokens_per_day: 100_000,
            lane_limit: 8,
            deadline_ms: 120_000,
            enabled: true,
            created_at: Date.now(),
            updated_at: Date.now(),
          })
        }).pipe(Effect.provide(Database.defaultLayer)),
      )
      const handler = HttpRouter.toWebHandler(
        HttpApiApp.createRoutes().pipe(
          Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ DEEPAGENT_CODE_GATEWAY: true }))),
        ),
        { disableLogger: true },
      ).handler
      const unauthorized = await handler(new Request("http://localhost/v1/models"), HttpApiApp.context)
      expect(unauthorized.status).toBe(401)
      expect((await unauthorized.json()).error.code).toBe("invalid_api_key")

      const response = await handler(
        new Request("http://localhost/v1/models", {
          headers: { authorization: `Bearer ${key}`, "x-deepagent-code-directory": "/" },
        }),
        HttpApiApp.context,
      )
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ object: "list", data: [] })
    } finally {
      Flag.DEEPAGENT_CODE_DB = originalDatabase
      await rm(directory, { recursive: true, force: true })
    }
  }, 30_000)
})
