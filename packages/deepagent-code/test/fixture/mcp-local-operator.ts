import assert from "node:assert/strict"
import { isMainThread } from "node:worker_threads"
import fs from "node:fs/promises"
import path from "node:path"
import { createHash, randomBytes } from "node:crypto"
import { Rpc } from "../../src/util/rpc"
import { createMcpOperatorBridge } from "../../src/cli/tui/mcp-operator-bridge"

export function authorizationServer() {
  const authorizations: string[] = []
  const clients = new Map<string, string[]>()
  const codes = new Map<string, { client: string; redirect: string; challenge: string }>()
  const tokens = new Set<string>()
  const calls: { path: string; method: string }[] = []
  const held: { promise?: Promise<void>; resolve?: () => void } = {}
  const listener = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      calls.push({ path: url.pathname, method: request.method })
      if (url.pathname === "/authorize") authorizations.push(url.href)
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
      if (url.pathname === "/register") {
        const body = (await request.json()) as { redirect_uris: string[] }
        const client = randomBytes(16).toString("hex")
        clients.set(client, body.redirect_uris)
        if (held.promise) await held.promise
        return Response.json({ ...body, client_id: client, client_id_issued_at: Math.floor(Date.now() / 1000) })
      }
      if (url.pathname === "/authorize") {
        const client = url.searchParams.get("client_id")!
        const redirect = url.searchParams.get("redirect_uri")!
        if (!clients.get(client)?.includes(redirect)) return new Response(null, { status: 400 })
        const code = randomBytes(16).toString("hex")
        codes.set(code, { client, redirect, challenge: url.searchParams.get("code_challenge")! })
        const callback = new URL(redirect)
        callback.searchParams.set("state", url.searchParams.get("state")!)
        callback.searchParams.set("code", code)
        callback.searchParams.set("iss", url.origin)
        return Response.redirect(callback.href)
      }
      if (url.pathname === "/token") {
        const body = new URLSearchParams(await request.text())
        const code = body.get("code")!
        const saved = codes.get(code)
        if (
          !saved ||
          saved.client !== body.get("client_id") ||
          saved.redirect !== body.get("redirect_uri") ||
          saved.challenge !==
            createHash("sha256")
              .update(body.get("code_verifier") ?? "")
              .digest("base64url")
        )
          return Response.json({ error: "invalid_grant" }, { status: 400 })
        codes.delete(code)
        const token = randomBytes(16).toString("hex")
        tokens.add(token)
        return Response.json({ access_token: token, token_type: "Bearer", expires_in: 600 })
      }
      if (
        url.pathname !== "/public" &&
        !tokens.has((request.headers.get("authorization") ?? "").replace(/^Bearer /, ""))
      )
        return new Response(null, {
          status: 401,
          headers: {
            "WWW-Authenticate": `Bearer resource_metadata="${url.origin}/.well-known/oauth-protected-resource"`,
          },
        })
      if (request.method === "GET" || request.method === "DELETE") return new Response(null, { status: 405 })
      const input = (await request.json()) as { id?: number; method: string }
      if (input.id === undefined) return new Response(null, { status: 202 })
      const result =
        input.method === "initialize"
          ? {
              protocolVersion: "2025-11-25",
              capabilities: { tools: {} },
              serverInfo: { name: "private-operator-fixture", version: "1" },
            }
          : input.method === "tools/list"
            ? { tools: [{ name: "echo", description: "Fixture echo", inputSchema: { type: "object" } }] }
            : { content: [{ type: "text", text: "fixture" }] }
      return Response.json({ jsonrpc: "2.0", id: input.id, result })
    },
  })
  return {
    listener,
    calls,
    authorizations,
    holdRegistration() {
      held.promise = new Promise<void>((resolve) => {
        held.resolve = resolve
      })
    },
    release() {
      held.resolve?.()
    },
  }
}

