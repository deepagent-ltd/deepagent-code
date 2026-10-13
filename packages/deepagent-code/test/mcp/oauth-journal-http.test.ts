import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { createHash } from "node:crypto"

const fixture = path.resolve(import.meta.dir, "../fixture/mcp-oauth-cold.ts")
test("real SDK token dispatch survives SIGKILL and cold actual scope GET and callback never repeat it", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dac-mcp-oauth-cold-")))
  await Promise.all(["home", "tmp", "project"].map((name) => fs.mkdir(path.join(root, name), { mode: 0o700 })))
  const token = Promise.withResolvers<void>()
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
      if (url.pathname.includes("oauth-authorization-server") || url.pathname.includes("openid-configuration"))
        return Response.json({
          issuer: url.origin,
          authorization_endpoint: `${url.origin}/authorize`,
          token_endpoint: `${url.origin}/token`,
          response_types_supported: ["code"],
          code_challenge_methods_supported: ["S256"],
        })
      if (url.pathname === "/token") {
        token.resolve()
        return hold.promise
      }
      if (request.method === "DELETE") return new Response(null, { status: 204 })
      return new Response(null, {
        status: 401,
        headers: {
          "WWW-Authenticate": `Bearer resource_metadata="${url.origin}/.well-known/oauth-protected-resource"`,
        },
      })
    },
  })
  const callback = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
  const port = callback.port!
  await callback.stop(true)
  await fs.writeFile(
    path.join(root, "project", "deepagent-code.json"),
    JSON.stringify({
      $schema: "https://ai.deepagent.ltd/config.schema.json",
      mcp: {
        cold: {
          type: "remote",
          url: `${listener.url.origin}/mcp`,
          oauth: { clientId: "fixture-client", callbackPort: port },
          timeout: 15000,
        },
      },
    }),
  )
  const spawn = (mode: string) =>
    Bun.spawn([process.execPath, fixture, mode], {
      cwd: path.resolve(import.meta.dir, "../.."),
      env: {
        PATH: process.env.PATH,
        HOME: path.join(root, "home"),
        TMPDIR: path.join(root, "tmp"),
        DEEPAGENT_CODE_TEST_HOME: path.join(root, "home"),
        DEEPAGENT_CODE_DB: path.join(root, "home", ".deepagent", "code", "authority.sqlite"),
        DEEPAGENT_CODE_TEST_MANAGED_CONFIG_DIR: path.join(root, "managed"),
        DAC_MCP_COLD_ROOT: root,
        DEEPAGENT_CODE_MODELS_PATH: path.resolve(import.meta.dir, "../tool/fixtures/models-api.json"),
      },
      stdout: "pipe",
      stderr: "pipe",
    })
  const first = spawn("exchange")
  const firstOut = new Response(first.stdout).text()
  const firstErr = new Response(first.stderr).text()
  const limit = setTimeout(() => {
    first.kill()
    token.reject(new Error("token request barrier timed out"))
  }, 25000)
  try {
    await Promise.race([
      token.promise,
      first.exited.then(async (code) => {
        const output = (await firstOut) + (await firstErr)
        await fs.writeFile(path.join(root, "process-one.log"), output)
        throw new Error(`OAuth fixture exited ${code}: ${output}`)
      }),
    ])
    const file = path.join(root, "home", ".deepagent", "code", "mcp-oauth", "journal.sqlite")
    const inode = await fs.stat(file)
    const business = await fs.stat(path.join(root, "home", ".deepagent", "code", "authority.sqlite"))
    first.kill("SIGKILL")
    await first.exited
    clearTimeout(limit)
    await fs.writeFile(path.join(root, "process-one.log"), (await firstOut) + (await firstErr))
    const before = createHash("sha256")
      .update(await fs.readFile(file))
      .digest("hex")
    const atCrash = calls.length
    const second = spawn("read")
    const deadline = setTimeout(() => second.kill(), 20000)
    const [code, stdout, stderr] = await Promise.all([
      second.exited,
      new Response(second.stdout).text(),
      new Response(second.stderr).text(),
    ])
    clearTimeout(deadline)
    await fs.writeFile(path.join(root, "process-two.log"), stdout + stderr)
    expect({ code, diagnostic: code === 0 ? null : stdout + stderr }).toEqual({ code: 0, diagnostic: null })
    const evidence = JSON.parse(stdout.split("\n").find((line) => line.startsWith('{"mode":"read"'))!)
    expect(evidence.file).toEqual({ path: file, dev: inode.dev, inode: inode.ino })
    expect(evidence.business).toEqual({
      path: path.join(root, "home", ".deepagent", "code", "authority.sqlite"),
      dev: business.dev,
      inode: business.ino,
    })
    expect(evidence.operations).toEqual([{ kind: "exchange", phase: "dispatched", n: 1 }])
    expect(calls.length).toBe(atCrash)
    expect(calls.filter((value) => value === "POST /token")).toHaveLength(1)
    expect(
      createHash("sha256")
        .update(await fs.readFile(file))
        .digest("hex"),
    ).toBe(before)
    await fs.writeFile(
      path.join(root, "evidence.json"),
      JSON.stringify({ ...evidence, firstPID: first.pid, calls, networkAfterCrash: 0, hash: before }, null, 2),
    )
    console.info("MCP_SCOPED_COLD_HTTP_EVIDENCE", root)
  } finally {
    clearTimeout(limit)
    first.kill()
    hold.resolve(new Response(null, { status: 503 }))
    await listener.stop(true)
  }
}, 50000)

