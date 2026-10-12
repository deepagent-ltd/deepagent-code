/** @jsxImportSource @opentui/solid */
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { mock } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { Effect } from "effect"
import { Global } from "@deepagent-code/core/global"
import type { GlobalEvent } from "@deepagent-code/sdk"
import { dict } from "../../src/i18n/en"
import { createTuiResolvedConfig } from "./tui-runtime"
import type { McpOperatorClient } from "@deepagent-code/core/mcp/operator-client"

const { authorizationServer } = (await import(
  path.resolve(import.meta.dir, "../../../deepagent-code/test/fixture/mcp-local-operator.ts")
)) as {
  authorizationServer(): {
    listener: { url: URL; stop(close: boolean): Promise<void> }
    calls: { path: string; method: string }[]
    release(): void
  }
}
const { createMcpOperatorBridge } = (await import(
  path.resolve(import.meta.dir, "../../../deepagent-code/src/cli/tui/mcp-operator-bridge.ts")
)) as {
  createMcpOperatorBridge(
    worker: Worker,
    directory: string,
  ): Promise<{ transport: McpOperatorClient.Transport; close(): void }>
}
const { Rpc } = (await import(path.resolve(import.meta.dir, "../../../deepagent-code/src/util/rpc.ts"))) as {
  Rpc: {
    client(worker: Worker): {
      call(
        action: "fetch",
        input: { url: string; method: string; headers: Record<string, string>; body?: string },
      ): Promise<{ status: number; body: string; headers: Record<string, string> }>
      call(action: "shutdown", input: undefined): Promise<void>
      on(action: "global.event", listener: (event: GlobalEvent) => void): () => void
      close(): void
    }
  }
}

const root = process.env.DAC_MCP_OPERATOR_ROOT!
assert(path.basename(root).startsWith("dac-mcp-tui-actual-"))
const directory = process.cwd()
const chinese = process.env.LANG?.startsWith("zh")
const localized = chinese ? await import("../../src/i18n/zh") : undefined
const text = (key: keyof typeof dict) => localized?.dict[key] ?? dict[key]
const server = authorizationServer()
await fs.writeFile(
  path.join(directory, "deepagent-code.json"),
  JSON.stringify({
    $schema: "https://ai.deepagent.ltd/config.schema.json",
    formatter: false,
    lsp: false,
    mcp: {
      fixture: {
        type: "remote",
        url: new URL("/mcp", server.listener.url).href,
        oauth: { redirectUri: "https://callback.example.test/return" },
      },
    },
  }),
)
await fs.mkdir(path.join(Global.Path.config), { recursive: true })
await fs.writeFile(
  path.join(Global.Path.config, "config.jsonc"),
  JSON.stringify({ $schema: "https://ai.deepagent.ltd/config.schema.json" }),
)
await fs.mkdir(path.join(Global.Path.cache, "bin"), { recursive: true })
await fs.copyFile(Bun.which("rg")!, path.join(Global.Path.cache, "bin", "rg"))
await fs.writeFile(
  path.join(Global.Path.state, "kv.json"),
  JSON.stringify({ theme_mode_lock: chinese ? "light" : "dark" }),
)
const worker = new Worker(new URL("../../../deepagent-code/src/cli/tui/worker.ts", import.meta.url))
const bridgePromise = createMcpOperatorBridge(worker, directory)
const rpc = Rpc.client(worker)
const bridge = await bridgePromise
const setup = await createTestRenderer({
  width: Number(process.env.DAC_MCP_OPERATOR_WIDTH),
  height: 36,
  useThread: false,
  kittyKeyboard: true,
})
const core = await import("@opentui/core")
mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
const frames: { name: string; frame: string }[] = []
const events: GlobalEvent[] = []
const http: { path: string; method: string; status: number }[] = []
const observed: { authorizationUrl?: string; oauthState?: string } = {}
const native = { prepares: 0, sends: [] as string[] }
const { run } = await import("../../src/app")
const app = Effect.runPromise(
  run({
    url: "http://deepagent-code.internal",
    directory,
    args: {},
    config: createTuiResolvedConfig({ plugin_enabled: {} }),
    pluginHost: { async start() {}, async dispose() {} },
    mcpOperator: {
      ...bridge.transport,
      async prepare(name, signal) {
        native.prepares++
        return bridge.transport.prepare(name, signal)
      },
      async send(command, signal) {
        native.sends.push(command.action)
        const result = await bridge.transport.send(command, signal)
        if (result.authorizationUrl) Object.assign(observed, result)
        return result
      },
    },
    events: {
      async subscribe(handler) {
        return rpc.on("global.event", (event) => {
          events.push(event)
          handler(event)
        })
      },
    },
    fetch: Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init)
        const result = await rpc.call("fetch", {
          url: request.url,
          method: request.method,
          headers: Object.fromEntries(request.headers),
          ...(request.body ? { body: await request.text() } : {}),
        })
        http.push({ path: new URL(request.url).pathname, method: request.method, status: result.status })
        return new Response(result.body, { status: result.status, headers: result.headers })
      },
      { preconnect: fetch.preconnect },
    ),
  }).pipe(Effect.provide(Global.defaultLayer)),
)

