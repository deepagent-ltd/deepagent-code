import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { createServer } from "node:http"
import { once } from "node:events"
import { Server } from "../../../src/server/server"
import { AppRuntime } from "../../../src/effect/app-runtime"
import { Database } from "@deepagent-code/core/database/database"
import { PrivateSqlite } from "@deepagent-code/core/database/private-sqlite"
import { McpAppResource } from "../../../src/mcp/app-resource"

const root = await fs.realpath(process.argv[2]!)
assert(path.basename(root).startsWith("dac-mcp-apps-http-"))
assert.equal(process.env.DEEPAGENT_CODE_DB, path.join(root, "home", ".deepagent", "code", "authority.sqlite"))
const directory = path.join(root, "project")
const state = { reads: 0, tools: 0, hold: false, release: undefined as (() => void) | undefined, headerSeen: false }
const html = "<!doctype html><html><body>Typed HTTP MCP App</body></html>"
async function wireHandler() {
  const { Server, createMcpHandler } = await import("@modelcontextprotocol/server")
  return createMcpHandler(
    () => {
      const server = new Server(
        { name: "http-apps-wire", version: "1" },
        { capabilities: { tools: {}, resources: {} } },
      )
      server.setRequestHandler("tools/list", () => ({
        tools: [
          {
            name: "view",
            inputSchema: { type: "object", properties: {} },
            _meta: { ui: { resourceUri: "ui://wire/http" } },
          },
        ],
      }))
      server.setRequestHandler("resources/list", () => ({
        resources: [{ name: "ui", uri: "ui://wire/http", mimeType: McpAppResource.MIME_TYPE }],
      }))
      server.setRequestHandler("resources/read", async (request) => {
        state.reads++
        if (state.hold)
          await new Promise<void>((resolve) => {
            state.release = resolve
          })
        return { contents: [{ uri: request.params.uri, mimeType: McpAppResource.MIME_TYPE, text: html }] }
      })
      server.setRequestHandler("tools/call", () => {
        state.tools++
        return { content: [{ type: "text", text: "must not execute" }] }
      })
      return server
    },
    { legacy: "reject", keepAliveMs: 0 },
  )
}
const handler = await wireHandler()
// This secondary Node listener only adapts actual SDK wire bytes. The DAC listener
// below uses its original NodeHttpServer, Root services and production auth middleware.
const remote = createServer(async (incoming, outgoing) => {
  const abort = new AbortController()
  outgoing.on("close", () => abort.abort())
  const parts: Buffer[] = []
  for await (const part of incoming) parts.push(Buffer.isBuffer(part) ? part : Buffer.from(part))
  const headers = new Headers()
  Object.entries(incoming.headers).forEach(([key, value]) => {
    if (typeof value === "string") headers.set(key, value)
  })
  state.headerSeen ||= headers.get("x-fixture-secret") === "synthetic-config-header-secret"
  const response = await handler.fetch(
    new Request(`http://${incoming.headers.host}${incoming.url}`, {
      method: incoming.method,
      headers,
      ...(parts.length ? { body: Buffer.concat(parts) } : {}),
      signal: abort.signal,
    }),
  )
  outgoing.writeHead(response.status, Object.fromEntries(response.headers))
  if (response.body) {
    const reader = response.body.getReader()
    while (!abort.signal.aborted) {
      const part = await reader.read()
      if (part.done) break
      outgoing.write(part.value)
    }
    if (abort.signal.aborted) await reader.cancel()
    reader.releaseLock()
  }
  outgoing.end()
})
remote.listen(0, "127.0.0.1")
await once(remote, "listening")
const address = remote.address()
assert(address && typeof address !== "string")
const configuration = {
  formatter: false,
  lsp: false,
  mcp: {
    wire: {
      type: "remote",
      url: `http://127.0.0.1:${address.port}/mcp`,
      oauth: false,
      protocol: "2026-07-28",
      headers: { "x-fixture-secret": "synthetic-config-header-secret" },
    },
  },
}
await fs.writeFile(path.join(directory, "deepagent-code.json"), JSON.stringify(configuration))
await AppRuntime.runPromise(Database.Service)
const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
const authorization = `Basic ${Buffer.from(`deepagent-code:${process.env.DEEPAGENT_CODE_SERVER_PASSWORD}`).toString("base64")}`
const failures: { route: string; status: number; code?: string }[] = []
const call = (route: string, input?: object, auth = true, origin?: string) =>
  fetch(new URL(route, listener.url), {
    method: input ? "POST" : "GET",
    headers: {
      "x-deepagent-code-directory": directory,
      "content-type": "application/json",
      ...(auth ? { authorization } : {}),
      ...(origin ? { origin } : {}),
    },
    ...(input ? { body: JSON.stringify(input) } : {}),
    signal: AbortSignal.timeout(10000),
  })