async function run() {
  const root = process.env.DAC_MCP_OPERATOR_ROOT
  assert(root && path.basename(root).startsWith("dac-mcp-operator-"))
  assert.equal(await fs.realpath(root), root)
  assert.equal(process.env.DEEPAGENT_CODE_SERVER_PASSWORD, "")
  const mode = process.env.DAC_MCP_OPERATOR_MODE ?? "canonical"
  const project = path.join(root, "project")
  assert.equal(process.cwd(), project)
  const server = authorizationServer()
  const config = {
    $schema: "https://ai.deepagent.ltd/config.schema.json",
    formatter: false,
    lsp: false,
    mcp: {
      fixture: {
        type: "remote",
        url: new URL("/mcp", server.listener.url).href,
        oauth: { redirectUri: "https://callback.example.test/return" },
      },
      zlocal: {
        type: "local",
        command: [process.execPath, path.resolve(import.meta.dir, "mcp-local-operator.ts"), "stdio"],
      },
      public: { type: "remote", url: new URL("/public", server.listener.url).href, oauth: false },
    },
  }
  await fs.writeFile(path.join(project, "deepagent-code.json"), JSON.stringify(config))
  const home = process.env.HOME!
  const data = path.join(home, ".deepagent", "code")
  await fs.mkdir(path.join(data, "cache", "bin"), { recursive: true })
  const rg = Bun.which("rg")
  assert(rg)
  await fs.copyFile(rg, path.join(data, "cache", "bin", "rg"))
  await fs.writeFile(
    path.join(data, mode === "legacy" ? "deepagent-code.jsonc" : "config.jsonc"),
    JSON.stringify({ $schema: config.$schema }),
  )
  const worker = new Worker(new URL(import.meta.url))
  const probeReady = new Promise<void>((resolve) => {
    worker.addEventListener("message", (event) => {
      if (event.data?.fixture === "ready") resolve()
    })
  })
  const pendingBridge = createMcpOperatorBridge(worker, project)
  const rpc = Rpc.client<typeof import("../../src/cli/tui/worker").rpc>(worker, { timeoutMs: 30000 })
  const bridge = await pendingBridge
  await probeReady
  const probe = (kind: string) =>
    new Promise<unknown>((resolve) => {
      const listener = (event: MessageEvent) => {
        if (event.data?.fixture !== kind) return
        worker.removeEventListener("message", listener)
        resolve(event.data.result)
      }
      worker.addEventListener("message", listener)
      worker.postMessage({ fixture: kind })
    })
  try {
    assert.deepEqual(await probe("repo"), {
      sameCapturedFunctions: true,
      readWrites: 0,
      emptyAuthority: true,
      goalSameFact: true,
    })
    if (mode === "legacy-binding" || mode === "legacy-git-binding") {
      assert.equal(await probe("legacy-binding-seed"), true)
      const journal = path.join(data, "mcp-oauth", "journal.sqlite")
      const before = await fs.readFile(journal)
      const identity = await probe("identity-rows")
      const ticket = await bridge.transport.prepare("fixture")
      await assert.rejects(() => bridge.transport.send({ ticket: ticket.ticket, action: "startAuth" }))
      await bridge.transport.release(ticket.ticket)
      assert.equal(server.calls.length, 0)
      assert.deepEqual(await fs.readFile(journal), before)
      assert.deepEqual(await probe("identity-rows"), identity)
      await fs.writeFile(
        path.join(root, "evidence.json"),
        JSON.stringify({ mode, originalBindingUnchanged: true, populatedJournalBytesUnchanged: true, AS: 0 }),
      )
      return
    }
    if (mode === "startup") {
      assert.equal(await probe("startup"), true)
      assert(server.calls.some((call) => call.path === "/public"))
      assert.equal(server.calls.filter((call) => call.path === "/register").length, 0)
      assert.equal(await fs.readFile(path.join(root, "stdio-started.txt"), "utf8"), "started")
      await fs.writeFile(
        path.join(root, "evidence.json"),
        JSON.stringify({ mode, ordinaryStartupHTTP: true, ordinaryStartupStdio: true, OAuth: 0 }),
      )
      return
    }
    if (mode === "listener") {
      await rpc.call("server", { port: 0, hostname: "127.0.0.1" })
      const denied = await bridge.transport.prepare("fixture")
      await assert.rejects(() => bridge.transport.send({ ticket: denied.ticket, action: "startAuth" }))
      assert.equal(server.calls.length, 0)
      assert.equal(await probe("listener"), false)
      await fs.writeFile(
        path.join(root, "evidence.json"),
        JSON.stringify({ mode, anonymousListenerRejectsNative: true, goalSameFact: true, AS: 0 }),
      )
      return
    }
    const response = await rpc.call("fetch", {
      url: "http://deepagent-code.internal/mcp/fixture/auth",
      method: "POST",
      headers: { "x-deepagent-code-directory": project },
    })
    assert.equal(response.status, 401)
    assert.equal(server.calls.length, 0)
    console.log("stage", "prepare")
    let prepared = await bridge.transport.prepare("fixture")
    assert.equal(server.calls.length, 0)
    assert.equal(prepared.manual, true)
    assert.equal(
      await fs.stat(path.join(data, "mcp-oauth")).then(
        () => true,
        () => false,
      ),
      false,
    )
    if (mode === "legacy") {
      const before = await fs.readFile(path.join(data, "deepagent-code.jsonc"))
      await assert.rejects(
        () => bridge.transport.send({ ticket: prepared.ticket, action: "startAuth" }),
        (error: unknown) => error instanceof Error && "code" in error && error.code === "SCOPE_CHANGED",
      )
      assert.equal(server.calls.length, 0)
      assert.deepEqual(await fs.readFile(path.join(data, "config.jsonc")), before)
      assert.equal(
        await fs.stat(path.join(data, "deepagent-code.jsonc")).then(
          () => true,
          () => false,
        ),
        false,
      )
      await bridge.transport.release(prepared.ticket)
      prepared = await bridge.transport.prepare("fixture")
    }
    if (mode === "cancel" || mode === "late-source") {
      server.holdRegistration()
      const controller = new AbortController()
      const operation = bridge.transport.send({ ticket: prepared.ticket, action: "startAuth" }, controller.signal)
      const denied = assert.rejects(() => operation)
      const deadline = Date.now() + 10000
      while (!server.calls.some((call) => call.path === "/register")) {
        if (Date.now() > deadline) throw new Error("Actual DCR was not dispatched")
        await Bun.sleep(10)
      }
      if (mode === "cancel") controller.abort()
      if (mode === "late-source")
        await fs.writeFile(
          path.join(project, "deepagent-code.json"),
          JSON.stringify({
            ...config,
            mcp: {
              ...config.mcp,
              fixture: { ...config.mcp.fixture, url: new URL("/changed", server.listener.url).href },
            },
          }),
        )
      server.release()
      await denied
      await bridge.transport.whenSettled()
      await bridge.transport.release(prepared.ticket)
      const count = server.calls.length
      const current = await bridge.transport.prepare("fixture")
      if (mode === "cancel") {
        await assert.rejects(() => bridge.transport.send({ ticket: current.ticket, action: "startAuth" }))
        assert.equal(server.calls.length, count)
      }
      assert.equal(server.calls.filter((call) => call.path === "/token").length, 0)
      assert.equal(server.calls.filter((call) => call.path === "/register").length, 1)
      await bridge.transport.release(current.ticket)
      await fs.writeFile(
        path.join(root, "evidence.json"),
        JSON.stringify({
          mode,
          registration: 1,
          token: 0,
          explicitUnknownNoRepeat: mode === "cancel",
          actualLateSourceFence: mode === "late-source",
        }),
      )
      return
    }
    if (mode === "account-aba") {
      assert.equal(await probe("account-aba"), true)
      await assert.rejects(() => bridge.transport.send({ ticket: prepared.ticket, action: "startAuth" }))
      assert.equal(server.calls.length, 0)
      await bridge.transport.release(prepared.ticket)
      await fs.writeFile(path.join(root, "evidence.json"), JSON.stringify({ mode, realRepoSelectionABA: true, AS: 0 }))
      return
    }
    console.log("stage", "startAuth")
    const started = await bridge.transport.send({ ticket: prepared.ticket, action: "startAuth" })
    assert.equal(
      server.calls.filter((call) => call.path === "/public").length,
      0,
      "Selecting fixture must not authorize public MCP B",
    )
    assert.equal(
      await fs.stat(path.join(root, "stdio-started.txt")).then(
        () => true,
        () => false,
      ),
      false,
      "A must not spawn local B",
    )
    assert(started.authorizationUrl && started.oauthState)
    const authorization = await fetch(started.authorizationUrl, { redirect: "manual" })
    assert.equal(authorization.status, 302)
    const callback = new URL(authorization.headers.get("location")!)
    assert.equal(callback.origin, "https://callback.example.test")
    const beforeWrong = server.calls.filter((call) => call.path === "/token").length
    await assert.rejects(() =>
      bridge.transport.send({
        ticket: prepared.ticket,
        action: "finishAuth",
        callback: {
          code: callback.searchParams.get("code")!,
          oauthState: "wrong-state",
          iss: server.listener.url.origin,
        },
      }),
    )
    assert.equal(server.calls.filter((call) => call.path === "/token").length, beforeWrong)
    await bridge.transport.send({
      ticket: prepared.ticket,
      action: "finishAuth",
      callback: {
        code: callback.searchParams.get("code")!,
        oauthState: started.oauthState,
        iss: server.listener.url.origin,
      },
    })
    await bridge.transport.release(prepared.ticket)
    const get = () =>
      rpc.call("fetch", {
        url: "http://deepagent-code.internal/mcp",
        method: "GET",
        headers: { "x-deepagent-code-directory": project },
      })
    assert.equal(JSON.parse((await get()).body).fixture.status, "connected")
    assert.deepEqual(await probe("tool"), { content: [{ type: "text", text: "fixture" }] })
    const fresh = await bridge.transport.prepare("fixture")
    await bridge.transport.send({ ticket: fresh.ticket, action: "clearAuth" })
    await bridge.transport.release(fresh.ticket)
    assert.equal(JSON.parse((await get()).body).fixture.status, "needs_auth")
    const plain = await bridge.transport.prepare("public")
    await bridge.transport.send({ ticket: plain.ticket, action: "connect" })
    await bridge.transport.release(plain.ticket)
    assert.equal(JSON.parse((await get()).body).public.status, "connected")
    const local = await bridge.transport.prepare("zlocal")
    await bridge.transport.send({ ticket: local.ticket, action: "connect" })
    await bridge.transport.release(local.ticket)
    assert.equal(JSON.parse((await get()).body).zlocal.status, "connected")
    assert.equal(await fs.readFile(path.join(root, "stdio-started.txt"), "utf8"), "started")
    const stale = await bridge.transport.prepare("public")
    await fs.writeFile(
      path.join(project, "deepagent-code.json"),
      JSON.stringify({
        ...config,
        mcp: { ...config.mcp, public: { ...config.mcp.public, url: new URL("/changed", server.listener.url).href } },
      }),
    )
    const calls = server.calls.length
    await assert.rejects(() => bridge.transport.send({ ticket: stale.ticket, action: "connect" }))
    assert.equal(server.calls.length, calls)
    await bridge.transport.release(stale.ticket)
    await fs.writeFile(
      path.join(root, "evidence.json"),
      JSON.stringify(
        {
          pid: process.pid,
          mode,
          actualWorker: true,
          rawHttp401: true,
          prepareZeroExternal: true,
          manualHttpsZeroListener: true,
          actualDcr: server.calls.filter((call) => call.path === "/register").length,
          actualToken: server.calls.filter((call) => call.path === "/token").length,
          successfulConnectionSurvivesTicketRelease: true,
          clearLocal: true,
          nonOAuthConnected: true,
          changedSourceZeroExternal: true,
        },
        null,
        2,
      ),
    )
    console.log("MCP_OPERATOR_FIXTURE_PASS", root)
  } finally {
    bridge.close()
    await bridge.transport.whenSettled()
    await rpc.call("shutdown", undefined).catch(() => undefined)
    rpc.close()
    worker.terminate()
    server.release()
    await server.listener.stop(true)
  }
}

