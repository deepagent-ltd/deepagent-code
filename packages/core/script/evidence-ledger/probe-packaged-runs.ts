#!/usr/bin/env bun
// RI-51 packaged evidence probe: boots the packaged binary against a stub LLM + file DB, drives
// one settled provider turn per run, and emits the PackagedRuntimeRun rows (contract in
// src/contract/packaged-runtime-report.ts) assembled from the probe's durable state plus the
// live HTTP surfaces. Usage:
//   bun probe-packaged-runs.ts <packaged-binary> <runs-out.json> [probe-home] [evidence-out.json]
import { $ } from "bun"
import { Database } from "bun:sqlite"

const binary = process.argv[2]
const runsOut = process.argv[3]
if (!binary || !runsOut) throw new Error("usage: bun probe-packaged-runs.ts <packaged-binary> <runs-out.json> [probe-home]")

const home = process.argv[4] ?? "/tmp/ri51-probe/home"
const workspace = `${home}/workspace`
await $`rm -rf ${home} || true`.quiet()
await $`mkdir -p ${home}/.deepagent/code`.quiet()
await $`git init --quiet ${workspace}`

let physicalCalls = 0
const llm = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    physicalCalls++
    const body = (await request.json()) as {
      stream?: boolean
      messages?: { content: unknown }[]
    }
    const last = body.messages?.at(-1)?.content
    const text = typeof last === "string" ? last : "stub-reply"
    if (!body.stream) {
      return Response.json({
        id: "chatcmpl-stub",
        object: "chat.completion",
        created: (Date.now() / 1000) | 0,
        model: "test-model",
        choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })
    }
    // OpenAI chat SSE: content delta, empty delta with finish, then DONE.
    const chunk = (delta: Record<string, unknown>, finish: string | null) =>
      `data: ${JSON.stringify({
        id: "chatcmpl-stub",
        object: "chat.completion.chunk",
        created: (Date.now() / 1000) | 0,
        model: "test-model",
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`
    const sse =
      chunk({ role: "assistant", content: text }, null) +
      chunk({}, "stop") +
      "data: [DONE]\n\n"
    return new Response(sse, { headers: { "content-type": "text/event-stream" } })
  },
})
console.log("stub llm:", llm.url)

