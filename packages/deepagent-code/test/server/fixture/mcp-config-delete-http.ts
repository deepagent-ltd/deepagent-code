import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { createServer } from "node:http"
import { once } from "node:events"
import { createHash } from "node:crypto"
import { parse } from "jsonc-parser"
import { Effect } from "effect"
import { Server } from "../../../src/server/server"
import { AppRuntime } from "../../../src/effect/app-runtime"
import { Global } from "@deepagent-code/core/global"
import { Database } from "@deepagent-code/core/database/database"
import { Config } from "../../../src/config/config"
import { MCP } from "../../../src/mcp"
import { InstanceStore } from "../../../src/project/instance-store"
import { InstanceRef } from "../../../src/effect/instance-ref"
import { createDeepAgentCodeClient } from "@deepagent-code/sdk"

const root = await fs.realpath(process.argv[2]!)
assert(path.basename(root).startsWith("dac-mcp-delete-http-"))
assert.equal(process.env.DEEPAGENT_CODE_DB, path.join(root, "authority.sqlite"))
const directory = path.join(root, "project")
const mode = process.argv[3] ?? "remove"
assert(mode === "remove" || mode === "metadata")
const state = { tools: 0, resources: 0, metadata: 0, promptLists: 0, resourceLists: 0 }
async function createWire() {
  const { Server, createMcpHandler } = await import("@modelcontextprotocol/server")
  return createMcpHandler(() => {
  const server = new Server({ name: "deletion-original-wire", version: "1" }, { capabilities: { tools: {}, resources: {}, prompts: {} } })
  server.setRequestHandler("tools/list", () => {
    state.metadata++
    return { tools: [{ name: "unused", inputSchema: { type: "object", properties: {} } }] }
  })
  server.setRequestHandler("resources/list", () => { state.resourceLists++; return { resources: [] } })
  server.setRequestHandler("prompts/list", () => { state.promptLists++; return { prompts: [{ name: "must-not-be-visible", description: "unobserved prompt" }] } })
  server.setRequestHandler("resources/read", () => {
    state.resources++
    return { contents: [] }
  })
  server.setRequestHandler("tools/call", () => {
    state.tools++
    return { content: [{ type: "text", text: "must not execute" }] }
  })
  return server
}, { legacy: "reject", keepAliveMs: 0 })
}
const wire = await createWire()
const remote = createServer(async (incoming, outgoing) => {
  if (incoming.url === "/.well-known/deepagent-code") {
    outgoing.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ config: { mcp: { remoteOnly: entry, shadowGlobal: entry } } }))
    return
  }
  const parts: Buffer[] = []
  for await (const part of incoming) parts.push(Buffer.isBuffer(part) ? part : Buffer.from(part))
  const headers = new Headers()
  Object.entries(incoming.headers).forEach(([key, value]) => {
    if (typeof value === "string") headers.set(key, value)
  })
  const response = await wire.fetch(new Request(`http://${incoming.headers.host}${incoming.url}`, {
    method: incoming.method, headers, ...(parts.length ? { body: Buffer.concat(parts) } : {}),
  }))
  outgoing.writeHead(response.status, Object.fromEntries(response.headers))
  if (response.body) {
    const reader = response.body.getReader()
    while (true) {
      const part = await reader.read()
      if (part.done) break
      outgoing.write(part.value)
    }
    reader.releaseLock()
  }
  outgoing.end()
})
remote.listen(0, "127.0.0.1")
await once(remote, "listening")
const address = remote.address()
assert(address && typeof address !== "string")
const entry = { type: "remote", url: `http://127.0.0.1:${address.port}/mcp`, oauth: false, protocol: "2026-07-28", enabled: false }
const configuration = ["{", "  // deletion preserves this comment", '  "formatter": false,', '  "lsp": false,', '  "command": { "ordinary": { "template": "original ordinary command" } },', '  "mcp": {', `    "wire": ${JSON.stringify({ ...entry, enabled: mode === "metadata" })},`, `    "fault": ${JSON.stringify(entry)},`, `    "shadowGlobal": ${JSON.stringify(entry)},`, `    "legacyCollision": ${JSON.stringify(entry)},`, '    "keeper": { "type": "local", "command": ["echo", "keeper"], "enabled": false, "environment": { "SHARED_REF": "synthetic-reference" } }', "  }", "}"].join("\n")
await fs.mkdir(Global.Path.config, { recursive: true, mode: 0o700 })
await fs.writeFile(path.join(Global.Path.config, "config.jsonc"), configuration, { mode: 0o600 })
await fs.writeFile(path.join(Global.Path.config, "settings.json"), JSON.stringify({ deepagent: { promptMode: "direct", agentMode: "general" } }), { mode: 0o600 })
await fs.writeFile(path.join(Global.Path.config, "auth.json"), JSON.stringify({ fixture: { type: "api", key: "synthetic-auth-preserved" }, [`http://127.0.0.1:${address.port}`]: { type: "wellknown", key: "SYNTHETIC_REMOTE_CONFIG", token: "synthetic-remote-reference" } }), { mode: 0o600 })
await fs.writeFile(path.join(directory, "deepagent-code.json"), JSON.stringify({ mcp: { projectOnly: { ...entry, enabled: false } } }))
await fs.mkdir(path.join(root, "managed"), { mode: 0o700 })
await fs.writeFile(path.join(root, "managed", "deepagent-code.json"), JSON.stringify({ mcp: { managedOnly: entry } }))
const digest = (file: string) => Bun.file(file).arrayBuffer().then((bytes) => createHash("sha256").update(Buffer.from(bytes)).digest("hex"))
const unchangedFiles = ["settings.json", "auth.json"].map((name) => path.join(Global.Path.config, name))
await AppRuntime.runPromise(Database.Service)
const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
const authorization = `Basic ${Buffer.from(`deepagent-code:${process.env.DEEPAGENT_CODE_SERVER_PASSWORD}`).toString("base64")}`
const client = createDeepAgentCodeClient({ baseUrl: listener.url.toString(), directory, headers: { authorization }, throwOnError: true })
const failures: { status: number; code?: string }[] = []
async function refuse(name: string, status: number, authenticated = true, origin?: string) {
  const response = await fetch(new URL(`/mcp/${encodeURIComponent(name)}/config`, listener.url), {
    method: "DELETE", headers: { "x-deepagent-code-directory": directory, ...(authenticated ? { authorization } : {}), ...(origin ? { origin } : {}) }, signal: AbortSignal.timeout(10000),
  })
  assert.equal(response.status, status, `remove ${name}`)
  const body = await response.json()
  failures.push({ status, code: typeof body.code === "string" ? body.code : undefined })
  return body
}
const scoped = <A, E>(use: (mcp: MCP.Interface, config: Config.Interface) => Effect.Effect<A, E>) => AppRuntime.runPromise(Effect.gen(function* () {
  const instances = yield* InstanceStore.Service
  const context = yield* instances.load({ directory })
  const mcp = yield* MCP.Service
  const config = yield* Config.Service
  return yield* use(mcp, config).pipe(Effect.provideService(InstanceRef, context))
}))
async function run() {
  await client.config.get()
  if (mode === "metadata") {
    assert.equal((await client.mcp.status()).data?.wire.status, "connected")
    const before = { ...state }
    assert.deepEqual(await scoped((mcp) => mcp.observedMetadata!()), { prompts: {}, resources: {} })
    const commands = await client.command.list()
    assert(commands.data?.some((item) => item.name === "ordinary"))
    assert.equal(commands.data?.some((item) => item.name.includes("must-not-be-visible")), false)
    assert.deepEqual(state, before)
    assert.equal(state.promptLists, 0)
    assert.equal(state.resourceLists, 0)
    await fs.writeFile(path.join(root, "result-safe.json"), JSON.stringify({
      version: 1, mode, actualRoot: true, originalSDK: true, connectedOriginalClient: true,
      missingObservationPromptsAndResourcesEmpty: true, ordinaryCommandListHTTP200: true,
      readonlyRpcDelta: 0, promptLists: 0, resourceLists: 0, tools: 0, modelCalls: 0,
    }, null, 2) + "\n", { flag: "wx", mode: 0o600 })
    return
  }
    const beforeOther = await Promise.all(unchangedFiles.map(digest))
  const readonlyBefore = await digest(path.join(Global.Path.config, "config.jsonc"))
  await refuse("wire", 401, false)
  await refuse("wire", 401, true, "https://foreign.invalid")
  for (const name of ["projectOnly", "managedOnly", "remoteOnly"])
    assert.equal((await refuse(name, 409)).code, "readonly")
  assert.equal(await digest(path.join(Global.Path.config, "config.jsonc")), readonlyBefore)
  assert.equal((await refuse("shadowGlobal", 409)).code, "changed")
  assert.equal(Object.hasOwn(parse(await Bun.file(path.join(Global.Path.config, "config.jsonc")).text()).mcp, "shadowGlobal"), false)
  assert(Object.hasOwn((await client.config.get()).data?.mcp ?? {}, "shadowGlobal"))
  await client.mcp.connect({ name: "wire" })
  assert.equal((await client.mcp.status()).data?.wire.status, "connected")
  const removed = await client.mcp.removeConfig({ name: "wire" })
  assert.deepEqual(removed.data, { removed: true })
  const after = await Bun.file(path.join(Global.Path.config, "config.jsonc")).text()
  assert(after.includes("// deletion preserves this comment"))
  assert.equal(Object.hasOwn(parse(after).mcp, "wire"), false)
  assert.deepEqual(parse(after).mcp.keeper, { type: "local", command: ["echo", "keeper"], enabled: false, environment: { SHARED_REF: "synthetic-reference" } })
  assert.deepEqual(await Promise.all(unchangedFiles.map(digest)), beforeOther)
  assert.equal((await client.mcp.status()).data?.wire, undefined)
  assert.deepEqual((await client.mcp.removeConfig({ name: "wire" })).data, { removed: true })
  await client.mcp.connect({ name: "fault" })
  const originalClient = await scoped((mcp) => mcp.clients().pipe(Effect.map((clients) => clients.fault)))
  assert(originalClient)
  const close = originalClient.close.bind(originalClient)
  originalClient.close = () => Promise.reject(new Error("owned-original-close-fault"))
  const beforeFault = await digest(path.join(Global.Path.config, "config.jsonc"))
  assert.equal((await refuse("fault", 409)).code, "unknown")
  assert.equal(await digest(path.join(Global.Path.config, "config.jsonc")), beforeFault)
  assert.equal((await client.mcp.status()).data?.fault.status, "failed")
  assert.equal(await scoped((mcp) => mcp.clients().pipe(Effect.map((clients) => clients.fault))), undefined)
  assert.deepEqual(await scoped((mcp) => mcp.tools()), {})
  const readsBefore = state.resources
  const denied = await scoped((mcp) => mcp.readResource("fault", "ui://unused").pipe(Effect.exit))
  assert.equal(denied._tag, "Failure")
  assert.equal(state.resources, readsBefore)
  originalClient.close = close
  assert.deepEqual((await client.mcp.removeConfig({ name: "fault" })).data, { removed: true })
  assert.deepEqual(await Promise.all(unchangedFiles.map(digest)), beforeOther)
  assert.equal(state.tools, 0)
  assert.equal(state.resources, 0)
  // The original normal partial PATCH must continue preserving omitted siblings.
  await client.global.config.update({ config: { mcp: { keeper: { enabled: false } } } })
  const patched = parse(await Bun.file(path.join(Global.Path.config, "config.jsonc")).text())
  assert.equal(patched.mcp.keeper.type, "local")
  assert.deepEqual(patched.mcp.keeper.command, ["echo", "keeper"])
  assert(Object.hasOwn(patched.mcp, "legacyCollision"))
  // Fresh original instance reads the actual file; no synthetic projection or config delete.
  await client.instance.dispose()
  const cold = await client.config.get()
  assert.equal(Object.hasOwn(cold.data?.mcp ?? {}, "wire"), false)
  assert.equal(Object.hasOwn(cold.data?.mcp ?? {}, "fault"), false)
  assert(Object.hasOwn(cold.data?.mcp ?? {}, "keeper"))
  await fs.writeFile(path.join(root, "result-safe.json"), JSON.stringify({
    version: 1, actualRoot: true, actualNodeHttp: true, originalSDK: true,
    explicitASTDelete: true, commentAndSiblingPreserved: true, settingsAndAuthBytesPreserved: true,
    originalPartialPatchPreserved: true, exactCompletedRetry: true, coldRead: true,
    unknownCloseRetainedOriginalClientAndConfig: true, unknownToolsAndReadDenied: true,
    explicitRetryUsedSameOriginalClient: true, readonlySourcesRefused: ["project", "managed", "remote"],
    survivingRemoteDefinitionReportedChanged: true,
    failures, tools: state.tools, resourceReads: state.resources,
    physicalProcessRetirementClaimed: false, modelCalls: 0,
  }, null, 2) + "\n", { flag: "wx", mode: 0o600 })
}
try {
  await run()
} finally {
  await listener.stop(true)
  await AppRuntime.dispose()
  remote.closeAllConnections()
  if (remote.listening)
    await new Promise<void>((resolve, reject) => remote.close((error) => error ? reject(error) : resolve()))
}
console.log(JSON.stringify({ pass: true, safe: path.join(root, "result-safe.json"), tools: 0, resourceReads: 0, modelCalls: 0 }))
