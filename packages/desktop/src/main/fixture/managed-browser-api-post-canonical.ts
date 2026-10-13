// Canonical source-runtime oracle. Only the original child Root creates admissions,
// provider receipts and permission capabilities; Main supplies controlled network peers.
import { app, utilityProcess, BrowserWindow } from "electron"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import http from "node:http"
import https from "node:https"
import net from "node:net"
import tls from "node:tls"
import { Schema } from "effect"
import { BrowserSchema } from "@deepagent-code/core/browser/schema"
import { Hash } from "@deepagent-code/core/util/hash"
import { installManagedBrowser } from "../managed-browser"

const root = process.env.DAC_BROWSER_API_CANONICAL_ROOT!
const origin = "https://positive.example.com"
const requestBody = '{"value":"canonical Unicode 原请求"}'
app.setPath("userData", path.join(root, "electron-user"))
app.setPath("sessionData", path.join(root, "electron-session"))
app.commandLine.appendSwitch("disable-background-networking")
app.on("window-all-closed", () => {})

async function main() {
  await app.whenReady()
  const requests: Array<{ method: string; url: string; bytes: number; sha256: string }> = []
  const providerCalls: Array<{ ordinal: number; tool: string | null }> = []
  const providerArrivals: Array<{ method: string; url: string }> = []
  const pending: Array<{ action: string; url: string; posts: number }> = []
  const connects: string[] = []
  const doh: number[] = []
  const sockets = new Set<import("node:stream").Duplex>()
  const state: { controlID?: string; tab?: typeof BrowserSchema.Tab.Type; observed?: BrowserSchema.Result;
    close?: () => void; completed: boolean; authLeak: boolean } = { completed: false, authLeak: false }
  const page = https.createServer({ key: await fs.readFile(path.join(root, "server-key.pem")),
    cert: await fs.readFile(path.join(root, "server.pem")) }, (request, response) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body = Buffer.concat(chunks)
      if (request.headers.host === "cloudflare-dns.com") {
        assert.equal(request.method, "POST"); assert.equal(request.url, "/dns-query")
        assert.equal(request.headers["content-type"], "application/dns-message")
        const type = body.readUInt16BE(body.length - 4)
        doh.push(type)
        const header = Buffer.from(body)
        header.writeUInt16BE(0x8180, 2); header.writeUInt16BE(type === 1 ? 1 : 0, 6)
        const record = Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 93, 184, 216, 34])
        response.setHeader("content-type", "application/dns-message")
        response.end(type === 1 ? Buffer.concat([header, record]) : header)
        return
      }
      assert.equal(request.headers.host, "positive.example.com")
      state.authLeak ||= Boolean(request.headers.authorization || request.headers.cookie || request.headers["proxy-authorization"])
      requests.push({ method: request.method ?? "", url: request.url ?? "", bytes: body.length, sha256: Hash.sha256(body) })
      if (request.method === "GET" && request.url === "/canonical-page") {
        response.setHeader("content-type", "text/html")
        response.end("<html><body><h1>Canonical API document</h1></body></html>")
        return
      }
      assert.equal(request.method, "POST")
      assert.equal(request.headers["content-type"], "application/json")
      assert.equal(body.toString("utf8"), requestBody)
      if (request.url === "/held") { child.postMessage({ type: "api-held-arrived" }); return }
      assert.equal(request.url, "/api?request=canonical")
      response.setHeader("content-type", "application/json")
      response.end('{"accepted":true}')
    })().catch((error: unknown) => {
      void fs.writeFile(path.join(root, "peer-error.log"), error instanceof Error ? (error.stack ?? error.message) : String(error))
      response.destroy()
    })
  })
  page.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)) })
  await new Promise<void>((resolve) => page.listen(0, "127.0.0.1", resolve))
  const pageAddress = page.address()
  assert(pageAddress && typeof pageAddress !== "string")
  const proxy = http.createServer((_request, response) => { response.writeHead(403); response.end() })
  proxy.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)) })
  proxy.on("connect", (request, client, head) => {
    connects.push(request.url ?? "")
    assert(["1.1.1.1:443", "93.184.216.34:443"].includes(request.url ?? ""))
    const upstream = net.connect(pageAddress.port, "127.0.0.1", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n")
      if (head.length) upstream.write(head)
      client.pipe(upstream); upstream.pipe(client)
    })
    sockets.add(upstream); upstream.once("close", () => sockets.delete(upstream))
    upstream.on("error", () => client.destroy()); client.on("error", () => upstream.destroy())
    upstream.once("close", () => client.destroy()); client.once("close", () => upstream.destroy())
  })
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve))
  const proxyAddress = proxy.address()
  assert(proxyAddress && typeof proxyAddress !== "string")
  Object.assign(process.env, { https_proxy: `http://127.0.0.1:${proxyAddress.port}`, no_proxy: "", NO_PROXY: "" })
  tls.setDefaultCACertificates([...tls.getCACertificates("default"), await fs.readFile(path.join(root, "ca.pem"), "utf8")])
  const bodySchema = Schema.Struct({ messages: Schema.Array(Schema.Struct({ role: Schema.String, content: Schema.Unknown })),
    tools: Schema.Array(Schema.Struct({ function: Schema.Struct({ name: Schema.String }) })) })
  const provider = http.createServer((request, response) => {
    void (async () => {
      providerArrivals.push({ method: request.method ?? "", url: request.url ?? "" })
      assert.equal(request.url, "/v1/chat/completions")
      assert(state.controlID)
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body = Schema.decodeUnknownSync(Schema.fromJsonString(bodySchema))(Buffer.concat(chunks).toString("utf8"))
      assert(body.tools.some((tool) => tool.function.name === "browser"), "Original provider must offer browser")
      const ordinal = providerCalls.length + 1
      const latest = body.messages.filter((value) => value.role === "tool").at(-1)
      if (ordinal >= 2 && ordinal <= 5) {
        assert.equal(typeof latest?.content, "string")
        const output = Schema.decodeUnknownSync(Schema.fromJsonString(BrowserSchema.Result))(latest!.content)
        state.tab = output.tabs[0]
        if (ordinal === 4) state.observed = output
        if (ordinal === 5) assert.equal(output.apiPost?.text, '{"accepted":true}')
      }
      const api = (url: string): Extract<BrowserSchema.Command, { type: "api.post" }> => {
        assert(state.tab && state.observed?.frameID && state.observed.observationRevision)
        return { type: "api.post", actionTag: BrowserSchema.API_POST_ACTION_TAG, profileVersion: 1,
          tabID: state.tab.tabID, generation: state.tab.generation, frameID: state.observed.frameID,
          observationRevision: state.observed.observationRevision, url, contentType: "application/json", body: requestBody }
      }
      const command: BrowserSchema.Command | undefined = ordinal === 1 ? { type: "tabs.list" } : ordinal === 2 ? {
        type: "navigate", tabID: state.tab!.tabID, generation: state.tab!.generation, url: origin + "/canonical-page" } : ordinal === 3 ? {
        type: "snapshot", tabID: state.tab!.tabID, generation: state.tab!.generation } : ordinal === 4 ? api(origin + "/api?request=canonical") :
        ordinal === 6 ? api(origin + "/held") : undefined
      assert(ordinal <= 7, "Unexpected additional ordinary provider turn")
      if (ordinal === 7) assert(String(latest?.content).includes("BROWSER_UNKNOWN"), "Unknown API outcome must not be converted to success")
      providerCalls.push({ ordinal, tool: command?.type ?? null })
      response.writeHead(200, { "content-type": "text/event-stream" })
      const emit = (value: object) => response.write(`data: ${JSON.stringify({ id: `api-canonical-${ordinal}`,
        object: "chat.completion.chunk", created: 1, model: "test-model", ...value })}\n\n`)
      emit({ choices: [{ index: 0, delta: { role: "assistant", ...(command ? { tool_calls: [{ index: 0,
        id: `api_canonical_call_${ordinal}`, type: "function", function: { name: "browser",
          arguments: JSON.stringify({ controlID: state.controlID, command }) } }] } :
        { content: ordinal === 5 ? "Canonical API completed" : "Unknown dispatched API is not retried" }) } }] })
      emit({ choices: [{ index: 0, delta: {}, finish_reason: command ? "tool_calls" : "stop" }],
        usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } })
      response.end("data: [DONE]\n\n")
    })().catch((error: unknown) => {
      void fs.writeFile(path.join(root, "provider-error.log"), error instanceof Error ? (error.stack ?? error.message) : String(error))
      response.destroy(error instanceof Error ? error : new Error(String(error)))
    })
  })
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve))
  const providerAddress = provider.address()
  assert(providerAddress && typeof providerAddress !== "string")
  await fs.writeFile(path.join(root, "project/deepagent-code.json"), JSON.stringify({ formatter: false, lsp: false,
    model: "fixture/test-model", permissions: [{ action: "*", resource: "*", effect: "deny" },
      { action: "browser", resource: "*", effect: "ask" }, { action: "browser-api-post", resource: "*", effect: "ask" }],
    providers: { fixture: { name: "Canonical free controlled provider", env: ["DAC_CANONICAL_PROVIDER_KEY"],
      api: { type: "native", settings: {}, protocol: "openai-compatible.chat", url: `http://127.0.0.1:${providerAddress.port}/v1` },
      models: { "test-model": { api: { id: "test-model" }, capabilities: { input: ["text"], output: ["text"], tools: true },
        limit: { context: 100000, output: 4096 }, cost: { input: 0, output: 0 } } } } } }), { mode: 0o600 })
  const child = utilityProcess.fork(process.env.DAC_BROWSER_API_CANONICAL_CHILD!, [], { cwd: path.join(root, "project"), env: {
    PATH: process.env.PATH, HOME: path.join(root, "home"), TMPDIR: path.join(root, "tmp"), XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_DATA_HOME: path.join(root, "data"), XDG_CACHE_HOME: path.join(root, "cache"), XDG_STATE_HOME: path.join(root, "state"),
    DEEPAGENT_CODE_TEST_HOME: path.join(root, "home"), DEEPAGENT_CODE_DB: path.join(root, "authority.sqlite"),
    DEEPAGENT_CODE_SERVER_USERNAME: "deepagent-code", DEEPAGENT_CODE_SERVER_PASSWORD: "private-fixture",
    DEEPAGENT_CODE_DISABLE_MODELS_FETCH: "1", DEEPAGENT_IM_AGENT_RESPONDER: "off", DEEPAGENT_ENABLED: "false",
    DEEPAGENT_CODE_V2_OWNER_DEV_MINT: "1", DAC_CANONICAL_PROVIDER_KEY: "private-fixture",
    DAC_BROWSER_API_CANONICAL_ROOT: root, DAC_BROWSER_API_CANONICAL_ORIGIN: origin,
    NO_PROXY: "127.0.0.1,localhost,::1", NO_COLOR: "1",
  }, stdio: "pipe" })
  child.stdout?.on("data", (data) => process.stdout.write(data))
  child.stderr?.on("data", (data) => process.stderr.write(data))
  const timeout = setTimeout(() => { child.kill(); app.exit(2) }, 60_000)
  child.on("message", (message) => {
    if (message.type === "managed-browser-bootstrap-ready-v1") { state.close = installManagedBrowser(child, "private-fixture"); return }
    if (message.type === "canonical-control") { state.controlID = message.controlID; return }
    if (message.type === "canonical-api-pending") {
      const url = new URL(message.url).pathname + new URL(message.url).search
      pending.push({ action: message.action, url, posts: requests.filter((value) => value.method === "POST" && value.url === url).length })
      return
    }
    if (message.type !== "canonical-result" || state.completed) return
    state.completed = true
    void (async () => {
      clearTimeout(timeout)
      const exited = new Promise<number>((resolve) => child.once("exit", resolve))
      child.kill()
      await exited
      state.close?.()
      for (const socket of sockets) socket.destroy()
      await Promise.all([new Promise<void>((resolve) => { page.closeAllConnections(); page.close(() => resolve()) }),
        new Promise<void>((resolve) => { provider.closeAllConnections(); provider.close(() => resolve()) }),
        new Promise<void>((resolve) => { proxy.closeAllConnections(); proxy.close(() => resolve()) })])
      await fs.writeFile(path.join(root, "main-result.json"), JSON.stringify({ providerCalls, providerArrivals, requests, pending,
        authLeak: state.authLeak, doh, connects, diagnosticTrust: "private startup CA + fixed public IP CONNECT -> owned TLS peer; no external public request",
        cleanup: { childStopped: true, serversStopped: !page.listening && !provider.listening && !proxy.listening,
          windows: BrowserWindow.getAllWindows().length, peerSockets: sockets.size } }, null, 2), { mode: 0o600 })
      app.exit(message.succeeded ? 0 : 1)
    })()
  })
}

void main().catch(async (error: unknown) => {
  await fs.writeFile(path.join(root, "main-error.log"), error instanceof Error ? (error.stack ?? error.message) : String(error), { mode: 0o600 })
  app.exit(1)
})