const config = {
  formatter: false,
  lsp: false,
  provider: {
    test: {
      name: "Test",
      id: "test",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        "test-model": {
          id: "test-model",
          name: "Test Model",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 100_000, output: 10_000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: { apiKey: "ri51-probe", baseURL: llm.url },
    },
  },
}
await Bun.write(`${home}/.deepagent/code/config.jsonc`, JSON.stringify(config))

const db = `${home}/.deepagent/code/probe.db`
const serve = Bun.spawn([binary, "serve", "--port", "0"], {
  env: {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: `${home}/.config`,
    XDG_DATA_HOME: `${home}/.local/share`,
    XDG_STATE_HOME: `${home}/.local/state`,
    XDG_CACHE_HOME: `${home}/.cache`,
    DEEPAGENT_CODE_CONFIG_CONTENT: JSON.stringify(config),
    DEEPAGENT_CODE_DISABLE_PROJECT_CONFIG: "1",
    DEEPAGENT_CODE_DISABLE_AUTOUPDATE: "1",
    DEEPAGENT_CODE_DISABLE_MODELS_FETCH: "1",
    DEEPAGENT_CODE_AUTH: "{}",
    DEEPAGENT_CODE_V2_OWNER_DEV_MINT: "1",
    DEEPAGENT_CODE_DB: db,
  },
  stdout: "pipe",
  stderr: "pipe",
  stdin: "ignore",
  cwd: workspace,
})

const stderrChunks: string[] = []
void Promise.resolve(new Response(serve.stderr).text()).then((t) => stderrChunks.push(t))
const lineIterator = serve.stdout.getReader()
let base = ""
{
  const decoder = new TextDecoder()
  const deadline = Date.now() + 30_000
  let buffer = ""
  while (Date.now() < deadline && !base) {
    // Plain sequential read: the packaged serve prints its listening line within a few seconds;
    // racing a sleep against read() would drop pending read results and wedge the stream.
    const { value, done } = await lineIterator.read()
    if (done) break
    buffer += decoder.decode(value)
    const match = buffer.match(/listening on (https?:\/\/[^\s]+)/)
    if (match) base = match[1]
  }
}
if (!base) {
  throw new Error(`serve did not report a URL; stderr: ${stderrChunks.join("").slice(0, 2000)}`)
}
console.log("serve at:", base)

const headers = { "content-type": "application/json", "x-deepagent-code-directory": workspace }
for (let attempt = 0; attempt < 60; attempt++) {
  try {
    const health = await fetch(`${base}/global/health`)
    if (health.ok) break
  } catch {}
  await Bun.sleep(500)
}

const createResponse = await fetch(`${base}/session`, {
  method: "POST",
  headers,
  body: JSON.stringify({ directory: workspace }),
})
if (!createResponse.ok) throw new Error(`session create failed: ${createResponse.status} ${await createResponse.text()}`)
const session = (await createResponse.json()) as { id: string }
console.log("session:", session.id)

const promptResponse = await fetch(`${base}/session/${session.id}/message`, {
  method: "POST",
  headers,
  body: JSON.stringify({
    agent: "build",
    model: { providerID: "test", modelID: "test-model" },
    parts: [{ type: "text", text: "ri51 packaged evidence probe turn" }],
  }),
})
if (!promptResponse.ok) throw new Error(`prompt failed: ${promptResponse.status} ${await promptResponse.text()}`)
console.log("prompt accepted")

// Wait for the durable turn to settle (poll the V2 receipt in the probe DB).
let receipt: Record<string, unknown> | undefined
for (let attempt = 0; attempt < 120 && !receipt; attempt++) {
  await Bun.sleep(500)
  try {
    const database = new Database(db, { readonly: true })
    receipt = database
      .query(
        `SELECT receipt_id, state, provider_attempt_id, prepared_turn, integrity_evidence_hash, integrity_evidence FROM session_v2_provider_turn_receipt WHERE session_id = ? ORDER BY created_at DESC LIMIT 1`,
      )
      .get(session.id) as Record<string, unknown> | undefined
    database.close()
  } catch {}
}
if (!receipt) throw new Error("no V2 provider receipt appeared in the probe DB")
const settled = receipt.state === "settled"
console.log("receipt:", receipt.receipt_id, receipt.state)

const digestResponse = await fetch(`${base}/composition/digest`)
const digestBody = (await digestResponse.json()) as { digest: string }
console.log("composition digest:", digestBody.digest)

// The run's evidenceDigest binds the durable runtime-integrity evidence artifact (RI-24
// contract), exported alongside the runs so the authoritative ledger can cross-check it against
// the evidence dir.
const evidenceOut = process.argv[5]
if (evidenceOut && receipt.integrity_evidence) {
  await Bun.write(evidenceOut, `${JSON.stringify(JSON.parse(String(receipt.integrity_evidence)), null, 2)}\n`)
}
const prepared = JSON.parse(String(receipt.prepared_turn)) as { tool_registry_ids?: string[] }
serve.kill()
await serve.exited
llm.stop()

const runs = [
  {
    // entrypoint/artifactPath are byte-stable across machines: the packaged binary artifact this
    // run exercised (relative to --package-dir), never absolute local paths.
    entrypoint: "deepagent-code serve",
    artifactPath: "bin/deepagent-code",
    evidenceDigest: String(receipt.integrity_evidence_hash ?? receipt.receipt_id),
    sessionID: session.id,
    attemptID: String(receipt.provider_attempt_id ?? receipt.receipt_id),
    rootCompositionDigest: digestBody.digest,
    toolIDs: prepared.tool_registry_ids ?? [],
    physicalCallCount: physicalCalls,
    terminalStatus: settled ? "settled" : String(receipt.state),
  },
]
await Bun.write(runsOut, JSON.stringify(runs, null, 2))
console.log("runs written:", runsOut, JSON.stringify(runs[0], null, 2))
