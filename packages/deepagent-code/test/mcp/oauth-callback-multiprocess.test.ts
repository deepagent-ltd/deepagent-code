import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { createHash, randomBytes } from "node:crypto"

const fixture = path.resolve(import.meta.dir, "../fixture/mcp-oauth-callback-process.ts")
async function root() {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dac-mcp-callback-")))
  await fs.chmod(directory, 0o700)
  await Promise.all(["home", "tmp", "project"].map((name) => fs.mkdir(path.join(directory, name), { mode: 0o700 })))
  return directory
}
function spawn(directory: string, mode: string, name = "one", node?: string) {
  const child = Bun.spawn(node ? ["node", node, mode, name] : [process.execPath, fixture, mode, name], {
    cwd: path.resolve(import.meta.dir, "../.."),
    env: {
      PATH: process.env.PATH,
      HOME: path.join(directory, "home"),
      TMPDIR: path.join(directory, "tmp"),
      DEEPAGENT_CODE_TEST_HOME: path.join(directory, "home"),
      DAC_CALLBACK_ROOT: directory,
      DEEPAGENT_CODE_DB: path.join(directory, "home", ".deepagent", "code", `${name}.sqlite`),
      DEEPAGENT_CODE_TEST_MANAGED_CONFIG_DIR: path.join(directory, "managed"),
      DEEPAGENT_CODE_MODELS_PATH: path.resolve(import.meta.dir, "../tool/fixtures/models-api.json"),
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = new Response(child.stdout).text()
  const stderr = new Response(child.stderr).text()
  const deadline = setTimeout(() => child.kill(), 45000)
  return { child, stdout, stderr, deadline }
}
async function collect(directory: string, label: string, process: ReturnType<typeof spawn>) {
  const code = await process.child.exited
  clearTimeout(process.deadline)
  const output = (await process.stdout) + (await process.stderr)
  await fs.writeFile(path.join(directory, `${label}.log`), output)
  expect({ code, diagnostic: code === 0 ? null : output }).toEqual({ code: 0, diagnostic: null })
}
async function wait(directory: string, file: string, process: ReturnType<typeof spawn>) {
  const deadline = Date.now() + 30000
  while (
    !(await fs.stat(path.join(directory, file)).then(
      () => true,
      () => false,
    ))
  ) {
    if (process.child.exitCode !== null)
      throw new Error(`Callback child exited ${process.child.exitCode}: ${await process.stderr}`)
    if (Date.now() > deadline) throw new Error(`Callback barrier timed out: ${file}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return JSON.parse(await fs.readFile(path.join(directory, file), "utf8"))
}

async function nodeBundle(directory: string) {
  const node = path.join(directory, "callback-fixture.mjs")
  const build = await Bun.build({
    entrypoints: [fixture],
    target: "node",
    format: "esm",
    external: ["bun", "@lydell/node-pty", "jsonc-parser"],
  })
  expect(build.success).toBe(true)
  await fs.writeFile(node, await build.outputs[0].text())
  await fs.mkdir(path.join(directory, "node_modules", "@lydell"), { recursive: true })
  await fs.symlink(
    await fs.realpath(path.resolve(import.meta.dir, "../../../core/node_modules/@lydell/node-pty")),
    path.join(directory, "node_modules", "@lydell", "node-pty"),
  )
  await fs.symlink(
    await fs.realpath(path.resolve(import.meta.dir, "../../node_modules/jsonc-parser")),
    path.join(directory, "node_modules", "jsonc-parser"),
  )
  return node
}

test("populated v1 reads stay byte-identical; two processes atomically add v2 without changing secret or operation rows", async () => {
  const directory = await root()
  await collect(directory, "seed", spawn(directory, "journal-seed"))
  await collect(directory, "read-v1", spawn(directory, "journal-read"))
  await Promise.all([
    collect(directory, "upgrade-a", spawn(directory, "journal-upgrade", "a")),
    collect(directory, "upgrade-b", spawn(directory, "journal-upgrade", "b")),
  ])
  await collect(directory, "read-v2", spawn(directory, "journal-read"))
  console.info("MCP_CALLBACK_V2_UPGRADE_EVIDENCE", directory)
}, 40000)

test("Node reads populated v1 without migration and explicitly upgrades the same inode", async () => {
  const directory = await root()
  await collect(directory, "seed", spawn(directory, "journal-seed"))
  const node = await nodeBundle(directory)
  await collect(directory, "node-read-v1", spawn(directory, "journal-read", "one", node))
  await collect(directory, "node-upgrade", spawn(directory, "journal-upgrade", "one", node))
  await collect(directory, "node-read-v2", spawn(directory, "journal-read", "one", node))
  console.info("MCP_CALLBACK_NODE_UPGRADE_EVIDENCE", directory)
}, 30000)

test("v2 upgrade rejects partial schemas, malformed retained credentials and extension capacity atomically", async () => {
  for (const name of ["partial", "extra", "shape", "capacity"]) {
    const directory = await root()
    await collect(directory, "seed", spawn(directory, "journal-seed"))
    await collect(directory, name, spawn(directory, name === "capacity" ? "journal-capacity" : "journal-invalid", name))
    console.info("MCP_CALLBACK_UPGRADE_NEGATIVE_EVIDENCE", name, directory)
  }
}, 30000)

test("a native SQLite COMMIT return fault stays unknown and observes committed v2 without repeating migration", async () => {
  const directory = await root()
  await collect(directory, "seed", spawn(directory, "journal-seed"))
  const node = await nodeBundle(directory)
  await collect(directory, "commit-loss", spawn(directory, "journal-commit-loss", "one", node))
  console.info("MCP_CALLBACK_UPGRADE_COMMIT_EVIDENCE", directory)
}, 30000)

for (const mode of ["two-processes", "two-roots", "manual", "node", "reuse", "static"] as const)
  test(`actual SDK DCR authorize callback token connect: ${mode}`, async () => {
    const directory = await root()
    const clients = new Map<string, string[]>()
    const codes = new Map<string, { client: string; redirect: string; challenge: string }>()
    const tokens = new Set<string>()
    const refreshTokens = new Map<string, string>()
    const calls: { path: string; method: string }[] = []
    const listener = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url)
        calls.push({ path: url.pathname, method: request.method })
        if (url.pathname.includes("oauth-protected-resource"))
          return Response.json({ resource: `${url.origin}/mcp`, authorization_servers: [url.origin] })
        if (url.pathname.includes("oauth-authorization-server"))
          return Response.json({
            issuer: url.origin,
            authorization_endpoint: `${url.origin}/authorize`,
            token_endpoint: `${url.origin}/token`,
            registration_endpoint: `${url.origin}/register`,
            response_types_supported: ["code"],
            code_challenge_methods_supported: ["S256"],
            authorization_response_iss_parameter_supported: true,
          })
        if (url.pathname === "/fixture-expire") {
          tokens.delete((request.headers.get("authorization") ?? "").replace(/^Bearer /, ""))
          return new Response(null, { status: 204 })
        }
        if (url.pathname === "/register") {
          const body = (await request.json()) as { redirect_uris: string[] }
          const client = randomBytes(16).toString("hex")
          clients.set(client, body.redirect_uris)
          return Response.json({ ...body, client_id: client, client_id_issued_at: Math.floor(Date.now() / 1000) })
        }
        if (url.pathname === "/authorize") {
          const client = url.searchParams.get("client_id")!
          const redirect = url.searchParams.get("redirect_uri")!
          if (!clients.get(client)?.includes(redirect))
            return new Response("Unregistered redirect URI", { status: 400 })
          const code = randomBytes(16).toString("hex")
          codes.set(code, { client, redirect, challenge: url.searchParams.get("code_challenge")! })
          const callback = new URL(redirect)
          callback.searchParams.set("state", url.searchParams.get("state")!)
          callback.searchParams.set("code", code)
          callback.searchParams.set("iss", url.origin)
          return Response.redirect(callback.href, 302)
        }
        if (url.pathname === "/token") {
          const body = new URLSearchParams(await request.text())
          if (body.get("grant_type") === "refresh_token") {
            const refresh = body.get("refresh_token")!
            if (refreshTokens.get(refresh) !== body.get("client_id"))
              return Response.json({ error: "invalid_grant" }, { status: 400 })
            const token = randomBytes(16).toString("hex")
            tokens.add(token)
            return Response.json({ access_token: token, refresh_token: refresh, token_type: "Bearer", expires_in: 600 })
          }
          const code = body.get("code")!
          const saved = codes.get(code)
          const challenge = createHash("sha256")
            .update(body.get("code_verifier") ?? "")
            .digest("base64url")
          if (
            !saved ||
            saved.client !== body.get("client_id") ||
            saved.redirect !== body.get("redirect_uri") ||
            saved.challenge !== challenge
          )
            return Response.json({ error: "invalid_grant" }, { status: 400 })
          codes.delete(code)
          const token = randomBytes(16).toString("hex")
          tokens.add(token)
          const refresh = randomBytes(16).toString("hex")
          refreshTokens.set(refresh, saved.client)
          return Response.json({ access_token: token, refresh_token: refresh, token_type: "Bearer", expires_in: 600 })
        }
        if (!tokens.has((request.headers.get("authorization") ?? "").replace(/^Bearer /, "")))
          return new Response(null, {
            status: 401,
            headers: {
              "WWW-Authenticate": `Bearer resource_metadata="${url.origin}/.well-known/oauth-protected-resource"`,
            },
          })
        if (request.method === "DELETE") return new Response(null, { status: 204 })
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
                  serverInfo: { name: "callback-full-chain", version: "1" },
                  capabilities: { tools: {} },
                }
              : { tools: [] },
        })
      },
    })
    const probe =
      mode === "static" ? Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() }) : undefined
    const staticUri = probe ? `http://127.0.0.1:${probe.port}/static/callback?fixed=value` : undefined
    if (probe) await probe.stop(true)
    if (staticUri) clients.set("static-fixture-client", [staticUri])
    await fs.writeFile(
      path.join(directory, "project", "deepagent-code.json"),
      JSON.stringify({
        $schema: "https://ai.deepagent.ltd/config.schema.json",
        mcp: {
          probe: {
            type: "remote",
            url: `${listener.url.origin}/mcp`,
            oauth: staticUri
              ? { clientId: "static-fixture-client", redirectUri: staticUri }
              : mode === "manual"
                ? { redirectUri: "https://callback.invalid/callback?fixed=value" }
                : {},
            timeout: 10000,
          },
        },
      }),
    )
    const node = mode === "node" ? await nodeBundle(directory) : undefined

    const first = spawn(
      directory,
      mode === "two-roots" || mode === "static" ? "two-roots" : mode === "reuse" ? "reuse" : "auth",
      "a",
      node,
    )
    const children = [first]
    try {
      const a = await wait(directory, "a.ready.json", first)
      const second =
        mode === "two-roots" || mode === "static"
          ? first
          : spawn(directory, mode === "reuse" ? "reuse" : "auth", "b", node)
      if (second !== first) children.push(second)
      const b = await wait(directory, "b.ready.json", second)
      if (mode !== "manual" && mode !== "static") expect(a.redirectUri).not.toBe(b.redirectUri)
      await fs.writeFile(path.join(directory, "go-a"), "")
      const resultA = await wait(directory, "a.result.json", first)
      await fs.writeFile(path.join(directory, "close-a"), "")
      await wait(directory, "a.closed.json", first)
      if (second !== first) await collect(directory, "a", first)
      await fs.writeFile(path.join(directory, "go-b"), "")
      const resultB = await wait(directory, "b.result.json", second)
      await fs.writeFile(path.join(directory, "close-b"), "")
      await collect(directory, "b", second)
      expect(resultA.connected && resultB.connected).toBe(true)
      expect(resultB.rows).toHaveLength(2)
      expect(new Set(resultB.rows.map((row: { namespace: string }) => row.namespace)).size).toBe(2)
      expect(
        resultB.rows.every((row: { registered: string | null }) =>
          mode === "reuse" || mode === "static" ? row.registered === null : JSON.parse(row.registered!).length === 1,
        ),
      ).toBe(true)
      expect(calls.filter((call) => call.path === "/register")).toHaveLength(mode === "static" ? 0 : 2)
      expect(calls.filter((call) => call.path === "/token")).toHaveLength(mode === "reuse" ? 6 : 2)
      expect(resultA.automatic).toBe(mode !== "manual")
      await fs.writeFile(
        path.join(directory, "evidence.json"),
        JSON.stringify({ mode, first: resultA, second: resultB, calls, asPort: listener.port }, null, 2),
      )
      console.info("MCP_CALLBACK_FULL_CHAIN_EVIDENCE", mode, directory)
    } finally {
      for (const child of children) {
        clearTimeout(child.deadline)
        if (child.child.exitCode === null) child.child.kill()
        await child.child.exited
      }
      await listener.stop(true)
    }
  }, 60000)

test("actual DCR dispatch survives SIGKILL; a cold explicit start cannot re-register or open a callback", async () => {
  const directory = await root()
  const received = Promise.withResolvers<void>()
  const hold = Promise.withResolvers<Response>()
  const calls: string[] = []
  const listener = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      calls.push(`${request.method} ${url.pathname}`)
      if (url.pathname.includes("oauth-protected-resource"))
        return Response.json({ resource: `${url.origin}/mcp`, authorization_servers: [url.origin] })
      if (url.pathname.includes("oauth-authorization-server"))
        return Response.json({
          issuer: url.origin,
          authorization_endpoint: `${url.origin}/authorize`,
          token_endpoint: `${url.origin}/token`,
          registration_endpoint: `${url.origin}/register`,
          response_types_supported: ["code"],
          code_challenge_methods_supported: ["S256"],
        })
      if (url.pathname === "/register") {
        received.resolve()
        return hold.promise
      }
      return new Response(null, {
        status: 401,
        headers: {
          "WWW-Authenticate": `Bearer resource_metadata="${url.origin}/.well-known/oauth-protected-resource"`,
        },
      })
    },
  })
  await fs.writeFile(
    path.join(directory, "project", "deepagent-code.json"),
    JSON.stringify({
      $schema: "https://ai.deepagent.ltd/config.schema.json",
      mcp: { probe: { type: "remote", url: `${listener.url.origin}/mcp`, oauth: {}, timeout: 20000 } },
    }),
  )
  const first = spawn(directory, "auth", "a")
  const guard = setTimeout(() => received.reject(new Error("DCR dispatch barrier timed out")), 25000)
  try {
    await Promise.race([
      received.promise,
      first.child.exited.then(async () => {
        throw new Error(await first.stderr)
      }),
    ])
    clearTimeout(guard)
    const file = path.join(directory, "home", ".deepagent", "code", "mcp-oauth", "journal.sqlite")
    const identity = await fs.stat(file)
    first.child.kill("SIGKILL")
    await first.child.exited
    clearTimeout(first.deadline)
    await fs.writeFile(path.join(directory, "killed.log"), (await first.stdout) + (await first.stderr))
    const before = calls.length
    const second = spawn(directory, "cold-read", "a")
    await collect(directory, "cold-read", second)
    const result = JSON.parse(await fs.readFile(path.join(directory, "a.result.json"), "utf8"))
    expect(result.operations).toEqual([{ kind: "registration", phase: "dispatched", n: 1 }])
    expect(result.dev).toBe(identity.dev)
    expect(result.inode).toBe(identity.ino)
    expect(result.pid).not.toBe(first.child.pid)
    expect(calls.length).toBe(before)
    expect(calls.filter((call) => call === "POST /register")).toHaveLength(1)
    expect(result.unchanged).toBe(true)
    await fs.writeFile(
      path.join(directory, "evidence.json"),
      JSON.stringify({ firstPID: first.child.pid, second: result, calls, networkAfterCrash: 0 }, null, 2),
    )
    console.info("MCP_CALLBACK_DCR_COLD_EVIDENCE", directory)
  } finally {
    clearTimeout(guard)
    clearTimeout(first.deadline)
    if (first.child.exitCode === null) first.child.kill()
    await first.child.exited
    hold.resolve(new Response(null, { status: 503 }))
    await listener.stop(true)
  }
}, 45000)