async function workerProbe() {
  await import("../../src/cli/tui/worker")
  const { parentPort } = await import("node:worker_threads")
  const { Effect, Option, Layer } = await import("effect")
  const { sql } = await import("drizzle-orm")
  const { AppRuntime } = await import("../../src/effect/app-runtime")
  const { Account } = await import("../../src/account/account")
  const { AccountRepo } = await import("../../src/account/repo")
  const { Database } = await import("@deepagent-code/core/database/database")
  const { Server } = await import("../../src/server/server")
  const { InstanceStore } = await import("../../src/project/instance-store")
  const { InstanceRef } = await import("../../src/effect/instance-ref")
  const { MCP } = await import("../../src/mcp")
  parentPort!.on("message", (value: unknown) => {
    if (!value || typeof value !== "object" || !("fixture" in value)) return
    const kind = value.fixture
    void AppRuntime.runPromise(
      Effect.gen(function* () {
        if (kind === "listener") return Server.privateLocalWritesAvailable()
        if (kind === "repo") {
          const repo = yield* AccountRepo.Service
          const account = yield* Account.Service
          const db = (yield* Database.Service).db
          const before = yield* db.all<{ changes: number }>(sql`SELECT total_changes() AS changes`)
          const authority = yield* repo.authority()
          yield* account.source()
          yield* account.active()
          const after = yield* db.all<{ changes: number }>(sql`SELECT total_changes() AS changes`)
          return {
            sameCapturedFunctions:
              repo.active === account.active && repo.list === account.list && repo.remove === account.remove,
            readWrites: Number(after[0].changes) - Number(before[0].changes),
            emptyAuthority: authority.account === null,
            goalSameFact: Server.privateLocalWritesAvailable() === Server.privateGoalWritesAvailable(),
          }
        }
        if (kind === "account-aba") {
          const repo = yield* AccountRepo.Service
          const before = yield* repo.authority()
          yield* repo.persistAccount({
            id: Account.AccountID.make("fixture-account"),
            email: "fixture@example.test",
            url: "https://identity.example.test",
            accessToken: Account.AccessToken.make("fixture-access"),
            refreshToken: Account.RefreshToken.make("fixture-refresh"),
            expiry: Date.now() + 600000,
            orgID: Option.none(),
          })
          yield* repo.remove(Account.AccountID.make("fixture-account"))
          const after = yield* repo.authority()
          return before.account === null && after.account === null && after.selectionRevision > before.selectionRevision
        }
        if (kind === "legacy-binding-seed") {
          const { LocationIdentity } = yield* Effect.promise(
            () => import("@deepagent-code/core/context-federation/identity"),
          )
          const { AbsolutePath } = yield* Effect.promise(() => import("@deepagent-code/core/schema"))
          const { Project } = yield* Effect.promise(() => import("../../src/project/project"))
          const { LocalAuthority } = yield* Effect.promise(() => import("../../src/installation/local-authority"))
          const { Global } = yield* Effect.promise(() => import("@deepagent-code/core/global"))
          const { McpAuthJournal } = yield* Effect.promise(() => import("../../src/mcp/auth-journal"))
          const observed = yield* (yield* Project.Service).fromDirectory(process.cwd())
          const { FSUtil } = yield* Effect.promise(() => import("@deepagent-code/core/fs-util"))
          const old = yield* Effect.gen(function* () {
            return yield* (yield* LocationIdentity.Service).resolve({
              boundary: { kind: "implicit_local" },
              directory: AbsolutePath.make(process.cwd()),
              project: { kind: "registered_root", observedProjectId: observed.project.id },
            })
          }).pipe(Effect.provide(LocationIdentity.layer.pipe(Layer.provide(FSUtil.defaultLayer))))
          const installation = yield* LocalAuthority.ensurePrivateInstallation()
          const journal = yield* Effect.promise(() =>
            McpAuthJournal.open(path.join(Global.Path.config, "mcp-oauth", "journal.sqlite"), "1".repeat(64), "write"),
          )
          assert(journal)
          const handle = journal.begin({
            slot: "2".repeat(64),
            explicit: true,
            binding: {
              version: 1,
              installationID: installation.instanceID,
              namespace: old.securityNamespaceId,
              location: old.locationKey,
              project: old.projectScopeKey,
              rootTag: "1".repeat(64),
              principal: { kind: "local", selectionRevision: 0 },
              name: "fixture",
              resource: "https://old.example.test/mcp",
              sourceTag: "1".repeat(64),
              configurationTag: "1".repeat(64),
              credentialTag: "1".repeat(64),
            },
            flow: {
              version: 1,
              id: "3".repeat(64),
              owner: "4".repeat(64),
              state: "5".repeat(64),
              phase: "preparing",
              createdAt: Date.now(),
              expiresAt: Date.now() + 300000,
              redirectUri: "https://callback.example.test/return",
            },
          })
          journal.credentials(handle, () => ({
            tokens: {
              accessToken: "fixture-retained-legacy-secret",
              issuer: "https://old.example.test",
              expiresAt: Date.now() + 300000,
            },
          }))
          journal.updateFlow(handle, { phase: "connected" })
          journal.close()
          return true
        }
        if (kind === "identity-rows") {
          const db = (yield* Database.Service).db
          return {
            location: yield* db.all(sql`SELECT * FROM context_location_identity ORDER BY location_key`),
            project: yield* db.all(sql`SELECT * FROM context_project_scope_identity ORDER BY project_scope_key`),
          }
        }
        if (kind === "startup") {
          const instance = yield* (yield* InstanceStore.Service).load({ directory: process.cwd() })
          const tools = yield* (yield* MCP.Service).tools().pipe(Effect.provideService(InstanceRef, instance))
          return !!tools.public_echo && !!tools.zlocal_echo
        }
        if (kind === "tool") {
          const instance = yield* (yield* InstanceStore.Service).peek(process.cwd())
          assert(instance)
          const tools = yield* (yield* MCP.Service).tools().pipe(Effect.provideService(InstanceRef, instance))
          assert(tools.fixture_echo?.execute)
          return yield* Effect.promise(async () =>
            tools.fixture_echo.execute!({}, { toolCallId: "fixture-echo", messages: [] }),
          )
        }
        throw new Error("Unknown private test probe")
      }),
    )
      .then((result) => parentPort!.postMessage({ fixture: kind, result }))
      .catch((error: unknown) => {
        console.error("PRIVATE_PROBE_FAILURE", error)
        parentPort!.postMessage({ fixture: kind, result: "failed" })
      })
  })
  parentPort!.postMessage({ fixture: "ready" })
}

if (!isMainThread) await workerProbe()
else if (process.argv[2] === "host") await run()
else if (process.argv[2] === "stdio") {
  const { createInterface } = await import("node:readline")
  await fs.writeFile(path.join(process.env.DAC_MCP_OPERATOR_ROOT!, "stdio-started.txt"), "started")
  for await (const line of createInterface({ input: process.stdin })) {
    const message = JSON.parse(line) as { id?: number; method: string }
    if (message.id === undefined) continue
    const result =
      message.method === "initialize"
        ? {
            protocolVersion: "2025-11-25",
            capabilities: { tools: {} },
            serverInfo: { name: "private-stdio", version: "1" },
          }
        : message.method === "tools/list"
          ? { tools: [{ name: "echo", inputSchema: { type: "object" } }] }
          : { content: [{ type: "text", text: "stdio fixture" }] }
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\n")
  }
}
