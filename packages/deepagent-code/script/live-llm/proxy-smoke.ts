import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import OpenAI from "openai"
import { ConfigProvider, Effect, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { loadLiveLLMConfig, writeLiveArtifact } from "../../../llm/script/live-llm/config"
import { prepareHarnessOwner } from "../../../core/script/live-llm/runtime"
import { liveWorkspaceConfig } from "./runtime"

// Five provider exchanges: passthrough, context, context SSE, two same-lane queued requests.
// The official DeepSeek endpoint is enforced by loadLiveLLMConfig; the gateway runs its production
// HttpApi composition over a loopback Web handler and the official OpenAI JS SDK is the client.
const config = await loadLiveLLMConfig()
assert.equal(config.providerID, "deepseek", "proxy-smoke uses the official DeepSeek reference model")
const root = await mkdtemp(path.join(os.tmpdir(), "deepagent-proxy-smoke-"))
const previous = { testHome: process.env.DEEPAGENT_CODE_TEST_HOME, database: process.env.DEEPAGENT_CODE_DB }
process.env.DEEPAGENT_CODE_TEST_HOME = path.join(root, "home")
process.env.DEEPAGENT_CODE_DB = path.join(root, "proxy.sqlite")

const { Flag } = await import("@deepagent-code/core/flag/flag")
const { Database } = await import("@deepagent-code/core/database/database")
const { ProxyTenantTable } = await import("@deepagent-code/core/proxy/sql")
const { contentDigest } = await import("@deepagent-code/core/contract/digest")
const { HttpApiApp } = await import("../../src/server/routes/instance/httpapi/server")
const originalDatabase = Flag.DEEPAGENT_CODE_DB
Flag.DEEPAGENT_CODE_DB = process.env.DEEPAGENT_CODE_DB
const ownerSetup = await prepareHarnessOwner()
await ownerSetup.seedRow()
const provider = liveWorkspaceConfig(config, { "*": "deny" }, undefined, undefined, { modelMaxTokens: 96 })
// An explicit fixture tariff verifies billing arithmetic without asserting a live provider price.
const configuredProvider = provider.provider?.["live-deepseek"]
if (!configuredProvider?.models?.[config.modelID]) throw new Error("Live DeepSeek model configuration is missing")
await Bun.write(path.join(root, "deepagent-code.json"), JSON.stringify({
  ...provider,
  provider: { ...provider.provider, "live-deepseek": {
    ...configuredProvider,
    models: { ...configuredProvider.models, [config.modelID]: {
      ...configuredProvider.models[config.modelID], cost: { input: 1, output: 2 },
    } },
  } },
}))
const tenantID = "proxy-smoke"
const tenantKey = `sk-proxy-smoke-${randomUUID()}`
const tenantKeyHash = createHash("sha256").update(tenantKey).digest("hex")
await Effect.runPromise(Effect.gen(function* () {
  yield* (yield* Database.Service).db.insert(ProxyTenantTable).values({
    id: tenantID,
    key_hash: tenantKeyHash,
    key_fingerprint: tenantKeyHash.slice(0, 16),
    directory: root,
    model_allowlist: [`live-deepseek/${config.modelID}`],
    tier: "passthrough",
    quota_requests_per_minute: 100,
    quota_tokens_per_day: 100_000,
    lane_limit: 8,
    deadline_ms: Math.min(config.timeoutMs, 180_000),
    enabled: true,
    created_at: Date.now(),
    updated_at: Date.now(),
  })
}).pipe(Effect.provide(Database.defaultLayer)))

const web = HttpRouter.toWebHandler(HttpApiApp.createRoutes().pipe(
  Layer.provide(ownerSetup.ownerLayer),
  Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ DEEPAGENT_CODE_GATEWAY: true }))),
), { disableLogger: true })
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => web.handler(request, HttpApiApp.context) })
const baseURL = `http://127.0.0.1:${server.port}`
const client = new OpenAI({ apiKey: tenantKey, baseURL: `${baseURL}/v1`, maxRetries: 0, timeout: config.timeoutMs })
const sqlite = await import("bun:sqlite")
const evidence: { phase: string; requestID: string; input: number; output: number; costKnown: boolean }[] = []
const soakLatencies: number[] = []

function checkLedger(requestID: string, usage: { prompt_tokens: number; completion_tokens: number }) {
  const reader = new sqlite.Database(Flag.DEEPAGENT_CODE_DB, { readonly: true })
  try {
    const row = reader.query("SELECT lane_session_id, usage_input, usage_output, cost_total, completed_at FROM proxy_request_ledger WHERE request_id = ?")
      .get(`${tenantID}:${requestID}`) as { lane_session_id: string | null; usage_input: number; usage_output: number; cost_total: number | null; completed_at: number } | null
    assert.ok(row?.completed_at, `missing completed ledger for ${requestID}`)
    assert.equal(row.usage_input, usage.prompt_tokens)
    assert.equal(row.usage_output, usage.completion_tokens)
    assert.equal(row.cost_total, (usage.prompt_tokens + usage.completion_tokens * 2) / 1_000_000)
    return row
  } finally {
    reader.close()
  }
}

