import { app, utilityProcess, BrowserWindow } from "electron"
import { createServer } from "node:http"
import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import assert from "node:assert/strict"
import { Schema } from "effect"
import { BrowserSchema } from "@deepagent-code/core/browser/schema"
import { Hash } from "@deepagent-code/core/util/hash"
import { installManagedBrowser } from "../managed-browser"
import { BrowserClientModelContext } from "./browser-client-model-context"

const root = process.env.DAC_BROWSER_CLIENT_ROOT!
const source = "return {version:1,steps:[{type:'fill',target:'name',text:'客户端中文确认'},{type:'select',target:'choice',values:['b']},{type:'click',target:'submit',waitForNavigation:true}]};"
app.setPath("userData", path.join(root, "electron-user"))
app.setPath("sessionData", path.join(root, "electron-session"))
app.commandLine.appendSwitch("disable-background-networking")
app.on("window-all-closed", () => {})

async function main() {
  assert(root && path.isAbsolute(root))
  assert(/^http:\/\/127\.0\.0\.1:[0-9]+$/.test(process.env.DAC_BROWSER_CLIENT_APP_ORIGIN ?? ""))
  await app.whenReady()
  const password = randomUUID()
  const deadlineAt = Date.now() + 300_000
  await fs.writeFile(path.join(root, "authorization"), `Basic ${Buffer.from(`deepagent-code:${password}`).toString("base64")}`, { mode: 0o600 })
  const requests: { method: string; pathname: string; bodyHash: string; bytes: number }[] = []
  const calls: { controlID: string; ordinal: number; tool: string | null }[] = []
  const incoming: { ordinal: number; bytes: number; sha256: string }[] = []
  const states = new Map<string, { ordinal: number; tab?: typeof BrowserSchema.Tab.Type; observed?: BrowserSchema.Result }>()
  const page = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const bytes of request) chunks.push(Buffer.from(bytes))
    const body = Buffer.concat(chunks)
    requests.push({ method: request.method ?? "", pathname: request.url ?? "", bodyHash: Hash.sha256(body), bytes: body.length })
    response.setHeader("Content-Type", "text/html; charset=utf-8")
    if (request.url === "/program-submit") {
      assert.equal(request.method, "POST")
      assert.equal(new URLSearchParams(body.toString()).get("name"), "客户端中文确认")
      assert.equal(new URLSearchParams(body.toString()).get("choice"), "b")
      response.end("<html><body><h1>Browser client program submitted</h1></body></html>")
      return
    }
    response.end('<html><body><h1>Browser client page</h1><form method="post" action="/program-submit"><label>Name<input name="name" aria-label="Name"></label><label>Choice<select name="choice" aria-label="Choice"><option value="a">A</option><option value="b">B</option></select></label><button type="submit">Submit</button></form></body></html>')
  })
  await new Promise<void>((resolve) => page.listen(0, "127.0.0.1", resolve))
  const address = page.address()
  assert(address && typeof address !== "string")
  const origin = `http://127.0.0.1:${address.port}`
  const bodySchema = Schema.Struct({ messages: Schema.Array(Schema.Struct({ role: Schema.String, content: Schema.Unknown })),
    tools: Schema.Array(Schema.Struct({ function: Schema.Struct({ name: Schema.String }) })) })
  const provider = createServer(async (request, response) => {
    try {
      assert.equal(request.url, "/v1/chat/completions")
      assert.equal(request.method, "POST")
      const chunks: Buffer[] = []
      for await (const bytes of request) chunks.push(Buffer.from(bytes))
      const bytes = Buffer.concat(chunks)
      incoming.push({ ordinal: incoming.length + 1, bytes: bytes.length, sha256: Hash.sha256(bytes) })
      await fs.writeFile(path.join(root, "provider-wire-" + incoming.length + "-private.json"), bytes, { flag: "wx", mode: 0o600 })
      const body = Schema.decodeUnknownSync(Schema.fromJsonString(bodySchema))(bytes.toString("utf8"))
      assert(body.tools.some((tool) => tool.function.name === "browser"), "Original tool must be offered by the actual runner")
      const controlID = BrowserClientModelContext.controlID(body.messages)
      // Fixed QA model response bytes, just as in the original canonical fixture.
      // This source is not an approval: the real tool/current control must match
      // the independently approved GUI/TUI bytes and ask its original permission.
      const state = states.get(controlID) ?? { ordinal: 0, tab: undefined as typeof BrowserSchema.Tab.Type | undefined,
        observed: undefined as BrowserSchema.Result | undefined }
      states.set(controlID, state)
      const ordinal = state.ordinal + 1
      assert(ordinal <= 5, "The controlled transport never retries unknown outcomes")
      const latest = body.messages.filter((value) => value.role === "tool").at(-1)?.content
      if (ordinal >= 2) {
        assert.equal(typeof latest, "string")
        const output = Schema.decodeUnknownSync(Schema.fromJsonString(BrowserSchema.Result))(latest)
        state.tab = output.tabs[0]
        if (ordinal === 4) state.observed = output
        if (ordinal === 5) assert.equal(output.program?.completedSteps, 3)
      }
      const command: BrowserSchema.Command | undefined = ordinal === 1 ? { type: "tabs.list" }
        : ordinal === 2 ? { type: "navigate", tabID: state.tab!.tabID, generation: state.tab!.generation, url: origin + "/program-page" }
          : ordinal === 3 ? { type: "snapshot", tabID: state.tab!.tabID, generation: state.tab!.generation }
            : ordinal === 4 ? { type: "program", tabID: state.tab!.tabID, generation: state.tab!.generation,
              frameID: state.observed!.frameID!, observationRevision: state.observed!.observationRevision!, source,
              scriptHash: Hash.sha256(source), argsJSON: "null",
              targets: ["Name", "Choice", "Submit"].map((name) => {
                const actual = state.observed!.refs?.find((ref) => ref.name === name)
                assert(actual, "Only original observed refs can enter a tool command")
                return { name: name.toLowerCase(), ref: actual.ref }
              }) } : undefined
      state.ordinal = ordinal
      calls.push({ controlID, ordinal, tool: command?.type ?? null })
      response.writeHead(200, { "content-type": "text/event-stream" })
      const emit = (value: object) => response.write(`data: ${JSON.stringify({ id: `client-${ordinal}`, object: "chat.completion.chunk",
        created: 1, model: "test-model", ...value })}\n\n`)
      emit({ choices: [{ index: 0, delta: { role: "assistant", ...(command ? { tool_calls: [{ index: 0,
        id: `client_call_${controlID}_${ordinal}`, type: "function", function: { name: "browser", arguments: JSON.stringify({ controlID, command }) } }] }
        : { content: "Browser client program completed" }) } }] })
      emit({ choices: [{ index: 0, delta: {}, finish_reason: command ? "tool_calls" : "stop" }],
        usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } })
      response.end("data: [DONE]\n\n")
    } catch (error) {
      await fs.writeFile(path.join(root, "provider-error-private.log"), error instanceof Error ? error.stack ?? error.message : String(error), { mode: 0o600 })
      response.destroy(error instanceof Error ? error : new Error("Controlled provider rejected the original request"))
    }
  })
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve))
  const providerAddress = provider.address()
  assert(providerAddress && typeof providerAddress !== "string")
  await fs.writeFile(path.join(root, "project/deepagent-code.json"), JSON.stringify({ formatter: false, lsp: false,
    // The original client picker reads ConfigV1's provider projection. Both
    // generations point at this same private free transport; execution remains V2.
    provider: { fixture: { name: "QA free controlled local transport", npm: "@ai-sdk/openai-compatible",
      options: { apiKey: "private-fixture", baseURL: `http://127.0.0.1:${providerAddress.port}/v1` },
      models: { "test-model": { name: "QA test model", tool_call: true, modalities: { input: ["text"], output: ["text"] },
        limit: { context: 100000, output: 4096 }, cost: { input: 0, output: 0 } } } } },
    model: "fixture/test-model", permissions: [{ action: "*", resource: "*", effect: "deny" },
      { action: "browser", resource: "*", effect: "ask" }, { action: "browser-program", resource: "*", effect: "ask" }],
    providers: { fixture: { name: "QA free controlled local transport", env: ["DAC_BROWSER_CLIENT_PROVIDER_KEY"],
      api: { type: "native", settings: {}, protocol: "openai-compatible.chat", url: `http://127.0.0.1:${providerAddress.port}/v1` },
      models: { "test-model": { api: { id: "test-model" }, capabilities: { input: ["text"], output: ["text"], tools: true },
        limit: { context: 100000, output: 4096 }, cost: { input: 0, output: 0 } } } } } }), { mode: 0o600 })
  const child = utilityProcess.fork(process.env.DAC_BROWSER_CLIENT_CHILD!, [], { cwd: path.join(root, "project"), env: {
    PATH: process.env.PATH, HOME: path.join(root, "home"), TMPDIR: path.join(root, "tmp"),
    XDG_CONFIG_HOME: path.join(root, "config"), XDG_DATA_HOME: path.join(root, "data"),
    XDG_CACHE_HOME: path.join(root, "cache"), XDG_STATE_HOME: path.join(root, "state"),
    DEEPAGENT_CODE_TEST_HOME: path.join(root, "home"), DEEPAGENT_CODE_DB: path.join(root, "authority.sqlite"),
    DEEPAGENT_CODE_SERVER_USERNAME: "deepagent-code", DEEPAGENT_CODE_SERVER_PASSWORD: password,
    DEEPAGENT_CODE_DISABLE_MODELS_FETCH: "1", DEEPAGENT_IM_AGENT_RESPONDER: "off", DEEPAGENT_ENABLED: "false",
    DEEPAGENT_CODE_V2_OWNER_DEV_MINT: "1", DAC_BROWSER_CLIENT_PROVIDER_KEY: "private-fixture",
    DAC_BROWSER_CLIENT_ROOT: root, DAC_BROWSER_CLIENT_PROGRAM: source, DAC_BROWSER_CLIENT_PAGE_ORIGIN: origin,
    DAC_BROWSER_CLIENT_APP_ORIGIN: process.env.DAC_BROWSER_CLIENT_APP_ORIGIN,
    DAC_BROWSER_CLIENT_DEADLINE: String(deadlineAt), NO_PROXY: "127.0.0.1,localhost,::1", NO_COLOR: "1",
    DAC_BROWSER_CLIENT_EXPECTED_CLIENTS: process.env.DAC_BROWSER_CLIENT_EXPECTED_CLIENTS,
  }, stdio: "pipe" })
  child.stdout?.on("data", (bytes) => process.stdout.write(bytes))
  child.stderr?.on("data", (bytes) => process.stderr.write(bytes))
  const ended = new Promise<number>((resolve) => child.once("exit", resolve))
  const watchdog = setTimeout(() => { child.kill() }, 330_000)
  const result = { stage: "startup", succeeded: false }
  child.on("message", (message) => {
    if (message.type === "managed-browser-bootstrap-ready-v1") { installManagedBrowser(child, password); return }
    if (message.type === "client-window-ready") { result.stage = "hold_ready"; console.log("CLIENT_NATIVE_WINDOW_READY"); return }
    if (message.type === "client-window-stopped") { result.stage = message.stage; result.succeeded = message.succeeded === true }
  })
  const code = await ended
  clearTimeout(watchdog)
  page.closeAllConnections()
  provider.closeAllConnections()
  await Promise.all([new Promise<void>((resolve) => page.close(() => resolve())), new Promise<void>((resolve) => provider.close(() => resolve()))])
  assert.equal(BrowserWindow.getAllWindows().length, 0)
  await fs.writeFile(path.join(root, "main-window-result-safe.json"), JSON.stringify({ ...result, childExit: code,
    providerCalls: calls, incoming, requests, windows: 0, listenersClosed: !page.listening && !provider.listening,
    controlledTransport: "Loopback-only QA response bytes, actual original provider admission and tool runner" }, null, 2), { mode: 0o600 })
  app.exit(result.succeeded && code === 0 ? 0 : 1)
}

void main().catch(async (error) => {
  await fs.writeFile(path.join(root, "main-error-private.log"), error instanceof Error ? error.stack ?? error.message : String(error), { mode: 0o600 })
  app.exit(1)
})
