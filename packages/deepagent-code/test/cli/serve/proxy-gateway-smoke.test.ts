import { createHash } from "node:crypto"
import path from "node:path"
import { expect } from "bun:test"
import { Effect } from "effect"
import OpenAI from "openai"
import { Database } from "@deepagent-code/core/database/database"
import { ProxyTenantTable } from "@deepagent-code/core/proxy/sql"
import { cliIt } from "../../lib/cli-process"

cliIt.live("a real serve process accepts the official OpenAI SDK and closes /v1 when disabled", ({ llm, deepagentCode, home }) =>
  Effect.gen(function* () {
    const databaseName = "proxy-serve.db"
    const databasePath = path.join(home, ".deepagent", "code", databaseName)
    const key = "sk-proxy-serve-fixture"
    yield* Effect.gen(function* () {
      yield* (yield* Database.Service).db.insert(ProxyTenantTable).values({
        id: "proxy-serve-tenant",
        key_hash: createHash("sha256").update(key).digest("hex"),
        key_fingerprint: "proxy-serve-key",
        directory: home,
        model_allowlist: ["test/test-model"],
        tier: "passthrough",
        quota_requests_per_minute: 10,
        quota_tokens_per_day: 100_000,
        lane_limit: 8,
        deadline_ms: 30_000,
        enabled: true,
        created_at: Date.now(),
        updated_at: Date.now(),
      })
    }).pipe(Effect.provide(Database.layerFromPath(databasePath)), Effect.scoped)

    const server = yield* deepagentCode.serve({
      env: { DEEPAGENT_CODE_DB: databaseName, DEEPAGENT_CODE_GATEWAY: "true" },
      readyTimeoutMs: 30_000,
    })
    const client = new OpenAI({ apiKey: key, baseURL: `${server.url}/v1`, maxRetries: 0, timeout: 30_000 })
    const models = yield* Effect.promise(() => client.models.list())
    expect(models.data.map((model) => model.id)).toContain("test-model")
    yield* llm.text("served by the real CLI process", { usage: { input: 11, output: 4 } })
    const completion = yield* Effect.promise(() => client.chat.completions.create({
      model: "test-model",
      messages: [{ role: "user", content: "Reply via the gateway" }],
    }, { headers: { "X-Request-ID": "serve-smoke" } }))
    expect(completion.choices[0]?.message.content).toBe("served by the real CLI process")
    expect(completion.usage).toMatchObject({ prompt_tokens: 11, completion_tokens: 4 })
    const sqlite = yield* Effect.promise(() => import("bun:sqlite"))
    const ledger = new sqlite.Database(databasePath, { readonly: true })
    try {
      expect(ledger.query("SELECT tenant_id, usage_input, usage_output FROM proxy_request_ledger WHERE request_id = 'proxy-serve-tenant:serve-smoke'").get())
        .toEqual({ tenant_id: "proxy-serve-tenant", usage_input: 11, usage_output: 4 })
    } finally {
      ledger.close()
    }

    server.kill()
    yield* Effect.promise(() => server.exited)
    const disabled = yield* deepagentCode.serve({
      env: { DEEPAGENT_CODE_DB: databaseName, DEEPAGENT_CODE_GATEWAY: "false" },
      readyTimeoutMs: 30_000,
    })
    const blocked = yield* Effect.promise(() => fetch(`${disabled.url}/v1/models`, {
      headers: { authorization: `Bearer ${key}` },
    }))
    expect(blocked.status).toBe(404)
    expect(yield* Effect.promise(() => blocked.json())).toMatchObject({ error: { code: "gateway_disabled" } })
    const after = new sqlite.Database(databasePath, { readonly: true })
    try {
      expect(after.query("SELECT count(*) AS count FROM proxy_request_ledger").get()).toEqual({ count: 1 })
    } finally {
      after.close()
    }
  }),
  120_000,
)