function checkTerminal(requestID: string, text: string, usage: { prompt_tokens: number; completion_tokens: number }) {
  const reader = new sqlite.Database(Flag.DEEPAGENT_CODE_DB, { readonly: true })
  try {
    const promptID = `msg_${contentDigest(`proxy:${tenantID}:${requestID}`).slice(0, 40)}`
    const activity = reader.query("SELECT activity_id, session_id, ordinal FROM session_activity WHERE trigger_input_id = ?")
      .get(promptID) as { activity_id: string; session_id: string; ordinal: number } | null
    assert.ok(activity, `missing queued activity for ${requestID}`)
    const trigger = reader.query("SELECT promoted_seq FROM session_input WHERE id = ?").get(promptID) as { promoted_seq: number }
    const next = reader.query("SELECT trigger_input_id FROM session_activity WHERE session_id = ? AND ordinal > ? ORDER BY ordinal LIMIT 1")
      .get(activity.session_id, activity.ordinal) as { trigger_input_id: string } | null
    const upper = next
      ? (reader.query("SELECT promoted_seq FROM session_input WHERE id = ?").get(next.trigger_input_id) as { promoted_seq: number }).promoted_seq
      : Number.MAX_SAFE_INTEGER
    const message = reader.query("SELECT id, data FROM session_message WHERE session_id = ? AND type = 'assistant' AND seq > ? AND seq < ? ORDER BY seq DESC LIMIT 1")
      .get(activity.session_id, trigger.promoted_seq, upper) as { id: string; data: string } | null
    assert.ok(message, `missing terminal assistant for ${requestID}`)
    const terminal = JSON.parse(message.data) as { content: { type: string; text?: string }[] }
    assert.equal(terminal.content.filter((part) => part.type === "text").map((part) => part.text ?? "").join(""), text)
    const step = reader.query("SELECT data FROM event WHERE aggregate_id = ? AND type = 'session.next.step.ended.2' AND json_extract(data, '$.assistantMessageID') = ? ORDER BY seq DESC LIMIT 1")
      .get(activity.session_id, message.id) as { data: string } | null
    assert.ok(step)
    const tokens = JSON.parse(step.data).tokens as { input: number; output: number }
    assert.equal(tokens.input, usage.prompt_tokens)
    assert.equal(tokens.output, usage.completion_tokens)
    const completed = reader.query("SELECT data FROM event WHERE aggregate_id = ? AND type = 'proxy.response.completed.1'")
      .get(`${tenantID}:${requestID}`) as { data: string } | null
    assert.ok(completed)
    assert.equal(JSON.parse(completed.data).mechanismTrace.activityID, activity.activity_id)
  } finally {
    reader.close()
  }
}

