import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import OpenAI from "openai"
import { Effect } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { ProxyTenantTable } from "@deepagent-code/core/proxy/sql"
import { contentDigest } from "@deepagent-code/core/contract/digest"
import { loadLiveLLMConfig, writeLiveArtifact } from "../../../llm/script/live-llm/config"
import { liveWorkspaceConfig } from "./runtime"

const sqlite = await import("bun:sqlite")

// The companion to proxy-smoke: one official DeepSeek exchange through the actual CLI serve
// process. The owner chain, global config, and SQLite database all belong to this temporary home.
const config = await loadLiveLLMConfig()
assert.equal(config.providerID, "deepseek")
const root = await mkdtemp(path.join(os.tmpdir(), "deepagent-proxy-process-"))
const databaseName = "proxy-process.db"
const databasePath = path.join(root, ".deepagent", "code", databaseName)
const tenantID = "proxy-process"
const tenantKey = `sk-proxy-process-${randomUUID()}`
const requestID = "proxy-process-context"
const ledgerID = `${tenantID}:${requestID}`
const childEnv = {
  ...process.env,
  DEEPAGENT_CODE_TEST_HOME: root,
  HOME: root,
  XDG_CONFIG_HOME: path.join(root, ".config"),
  XDG_DATA_HOME: path.join(root, ".local/share"),
  XDG_STATE_HOME: path.join(root, ".local/state"),
  XDG_CACHE_HOME: path.join(root, ".cache"),
  DEEPAGENT_CODE_DB: databaseName,
  DEEPAGENT_CODE_DISABLE_PROJECT_CONFIG: "1",
  DEEPAGENT_CODE_PURE: "1",
  DEEPAGENT_CODE_DISABLE_AUTOUPDATE: "1",
  DEEPAGENT_CODE_DISABLE_AUTOCOMPACT: "1",
  DEEPAGENT_CODE_DISABLE_MODELS_FETCH: "1",
  DEEPAGENT_CODE_AUTH_CONTENT: "{}",
  DEEPAGENT_CODE_STRICT_PLAN_GATE: "false",
  DEEPAGENT_CODE_V2_OWNER_DEV_MINT: "1",
  DEEPAGENT_CODE_V2_OWNER_AUTHORIZATION_PUBLIC_KEY: "",
  DEEPAGENT_CODE_V2_OWNER_CAMPAIGN: "",
}

async function serve(gateway: boolean) {
  const child = Bun.spawn([
    process.execPath, "run", "--conditions=browser", path.resolve(import.meta.dir, "../../src/index.ts"),
    "serve", "--hostname", "127.0.0.1", "--port", "0",
  ], {
    cwd: root,
    env: { ...childEnv, DEEPAGENT_CODE_GATEWAY: String(gateway) },
    stdout: "pipe",
    stderr: "pipe",
  })
  const stderr = new Response(child.stderr).text()
  const reader = child.stdout.getReader()
  const ready = (async () => {
    const decoder = new TextDecoder()
    let output = ""
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) throw new Error(`deepagent serve exited before readiness (${await child.exited})`)
      output += decoder.decode(chunk.value, { stream: true })
      const match = output.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/)
      if (match) {
        // Keep draining the same reader; a locked stream cannot be wrapped in a new Response.
        void (async () => {
          while (!(await reader.read()).done) { /* discard later serve logs */ }
        })()
        return match[1]
      }
      output = output.slice(-4096)
    }
  })()
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("deepagent serve readiness timed out after 30s")), 30_000)
  })
  try {
    return { child, url: await Promise.race([ready, timeout]) }
  } catch (error) {
    child.kill()
    await child.exited
    const detail = (await stderr).replaceAll(config.apiKey, "<redacted>").replaceAll(tenantKey, "<redacted>")
    throw new Error(`${String(error)}\n${detail.slice(-2000)}`)
  } finally {
    clearTimeout(timer!)
  }
}

async function stop(child: ReturnType<typeof Bun.spawn>) {
  child.kill()
  await child.exited
}

function inspect(usage: { prompt_tokens: number; completion_tokens: number }, answer: string) {
  const reader = new sqlite.Database(databasePath, { readonly: true })
  try {
    const ledger = reader.query("SELECT lane_session_id, usage_input, usage_output, completed_at FROM proxy_request_ledger WHERE request_id = ?")
      .get(ledgerID) as { lane_session_id: string | null; usage_input: number; usage_output: number; completed_at: number } | null
    assert.ok(ledger?.completed_at)
    assert.ok(ledger.lane_session_id, "enhanced request must have a durable lane")
    assert.equal(ledger.usage_input, usage.prompt_tokens)
    assert.equal(ledger.usage_output, usage.completion_tokens)

    const promptID = `msg_${contentDigest(`proxy:${tenantID}:${requestID}`).slice(0, 40)}`
    const activity = reader.query("SELECT activity_id, session_id FROM session_activity WHERE trigger_input_id = ?")
      .get(promptID) as { activity_id: string; session_id: string } | null
    assert.ok(activity)
    assert.equal(activity.session_id, ledger.lane_session_id)
    const trigger = reader.query("SELECT promoted_seq FROM session_input WHERE id = ?")
      .get(promptID) as { promoted_seq: number } | null
    assert.ok(trigger)
    const message = reader.query("SELECT id, data FROM session_message WHERE session_id = ? AND type = 'assistant' AND seq > ? ORDER BY seq DESC LIMIT 1")
      .get(activity.session_id, trigger.promoted_seq) as { id: string; data: string } | null
    assert.ok(message, "missing durable terminal assistant")
    const terminal = JSON.parse(message.data) as { content: { type: string; text?: string }[] }
    assert.equal(terminal.content.filter((part) => part.type === "text").map((part) => part.text ?? "").join(""), answer)
    const step = reader.query("SELECT data FROM event WHERE aggregate_id = ? AND type = 'session.next.step.ended.2' AND json_extract(data, '$.assistantMessageID') = ? ORDER BY seq DESC LIMIT 1")
      .get(activity.session_id, message.id) as { data: string } | null
    assert.ok(step, "missing provider terminal event")
    const tokens = JSON.parse(step.data).tokens as { input: number; output: number }
    assert.equal(tokens.input, usage.prompt_tokens)
    assert.equal(tokens.output, usage.completion_tokens)

    for (const type of ["proxy.request.admitted.1", "proxy.response.completed.1"]) {
      assert.equal((reader.query("SELECT count(*) AS count FROM event WHERE aggregate_id = ? AND type = ?")
        .get(ledgerID, type) as { count: number }).count, 1, `missing durable ${type}`)
      assert.equal((reader.query("SELECT count(*) AS count FROM deepagent_event_outbox WHERE event_type = ? AND aggregate_id = ?")
        .get(type.replace(/\.1$/, ""), ledgerID) as { count: number }).count, 1, `missing audit outbox ${type}`)
    }
    const completed = reader.query("SELECT data FROM event WHERE aggregate_id = ? AND type = 'proxy.response.completed.1'")
      .get(ledgerID) as { data: string }
    assert.equal(JSON.parse(completed.data).mechanismTrace.activityID, activity.activity_id)
    return { laneSessionID: ledger.lane_session_id, activityID: activity.activity_id, auditEvents: 2 }
  } finally {
    reader.close()
  }
}