async function frame(name: string, expected: string, timeout = 15000) {
  const deadline = Date.now() + timeout
  for (;;) {
    await setup.renderOnce()
    const value = setup.captureCharFrame()
    if (
      !value.replace(/\s+/g, "").includes(text("tui.mcp.operator.waiting").replace(/\s+/g, "")) &&
      (value.includes(expected) || value.replace(/\s+/g, "").includes(expected.replace(/\s+/g, "")))
    ) {
      frames.push({ name, frame: value })
      return
    }
    if (Date.now() > deadline) {
      await fs.writeFile(path.join(root, "diagnostic.json"), JSON.stringify({ frame: value, frames, http, native }))
      throw new Error(`Missing ${expected}\n${value}`)
    }
    await Bun.sleep(20)
  }
}
async function select(index: number) {
  await setup.renderOnce()
  setup.mockInput.pressKey("HOME")
  await Bun.sleep(10)
  for (let count = 0; count < index; count++) {
    setup.mockInput.pressArrow("down")
    await Bun.sleep(10)
  }
  setup.mockInput.pressEnter()
}
async function relay() {
  for (const command of ["dialog.select.submit", "mcp.list", "dialog.prompt.submit"]) {
    const response = await rpc.call("fetch", {
      url: `http://deepagent-code.internal/tui/publish?directory=${encodeURIComponent(directory)}`,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "tui.command.execute", properties: { command } }),
    })
    assert.equal(response.status, 200)
  }
  const label = `relay fence ${events.length}`
  const result = await rpc.call("fetch", {
    url: `http://deepagent-code.internal/tui/publish?directory=${encodeURIComponent(directory)}`,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "tui.toast.show", properties: { message: label, variant: "info", duration: 3000 } }),
  })
  assert.equal(result.status, 200)
  await frame("actual-relay-fence", label)
}
async function type(value: string) {
  const deadline = Date.now() + 3000
  while (!(setup.renderer.currentFocusedEditor instanceof core.TextareaRenderable)) {
    if (Date.now() > deadline) throw new Error("Actual textarea never focused")
    await Bun.sleep(10)
  }
  await setup.mockInput.typeText(value, 5)
  setup.mockInput.pressEnter()
}
try {
  const deadline = Date.now() + 15000
  while (!http.some((entry) => entry.path === "/mcp" && entry.status === 200)) {
    if (Date.now() > deadline) throw new Error("Actual app did not load MCP status")
    await Bun.sleep(20)
  }
  setup.mockInput.pressKey("p", { ctrl: true })
  await frame("palette", text("tui.app.toggleMcps"))
  await setup.mockInput.typeText(text("tui.app.toggleMcps"), 5)
  setup.mockInput.pressEnter()
  await frame("server-list", "fixture")
  await relay()
  assert.equal(native.prepares, 0)
  assert.equal(server.calls.length, 0)
  setup.mockInput.pressEnter()
  await frame("server-actions", text("tui.mcp.action.authenticate"))
  assert.equal(native.prepares, 1)
  await relay()
  assert.deepEqual(native.sends, [])
  await select(1)
  await frame("manual-ready", text("tui.mcp.operator.enterCode"))
  assert.deepEqual(native.sends, ["startAuth"])
  assert(observed.authorizationUrl)
  const authorization = await fetch(observed.authorizationUrl, { redirect: "manual" })
  assert.equal(authorization.status, 302)
  const callback = new URL(authorization.headers.get("location")!)
  await select(1)
  await frame("code-input", text("tui.mcp.operator.enterCode"))
  await relay()
  assert.equal(server.calls.filter((call) => call.path === "/token").length, 0)
  await type(callback.searchParams.get("code")!)
  await frame("issuer-input", text("tui.mcp.operator.enterIssuer"))
  await type(callback.searchParams.get("iss")!)
  await frame("connected-actions", text("tui.mcp.action.disconnect"))
  assert.deepEqual(native.sends, ["startAuth", "finishAuth"])
  assert.equal(server.calls.filter((call) => call.path === "/token").length, 1)
  await select(3)
  await frame("clear-confirm", text("tui.mcp.operator.clearHint"))
  await relay()
  assert.deepEqual(native.sends, ["startAuth", "finishAuth"])
  setup.mockInput.pressEnter()
  await frame("cleared-actions", text("tui.mcp.action.connect"))
  assert.deepEqual(native.sends, ["startAuth", "finishAuth", "clearAuth"])
  assert.equal(server.calls.filter((call) => call.path === "/register").length, 1)
  setup.mockInput.pressEscape()
  await bridge.transport.whenSettled()
  await setup.renderOnce()
  frames.push({ name: "closed", frame: setup.captureCharFrame() })
  await fs.writeFile(
    path.join(root, "result.json"),
    JSON.stringify({
      frames,
      http,
      native,
      width: Number(process.env.DAC_MCP_OPERATOR_WIDTH),
      locale: chinese ? "zh" : "en",
      relayEvents: events.filter((event) => event.payload.type === "tui.command.execute").length,
      actualToken: 1,
      actualRegistration: 1,
      publicMcpWrites: http.filter((item) => item.path.startsWith("/mcp") && item.method !== "GET").length,
    }),
  )
} finally {
  setup.renderer.destroy()
  await app.catch(() => undefined)
  bridge.close()
  await bridge.transport.whenSettled()
  await rpc.call("shutdown", undefined).catch(() => undefined)
  rpc.close()
  worker.terminate()
  server.release()
  await server.listener.stop(true)
  mock.restore()
}