async function refuse(route: string, input: object | undefined, status: number, auth = true, origin?: string) {
  const response = await call(route, input, auth, origin)
  const text = await response.text()
  assert.equal(response.status, status, text)
  assert(!text.includes(html))
  assert(!text.includes("synthetic-config-header-secret"))
  assert(!text.includes(process.env.DEEPAGENT_CODE_SERVER_PASSWORD!))
  assert(!text.includes(directory))
  const body = text ? (JSON.parse(text) as { code?: string }) : {}
  failures.push({ route, status, ...(body.code ? { code: body.code } : {}) })
}
try {
  const negative = {
    server: "wire",
    tool: "view",
    generation: "00000000-0000-0000-0000-000000000000",
    resourceUri: "ui://wire/http",
    consent: true,
  }
  await refuse("/mcp/apps", undefined, 401, false)
  await refuse("/mcp/apps/open", negative, 401, false)
  await refuse("/mcp/apps/check", { viewID: negative.generation }, 401, false)
  await refuse("/mcp/apps/close", { viewID: negative.generation }, 401, true, "https://untrusted.example")
  assert.equal(state.reads, 0)
  const connected = await call("/mcp/wire/connect", {})
  assert.equal(connected.status, 200, await connected.text())
  const listing = await call("/mcp/apps")
  assert.equal(listing.status, 200)
  const descriptors = (await listing.json()) as McpAppResource.Descriptor[]
  assert.equal(descriptors.length, 1)
  assert.equal(descriptors[0]!.toolName, "mcp__wire__view")
  assert(state.headerSeen)
  assert.equal(state.reads, 0)
  const input = {
    server: descriptors[0]!.server,
    tool: descriptors[0]!.tool,
    generation: descriptors[0]!.generation,
    resourceUri: descriptors[0]!.resourceUri,
    consent: true,
  }
  const { consent, ...missing } = input
  assert(consent)
  await refuse("/mcp/apps/open", missing, 400)
  await refuse("/mcp/apps/open", { ...input, consent: false }, 400)
  await refuse("/mcp/apps/open", { ...input, generation: negative.generation }, 409)
  await refuse("/mcp/apps/open", { ...input, resourceUri: "ui://other/arbitrary" }, 409)
  assert.equal(state.reads, 0)
  assert(failures.filter((failure) => failure.status === 409).every((failure) => failure.code === "changed"))
  const opened = await call("/mcp/apps/open", input)
  assert.equal(opened.status, 200)
  const view = (await opened.json()) as McpAppResource.View
  assert.equal(view.html, html)
  assert.equal(view.csp, McpAppResource.CSP)
  assert.deepEqual(view.descriptor, descriptors[0])
  const checked = await call("/mcp/apps/check", { viewID: view.viewID })
  assert.equal(checked.status, 200)
  assert.deepEqual(await checked.json(), descriptors[0])
  const closed = await call("/mcp/apps/close", { viewID: view.viewID })
  assert.equal(closed.status, 200)
  assert.equal(await closed.json(), true)
  const stale = await call("/mcp/apps/check", { viewID: view.viewID })
  assert.equal(stale.status, 409)
  assert.equal(((await stale.json()) as { code: string }).code, "changed")
  state.hold = true
  const delayed = call("/mcp/apps/open", input)
  const deadline = performance.now() + 5000
  while (!state.release) {
    assert(performance.now() < deadline, "resource request did not reach actual MCP server")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  await fs.writeFile(
    path.join(directory, "deepagent-code.json"),
    JSON.stringify({ ...configuration, mcp: { wire: { ...configuration.mcp.wire, enabled: false } } }),
  )
  const revoked = await call("/mcp/apps")
  assert.equal(revoked.status, 200)
  assert.deepEqual(await revoked.json(), [])
  state.release()
  const late = await delayed
  assert.equal(late.status, 409)
  const lateText = await late.text()
  assert(!lateText.includes(html))
  assert(!lateText.includes("synthetic-config-header-secret"))
  const lateCode = (JSON.parse(lateText) as { code: string }).code
  assert(["changed", "unavailable"].includes(lateCode))
  const database = new PrivateSqlite.Database(process.env.DEEPAGENT_CODE_DB!, { readonly: true })
  const executionRows = [
    "session",
    "session_input",
    "work_execution",
    "work_count_acquisition",
    "work_dispatch_reservation",
    "session_v2_provider_turn_receipt",
    "session_v2_tool_effect_admission",
    "session_v2_tool_effect",
  ].map((table) => (database.prepare(`SELECT count(*) AS n FROM "${table}"`).get() as { n: number }).n)
  database.close()
  assert.deepEqual(executionRows, [0, 0, 0, 0, 0, 0, 0, 0])
  assert.equal(state.tools, 0)
  await listener.stop(true)
  state.release?.()
  await handler.close()
  await new Promise<void>((resolve) => remote.close(() => resolve()))
  await AppRuntime.dispose()
  await fs.writeFile(
    path.join(root, "result.json"),
    JSON.stringify({
      fixture: "mcp-apps-http",
      actualRoot: true,
      actualNodeHttp: true,
      actualSdkServer: true,
      htmlRead: true,
      authReadDelta: 0,
      invalidReadDelta: 0,
      toolsCalled: state.tools,
      totalReads: state.reads,
      failures,
      lateCode,
      executionRows,
      stopped: true,
    }),
  )
  console.log(
    JSON.stringify({
      fixture: "mcp-apps-http",
      status: "passed",
      totalReads: state.reads,
      failures,
      lateCode,
      executionRows,
      stopped: true,
    }),
  )
} finally {
  state.release?.()
  await listener.stop(true)
  await handler.close()
  remote.closeAllConnections()
  if (remote.listening) await new Promise<void>((resolve) => remote.close(() => resolve()))
  await AppRuntime.dispose()
}