let active: Awaited<ReturnType<typeof serve>> | undefined
try {
  await mkdir(path.dirname(databasePath), { recursive: true })
  const provider = liveWorkspaceConfig(config, { "*": "deny" }, undefined, undefined, { modelMaxTokens: 96 })
  const configured = provider.provider?.["live-deepseek"]
  assert.ok(configured?.models?.[config.modelID])
  const workspace = { ...provider, provider: { ...provider.provider, "live-deepseek": {
    ...configured, models: { ...configured.models, [config.modelID]: {
      ...configured.models[config.modelID], cost: { input: 1, output: 2 },
    } },
  } } }
  await Bun.write(path.join(root, ".deepagent", "code", "config.jsonc"), JSON.stringify(workspace))
  await Effect.runPromise(Effect.gen(function* () {
    yield* (yield* Database.Service).db.insert(ProxyTenantTable).values({
      id: tenantID,
      key_hash: createHash("sha256").update(tenantKey).digest("hex"),
      key_fingerprint: "proxy-process-key",
      directory: root,
      model_allowlist: [`live-deepseek/${config.modelID}`],
      tier: "context",
      quota_requests_per_minute: 10,
      quota_tokens_per_day: 100_000,
      lane_limit: 8,
      deadline_ms: Math.min(config.timeoutMs, 180_000),
      enabled: true,
      created_at: Date.now(),
      updated_at: Date.now(),
    })
  }).pipe(Effect.provide(Database.layerFromPath(databasePath)), Effect.scoped))

  active = await serve(true)
  const client = new OpenAI({ apiKey: tenantKey, baseURL: `${active.url}/v1`, maxRetries: 0, timeout: config.timeoutMs })
  const models = await client.models.list()
  assert.ok(models.data.some((model) => model.id === config.modelID))
  const reply = await client.chat.completions.create({
    model: config.modelID,
    user: "process-lane",
    messages: [{ role: "user", content: "Reply with one short sentence about a silver moon." }],
    max_tokens: 64,
  }, { headers: { "X-Request-ID": requestID } })
  const answer = reply.choices[0]?.message.content
  assert.ok(answer)
  assert.ok(reply.usage?.prompt_tokens && reply.usage.completion_tokens)
  const durable = inspect(reply.usage, answer)
  await stop(active.child)
  active = await serve(false)
  const blocked = await fetch(`${active.url}/v1/models`, { headers: { authorization: `Bearer ${tenantKey}` } })
  assert.equal(blocked.status, 404)
  assert.equal((await blocked.json() as { error: { code: string } }).error.code, "gateway_disabled")
  const after = new sqlite.Database(databasePath, { readonly: true })
  try {
    assert.equal((after.query("SELECT count(*) AS count FROM proxy_request_ledger").get() as { count: number }).count, 1)
  } finally {
    after.close()
  }
  await writeLiveArtifact(config, "proxy-process-smoke", {
    status: "passed", provider: config.providerID, model: config.modelID,
    process: "deepagent serve", tier: "context", sdk: "openai",
    requestID, usage: { input: reply.usage.prompt_tokens, output: reply.usage.completion_tokens },
    durable, killSwitch: { status: blocked.status, ledgerRowsAfter: 1 },
  }, { redactions: [{ value: tenantKey }], harnessFiles: ["packages/deepagent-code/script/live-llm/proxy-process-smoke.ts"] })
  console.log(`proxy-process-smoke passed: 1 DeepSeek exchange, ${reply.usage.prompt_tokens + reply.usage.completion_tokens} tokens`)
} catch (error) {
  await writeLiveArtifact(config, "proxy-process-smoke", {
    status: "failed", provider: config.providerID, model: config.modelID,
    failure: error instanceof Error ? error.message : "unknown",
  }, { redactions: [{ value: tenantKey }], harnessFiles: ["packages/deepagent-code/script/live-llm/proxy-process-smoke.ts"] })
  throw error
} finally {
  if (active) await stop(active.child)
  await rm(root, { recursive: true, force: true })
}
