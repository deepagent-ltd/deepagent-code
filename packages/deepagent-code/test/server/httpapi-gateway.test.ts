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
import { testProviderConfig } from "../lib/test-provider"

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
      Flag.DEEPAGENT_CODE_DB = originalDatabase
      await rm(directory, { recursive: true, force: true })
    }
  }, 30_000)

  test("keeps passthrough free of sessions and reconciles provider usage with durable audit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "deepagent-proxy-chat-test-"))
    const originalDatabase = Flag.DEEPAGENT_CODE_DB
    Flag.DEEPAGENT_CODE_DB = join(directory, "proxy.sqlite")
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
      const handler = HttpRouter.toWebHandler(
        HttpApiApp.createRoutes().pipe(
          Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ DEEPAGENT_CODE_GATEWAY: true }))),
        ),
        { disableLogger: true },
      ).handler
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
      upstream.stop(true)
      Flag.DEEPAGENT_CODE_DB = originalDatabase
      await rm(directory, { recursive: true, force: true })
    }
  }, 30_000)

  test("adopts a context lane and collects its own queued activity", async () => {
    const directory = await mkdtemp(join(tmpdir(), "deepagent-proxy-context-test-"))
    const originalDatabase = Flag.DEEPAGENT_CODE_DB
    Flag.DEEPAGENT_CODE_DB = join(directory, "proxy.sqlite")
    const streamGate = Promise.withResolvers<void>()
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const payload = await request.json() as { messages?: { role: string; content: unknown }[]; input?: unknown[] }
        const lastUser = payload.messages?.filter((message) => message.role === "user").at(-1)
        if (JSON.stringify(lastUser ?? payload.input?.at(-1)).includes("Reject"))
          return Response.json({ error: { message: "provider rejected test-key", type: "authentication_error" } }, { status: 401 })
        const answer = JSON.stringify(lastUser ?? payload.input?.at(-1)).includes("Second question") ? "second durable answer" : "first durable answer"
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
      const handler = web.handler
      const send = (requestID: string, content: string, stream = false) => handler(new Request("http://localhost/v1/chat/completions", {
        method: "POST", headers: { authorization: "Bearer sk-context", "content-type": "application/json", "x-request-id": requestID },
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
      const sqlite = await import("bun:sqlite")
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
      const exported = await handler(new Request("http://localhost/proxy/admin/ledger?tenant=tenant-context"), HttpApiApp.context)
      expect(exported.status).toBe(200)
      expect((await exported.json()).data).toHaveLength(4)
      const lanes = await handler(new Request("http://localhost/proxy/admin/lanes?tenant=tenant-context"), HttpApiApp.context)
      expect(lanes.status).toBe(200)
      expect((await lanes.json()).data.map((lane: { hint: string }) => lane.hint).sort()).toEqual(["default", "default"])
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
    } finally {
      streamGate.resolve()
      upstream.stop(true)
      Flag.DEEPAGENT_CODE_DB = originalDatabase
      await rm(directory, { recursive: true, force: true })
    }
  }, 30_000)
})
