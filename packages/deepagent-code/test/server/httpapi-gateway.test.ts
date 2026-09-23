import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ConfigProvider, Effect, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { Database } from "@deepagent-code/core/database/database"
import { Flag } from "@deepagent-code/core/flag/flag"
import { ProxyTenantTable } from "@deepagent-code/core/proxy/sql"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { testProviderConfig } from "../lib/test-provider"

describe("gateway release gate", () => {
  test("defaults off with a typed OpenAI 404 for declared and unknown /v1 routes", async () => {
    const web = HttpRouter.toWebHandler(
      HttpApiApp.createRoutes().pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({})))),
      { disableLogger: true },
    )
    try {
      for (const pathname of ["/v1/models", "/v1/embeddings"]) {
        const response = await web.handler(
          new Request(new URL(pathname, "http://localhost"), { headers: { authorization: "Bearer sk-test-secret" } }),
          HttpApiApp.context,
        )
        expect(response.status).toBe(404)
        expect(await response.json()).toEqual({
          error: { message: "Gateway is disabled", type: "invalid_request_error", code: "gateway_disabled" },
        })
      }
    } finally {
      await web.dispose()
    }
  }, 30_000)

  test("requires a durable tenant key and ignores caller-supplied directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "deepagent-proxy-test-"))
    const key = "sk-test-proxy-tenant"
    const originalDatabase = Flag.DEEPAGENT_CODE_DB
    Flag.DEEPAGENT_CODE_DB = join(directory, "proxy.sqlite")
    const openHandlers: Array<{ dispose: () => Promise<void> }> = []
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
      const web = HttpRouter.toWebHandler(
        HttpApiApp.createRoutes().pipe(
          Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ DEEPAGENT_CODE_GATEWAY: true }))),
        ),
        { disableLogger: true },
      )
      openHandlers.push(web)
      const handler = web.handler
      const unauthorized = await handler(new Request("http://localhost/v1/models"), HttpApiApp.context)
      expect(unauthorized.status).toBe(401)
      expect((await unauthorized.json()).error.code).toBe("invalid_api_key")
      const unknownWithoutKey = await handler(new Request("http://localhost/v1/embeddings"), HttpApiApp.context)
      expect(unknownWithoutKey.status).toBe(401)
      const unknownWithKey = await handler(
        new Request("http://localhost/v1/embeddings", { headers: { authorization: `Bearer ${key}` } }),
        HttpApiApp.context,
      )
      expect(unknownWithKey.status).toBe(501)
      expect((await unknownWithKey.json()).error.code).toBe("model_not_supported")

      const response = await handler(
        new Request("http://localhost/v1/models", {
          headers: { authorization: `Bearer ${key}`, "x-deepagent-code-directory": "/" },
        }),
        HttpApiApp.context,
      )
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ object: "list", data: [] })
      const provisioned = await handler(new Request("http://localhost/proxy/admin/tenants", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "tenant-admin", key: "sk-admin-created-tenant", directory,
          model_allowlist: [], tier: "passthrough", quota_requests_per_minute: 5,
          quota_tokens_per_day: 10_000, lane_limit: 8, deadline_ms: 120_000 }),
      }), HttpApiApp.context)
      expect(provisioned.status).toBe(201)
      expect((await provisioned.json()).id).toBe("tenant-admin")
      const listed = await handler(new Request("http://localhost/proxy/admin/tenants"), HttpApiApp.context)
      expect(listed.status).toBe(200)
      const tenants = await listed.json()
      expect(tenants.data.map((tenant: { id: string }) => tenant.id).sort()).toEqual(["tenant-admin", "tenant-test"])
      expect(JSON.stringify(tenants)).not.toContain("sk-admin-created-tenant")
      expect(JSON.stringify(tenants)).not.toContain("key_hash")
      const updated = await handler(new Request("http://localhost/proxy/admin/tenants/tenant-admin", {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: false }),
      }), HttpApiApp.context)
      expect(updated.status).toBe(200)
      const disabled = await handler(new Request("http://localhost/v1/models", {
        headers: { authorization: "Bearer sk-admin-created-tenant" },
      }), HttpApiApp.context)
      expect(disabled.status).toBe(401)
      const revoked = await handler(new Request("http://localhost/proxy/admin/tenants/tenant-admin", {
        method: "DELETE",
      }), HttpApiApp.context)
      expect(revoked.status).toBe(204)
      const missing = await handler(new Request("http://localhost/proxy/admin/tenants/unknown", {
        method: "DELETE",
      }), HttpApiApp.context)
      expect(missing.status).toBe(404)
    } finally {
      await Promise.all(openHandlers.map((web) => web.dispose()))
      Flag.DEEPAGENT_CODE_DB = originalDatabase
      await rm(directory, { recursive: true, force: true })
    }
  }, 30_000)

  test("keeps passthrough free of sessions and reconciles provider usage with durable audit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "deepagent-proxy-chat-test-"))
    const originalDatabase = Flag.DEEPAGENT_CODE_DB
    Flag.DEEPAGENT_CODE_DB = join(directory, "proxy.sqlite")
    const openHandlers: Array<{ dispose: () => Promise<void> }> = []
    const hits: string[] = []
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const body = await request.text()
        hits.push(body)
        if (body.includes("Reject"))
          return Response.json(
            { error: { message: "upstream key rejected: test-key", type: "authentication_error", code: "invalid_api_key" } },
            { status: 401 },
          )
        return new Response(
          [
            'data: {"id":"upstream-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}',
            'data: {"id":"upstream-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"exact upstream text"},"finish_reason":null}]}',
            'data: {"id":"upstream-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":11,"completion_tokens":4,"total_tokens":15}}',
            "data: [DONE]",
            "",
          ].join("\n\n"),
          { headers: { "content-type": "text/event-stream" } },
        )
      },
    })
    try {
      const pricedProvider = testProviderConfig(`http://127.0.0.1:${upstream.port}/v1`)
      Object.assign(pricedProvider.provider.test.models["test-model"], { cost: { input: 1, output: 2 } })
      await Bun.write(join(directory, "deepagent-code.json"), JSON.stringify(pricedProvider))
      await Effect.runPromise(
        Effect.gen(function* () {
          yield* (yield* Database.Service).db.insert(ProxyTenantTable).values({
            id: "tenant-chat",
            key_hash: createHash("sha256").update("sk-test-proxy-chat").digest("hex"),
            key_fingerprint: "chat-fingerprint",
            directory,
            model_allowlist: ["test/test-model"],
            tier: "passthrough",
            quota_requests_per_minute: 4,
            quota_tokens_per_day: 100_000,
            lane_limit: 8,
            deadline_ms: 120_000,
            enabled: true,
            created_at: Date.now(),
            updated_at: Date.now(),
          })
        }).pipe(Effect.provide(Database.defaultLayer)),
      )
      const web = HttpRouter.toWebHandler(
        HttpApiApp.createRoutes().pipe(
          Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ DEEPAGENT_CODE_GATEWAY: true }))),
        ),
        { disableLogger: true },
      )
      openHandlers.push(web)
      const handler = web.handler
      const response = await handler(
        new Request("http://localhost/v1/chat/completions", {
          method: "POST",
          headers: {
            authorization: "Bearer sk-test-proxy-chat",
            "content-type": "application/json",
            "x-request-id": "example-1",
          },
          body: JSON.stringify({ model: "test-model", messages: [{ role: "user", content: "Say hello" }] }),
        }),
        HttpApiApp.context,
      )
      expect(response.status).toBe(200)
      expect((await response.json()).choices[0].message.content).toBe("exact upstream text")
      expect(hits).toHaveLength(1)
      const streamed = await handler(
        new Request("http://localhost/v1/chat/completions", {
          method: "POST",
          headers: {
            authorization: "Bearer sk-test-proxy-chat",
            "content-type": "application/json",
            "x-request-id": "example-2",
          },
          body: JSON.stringify({
            model: "test-model",
            messages: [{ role: "user", content: "Say hello" }],
            stream: true,
            stream_options: { include_usage: true },
          }),
        }),
        HttpApiApp.context,
      )
      expect(streamed.status).toBe(200)
      expect(streamed.headers.get("content-type")).toContain("text/event-stream")
      const sse = await streamed.text()
      expect(sse).toContain('"content":"exact upstream text"')
      expect(sse).toContain('"prompt_tokens":11')
      expect(sse).toContain("data: [DONE]")
      expect(hits).toHaveLength(2)
      const responses = await handler(new Request("http://localhost/v1/responses", {
        method: "POST", headers: { authorization: "Bearer sk-test-proxy-chat", "content-type": "application/json", "x-request-id": "example-3" },
        body: JSON.stringify({ model: "test-model", input: "Say hello" }),
      }), HttpApiApp.context)
      expect(responses.status).toBe(200)
      const responseBody = await responses.json()
      expect(responseBody.object).toBe("response")
      expect(responseBody.output[0].content[0].text).toBe("exact upstream text")
      expect(responseBody.usage).toMatchObject({ input_tokens: 11, output_tokens: 4 })
      expect(hits).toHaveLength(3)
      const unsupported = await handler(new Request("http://localhost/v1/responses", {
        method: "POST", headers: { authorization: "Bearer sk-test-proxy-chat", "content-type": "application/json" },
        body: JSON.stringify({ model: "test-model", input: "Say hello", tools: [] }),
      }), HttpApiApp.context)
      expect(unsupported.status).toBe(501)
      expect((await unsupported.json()).error.code).toBe("model_not_supported")
      const repeated = await handler(
        new Request("http://localhost/v1/chat/completions", {
          method: "POST",
          headers: {
            authorization: "Bearer sk-test-proxy-chat",
            "content-type": "application/json",
            "x-request-id": "example-1",
          },
          body: JSON.stringify({ model: "test-model", messages: [{ role: "user", content: "Say hello" }] }),
        }),
        HttpApiApp.context,
      )
      expect(repeated.status).toBe(409)
      expect((await repeated.json()).error.code).toBe("request_replay_unavailable")
      const providerFailure = await handler(
        new Request("http://localhost/v1/chat/completions", {
          method: "POST",
          headers: {
            authorization: "Bearer sk-test-proxy-chat",
            "content-type": "application/json",
            "x-request-id": "example-4",
          },
          body: JSON.stringify({ model: "test-model", messages: [{ role: "user", content: "Reject" }] }),
        }),
        HttpApiApp.context,
      )
      expect(providerFailure.status).toBe(401)
      expect(await providerFailure.json()).toEqual({
        error: { message: "upstream key rejected: <redacted>", type: "authentication_error", code: "invalid_api_key" },
      })
      const limited = await handler(
        new Request("http://localhost/v1/chat/completions", {
          method: "POST",
          headers: {
            authorization: "Bearer sk-test-proxy-chat",
            "content-type": "application/json",
            "x-request-id": "example-5",
          },
          body: JSON.stringify({ model: "test-model", messages: [{ role: "user", content: "Again" }] }),
        }),
        HttpApiApp.context,
      )
      expect(limited.status).toBe(429)
      expect((await limited.json()).error.code).toBe("rate_limit_exceeded")
      expect(limited.headers.get("x-ratelimit-limit-requests")).toBe("4")
      expect(limited.headers.get("x-ratelimit-remaining-requests")).toBe("0")
      expect(hits).toHaveLength(4)
      const sqlite = await import("bun:sqlite")
      const reader = new sqlite.Database(Flag.DEEPAGENT_CODE_DB, { readonly: true })
      try {
        const ledger = reader.query("SELECT request_id, usage_input, usage_output, cost_total, lane_session_id FROM proxy_request_ledger").all() as {
          request_id: string
          usage_input: number | null
          usage_output: number | null
          cost_total: number | null
          lane_session_id: string | null
        }[]
        const events = reader.query("SELECT type FROM event").all() as { type: string }[]
        expect(ledger).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ request_id: "tenant-chat:example-1", usage_input: 11, usage_output: 4, cost_total: 0.000019 }),
            expect.objectContaining({ request_id: "tenant-chat:example-2", usage_input: 11, usage_output: 4, cost_total: 0.000019 }),
          ]),
        )
        expect(ledger.every((row) => row.lane_session_id === null)).toBe(true)
        expect(events.map((event) => event.type)).toContain("proxy.request.admitted.1")
        expect(events.map((event) => event.type)).toContain("proxy.response.completed.1")
        expect(reader.query("SELECT count(*) AS count FROM deepagent_event_outbox WHERE event_type LIKE 'proxy.%'").get()).toMatchObject({ count: 8 })
        const delivered = reader.query("SELECT count(*) AS count FROM deepagent_event_consumer_delivery AS delivery JOIN deepagent_event_outbox AS outbox ON outbox.outbox_id = delivery.outbox_id WHERE outbox.event_type LIKE 'proxy.%' AND delivery.consumer_key = 'runtime' AND delivery.status = 'resolved'")
        const deadline = Date.now() + 5_000
        while ((delivered.get() as { count: number }).count < 8 && Date.now() < deadline) await Bun.sleep(100)
        expect(delivered.get()).toMatchObject({ count: 8 })
        expect(reader.query("SELECT count(*) AS count FROM session").get()).toMatchObject({ count: 0 })
      } finally {
        reader.close()
      }
    } finally {
      await Promise.all(openHandlers.map((web) => web.dispose()))
      upstream.stop(true)
      Flag.DEEPAGENT_CODE_DB = originalDatabase
      await rm(directory, { recursive: true, force: true })
    }
  }, 30_000)

  test("serializes a tenant's token budget before a concurrent provider dispatch", async () => {
    const directory = await mkdtemp(join(tmpdir(), "deepagent-proxy-quota-test-"))
    const originalDatabase = Flag.DEEPAGENT_CODE_DB
    Flag.DEEPAGENT_CODE_DB = join(directory, "proxy.sqlite")
    const firstSeen = Promise.withResolvers<void>()
    const releaseFirst = Promise.withResolvers<void>()
    const hits: string[] = []
    const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      const body = await request.text()
      hits.push(body)
      if (body.includes("First request")) {
        firstSeen.resolve()
        await releaseFirst.promise
      }
      return new Response([
        'data: {"choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}',
        'data: {"choices":[{"index":0,"delta":{"content":"quota answer"},"finish_reason":null}]}',
        body.includes("Missing usage")
          ? 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}'
          : 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":11,"completion_tokens":4,"total_tokens":15}}',
        "data: [DONE]", "",
      ].join("\n\n"), { headers: { "content-type": "text/event-stream" } })
    } })
    try {
      await Bun.write(join(directory, "deepagent-code.json"), JSON.stringify(testProviderConfig(`http://127.0.0.1:${upstream.port}/v1`)))
      await Effect.runPromise(Effect.gen(function* () {
        yield* (yield* Database.Service).db.insert(ProxyTenantTable).values({
          id: "tenant-quota", key_hash: createHash("sha256").update("sk-quota").digest("hex"),
          key_fingerprint: "quota-fingerprint", directory, model_allowlist: ["test/test-model"],
          tier: "passthrough", quota_requests_per_minute: 10, quota_tokens_per_day: 15,
          lane_limit: 8, deadline_ms: 5_000, enabled: true, created_at: Date.now(), updated_at: Date.now(),
        })
      }).pipe(Effect.provide(Database.defaultLayer)))
      const web = HttpRouter.toWebHandler(HttpApiApp.createRoutes().pipe(
        Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ DEEPAGENT_CODE_GATEWAY: true }))),
      ), { disableLogger: true })
      const send = (id: string, content: string, key = "sk-quota") => web.handler(new Request("http://localhost/v1/chat/completions", {
        method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "x-request-id": id },
        body: JSON.stringify({ model: "test-model", messages: [{ role: "user", content }] }),
      }), HttpApiApp.context)
      const first = send("quota-1", "First request")
      await firstSeen.promise
      const second = send("quota-2", "Second request")
      await Bun.sleep(300)
      expect(hits).toHaveLength(1)
      releaseFirst.resolve()
      expect((await first).status).toBe(200)
      const denied = await second
      expect(denied.status).toBe(429)
      expect((await denied.json()).error.code).toBe("rate_limit_exceeded")
      expect(hits).toHaveLength(1)
      const provision = await web.handler(new Request("http://localhost/proxy/admin/tenants", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "tenant-unknown", key: "sk-test-unknown-tenant", directory,
          model_allowlist: ["test/test-model"], tier: "passthrough", quota_requests_per_minute: 10,
          quota_tokens_per_day: 100, lane_limit: 8, deadline_ms: 5_000 }),
      }), HttpApiApp.context)
      expect(provision.status).toBe(201)
      expect((await send("unknown-1", "Missing usage", "sk-test-unknown-tenant")).status).toBe(200)
      const unknown = await send("unknown-2", "Again", "sk-test-unknown-tenant")
      expect(unknown.status).toBe(503)
      expect((await unknown.json()).error.code).toBe("quota_usage_unknown")
      expect(hits).toHaveLength(2)
      const auditPage = await web.handler(new Request("http://localhost/proxy/admin/audit?tenant=tenant-quota&limit=1"), HttpApiApp.context)
      expect(auditPage.status).toBe(200)
      const firstAudit = await auditPage.json()
      expect(firstAudit.data).toHaveLength(1)
      expect(firstAudit.data[0].data.tenantID).toBe("tenant-quota")
      expect(firstAudit.next_cursor).toBeGreaterThan(0)
      const nextAudit = await web.handler(new Request(`http://localhost/proxy/admin/audit?tenant=tenant-quota&limit=1&after=${firstAudit.next_cursor}`), HttpApiApp.context)
      expect(nextAudit.status).toBe(200)
      const secondAudit = await nextAudit.json()
      expect(secondAudit.data).toHaveLength(1)
      expect(secondAudit.data[0].data.tenantID).toBe("tenant-quota")
      expect(secondAudit.data[0].id).not.toBe(firstAudit.data[0].id)
      expect(secondAudit.next_cursor).toBeNull()
      const otherAudit = await web.handler(new Request("http://localhost/proxy/admin/audit?tenant=tenant-unknown"), HttpApiApp.context)
      expect(otherAudit.status).toBe(200)
      expect((await otherAudit.json()).data.map((event: { data: { tenantID: string } }) => event.data.tenantID))
        .toEqual(["tenant-unknown", "tenant-unknown"])
      const unsupportedDirectory = join(directory, "unsupported")
      await mkdir(unsupportedDirectory)
      const unsupportedProvider = testProviderConfig(`http://127.0.0.1:${upstream.port}/v1`)
      unsupportedProvider.provider.test.options.apiKey = ""
      await Bun.write(join(unsupportedDirectory, "deepagent-code.json"), JSON.stringify(unsupportedProvider))
      const unsupportedTenant = await web.handler(new Request("http://localhost/proxy/admin/tenants", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "tenant-unsupported", key: "sk-test-unsupported-tenant", directory: unsupportedDirectory,
          model_allowlist: ["test/test-model"], tier: "passthrough", quota_requests_per_minute: 10,
          quota_tokens_per_day: 100, lane_limit: 8, deadline_ms: 1_000 }),
      }), HttpApiApp.context)
      expect(unsupportedTenant.status).toBe(201)
      expect((await send("unsupported-1", "No provider credential", "sk-test-unsupported-tenant")).status).toBe(501)
      expect((await send("unsupported-2", "Retry after unsupported provider", "sk-test-unsupported-tenant")).status).toBe(501)
      expect(hits).toHaveLength(2)
      await web.dispose()
      const protectedWeb = HttpRouter.toWebHandler(HttpApiApp.createRoutes().pipe(
        Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ DEEPAGENT_CODE_GATEWAY: true,
          DEEPAGENT_CODE_SERVER_PASSWORD: "test-admin-password" }))),
      ), { disableLogger: true })
      const auditURL = "http://localhost/proxy/admin/audit?tenant=tenant-quota"
      expect((await protectedWeb.handler(new Request(auditURL, { headers: { authorization: "Bearer sk-quota" } }), HttpApiApp.context)).status).toBe(401)
      const authorizedAudit = await protectedWeb.handler(new Request(auditURL, {
        headers: { authorization: `Basic ${Buffer.from("deepagent-code:test-admin-password").toString("base64")}` },
      }), HttpApiApp.context)
      expect(authorizedAudit.status).toBe(200)
      expect((await authorizedAudit.json()).data.every((event: { data: { tenantID: string } }) => event.data.tenantID === "tenant-quota")).toBe(true)
      await protectedWeb.dispose()
    } finally {
      releaseFirst.resolve()
      upstream.stop(true)
      Flag.DEEPAGENT_CODE_DB = originalDatabase
      await rm(directory, { recursive: true, force: true })
    }
  }, 30_000)

  test("adopts a context lane and collects its own queued activity", async () => {
    const directory = await mkdtemp(join(tmpdir(), "deepagent-proxy-context-test-"))
    const originalDatabase = Flag.DEEPAGENT_CODE_DB
    Flag.DEEPAGENT_CODE_DB = join(directory, "proxy.sqlite")
    const openHandlers: Array<{ dispose: () => Promise<void> }> = []
    const streamGate = Promise.withResolvers<void>()
    const offeredWrite: boolean[] = []
    const deniedToolResults: string[] = []
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const payload = await request.json() as {
          messages?: { role: string; content: unknown }[]
          input?: unknown[]
          tools?: { function?: { name?: string } }[]
        }
        const lastUser = payload.messages?.filter((message) => message.role === "user").at(-1)
        const deniedToolRequest = JSON.stringify(lastUser ?? payload.input?.at(-1)).includes("Denied tool")
        const toolResult = payload.messages?.findLast((message) => message.role === "tool")
        if (deniedToolRequest && !toolResult) {
          offeredWrite.push(payload.tools?.some((tool) => tool.function?.name === "write") ?? false)
          return new Response([
            'data: {"choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}',
            'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_proxy_denied_write","type":"function","function":{"name":"write","arguments":""}}]},"finish_reason":null}]}',
            `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0,
              function: { arguments: JSON.stringify({ path: "blocked.txt", content: "must not exist" }) } }]
            }, finish_reason: null }] })}`,
            'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":11,"completion_tokens":4,"total_tokens":15}}',
            "data: [DONE]", "",
          ].join("\n\n"), { headers: { "content-type": "text/event-stream" } })
        }
        if (toolResult) deniedToolResults.push(JSON.stringify(toolResult))
        if (JSON.stringify(lastUser ?? payload.input?.at(-1)).includes("Reject"))
          return Response.json({ error: { message: "provider rejected test-key", type: "authentication_error" } }, { status: 401 })
        const answer = toolResult ? "denied side effect confirmed" :
          JSON.stringify(lastUser ?? payload.input?.at(-1)).includes("Second question") ? "second durable answer" : "first durable answer"
        if (JSON.stringify(lastUser ?? payload.input?.at(-1)).includes("Stream question")) {
          const encode = new TextEncoder()
          return new Response(new ReadableStream({
            start(controller) {
              controller.enqueue(encode.encode('data: {"choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n'))
              controller.enqueue(encode.encode('data: {"choices":[{"index":0,"delta":{"content":"first durable"},"finish_reason":null}]}\n\n'))
              void streamGate.promise.then(() => {
                controller.enqueue(encode.encode('data: {"choices":[{"index":0,"delta":{"content":" answer"},"finish_reason":null}]}\n\n'))
                controller.enqueue(encode.encode('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":11,"completion_tokens":4,"total_tokens":15}}\n\ndata: [DONE]\n\n'))
                controller.close()
              })
            },
          }), { headers: { "content-type": "text/event-stream" } })
        }
        return new Response([
        'data: {"id":"upstream-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}',
        `data: {"id":"upstream-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"${answer}"},"finish_reason":null}]}`,
        'data: {"id":"upstream-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":11,"completion_tokens":4,"total_tokens":15}}',
        "data: [DONE]", "",
        ].join("\n\n"), { headers: { "content-type": "text/event-stream" } })
      },
    })
    try {
      await Bun.write(join(directory, "deepagent-code.json"), JSON.stringify(testProviderConfig(`http://127.0.0.1:${upstream.port}/v1`)))
      await Effect.runPromise(Effect.gen(function* () {
        yield* (yield* Database.Service).db.insert(ProxyTenantTable).values({
          id: "tenant-context", key_hash: createHash("sha256").update("sk-context").digest("hex"),
          key_fingerprint: "context-fingerprint", directory, model_allowlist: ["test/test-model"],
          tier: "context", quota_requests_per_minute: 10, quota_tokens_per_day: 100_000,
          lane_limit: 8, deadline_ms: 5_000, enabled: true, created_at: Date.now(), updated_at: Date.now(),
        })
      }).pipe(Effect.provide(Database.defaultLayer)))
      const web = HttpRouter.toWebHandler(HttpApiApp.createRoutes().pipe(
        Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ DEEPAGENT_CODE_GATEWAY: true }))),
      ), { disableLogger: true })
      openHandlers.push(web)
      const handler = web.handler
      const send = (requestID: string, content: string, stream = false, hint?: string) => handler(new Request("http://localhost/v1/chat/completions", {
        method: "POST", headers: { authorization: "Bearer sk-context", "content-type": "application/json", "x-request-id": requestID,
          ...(hint ? { "x-deepagent-session": hint } : {}) },
        body: JSON.stringify({ model: "test-model", messages: [{ role: "user", content }], stream, stream_options: { include_usage: true } }),
      }), HttpApiApp.context)
      const [first, second] = await Promise.all([send("context-1", "First question"), send("context-2", "Second question")])
      expect(first.status).toBe(200)
      expect(second.status).toBe(200)
      const firstBody = await first.json()
      const secondBody = await second.json()
      expect(firstBody.choices[0].message.content).toBe("first durable answer")
      expect(secondBody.choices[0].message.content).toBe("second durable answer")
      expect(firstBody.usage).toMatchObject({ prompt_tokens: 11, completion_tokens: 4 })
      expect(secondBody.usage).toMatchObject({ prompt_tokens: 11, completion_tokens: 4 })
      const replay = await send("context-1", "First question")
      expect(replay.status).toBe(200)
      expect((await replay.json()).choices[0].message.content).toBe("first durable answer")
      const reroutedReplay = await send("context-1", "First question", false, "different-lane")
      expect(reroutedReplay.status).toBe(409)
      expect((await reroutedReplay.json()).error.code).toBe("request_replay_unavailable")
      const sqlite = await import("bun:sqlite")
      const replayReader = new sqlite.Database(Flag.DEEPAGENT_CODE_DB, { readonly: true })
      try {
        expect(replayReader.query("SELECT count(*) AS count FROM session WHERE json_extract(metadata, '$.proxy.tenant') = 'tenant-context'").get())
          .toMatchObject({ count: 1 })
      } finally {
        replayReader.close()
      }
      const conflict = await send("context-1", "Changed question")
      expect(conflict.status).toBe(409)
      expect((await conflict.json()).error.code).toBe("request_conflict")
      const streamed = await send("context-3", "Stream question", true)
      expect(streamed.status).toBe(200)
      const readerStream = streamed.body!.getReader()
      const decoder = new TextDecoder()
      let sse = ""
      let firstDeltaTimedOut = false
      const deadline = setTimeout(() => { firstDeltaTimedOut = true; streamGate.resolve() }, 2_000)
      while (!sse.includes('"content":"first durable"')) {
        const item = await readerStream.read()
        if (item.done) throw new Error("Proxy stream ended before its first text delta")
        sse += decoder.decode(item.value)
      }
      clearTimeout(deadline)
      expect(firstDeltaTimedOut).toBe(false)
      streamGate.resolve()
      while (true) {
        const item = await readerStream.read()
        if (item.done) break
        sse += decoder.decode(item.value)
      }
      expect([...sse.matchAll(/^data: (\{.*\})$/gm)].map((match) => JSON.parse(match[1]!).choices?.[0]?.delta?.content ?? "").join("")).toBe("first durable answer")
      expect(sse).toContain('"prompt_tokens":11')
      expect(sse).toContain("data: [DONE]")
      const reader = new sqlite.Database(Flag.DEEPAGENT_CODE_DB, { readonly: true })
      try {
        const activities = reader.query("SELECT activity_id, ordinal, state FROM session_activity ORDER BY ordinal").all() as { activity_id: string; ordinal: number; state: string }[]
        expect(activities).toHaveLength(3)
        expect(activities.map((activity) => activity.state)).toEqual(["settled", "settled", "settled"])
        const messages = reader.query("SELECT data FROM session_message WHERE type = 'assistant' ORDER BY seq").all() as { data: string }[]
        expect(messages.map((row) => JSON.parse(row.data).content.filter((part: { type: string }) => part.type === "text").map((part: { text: string }) => part.text).join("")).sort()).toEqual(["first durable answer", "first durable answer", "second durable answer"])
        const ledger = reader.query("SELECT request_id, lane_session_id, usage_input, usage_output FROM proxy_request_ledger ORDER BY admitted_at").all() as { request_id: string; lane_session_id: string; usage_input: number; usage_output: number }[]
        expect(ledger).toHaveLength(3)
        expect(ledger[0]?.lane_session_id).toBe(ledger[1]?.lane_session_id)
        expect(ledger.every((row) => row.usage_input === 11 && row.usage_output === 4)).toBe(true)
        const providerUsage = reader.query("SELECT data FROM event WHERE type = 'session.next.step.ended.2'").all() as { data: string }[]
        expect(providerUsage).toHaveLength(3)
        expect(providerUsage.every((row) => JSON.parse(row.data).tokens.input === 11 && JSON.parse(row.data).tokens.output === 4)).toBe(true)
        expect(reader.query("SELECT count(*) AS count FROM event WHERE type LIKE 'proxy.%'").get()).toMatchObject({ count: 9 })
        const trace = reader.query("SELECT data FROM event WHERE type = 'proxy.response.completed.1' LIMIT 1").get() as { data: string }
        expect(JSON.parse(trace.data).mechanismTrace.activityID).toMatch(/^act/)
        expect(reader.query("SELECT count(*) AS count FROM deepagent_event_outbox WHERE event_type = 'proxy.mechanism.traced'").get()).toMatchObject({ count: 3 })
      } finally {
        reader.close()
      }
      const writer = new sqlite.Database(Flag.DEEPAGENT_CODE_DB)
      try {
        writer.query("UPDATE proxy_tenant SET tier = 'full', permission_policy = ? WHERE id = 'tenant-context'")
          .run(JSON.stringify([{ action: "*", resource: "*", effect: "deny" }]))
      } finally {
        writer.close()
      }
      const full = await handler(new Request("http://localhost/v1/chat/completions", {
        method: "POST", headers: { authorization: "Bearer sk-context", "content-type": "application/json",
          "x-request-id": "context-4" },
        body: JSON.stringify({ model: "test-model", messages: [{ role: "user", content: "Full question" }] }),
      }), HttpApiApp.context)
      expect(full.status).toBe(200)
      expect((await full.json()).choices[0].message.content).toBe("first durable answer")
      const policyReader = new sqlite.Database(Flag.DEEPAGENT_CODE_DB, { readonly: true })
      try {
        const session = policyReader.query("SELECT permission FROM session WHERE id IN (SELECT lane_session_id FROM proxy_request_ledger WHERE request_id = 'tenant-context:context-4')").get() as { permission: string }
        expect(JSON.parse(session.permission)).toEqual([{ action: "*", resource: "*", effect: "deny" }])
        const laneIDs = policyReader.query("SELECT lane_session_id FROM proxy_request_ledger WHERE request_id IN ('tenant-context:context-1', 'tenant-context:context-4') ORDER BY request_id").all() as { lane_session_id: string }[]
        expect(laneIDs[0]?.lane_session_id).not.toBe(laneIDs[1]?.lane_session_id)
      } finally {
        policyReader.close()
      }
      const changedPolicy = await handler(new Request("http://localhost/proxy/admin/tenants/tenant-context", {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ permission_policy: [
          { action: "*", resource: "*", effect: "allow" },
          { action: "edit", resource: "blocked.txt", effect: "deny" },
        ] }),
      }), HttpApiApp.context)
      expect(changedPolicy.status).toBe(200)
      const deniedTool = await handler(new Request("http://localhost/v1/chat/completions", {
        method: "POST", headers: { authorization: "Bearer sk-context", "content-type": "application/json",
          "x-request-id": "context-denied-tool", "x-deepagent-session": "policy-lane" },
        body: JSON.stringify({ model: "test-model", messages: [{ role: "user", content: "Denied tool" }] }),
      }), HttpApiApp.context)
      expect(deniedTool.status).toBe(200)
      expect((await deniedTool.json()).choices[0].message.content).toBe("denied side effect confirmed")
      expect(offeredWrite).toEqual([true])
      expect(deniedToolResults).toHaveLength(1)
      expect(deniedToolResults[0]).toContain("prevents you from using this specific tool call")
      expect(deniedToolResults[0]).toContain("blocked.txt")
      expect(await Bun.file(join(directory, "blocked.txt")).exists()).toBe(false)
      const toolReader = new sqlite.Database(Flag.DEEPAGENT_CODE_DB, { readonly: true })
      try {
        const lane = toolReader.query("SELECT lane_session_id FROM proxy_request_ledger WHERE request_id = 'tenant-context:context-denied-tool'")
          .get() as { lane_session_id: string }
        const receipts = toolReader.query("SELECT prepared_turn FROM session_v2_provider_turn_receipt WHERE session_id = ? ORDER BY provider_turn_seq")
          .all(lane.lane_session_id) as { prepared_turn: string }[]
        expect((JSON.parse(receipts[0]!.prepared_turn).tool_final_offered_ids as string[])).toContain("write")
        const effects = toolReader.query("SELECT tool_name, state, error_code FROM session_v2_tool_effect WHERE session_id = ?")
          .all(lane.lane_session_id)
        // The refusal is a settled tool result (model-visible), not a failed provider turn.
        expect(effects).toEqual([{ tool_name: "write", state: "settled", error_code: null }])
      } finally {
        toolReader.close()
      }
      const exported = await handler(new Request("http://localhost/proxy/admin/ledger?tenant=tenant-context"), HttpApiApp.context)
      expect(exported.status).toBe(200)
      expect((await exported.json()).data).toHaveLength(5)
      const audited = await handler(new Request("http://localhost/proxy/admin/audit?tenant=tenant-context"), HttpApiApp.context)
      expect(audited.status).toBe(200)
      const auditEvents = (await audited.json()).data as { type: string; data: { tenantID: string } }[]
      expect(auditEvents.every((event) => event.data.tenantID === "tenant-context")).toBe(true)
      expect(auditEvents.map((event) => event.type)).toEqual(expect.arrayContaining([
        "proxy.request.admitted.1", "proxy.response.completed.1", "proxy.mechanism.traced.1",
      ]))
      const lanes = await handler(new Request("http://localhost/proxy/admin/lanes?tenant=tenant-context"), HttpApiApp.context)
      expect(lanes.status).toBe(200)
      expect((await lanes.json()).data.map((lane: { hint: string }) => lane.hint).sort()).toEqual(["default", "default", "policy-lane"])
      const failed = await handler(new Request("http://localhost/v1/chat/completions", {
        method: "POST", headers: { authorization: "Bearer sk-context", "content-type": "application/json",
          "x-request-id": "context-5", "x-deepagent-session": "failure-lane" },
        body: JSON.stringify({ model: "test-model", messages: [{ role: "user", content: "Reject" }] }),
      }), HttpApiApp.context)
      expect(failed.status).toBe(502)
      const failure = await failed.json()
      expect(failure.error.type).toBe("deepagent_enhancement_error")
      expect(JSON.stringify(failure)).not.toContain("test-key")
      const secondTenant = await handler(new Request("http://localhost/proxy/admin/tenants", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "tenant-other", key: "sk-other-tenant-key", directory,
          model_allowlist: ["test/test-model"], tier: "context", quota_requests_per_minute: 10,
          quota_tokens_per_day: 100_000, lane_limit: 8, deadline_ms: 5_000 }),
      }), HttpApiApp.context)
      expect(secondTenant.status).toBe(201)
      const other = await handler(new Request("http://localhost/v1/chat/completions", {
        method: "POST", headers: { authorization: "Bearer sk-other-tenant-key", "content-type": "application/json", "x-request-id": "context-1" },
        body: JSON.stringify({ model: "test-model", messages: [{ role: "user", content: "Tenant B" }] }),
      }), HttpApiApp.context)
      expect(other.status).toBe(200)
      const isolation = new sqlite.Database(Flag.DEEPAGENT_CODE_DB, { readonly: true })
      try {
        const rows = isolation.query("SELECT tenant_id, lane_session_id FROM proxy_request_ledger WHERE request_id IN ('tenant-context:context-1', 'tenant-other:context-1') ORDER BY tenant_id").all() as { tenant_id: string; lane_session_id: string }[]
        expect(rows).toHaveLength(2)
        expect(rows[0]?.lane_session_id).not.toBe(rows[1]?.lane_session_id)
        const otherLanes = await handler(new Request("http://localhost/proxy/admin/lanes?tenant=tenant-other"), HttpApiApp.context)
        expect((await otherLanes.json()).data.map((lane: { tenant: string }) => lane.tenant)).toEqual(["tenant-other"])
      } finally {
        isolation.close()
      }
      const limit = await handler(new Request("http://localhost/proxy/admin/tenants/tenant-other", {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ lane_limit: 1 }),
      }), HttpApiApp.context)
      expect(limit.status).toBe(200)
      const nextLane = await handler(new Request("http://localhost/v1/chat/completions", {
        method: "POST", headers: { authorization: "Bearer sk-other-tenant-key", "content-type": "application/json",
          "x-request-id": "context-2", "x-deepagent-session": "second-lane" },
        body: JSON.stringify({ model: "test-model", messages: [{ role: "user", content: "Tenant B again" }] }),
      }), HttpApiApp.context)
      expect(nextLane.status).toBe(200)
      const archivedLanes = await handler(new Request("http://localhost/proxy/admin/lanes?tenant=tenant-other"), HttpApiApp.context)
      const laneRows = (await archivedLanes.json()).data as { hint: string; archived_at: number | null }[]
      expect(laneRows).toHaveLength(2)
      expect(laneRows.find((lane) => lane.hint === "default")?.archived_at).toBeGreaterThan(0)
      expect(laneRows.find((lane) => lane.hint === "second-lane")?.archived_at).toBeNull()
      await web.dispose()
      openHandlers.pop()
      const disabled = HttpRouter.toWebHandler(HttpApiApp.createRoutes().pipe(
        Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ DEEPAGENT_CODE_GATEWAY: false }))),
      ), { disableLogger: true })
      const audit = new sqlite.Database(Flag.DEEPAGENT_CODE_DB, { readonly: true })
      try {
        const count = () => audit.query("SELECT count(*) AS total FROM proxy_request_ledger").get() as { total: number }
        const before = count().total
        const blocked = await disabled.handler(new Request("http://localhost/v1/chat/completions", {
          method: "POST", headers: { authorization: "Bearer sk-context", "content-type": "application/json", "x-request-id": "disabled" },
          body: JSON.stringify({ model: "test-model", messages: [{ role: "user", content: "Must not run" }] }),
        }), HttpApiApp.context)
        expect(blocked.status).toBe(404)
        expect((await blocked.json()).error.code).toBe("gateway_disabled")
        expect(count().total).toBe(before)
      } finally {
        audit.close()
        await disabled.dispose()
      }
    } finally {
      await Promise.all(openHandlers.map((web) => web.dispose()))
      streamGate.resolve()
      upstream.stop(true)
      Flag.DEEPAGENT_CODE_DB = originalDatabase
      await rm(directory, { recursive: true, force: true })
    }
  }, 30_000)
})