test("two real business Roots at one directory share a private journal but isolate actual SQL namespace identity", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dac-mcp-oauth-cold-")))
  await Promise.all(["home", "tmp", "project"].map((name) => fs.mkdir(path.join(root, name), { mode: 0o700 })))
  const calls: string[] = []
  const listener = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      calls.push(`${request.method} ${url.pathname}`)
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
        return Response.json({ access_token: "two-root-fixture-token", token_type: "Bearer", expires_in: 600 })
      if (request.method === "DELETE") return new Response(null, { status: 204 })
      if (request.headers.get("authorization") !== "Bearer two-root-fixture-token")
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
                serverInfo: { name: "two-root-fixture", version: "1" },
                capabilities: { tools: {} },
              }
            : { tools: [] },
      })
    },
  })
  await fs.writeFile(
    path.join(root, "project", "deepagent-code.json"),
    JSON.stringify({
      $schema: "https://ai.deepagent.ltd/config.schema.json",
      mcp: { cold: { type: "remote", url: `${listener.url.origin}/mcp`, oauth: { clientId: "two-root-client" } } },
    }),
  )
  const spawn = (mode: "namespace-a" | "namespace-b") =>
    Bun.spawn([process.execPath, fixture, mode], {
      cwd: path.resolve(import.meta.dir, "../.."),
      env: {
        PATH: process.env.PATH,
        HOME: path.join(root, "home"),
        TMPDIR: path.join(root, "tmp"),
        DEEPAGENT_CODE_TEST_HOME: path.join(root, "home"),
        DEEPAGENT_CODE_DB: path.join(
          root,
          "home",
          ".deepagent",
          "code",
          mode === "namespace-a" ? "authority.sqlite" : "authority-two.sqlite",
        ),
        DEEPAGENT_CODE_TEST_MANAGED_CONFIG_DIR: path.join(root, "managed"),
        DAC_MCP_COLD_ROOT: root,
        DEEPAGENT_CODE_MODELS_PATH: path.resolve(import.meta.dir, "../tool/fixtures/models-api.json"),
      },
      stdout: "pipe",
      stderr: "pipe",
    })
  const processes: ReturnType<typeof spawn>[] = []
  const outputs: Promise<string>[] = []
  const barrier = async (name: string) => {
    const deadline = Date.now() + 15000
    while (
      !(await fs.stat(path.join(root, name)).then(
        () => true,
        () => false,
      ))
    ) {
      if (Date.now() >= deadline) throw new Error(`namespace barrier timed out: ${name}`)
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }
  try {
    for (const mode of ["namespace-a", "namespace-b"] as const) {
      const process = spawn(mode)
      processes.push(process)
      outputs.push(
        Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text()]).then((parts) =>
          parts.join(""),
        ),
      )
      await barrier(`${mode}.ready`)
    }
    const ready = JSON.parse(await fs.readFile(path.join(root, "namespace-b.ready"), "utf8")) as {
      rows: {
        slot_key: string
        namespace: string
        location: string
        project: string
        installation: string
        state: string
        phase: string
      }[]
    }
    expect(ready.rows).toHaveLength(2)
    expect(new Set(ready.rows.map((row) => row.namespace)).size).toBe(2)
    expect(new Set(ready.rows.map((row) => row.location)).size).toBe(2)
    expect(new Set(ready.rows.map((row) => row.installation)).size).toBe(1)
    expect(new Set(ready.rows.map((row) => row.state)).size).toBe(2)
    await fs.writeFile(path.join(root, "namespace-a.continue"), "close")
    expect(await processes[0].exited).toBe(0)
    await fs.writeFile(path.join(root, "namespace-b.continue"), "finish")
    expect(await processes[1].exited).toBe(0)
    const result = JSON.parse(await fs.readFile(path.join(root, "namespace-result.json"), "utf8"))
    expect(result.current).toBe(true)
    expect(calls).toHaveLength(0)
    await fs.writeFile(
      path.join(root, "public-evidence.json"),
      JSON.stringify(
        {
          firstPID: processes[0].pid,
          secondPID: processes[1].pid,
          samePhysicalDirectory: path.join(root, "project"),
          sameInstallation: true,
          distinctActualSQLNamespaces: 2,
          tokenPosts: 0,
          survivingSecondRoot: true,
          rows: ready.rows.map(({ state, ...row }) => row),
        },
        null,
        2,
      ),
    )
    console.info("MCP_TWO_ROOT_NAMESPACE_EVIDENCE", root)
  } finally {
    for (const process of processes) process.kill()
    await Promise.all(
      outputs.map(async (output, index) => fs.writeFile(path.join(root, `namespace-${index}.log`), await output)),
    )
    await listener.stop(true)
  }
}, 45000)
