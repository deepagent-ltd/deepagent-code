#!/usr/bin/env bun
/**
 * Replay-history worker: runs ONE scenario in a child process so HOME and all state-dir env are
 * pinned before any module import (mutating process.env.HOME mid-process does not move
 * os.homedir() — the in-process variant once pointed a replay server at the real ~/.deepagent).
 * The parent spawns this with a clean environment.
 *
 *   bun replay-worker.ts <scenario.json> <workspace-dir>
 *
 * Emits the scenario result as JSON on stdout.
 */
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { Database } from "bun:sqlite"

const [scenarioFile, workspace] = process.argv.slice(2)
const scenario = (await Bun.file(scenarioFile).json()) as {
  readonly id: string
  readonly agent: string | null
  readonly ops: ReadonlyArray<{ readonly text: string }>
}
const home = path.dirname(workspace)
const maxOps = Number(process.env.REPLAY_OPS ?? 5)
const scenarioTimeoutMs = Number(process.env.REPLAY_SCENARIO_TIMEOUT_MS ?? 240_000)

const llm = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const body = (await request.json()) as { messages?: { content: unknown }[]; stream?: boolean }
    const last = body.messages?.at(-1)?.content
    const text = (typeof last === "string" ? last : "replay-stub-reply").slice(0, 400)
    const reply = () =>
      Response.json({
        id: "chatcmpl-replay",
        object: "chat.completion",
        created: (Date.now() / 1000) | 0,
        model: "test-model",
        choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })
    if (body.stream !== true) return reply()
    // Mirror the test fixture's SSE shape: role chunk, content delta, finish+usage, DONE.
    const chunk = (input: { delta?: Record<string, unknown>; finish?: string; usage?: unknown }) =>
      `data: ${JSON.stringify({
        id: "chatcmpl-replay",
        object: "chat.completion.chunk",
        choices: [{ delta: input.delta ?? {}, ...(input.finish ? { finish_reason: input.finish } : {}) }],
        ...(input.usage ? { usage: input.usage } : {}),
      })}\n\n`
    return new Response(
      [
        chunk({ delta: { role: "assistant" } }),
        chunk({ delta: { content: text } }),
        chunk({ finish: "stop", usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
        "data: [DONE]\n\n",
      ].join(""),
      { headers: { "content-type": "text/event-stream" } },
    )
  },
})

const config = {
  formatter: false,
  lsp: false,
  compaction: { tail_turns: 1, preserve_recent_tokens: 1000, prune: false },
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
          limit: { context: 200_000, output: 10_000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: { apiKey: "replay-stub", baseURL: llm.url },
    },
  },
}
const configDir = path.join(home, ".deepagent", "code")
mkdirSync(configDir, { recursive: true })
writeFileSync(path.join(configDir, "config.jsonc"), JSON.stringify(config))
process.env.DEEPAGENT_CODE_V2_OWNER_DEV_MINT = "1"
process.env.DEEPAGENT_CODE_DB = "replay.db"
process.env.DEEPAGENT_CODE_CONFIG_CONTENT = JSON.stringify(config)

const { Server } = await import("../../src/server/server")

const opResults: Record<string, unknown>[] = []
let status = "pass"
let failure = ""
const started = Date.now()
try {
  const server = await Server.listen({ hostname: "127.0.0.1", port: 0 })
  const headers = { "content-type": "application/json", "x-deepagent-code-directory": workspace }
  if ((await fetch(`${server.url}/global/health`)).status !== 200) throw new Error("health != 200")

  const created = await fetch(`${server.url}/session`, {
    method: "POST",
    headers,
    body: JSON.stringify({ title: `replay ${scenario.id}` }),
  })
  const sessionID = ((await created.json()) as { id?: string }).id
  if (!sessionID) throw new Error(`create=${created.status}`)

  for (const [index, op] of scenario.ops.slice(0, maxOps).entries()) {
    const opStart = Date.now()
    const response = await fetch(`${server.url}/session/${sessionID}/message`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        agent: scenario.agent ?? "build",
        model: { providerID: "test", modelID: "test-model" },
        parts: [{ type: "text", text: op.text }],
      }),
      signal: AbortSignal.timeout(scenarioTimeoutMs),
    }).catch((error) => {
      status = "fail"
      failure = `op${index}: ${String(error).slice(0, 120)}`
      return null
    })
    if (!response) break
    const bodyText = (await response.text()).slice(0, 160)
    const ok = response.status === 200
    if (!ok && status === "pass") {
      status = response.status >= 500 ? "fail" : "typed"
      failure = `op${index}: ${response.status} ${bodyText.slice(0, 120)}`
    }
    opResults.push({ op: index, status: response.status, ms: Date.now() - opStart, bytes: op.text.length })
    if (!ok && response.status >= 500) break
  }

  await Bun.sleep(500)
  await server.stop(true)
} catch (error) {
  status = "fail"
  failure = String(error).slice(0, 200)
}

let evidence = -1
let receipts = -1
try {
  const db = new Database(path.join(configDir, "replay.db"), { readonly: true })
  evidence = (db.query("SELECT COUNT(*) AS n FROM runtime_integrity_evidence_artifact").get() as { n: number }).n
  receipts = (db.query("SELECT COUNT(*) AS n FROM session_v2_provider_turn_receipt").get() as { n: number }).n
  db.close()
} catch {
  // the server never got far enough to create the database — counts stay -1
}
llm.stop(true)

console.log(
  JSON.stringify({
    id: scenario.id,
    status,
    failure,
    totalMs: Date.now() - started,
    replayedOps: opResults.length,
    ops: opResults,
    receipts,
    evidenceArtifacts: evidence,
  }),
)
process.exit(0)
