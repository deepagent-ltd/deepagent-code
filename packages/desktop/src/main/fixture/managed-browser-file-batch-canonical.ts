import { app, utilityProcess, BrowserWindow } from "electron"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import { watch } from "node:fs"
import path from "node:path"
import { Schema } from "effect"
import { BrowserSchema } from "@deepagent-code/core/browser/schema"
import { BrowserFileSchema } from "@deepagent-code/core/browser/file-exchange.schema"
import { installManagedBrowser } from "../managed-browser"
import { closeBrowserFileBatchServers } from "./managed-browser-file-batch-cleanup"

const root = process.env.DAC_BROWSER_TEST_ROOT!
app.setPath("userData", path.join(root, "electron-user"))
app.setPath("sessionData", path.join(root, "electron-session"))
app.commandLine.appendSwitch("disable-background-networking")
app.on("window-all-closed", () => {})
async function main() {
  await app.whenReady()
  const manifest = await Promise.all([0, 1, 2, 3].map(async (ordinal) => {
    const file = await fs.open(path.join(root, `project/source-${ordinal}.bin`), "wx", 0o600)
    const chunk = Buffer.alloc(1_048_576, ordinal + 1)
    const digest = createHash("sha256")
    try {
      for (let index = 0; index < BrowserFileSchema.MAX_FILE_BYTES / chunk.length; index++) {
        await file.writeFile(chunk); digest.update(chunk)
      }
      await file.sync()
    } finally { await file.close() }
    return { name: `source-${ordinal}.bin`, bytes: BrowserFileSchema.MAX_FILE_BYTES, sha256: digest.digest("hex") }
  }))
  const html = '<!doctype html><h1>Approved file exchange</h1><label>Upload files<input name="asset" type="file" multiple form="upload" aria-label="Upload files"></label><form id="upload" method="post" action="/upload" enctype="multipart/form-data"></form><a href="/download">Download file</a>'
  const requests: Array<{ method: string; url: string; bytes: number; files?: typeof manifest }> = []
  const sockets = new Set<import("node:net").Socket>()
  const page = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/download") {
      requests.push({ method: "GET", url: request.url, bytes: BrowserFileSchema.MAX_FILE_BYTES })
      response.setHeader("content-type", "application/octet-stream")
      response.setHeader("content-length", BrowserFileSchema.MAX_FILE_BYTES)
      const file = await fs.open(path.join(root, "project/source-0.bin"), "r")
      file.createReadStream({ autoClose: true }).pipe(response)
      return
    }
    if (request.method === "POST" && request.url === "/upload") {
      const chunks: Buffer[] = []
      let bytes = 0
      for await (const data of request) {
        bytes += data.length
        assert(bytes <= BrowserFileSchema.MAX_FILES * BrowserFileSchema.MAX_FILE_BYTES + 196_608)
        chunks.push(Buffer.from(data))
      }
      const body = Buffer.concat(chunks)
      const match = /boundary=(?:"([^"]+)"|([^;]+))/.exec(String(request.headers["content-type"]))
      assert(match)
      const separator = Buffer.from(`\r\n--${match[1] ?? match[2]}`)
      const found: typeof manifest = []
      let position = 0
      for (const expected of manifest) {
        const start = body.indexOf(Buffer.from("\r\n\r\n"), position)
        assert(start >= position)
        const header = body.subarray(position, start).toString("utf8")
        assert(header.includes(`filename="${expected.name}"`))
        const end = body.indexOf(separator, start + 4)
        assert(end >= start + 4)
        const payload = body.subarray(start + 4, end)
        assert.equal(payload.length, expected.bytes)
        assert.equal(createHash("sha256").update(payload).digest("hex"), expected.sha256)
        found.push(expected); position = end + separator.length
      }
      requests.push({ method: "POST", url: "/upload", bytes, files: found })
      response.setHeader("content-type", "text/html; charset=utf-8"); response.end(html); return
    }
    assert.equal(request.method, "GET")
    requests.push({ method: request.method!, url: request.url!, bytes: 0 })
    response.setHeader("content-type", "text/html; charset=utf-8"); response.end(html)
  })
  page.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)) })
  await new Promise<void>((resolve) => page.listen(0, "127.0.0.1", resolve))
  const address = page.address(); assert(address && typeof address !== "string")
  const origin = `http://127.0.0.1:${address.port}`
  const controls = new Map<string, { direction: "upload" | "download"; grantIDs: string[]; calls: number }>()
  const state: { controlID?: string } = {}
  const providerCalls: Array<{ direction: string; ordinal: number; command: string | null }> = []
  const pending: Array<{ direction: string; uploads: number; downloads: number }> = []
  const bodySchema = Schema.Struct({ messages: Schema.Array(Schema.Struct({ role: Schema.String, content: Schema.Unknown })),
    tools: Schema.Array(Schema.Struct({ function: Schema.Struct({ name: Schema.String }) })) })
  const provider = createServer(async (request, response) => {
    try {
      assert.equal(request.url, "/v1/chat/completions")
      assert(state.controlID)
      const control = controls.get(state.controlID)!; assert(control)
      const chunks: Buffer[] = []
      for await (const data of request) chunks.push(Buffer.from(data))
      const body = Schema.decodeUnknownSync(Schema.fromJsonString(bodySchema))(Buffer.concat(chunks).toString("utf8"))
      assert(body.tools.some((tool) => tool.function.name === "browser"))
      const ordinal = ++control.calls
      assert(ordinal <= 5, "Unknown effects must not cause extra provider retries")
      const latest = body.messages.filter((message) => message.role === "tool").at(-1)
      const observed = ordinal > 1
        ? Schema.decodeUnknownSync(Schema.fromJsonString(BrowserSchema.Result))(String(latest?.content)) : undefined
      const tab = observed?.tabs[0]
      const target = observed?.refs?.find((ref) => ref.name === (control.direction === "upload" ? "Upload files" : "Download file"))
      const command: BrowserSchema.Command | undefined = ordinal === 1 ? { type: "tabs.list" }
        : ordinal === 2 ? { type: "navigate", tabID: tab!.tabID, generation: tab!.generation, url: origin + "/" }
        : ordinal === 3 ? { type: "snapshot", tabID: tab!.tabID, generation: tab!.generation }
        : ordinal === 4 ? { type: control.direction === "upload" ? "file.upload" : "file.download",
          tabID: tab!.tabID, generation: tab!.generation, frameID: target!.frameID,
          observationRevision: observed!.observationRevision!, ref: target!.ref,
          ...(control.direction === "upload" ? { grantIDs: control.grantIDs } : { grantID: control.grantIDs[0]! }) } as BrowserSchema.Command
        : undefined
      if (ordinal === 4) assert(target && observed?.observationRevision)
      if (ordinal === 5) assert.equal(observed?.files?.length, control.grantIDs.length)
      providerCalls.push({ direction: control.direction, ordinal, command: command?.type ?? null })
      response.writeHead(200, { "content-type": "text/event-stream" })
      const emit = (value: object) => response.write(`data: ${JSON.stringify({ id: `files-${control.direction}-${ordinal}`,
        object: "chat.completion.chunk", created: 1, model: "test-model", ...value })}\n\n`)
      emit({ choices: [{ index: 0, delta: { role: "assistant", ...(command ? { tool_calls: [{ index: 0,
        id: `canonical_file_${control.direction}_${ordinal}`, type: "function", function: { name: "browser",
          arguments: JSON.stringify({ controlID: state.controlID, command, timeoutMs: BrowserSchema.MAX_TIMEOUT_MS }) } }] }
        : { content: "Approved file exchange completed" }) } }] })
      emit({ choices: [{ index: 0, delta: {}, finish_reason: command ? "tool_calls" : "stop" }],
        usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } })
      response.end("data: [DONE]\n\n")
    } catch (error) {
      await fs.writeFile(path.join(root, "provider-error-private.log"), error instanceof Error ? error.stack ?? error.message : String(error), { mode: 0o600 })
      response.destroy(error instanceof Error ? error : new Error(String(error)))
    }
  })
  provider.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)) })
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve))
  const providerAddress = provider.address(); assert(providerAddress && typeof providerAddress !== "string")
  await fs.writeFile(path.join(root, "project/deepagent-code.json"), JSON.stringify({ formatter: false, lsp: false,
    model: "fixture/test-model", providers: { fixture: { name: "Canonical private file provider", env: ["DAC_CANONICAL_PROVIDER_KEY"],
      api: { type: "native", settings: {}, protocol: "openai-compatible.chat", url: `http://127.0.0.1:${providerAddress.port}/v1` },
      models: { "test-model": { api: { id: "test-model" }, capabilities: { input: ["text"], output: ["text"], tools: true },
        limit: { context: 100_000, output: 4096 }, cost: { input: 0, output: 0 } } } } } }), { mode: 0o600 })
  const child = utilityProcess.fork(process.env.DAC_BROWSER_CHILD!, [], { cwd: path.join(root, "project"),
    env: { PATH: process.env.PATH, HOME: path.join(root, "home"), TMPDIR: path.join(root, "tmp"), XDG_CONFIG_HOME: path.join(root, "config"),
      XDG_DATA_HOME: path.join(root, "data"), XDG_CACHE_HOME: path.join(root, "cache"), XDG_STATE_HOME: path.join(root, "state"),
      DEEPAGENT_CODE_TEST_HOME: path.join(root, "home"), DEEPAGENT_CODE_DB: path.join(root, "authority.sqlite"),
      DEEPAGENT_CODE_SERVER_USERNAME: "deepagent-code", DEEPAGENT_CODE_SERVER_PASSWORD: "private-fixture",
      DEEPAGENT_CODE_DISABLE_MODELS_FETCH: "1", DEEPAGENT_IM_AGENT_RESPONDER: "off", DEEPAGENT_ENABLED: "false",
      DEEPAGENT_CODE_V2_OWNER_DEV_MINT: "1", DAC_CANONICAL_PROVIDER_KEY: "private-fixture", DAC_BROWSER_TEST_ROOT: root,
      ...(process.env.DAC_BROWSER_FILE_BATCH_DIRECTION === "download" ? { DAC_BROWSER_FILE_BATCH_DIRECTION: "download" } : {}),
      DAC_BROWSER_ORIGIN: origin, NO_PROXY: "127.0.0.1,localhost,::1", NO_COLOR: "1" }, stdio: "pipe" })
  child.stdout?.on("data", (data) => process.stdout.write(data))
  child.stderr?.on("data", (data) => process.stderr.write(data))
  const stopped = Promise.withResolvers<number | null>()
  child.once("exit", (code) => stopped.resolve(code))
  const timer = setTimeout(() => child.kill(), 220_000)
  const owner: { manager?: ReturnType<typeof installManagedBrowser>; result?: boolean } = {}
  // Private QA coordination only. Actual grants still come from the original
  // native confirmation and original PermissionV2 replies below.
  const uiReady = watch(root, (_, filename) => {
    if (filename !== "native-ui-ready-upload" && filename !== "native-ui-ready-download") return
    child.postMessage({ type: "canonical-file-ui-ready", direction: filename.endsWith("upload") ? "upload" : "download" })
  })
  child.on("message", (message) => {
    if (message.type === "managed-browser-bootstrap-ready-v1") { owner.manager = installManagedBrowser(child, "private-fixture"); return }
    if (message.type === "canonical-file-control") {
      state.controlID = message.controlID
      controls.set(message.controlID, { direction: message.direction, grantIDs: message.grantIDs, calls: 0 }); return
    }
    if (message.type === "canonical-file-native-pending") {
      void fs.writeFile(path.join(root, "native-confirm-stage-private.json"), JSON.stringify({ direction: message.direction,
        ordinal: message.ordinal, mainPID: process.pid }), { mode: 0o600 }); return
    }
    if (message.type === "canonical-file-permission-pending") {
      pending.push({ direction: message.direction, uploads: requests.filter((value) => value.method === "POST").length,
        downloads: requests.filter((value) => value.url === "/download").length }); return
    }
    if (message.type === "canonical-file-result") { owner.result = message.succeeded; child.kill() }
  })
  const code = await stopped.promise
  clearTimeout(timer); uiReady.close(); owner.manager?.()
  await closeBrowserFileBatchServers([page, provider], sockets)
  await fs.writeFile(path.join(root, "main-result.json"), JSON.stringify({ providerCalls, requests, pending, manifest,
    cleanup: { childExit: code, windows: BrowserWindow.getAllWindows().length, sockets: sockets.size } }, null, 2), { mode: 0o600 })
  app.exit(owner.result ? 0 : 1)
}
void main().catch(async (error) => {
  await fs.writeFile(path.join(root, "main-error-private.log"), error instanceof Error ? error.stack ?? error.message : String(error), { mode: 0o600 })
  app.exit(1)
})
