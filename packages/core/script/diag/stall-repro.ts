// Stall repro probe: boots the packaged binary (serve) against a slow streaming stub LLM and
// measures the provider-owner heartbeat cadence while a provider turn streams. A healthy loop
// heartbeats every ~10s; the ablation environment showed multi-minute heartbeat gaps during long
// provider turns. When hb_age crosses the threshold the probe samples the process so the blocking
// stack is captured.
//
//   bun script/diag/stall-repro.ts <packaged-binary> [out-dir] [deltas] [delay-ms]
import { $ } from "bun"
import { Database } from "bun:sqlite"

const binary = process.argv[2]
const out = process.argv[3] ?? "/tmp/stall-repro"
const deltas = Number(process.argv[4] ?? 2400)
const delayMs = Number(process.argv[5] ?? 40)
if (!binary) throw new Error("usage: bun stall-repro.ts <packaged-binary> [out-dir] [deltas] [delay-ms]")

const home = `${out}/home`
await $`mkdir -p ${home} && rm -rf ${out}/samples`.quiet()
await $`git init --quiet ${out}/workspace`

let physicalCalls = 0
const llm = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    physicalCalls++
    const body = (await request.json().catch(() => ({}))) as { stream?: boolean }
    console.log(`[stub] call#${physicalCalls} path=${new URL(request.url).pathname} stream=${body.stream}`)
    if (!body.stream) {
      return Response.json({
        id: "chatcmpl-stall",
        object: "chat.completion",
        created: (Date.now() / 1000) | 0,
        model: "test-model",
        choices: [{ index: 0, message: { role: "assistant", content: "stub-reply" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })
    }
    const chunk = (delta: Record<string, unknown>, finish: string | null) =>
      `data: ${JSON.stringify({
        id: "chatcmpl-stall",
        object: "chat.completion.chunk",
        created: (Date.now() / 1000) | 0,
        model: "test-model",
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`
    const stream = new ReadableStream({
      async start(controller) {
        controller.enqueue(new TextEncoder().encode(chunk({ role: "assistant", content: "" }, null)))
        for (let i = 0; i < deltas; i++) {
          controller.enqueue(new TextEncoder().encode(chunk({ content: `d${i} ` }, null)))
          await Bun.sleep(delayMs)
        }
        controller.enqueue(new TextEncoder().encode(chunk({}, "stop")))
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"))
        controller.close()
      },
    })
    return new Response(stream, { headers: { "content-type": "text/event-stream" } })
  },
})

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
      options: { apiKey: "stall-probe", baseURL: llm.url },
    },
  },
}
await Bun.write(`${home}/.deepagent/code/config.jsonc`, JSON.stringify(config))

const db = `${home}/.deepagent/code/stall.db`
const serve = Bun.spawn(["arch", "-x86_64", binary, "serve", "--port", "0"], {
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
  cwd: `${out}/workspace`,
})
const pid = serve.pid
console.log("serve pid:", pid)

const stderrTail: string[] = []
void Promise.resolve(new Response(serve.stderr).text()).then((t) => stderrTail.push(t))
const decoder = new TextDecoder()
let base = ""
{
  const reader = serve.stdout.getReader()
  const deadline = Date.now() + 30_000
  let buffer = ""
  while (Date.now() < deadline && !base) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value)
    const match = buffer.match(/listening on (https?:\/\/[^\s]+)/)
    if (match) base = match[1]
  }
}
if (!base) throw new Error(`no URL; stderr: ${stderrTail.join("").slice(-2000)}`)
console.log("serve at:", base)

const headers = { "content-type": "application/json", "x-deepagent-code-directory": `${out}/workspace` }
for (let attempt = 0; attempt < 60; attempt++) {
  try {
    if ((await fetch(`${base}/global/health`)).ok) break
  } catch {}
  await Bun.sleep(500)
}
const session = (await (
  await fetch(`${base}/session`, { method: "POST", headers, body: JSON.stringify({ directory: `${out}/workspace` }) })
).json()) as { id: string }
console.log("session:", session.id)

// The prompt POST awaits the whole turn, so the heartbeat probe runs CONCURRENTLY.
const probe = (async () => {
  let maxAge = 0
  let samples = 0
  const t0 = Date.now()
  for (let i = 0; i < 400; i++) {
    await Bun.sleep(1000)
    let age = -1
    try {
      const database = new Database(db, { readonly: true })
      const row = database
        .query(`SELECT heartbeat_at FROM session_provider_owner_lease ORDER BY heartbeat_at DESC LIMIT 1`)
        .get() as { heartbeat_at: number } | undefined
      database.close()
      if (row) age = Math.round((Date.now() - row.heartbeat_at) / 100) / 10
    } catch {}
    let cpu = "?"
    try {
      cpu = (await $`ps -p ${pid} -o %cpu=`.text()).trim()
    } catch {}
    console.log(`[t+${Math.round((Date.now() - t0) / 1000)}s] hb_age=${age}s cpu=${cpu}%`)
    if (age > maxAge) maxAge = age
    if (age >= 15 && age < 16.5 && samples < 3) {
      samples++
      await $`sample ${pid} 3 -file ${out}/samples/stall-${samples}.txt`.quiet().nothrow()
      console.log(`*** stall sample ${samples} captured (hb_age=${age}s)`)
    }
  }
  return { maxAge, samples }
})()

const prompt = await fetch(`${base}/session/${session.id}/message`, {
  method: "POST",
  headers,
  body: JSON.stringify({
    agent: "build",
    model: { providerID: "test", modelID: "test-model" },
    parts: [{ type: "text", text: "stall repro turn" }],
  }),
})
if (!prompt.ok) throw new Error(`prompt failed: ${prompt.status}`)
console.log("prompt settled")
serve.kill()
llm.stop()
const probeResult = await probe
console.log(`DONE max_hb_age=${probeResult.maxAge}s samples=${probeResult.samples} physicalCalls=${physicalCalls}`)