try {
  const models = await client.models.list()
  assert.ok(models.data.some((model) => model.id === config.modelID), `Gateway models: ${models.data.map((model) => model.id).join(",")}`)
  const direct = await client.chat.completions.create({
    model: config.modelID, messages: [{ role: "user", content: "Reply with one short sentence about a blue sky." }], max_tokens: 64,
  }, { headers: { "X-Request-ID": "proxy-direct" } })
  assert.ok(direct.choices[0]?.message.content)
  assert.ok(direct.usage?.prompt_tokens && direct.usage.completion_tokens)
  const directLedger = checkLedger("proxy-direct", direct.usage)
  assert.equal(directLedger.lane_session_id, null)
  evidence.push({ phase: "passthrough", requestID: "proxy-direct", input: direct.usage.prompt_tokens,
    output: direct.usage.completion_tokens, costKnown: directLedger.cost_total !== null })

  const admin = await fetch(`${baseURL}/proxy/admin/tenants/${tenantID}`, {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ tier: "context" }),
  })
  assert.equal(admin.status, 200)
  const context = await client.chat.completions.create({
    model: config.modelID, user: "smoke-lane", messages: [{ role: "user", content: "Reply with one short sentence about a green tree." }], max_tokens: 64,
  }, { headers: { "X-Request-ID": "proxy-context" } })
  assert.ok(context.choices[0]?.message.content)
  assert.ok(context.usage?.prompt_tokens && context.usage.completion_tokens)
  const contextLedger = checkLedger("proxy-context", context.usage)
  assert.ok(contextLedger.lane_session_id)
  checkTerminal("proxy-context", context.choices[0].message.content, context.usage)
  evidence.push({ phase: "context", requestID: "proxy-context", input: context.usage.prompt_tokens,
    output: context.usage.completion_tokens, costKnown: contextLedger.cost_total !== null })

  const chunks = await client.chat.completions.create({
    model: config.modelID, user: "smoke-lane", messages: [{ role: "user", content: "Reply with one short sentence about a red flower." }],
    max_tokens: 64, stream: true, stream_options: { include_usage: true },
  }, { headers: { "X-Request-ID": "proxy-stream" } })
  let streamedText = ""
  let streamUsage: { prompt_tokens: number; completion_tokens: number } | undefined
  for await (const chunk of chunks) {
    streamedText += chunk.choices[0]?.delta.content ?? ""
    if (chunk.usage) streamUsage = chunk.usage
  }
  assert.ok(streamedText)
  assert.ok(streamUsage?.prompt_tokens && streamUsage.completion_tokens)
  const streamLedger = checkLedger("proxy-stream", streamUsage)
  checkTerminal("proxy-stream", streamedText, streamUsage)
  evidence.push({ phase: "context-sse", requestID: "proxy-stream", input: streamUsage.prompt_tokens,
    output: streamUsage.completion_tokens, costKnown: streamLedger.cost_total !== null })

  const queued = await Promise.all(["alpha", "beta"].map((label) => client.chat.completions.create({
    model: config.modelID, user: "smoke-lane", messages: [{ role: "user", content: `Reply in one short sentence about ${label}.` }], max_tokens: 64,
  }, { headers: { "X-Request-ID": `proxy-${label}` } })))
  for (const [index, label] of ["alpha", "beta"].entries()) {
    const reply = queued[index]!
    assert.ok(reply.choices[0]?.message.content)
    assert.ok(reply.usage?.prompt_tokens && reply.usage.completion_tokens)
    const ledger = checkLedger(`proxy-${label}`, reply.usage)
    checkTerminal(`proxy-${label}`, reply.choices[0].message.content, reply.usage)
    evidence.push({ phase: `queue-${label}`, requestID: `proxy-${label}`, input: reply.usage.prompt_tokens,
      output: reply.usage.completion_tokens, costKnown: ledger.cost_total !== null })
  }
  const reader = new sqlite.Database(Flag.DEEPAGENT_CODE_DB, { readonly: true })
  try {
    assert.equal((reader.query("SELECT count(*) AS count FROM session_input WHERE session_id = ?")
      .get(contextLedger.lane_session_id) as { count: number }).count, 4)
    assert.equal((reader.query("SELECT count(*) AS count FROM deepagent_event_outbox WHERE event_type LIKE 'proxy.%'")
      .get() as { count: number }).count, 14)
  } finally {
    reader.close()
  }
  // A bounded single-tenant pilot samples repeated enhanced requests after the semantic gates.
  // Every sample must reconcile with both the provider receipt and the durable request ledger.
  for (const index of Array.from({ length: 10 }, (_, value) => value)) {
    const requestID = `proxy-soak-${index}`
    const started = performance.now()
    const reply = await client.chat.completions.create({
      model: config.modelID, user: "soak-lane",
      messages: [{ role: "user", content: `Reply with one short sentence about number ${index}.` }],
      max_tokens: 64,
    }, { headers: { "X-Request-ID": requestID } })
    soakLatencies.push(Math.round(performance.now() - started))
    assert.ok(reply.choices[0]?.message.content)
    assert.ok(reply.usage?.prompt_tokens && reply.usage.completion_tokens)
    const ledger = checkLedger(requestID, reply.usage)
    checkTerminal(requestID, reply.choices[0].message.content, reply.usage)
    evidence.push({ phase: "context-soak", requestID, input: reply.usage.prompt_tokens,
      output: reply.usage.completion_tokens, costKnown: ledger.cost_total !== null })
  }
  const sortedLatencies = [...soakLatencies].sort((left, right) => left - right)
  const soak = {
    tenant: tenantID,
    requests: soakLatencies.length,
    errorRate: 0,
    p95LatencyMs: sortedLatencies[Math.ceil(sortedLatencies.length * 0.95) - 1],
    usageDiscrepancies: 0,
  }
  await writeLiveArtifact(config, "proxy-smoke", { status: "passed", provider: config.providerID,
    model: config.modelID, requests: evidence, soak,
    totalTokens: evidence.reduce((total, item) => total + item.input + item.output, 0) })
  console.log(`proxy-smoke passed: ${evidence.length} provider exchanges, ${evidence.reduce((total, item) => total + item.input + item.output, 0)} tokens; pilot p95 ${soak.p95LatencyMs} ms`)
} catch (error) {
  await writeLiveArtifact(config, "proxy-smoke", { status: "failed", provider: config.providerID,
    model: config.modelID, requests: evidence, failure: error instanceof Error ? error.message.replaceAll(config.apiKey, "<redacted>") : "unknown" })
  throw error
} finally {
  await web.dispose()
  server.stop(true)
  Flag.DEEPAGENT_CODE_DB = originalDatabase
  if (previous.testHome === undefined) delete process.env.DEEPAGENT_CODE_TEST_HOME
  else process.env.DEEPAGENT_CODE_TEST_HOME = previous.testHome
  if (previous.database === undefined) delete process.env.DEEPAGENT_CODE_DB
  else process.env.DEEPAGENT_CODE_DB = previous.database
  await rm(root, { recursive: true, force: true })
}
