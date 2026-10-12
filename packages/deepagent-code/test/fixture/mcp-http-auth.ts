import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { Server } from "../../src/server/server"
import { AppRuntime } from "../../src/effect/app-runtime"
import { Database } from "@deepagent-code/core/database/database"
import { Global } from "@deepagent-code/core/global"

const root = process.env.DAC_MCP_HTTP_ROOT
assert(root && path.basename(root).startsWith("dac-mcp-http-auth-"))
assert.equal(await fs.realpath(root), root)
const mode = process.argv[2]
assert(mode === "empty" || mode === "authenticated")
assert.equal(process.env.DEEPAGENT_CODE_DB, path.join(root, "home", ".deepagent", "code", "authority.sqlite"))
const password = mode === "authenticated" ? "fixture-mcp-password" : ""
assert.equal(process.env.DEEPAGENT_CODE_SERVER_PASSWORD, password)
const directory = path.join(root, "project")
const requests: string[] = []
const authorizationServer = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: async (request) => {
    const url = new URL(request.url)
    requests.push(`${request.method} ${url.pathname}`)
    if (url.pathname.includes("oauth-protected-resource"))
      return Response.json({ resource: `${url.origin}/mcp`, authorization_servers: [url.origin] })
    if (url.pathname.includes("oauth-authorization-server") || url.pathname.includes("openid-configuration"))
      return Response.json({
        issuer: url.origin,
        authorization_endpoint: `${url.origin}/authorize`,
        token_endpoint: `${url.origin}/token`,
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
      })
    if (url.pathname === "/token")
      return Response.json({ access_token: "fixture-http-token", token_type: "Bearer", expires_in: 600 })
    if (request.method === "DELETE") return new Response(null, { status: 204 })
    if (request.headers.get("authorization") !== "Bearer fixture-http-token")
      return new Response(null, {
        status: 401,
        headers: {
          "WWW-Authenticate": `Bearer resource_metadata="${url.origin}/.well-known/oauth-protected-resource"`,
        },
      })
    if (request.method === "GET") return new Response(null, { status: 405 })
    const body = (await request.json()) as { id?: number; method: string }
    if (body.id === undefined) return new Response(null, { status: 202 })
    return Response.json({
      jsonrpc: "2.0",
      id: body.id,
      result:
        body.method === "initialize"
          ? {
              protocolVersion: "2025-11-25",
              serverInfo: { name: "http-fixture", version: "1" },
              capabilities: { tools: {} },
            }
          : { tools: [] },
    })
  },
})
const config = {
  type: "remote",
  url: `${authorizationServer.url.origin}/mcp`,
  oauth: { clientId: "http-fixture-client" },
  headers: { "x-api-key": "fixture-preserved-plaintext" },
}
await fs.writeFile(
  path.join(directory, "deepagent-code.json"),
  JSON.stringify({ formatter: false, lsp: false, mcp: { fixture: config } }),
)
const rg = Bun.which("rg")
assert(rg)
await fs.mkdir(Global.Path.bin, { recursive: true })
await fs.copyFile(rg, path.join(Global.Path.bin, "rg"))
await AppRuntime.runPromise(Database.Service)
const listener = await Server.listen({ hostname: "127.0.0.1", port: 0, cors: ["http://127.0.0.1:45123"] })
const basic = `Basic ${Buffer.from(`deepagent-code:${password}`).toString("base64")}`
const call = (route: string, method: string, body?: object, headers: Record<string, string> = {}) =>
  fetch(new URL(route, listener.url), {
    method,
    headers: {
      "content-type": "application/json",
      "x-deepagent-code-directory": directory,
      ...(mode === "authenticated" ? { authorization: basic } : {}),
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
const inventory = async (dir: string): Promise<Record<string, string>> => {
  const result: Record<string, string> = {}
  for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      for (const [child, value] of Object.entries(await inventory(file))) result[`${entry.name}/${child}`] = value
    } else if (entry.isFile())
      result[entry.name] = createHash("sha256")
        .update(await fs.readFile(file))
        .digest("hex")
  }
  return result
}
const before = { config: await inventory(Global.Path.config), project: await inventory(directory) }
const evidence: Record<string, unknown> = { mode, pid: process.pid, port: listener.port }
try {
  assert.equal((await call("/mcp", "GET")).status, 200)
  assert.equal(requests.length, 0)
  for (const filename of [
    path.join(Global.Path.config, "mcp-oauth"),
    path.join(Global.Path.data, "local-operator", "installation.json"),
  ])
    assert.equal(
      await fs.stat(filename).then(
        () => true,
        () => false,
      ),
      false,
    )
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, "deepagent-code.json"), "utf8")).mcp, {
    fixture: config,
  })
  evidence.coldGet = { http: 200, oauthWrites: 0, externalRequests: 0 }
  evidence.coldConfig = {
    fullRootReadOnly: false,
    limitation:
      "This OAuth-specific oracle does not assert general Root background writes; the readonly producer fixture separately inventories every table/config/project file and distinguishes startup schedules.",
    before,
    after: { config: await inventory(Global.Path.config), project: await inventory(directory) },
    plaintextPreserved: true,
    secretStoreFileAbsent: !(await fs.stat(path.join(Global.Path.config, "mcp-secrets.json")).then(
      () => true,
      () => false,
    )),
  }
  for (const route of [
    "/mcp/fixture/auth",
    "/mcp/fixture/auth/authenticate",
    "/mcp/fixture/connect",
    "/mcp/fixture/disconnect",
  ])
    assert.equal((await call(route, "POST", undefined, { authorization: "" })).status, 401)
  assert.equal((await call("/mcp", "POST", { name: "added", config }, { authorization: "" })).status, 401)
  assert.equal((await call("/mcp/fixture/auth", "DELETE", undefined, { authorization: "" })).status, 401)
  assert.equal(requests.length, 0)
  evidence.unauthenticatedMutations = 6
  if (mode === "authenticated") {
    assert.equal((await call("/mcp/fixture/auth", "POST", undefined, { authorization: "Basic invalid" })).status, 401)
    assert.equal(
      (await call("/mcp/fixture/auth", "POST", undefined, { origin: "https://untrusted.invalid" })).status,
      401,
    )
    assert.equal((await call(`/mcp/fixture/auth?auth_token=${encodeURIComponent(basic.slice(6))}`, "POST")).status, 401)
    assert.equal(requests.length, 0)
    const started = await call("/mcp/fixture/auth", "POST")
    assert.equal(started.status, 200, await started.clone().text())
    const pending = (await started.json()) as { oauthState: string }
    assert.equal((await call("/mcp/fixture/auth/callback", "POST", { code: "wrong", oauthState: "wrong" })).status, 409)
    assert.equal(requests.filter((item) => item === "POST /token").length, 0)
    const finished = await call("/mcp/fixture/auth/callback", "POST", {
      code: "real-fixture-code",
      oauthState: pending.oauthState,
    })
    assert.equal(finished.status, 200, await finished.clone().text())
    assert.equal(((await finished.json()) as { status: string }).status, "connected")
    assert.equal(requests.filter((item) => item === "POST /token").length, 1)
    assert.equal(
      await fs
        .readFile(path.join(directory, "deepagent-code.json"), "utf8")
        .then((text) => text.includes("fixture-preserved-plaintext")),
      true,
    )
    evidence.actualAuthenticatedCallback = { status: 200, tokenPosts: 1, wrongStateTokenPosts: 0 }
  }
  await fs.writeFile(path.join(root, "evidence.json"), JSON.stringify({ ...evidence, requests }, null, 2))
  console.log(JSON.stringify({ mode, passed: true, root }))
} finally {
  await listener.stop(true)
  await authorizationServer.stop(true)
}
process.exit(0)
