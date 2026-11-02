import { expect, test, spyOn } from "bun:test"
import { Context } from "effect"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

if (!process.env.DEEPAGENT_TEST_MCP_OAUTH_SCOPE_CHILD) {
  test("real OAuth transport ownership runs in an isolated authority process", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dac-mcp-oauth-scope-"))
    await Promise.all(["home", "tmp", "config", "data", "cache", "state"].map((name) => mkdir(path.join(root, name))))
    const child = Bun.spawn({
      cmd: [process.execPath, "test", import.meta.path, "--timeout", "15000"],
      cwd: path.resolve(import.meta.dir, "../.."),
      env: {
        PATH: process.env.PATH,
        HOME: path.join(root, "home"),
        TMPDIR: path.join(root, "tmp"),
        XDG_CONFIG_HOME: path.join(root, "config"),
        XDG_DATA_HOME: path.join(root, "data"),
        XDG_CACHE_HOME: path.join(root, "cache"),
        XDG_STATE_HOME: path.join(root, "state"),
        DEEPAGENT_TEST_MCP_OAUTH_SCOPE_CHILD: "1",
        DEEPAGENT_CODE_SERVER_PASSWORD: "scope-fixture-secret",
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const deadline = setTimeout(() => child.kill(), 90_000)
    try {
      const [status, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      const output = stdout + stderr
      if (process.env.DEEPAGENT_TEST_MCP_OAUTH_SCOPE_EVIDENCE)
        await Bun.write(process.env.DEEPAGENT_TEST_MCP_OAUTH_SCOPE_EVIDENCE, output)
      expect({ status, output: status === 0 ? "ok" : output }).toEqual({ status: 0, output: "ok" })
      expect(output).toMatch(/\b0 fail\b/)
      console.info(output)
    } finally {
      clearTimeout(deadline)
      child.kill()
      await rm(root, { recursive: true, force: true })
    }
  }, 95_000)
}

if (process.env.DEEPAGENT_TEST_MCP_OAUTH_SCOPE_CHILD) {
  process.env.DEEPAGENT_CODE_SERVER_PASSWORD = "scope-fixture-secret"
  const { Effect, Exit, Layer, Fiber } = await import("effect")
  const { MCP } = await import("../../src/mcp/index")
  const { McpOAuthCallback } = await import("../../src/mcp/oauth-callback")
  const { InstanceRef } = await import("../../src/effect/instance-ref")
  const { InstanceRegistry } = await import("../../src/effect/instance-registry")
  const { testEffect } = await import("../lib/effect")
  const { tmpdirScoped, provideInstance } = await import("../fixture/fixture")
  const { CrossSpawnSpawner } = await import("@deepagent-code/core/cross-spawn-spawner")
  const { McpAuth } = await import("../../src/mcp/auth")
  const { Config } = await import("../../src/config/config")
  const { Global } = await import("@deepagent-code/core/global")
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/client")
  const it = testEffect(
    Layer.mergeAll(MCP.defaultLayer, CrossSpawnSpawner.defaultLayer, McpAuth.defaultLayer, Config.defaultLayer),
  )

  const fixture = Effect.gen(function* () {
    const tokenRequests: { endpoint: string; code: string | null }[] = []
    const control: {
      requireIss?: boolean
      failStart?: boolean
      failToken?: boolean
      blockToken?: ReturnType<typeof Promise.withResolvers<void>>
      blockRegistration?: ReturnType<typeof Promise.withResolvers<void>>
    } = {}
    const tokenReceived = Promise.withResolvers<void>()
    const registrationReceived = Promise.withResolvers<void>()
    const registrationRequests: string[] = []
    const closed: object[] = []
    const originalClose = StreamableHTTPClientTransport.prototype.close
    const close = spyOn(StreamableHTTPClientTransport.prototype, "close").mockImplementation(function (
      this: InstanceType<typeof StreamableHTTPClientTransport>,
    ) {
      closed.push(this)
      return originalClose.call(this)
    })
    const authRequests: string[] = []
    const callback = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
    const callbackPort = callback.port!
    yield* Effect.promise(() => callback.stop(true))
    const listener = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url)
        const endpoint = url.pathname.includes("/b") ? "b" : url.pathname.includes("/open") ? "open" : "a"
        const issuer = `${url.origin}/${endpoint}`
        if (url.pathname.includes("oauth-protected-resource"))
          return Response.json({ resource: `${issuer}/mcp`, authorization_servers: [issuer] })
        if (url.pathname.includes("oauth-authorization-server") || url.pathname.includes("openid-configuration"))
          return Response.json({
            issuer,
            ...(control.requireIss ? { authorization_response_iss_parameter_supported: true } : {}),
            authorization_endpoint: `${issuer}/authorize`,
            token_endpoint: `${issuer}/token`,
            registration_endpoint: `${issuer}/register`,
            response_types_supported: ["code"],
            code_challenge_methods_supported: ["S256"],
          })
        if (url.pathname.endsWith("/register")) {
          registrationRequests.push(url.pathname)
          registrationReceived.resolve()
          if (control.blockRegistration) await control.blockRegistration.promise
          return Response.json(
            {
              client_id: "dynamic-fixture-client",
              redirect_uris: [`http://127.0.0.1:${callbackPort}/mcp/oauth/callback`],
            },
            { status: 201 },
          )
        }
        if (url.pathname.endsWith("/token")) {
          tokenRequests.push({ endpoint, code: new URLSearchParams(await request.text()).get("code") })
          tokenReceived.resolve()
          if (control.blockToken) await control.blockToken.promise
          if (control.failToken) return Response.json({ error: "invalid_grant" }, { status: 400 })
          return Response.json({ access_token: `fixture-token-${endpoint}`, token_type: "Bearer", expires_in: 600 })
        }
        if (request.method === "GET") return new Response(null, { status: 405 })
        if (request.method === "DELETE") return new Response(null, { status: 204 })
        if (control.failStart) return new Response("fixture failure", { status: 500 })
        if (endpoint !== "open" && request.headers.get("authorization") !== `Bearer fixture-token-${endpoint}`) {
          authRequests.push(endpoint)
          return new Response("Unauthorized", {
            status: 401,
            headers: {
              "WWW-Authenticate": `Bearer resource_metadata="${url.origin}/.well-known/oauth-protected-resource/${endpoint}"`,
            },
          })
        }
        const body = (await request.json()) as { id?: number; method: string }
        if (body.id === undefined) return new Response(null, { status: 202 })
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          result:
            body.method === "initialize"
              ? { protocolVersion: "2025-11-25", capabilities: {}, serverInfo: { name: endpoint, version: "1" } }
              : {},
        })
      },
    })
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        control.blockToken?.resolve()
        control.blockRegistration?.resolve()
        await McpOAuthCallback.stop()
        await listener.stop(true)
        close.mockRestore()
      }),
    )
    return {
      tokenRequests,
      tokenReceived,
      registrationReceived,
      registrationRequests,
      authRequests,
      control,
      closed,
      config: (endpoint: string) => ({
        type: "remote" as const,
        url: new URL(`/${endpoint}/mcp`, listener.url).href,
        oauth: { clientId: "fixture-client", callbackPort },
        timeout: 1500,
      }),
    }
  })

  it.instance(
    "isolates same-name OAuth PKCE in two actual locations and rejects a foreign callback",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture
        const mcp = yield* MCP.Service
        const a = yield* InstanceRef
        const directory = yield* tmpdirScoped({ config: { mcp: {} } })
        const b = yield* InstanceRef.pipe(provideInstance(directory))
        yield* mcp.add("shared", f.config("a"))
        yield* mcp.add("shared", f.config("b")).pipe(Effect.provideService(InstanceRef, b))
        const first = yield* mcp.startAuth("shared")
        expect(first.authorizationUrl).toContain("/a/authorize")
        const second = yield* mcp.startAuth("shared").pipe(Effect.provideService(InstanceRef, b))
        expect(second.authorizationUrl).toContain("/b/authorize")
        expect(second.oauthState).not.toBe(first.oauthState)
        const foreign = yield* mcp
          .finishAuth("shared", "wrong-instance", first.oauthState)
          .pipe(Effect.provideService(InstanceRef, b), Effect.exit)
        expect(Exit.isFailure(foreign)).toBe(true)
        expect(f.tokenRequests).toEqual([])
        expect(a).not.toBe(b)
      }),
    { config: { mcp: {} } },
  )

  it.instance(
    "disposing an unrelated real InstanceRef does not clear another instance's pending transport",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture
        const mcp = yield* MCP.Service
        const a = yield* InstanceRef
        const directory = yield* tmpdirScoped({ config: { mcp: {} } })
        const b = yield* InstanceRef.pipe(provideInstance(directory))
        yield* mcp.add("shared", f.config("a"))
        const first = yield* mcp.startAuth("shared")
        expect((yield* mcp.finishAuth("shared", "code-a", first.oauthState)).status).toBe("connected")
        yield* mcp.add("shared", f.config("b")).pipe(Effect.provideService(InstanceRef, b))
        const pending = yield* mcp.startAuth("shared").pipe(Effect.provideService(InstanceRef, b))
        expect(pending.authorizationUrl).toContain("/b/authorize")
        if (!a) throw new Error("Missing fixture instance")
        yield* InstanceRegistry.disposeInstanceState(a)
        const status = yield* mcp
          .finishAuth("shared", "code-b", pending.oauthState)
          .pipe(Effect.provideService(InstanceRef, b))
        expect(status.status).toBe("connected")
        expect(f.tokenRequests).toEqual([
          { endpoint: "a", code: "code-a" },
          { endpoint: "b", code: "code-b" },
        ])
      }),
    { config: { mcp: {} } },
  )

  it.instance(
    "automatic auth failure closes its transport and requires an explicit fresh OAuth flow",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture
        const mcp = yield* MCP.Service
        yield* mcp.add("automatic", f.config("a"))
        expect((yield* mcp.status()).automatic?.status).toBe("needs_auth")
        expect(f.closed.length).toBeGreaterThan(0)
        const result = yield* mcp.finishAuth("automatic", "closed-transport", "missing-state").pipe(Effect.exit)
        expect(Exit.isFailure(result)).toBe(true)
        expect(f.tokenRequests).toEqual([])
        const pending = yield* mcp.startAuth("automatic")
        expect(pending.authorizationUrl).toContain("/a/authorize")
      }),
    { config: { mcp: {} } },
  )

  it.instance(
    "restarting, disconnecting and removing auth close only the owned pending transports",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture
        const mcp = yield* MCP.Service
        yield* mcp.add("replace", f.config("a"))
        const first = yield* mcp.startAuth("replace")
        const before = f.closed.length
        const second = yield* mcp.startAuth("replace")
        expect(second.oauthState).not.toBe(first.oauthState)
        expect(f.closed.length).toBeGreaterThan(before)
        yield* mcp.disconnect("replace")
        expect(Exit.isFailure(yield* mcp.finishAuth("replace", "revoked", second.oauthState).pipe(Effect.exit))).toBe(
          true,
        )
        const third = yield* mcp.startAuth("replace")
        const pending = f.closed.length
        yield* mcp.removeAuth("replace")
        expect(f.closed.length).toBeGreaterThan(pending)
        expect(Exit.isFailure(yield* mcp.finishAuth("replace", "removed", third.oauthState).pipe(Effect.exit))).toBe(
          true,
        )
        expect(f.tokenRequests).toEqual([])
      }),
    { config: { mcp: {} } },
  )

  it.instance(
    "a failed explicit start closes its actual SDK transport and releases the name lease",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture
        const mcp = yield* MCP.Service
        yield* mcp.add("failed-start", f.config("a"))
        f.control.failStart = true
        const before = f.closed.length
        expect(Exit.isFailure(yield* mcp.startAuth("failed-start").pipe(Effect.exit))).toBe(true)
        expect(f.closed.length).toBeGreaterThan(before)
        f.control.failStart = false
        expect((yield* mcp.startAuth("failed-start")).authorizationUrl).toContain("/a/authorize")
      }),
    { config: { mcp: {} } },
  )

  it.instance(
    "a late token exchange cannot store credentials or replace a newer connected transport",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture
        const mcp = yield* MCP.Service
        const auth = yield* McpAuth.Service
        yield* mcp.add("late", f.config("a"))
        const pending = yield* mcp.startAuth("late")
        f.control.blockToken = Promise.withResolvers<void>()
        const finishing = yield* mcp.finishAuth("late", "old-code", pending.oauthState).pipe(Effect.forkChild)
        yield* Effect.promise(() => f.tokenReceived.promise)
        yield* mcp.add("late", { ...f.config("open"), oauth: false })
        const client = (yield* mcp.clients()).late
        expect(client).toBeDefined()
        f.control.blockToken.resolve()
        expect((yield* Fiber.join(finishing)).status).toBe("failed")
        expect((yield* mcp.clients()).late).toBe(client)
        expect((yield* mcp.status()).late?.status).toBe("connected")
        expect((yield* auth.get("late"))?.tokens).toBeUndefined()
      }),
    { config: { mcp: {} } },
  )

  it.instance(
    "an OAuth token endpoint failure removes the pending transport rather than leaving a retryable closed flow",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture
        const mcp = yield* MCP.Service
        yield* mcp.add("token-failure", f.config("a"))
        const pending = yield* mcp.startAuth("token-failure")
        f.control.failToken = true
        const before = f.closed.length
        expect((yield* mcp.finishAuth("token-failure", "invalid-code", pending.oauthState)).status).toBe("failed")
        expect(f.closed.length).toBeGreaterThan(before)
        const exchanges = f.tokenRequests.length
        expect(exchanges).toBeGreaterThan(0)
        expect(
          Exit.isFailure(yield* mcp.finishAuth("token-failure", "again", pending.oauthState).pipe(Effect.exit)),
        ).toBe(true)
        expect(f.tokenRequests).toHaveLength(exchanges)
      }),
    { config: { mcp: {} } },
  )

  it.instance(
    "external configuration drift is rejected before token exchange even before reconciliation",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture
        const mcp = yield* MCP.Service
        const cfg = yield* Config.Service
        const context = yield* InstanceRef
        if (!context) throw new Error("Missing fixture instance")
        yield* Effect.promise(() =>
          Bun.write(
            path.join(context.directory, "deepagent-code.json"),
            JSON.stringify({ mcp: { drift: f.config("a") } }),
          ),
        )
        yield* cfg.invalidate()
        const pending = yield* mcp.startAuth("drift")
        yield* Effect.promise(() =>
          Bun.write(
            path.join(context.directory, "deepagent-code.json"),
            JSON.stringify({ mcp: { drift: f.config("b") } }),
          ),
        )
        yield* cfg.invalidate()
        expect(Exit.isFailure(yield* mcp.finishAuth("drift", "old-config", pending.oauthState).pipe(Effect.exit))).toBe(
          true,
        )
        expect(f.tokenRequests).toEqual([])
        expect((yield* mcp.startAuth("drift")).authorizationUrl).toContain("/b/authorize")
      }),
    { config: { mcp: {} } },
  )

  it.instance(
    "late dynamic client registration cannot write after the connection generation is revoked",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture
        const mcp = yield* MCP.Service
        const auth = yield* McpAuth.Service
        f.control.blockRegistration = Promise.withResolvers<void>()
        const config = f.config("a")
        yield* mcp.add("late-register", { ...config, oauth: { ...config.oauth, clientId: undefined } })
        expect(f.registrationRequests).toHaveLength(0)
        const connecting = yield* mcp.startAuth("late-register").pipe(Effect.exit, Effect.forkChild)
        yield* Effect.promise(() => f.registrationReceived.promise)
        yield* mcp.disconnect("late-register")
        const journal = path.join(Global.Path.config, "mcp-oauth", "journal.sqlite")
        const saved = yield* Effect.promise(() => Bun.file(journal).arrayBuffer())
        f.control.blockRegistration.resolve()
        yield* Fiber.join(connecting)
        expect((yield* auth.get("late-register"))?.clientInfo).toBeUndefined()
        expect((yield* mcp.status())["late-register"]).toMatchObject({
          status: "disconnected",
          authStatus: "unknown",
          reason: "unknown_outcome",
        })
        expect((yield* mcp.connect("late-register").pipe(Effect.exit))._tag).toBe("Failure")
        expect(f.registrationRequests).toHaveLength(1)
        expect(f.tokenRequests).toEqual([])
        expect(yield* Effect.promise(() => Bun.file(journal).arrayBuffer())).toEqual(saved)
        expect((yield* mcp.clients())["late-register"]).toBeUndefined()
      }),
    { config: { mcp: {} } },
  )

  it.instance(
    "an expired pending flow closes without token exchange and permits a fresh flow",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture
        const mcp = yield* MCP.Service
        yield* mcp.add("expired", f.config("a"))
        const pending = yield* mcp.startAuth("expired")
        const { PrivateSqlite } = yield* Effect.promise(() => import("@deepagent-code/core/database/private-sqlite"))
        const database = new PrivateSqlite.Database(path.join(Global.Path.config, "mcp-oauth", "journal.sqlite"), {
          readwrite: true,
          create: false,
        })
        const now = Date.now()
        database
          .query(
            "UPDATE mcp_auth_slot SET flow=json_set(flow,'$.createdAt',?,'$.expiresAt',?) WHERE json_extract(flow,'$.state')=?",
          )
          .run(now - 300001, now - 1, pending.oauthState)
        database.close()
        const result = yield* mcp.finishAuth("expired", "too-late", pending.oauthState).pipe(Effect.exit)
        expect(Exit.isFailure(result)).toBe(true)
        expect(f.tokenRequests).toEqual([])
        expect((yield* mcp.startAuth("expired")).authorizationUrl).toContain("/a/authorize")
      }),
    { config: { mcp: {} } },
  )

  it.instance(
    "independent callback paths share an owned listener without reconfiguring another flow",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture
        const mcp = yield* MCP.Service
        yield* mcp.add("callback-first", f.config("a"))
        yield* mcp.add("callback-other", {
          ...f.config("b"),
          oauth: {
            ...f.config("b").oauth,
            redirectUri: `http://127.0.0.1:${f.config("b").oauth.callbackPort}/different`,
          },
        })
        const pending = yield* mcp.startAuth("callback-first")
        const other = yield* mcp.startAuth("callback-other")
        expect(other.authorizationUrl).toContain("/b/authorize")
        expect((yield* mcp.finishAuth("callback-first", "first-code", pending.oauthState)).status).toBe("connected")
        expect((yield* mcp.finishAuth("callback-other", "second-code", other.oauthState)).status).toBe("connected")
        expect(f.tokenRequests).toEqual([
          { endpoint: "a", code: "first-code" },
          { endpoint: "b", code: "second-code" },
        ])
      }),
    { config: { mcp: {} } },
  )

  it.instance(
    "a replaced pending generation survives an older finish returning late for the same config",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture
        const mcp = yield* MCP.Service
        yield* mcp.add("same-config", f.config("a"))
        const old = yield* mcp.startAuth("same-config")
        f.control.blockToken = Promise.withResolvers<void>()
        const finishing = yield* mcp.finishAuth("same-config", "old-code", old.oauthState).pipe(Effect.forkChild)
        yield* Effect.promise(() => f.tokenReceived.promise)
        expect((yield* mcp.startAuth("same-config").pipe(Effect.exit))._tag).toBe("Failure")
        yield* mcp.removeAuth("same-config")
        const replacement = yield* mcp.startAuth("same-config")
        expect(replacement.oauthState).not.toBe(old.oauthState)
        f.control.blockToken.resolve()
        expect((yield* Fiber.join(finishing)).status).toBe("failed")
        expect((yield* mcp.finishAuth("same-config", "new-code", replacement.oauthState)).status).toBe("connected")
        expect(f.tokenRequests.map((item) => item.code)).toEqual(["old-code", "new-code"])
      }),
    { config: { mcp: {} } },
  )

  for (const next of ["disabled", "removed"] as const) {
    it.instance(
      `configuration ${next} closes its pending flow before another finish`,
      () =>
        Effect.gen(function* () {
          const f = yield* fixture
          const mcp = yield* MCP.Service
          const cfg = yield* Config.Service
          const context = yield* InstanceRef
          if (!context) throw new Error("Missing fixture instance")
          const config = f.config("a")
          yield* Effect.promise(() =>
            Bun.write(
              path.join(context.directory, "deepagent-code.json"),
              JSON.stringify({ mcp: { retiring: config } }),
            ),
          )
          yield* cfg.invalidate()
          const pending = yield* mcp.startAuth("retiring")
          const before = f.closed.length
          yield* Effect.promise(() =>
            Bun.write(
              path.join(context.directory, "deepagent-code.json"),
              JSON.stringify({ mcp: next === "removed" ? {} : { retiring: { ...config, enabled: false } } }),
            ),
          )
          yield* cfg.invalidate()
          if (!mcp.reconcileConfig) throw new Error("Missing config reconciler")
          yield* mcp.reconcileConfig()
          expect(f.closed.length).toBeGreaterThan(before)
          expect(
            Exit.isFailure(yield* mcp.finishAuth("retiring", "retired", pending.oauthState).pipe(Effect.exit)),
          ).toBe(true)
          expect(f.tokenRequests).toEqual([])
        }),
      { config: { mcp: {} } },
    )
  }

  it.instance(
    "manual callbacks require the exact current state and rejected old state does not consume the new flow",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture
        const mcp = yield* MCP.Service
        yield* mcp.add("manual-state", f.config("a"))
        const old = yield* mcp.startAuth("manual-state")
        const current = yield* mcp.startAuth("manual-state")
        for (const state of ["", "wrong-state", old.oauthState]) {
          const result = yield* mcp.finishAuth("manual-state", "stale-code", state).pipe(Effect.exit)
          expect(Exit.isFailure(result)).toBe(true)
        }
        expect(f.tokenRequests).toEqual([])
        expect((yield* mcp.finishAuth("manual-state", "current-code", current.oauthState)).status).toBe("connected")
        expect(f.tokenRequests).toEqual([{ endpoint: "a", code: "current-code" }])
      }),
    { config: { mcp: {} } },
  )

  it.instance(
    "actual HttpApi rejects code-only and stale callbacks before exchange without consuming the current flow",
    () =>
      Effect.gen(function* () {
        const { HttpApiApp } = yield* Effect.promise(() => import("../../src/server/routes/instance/httpapi/server"))
        const f = yield* fixture
        const instance = yield* InstanceRef
        if (!instance) throw new Error("Missing fixture instance")
        const handler = HttpApiApp.webHandler()
        yield* Effect.addFinalizer(() => Effect.promise(() => handler.dispose()))
        const request = (route: string, body?: object) =>
          Effect.promise(() =>
            handler.handler(
              new Request(`http://localhost${route}`, {
                method: "POST",
                headers: {
                  "content-type": "application/json",
                  "x-deepagent-code-directory": instance.directory,
                  authorization: `Basic ${Buffer.from("deepagent-code:scope-fixture-secret").toString("base64")}`,
                },
                ...(body ? { body: JSON.stringify(body) } : {}),
              }),
              Context.empty() as Context.Context<unknown>,
            ),
          )
        expect((yield* request("/mcp", { name: "http-state", config: f.config("a") })).status).toBe(200)
        const first = yield* request("/mcp/http-state/auth")
        expect(first.status).toBe(200)
        const old = (yield* Effect.promise(() => first.json())) as { oauthState: string }
        const second = yield* request("/mcp/http-state/auth")
        expect(second.status).toBe(200)
        const current = (yield* Effect.promise(() => second.json())) as { oauthState: string }
        for (const body of [{ code: "code" }, { code: "code", oauthState: "" }])
          expect((yield* request("/mcp/http-state/auth/callback", body)).status).toBe(400)
        for (const state of [old.oauthState, "wrong-state"]) {
          const response = yield* request("/mcp/http-state/auth/callback", { code: "stale", oauthState: state })
          expect(response.status).toBe(409)
          expect(yield* Effect.promise(() => response.json())).toEqual({
            error: "OAuth callback does not match the current pending flow; restart authentication",
          })
        }
        expect(f.tokenRequests).toEqual([])
        const accepted = yield* request("/mcp/http-state/auth/callback", {
          code: "current-code",
          oauthState: current.oauthState,
        })
        expect(accepted.status).toBe(200)
        expect(yield* Effect.promise(() => accepted.json())).toMatchObject({ status: "connected" })
        expect(f.tokenRequests).toEqual([{ endpoint: "a", code: "current-code" }])
      }),
    { config: { mcp: {} } },
  )

  it.instance(
    "required issuer rejection preserves the genuine SDK transport and never exchanges a token",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture
        f.control.requireIss = true
        const mcp = yield* MCP.Service
        const auth = yield* McpAuth.Service
        yield* mcp.add("issuer-response", f.config("a"))
        const pending = yield* mcp.startAuth("issuer-response")
        const issuer = new URL(f.config("a").url).origin + "/a"
        for (const iss of [undefined, "https://wrong.invalid", issuer + "/"]) {
          const rejected = yield* mcp.finishAuth("issuer-response", "wrong", pending.oauthState, iss).pipe(Effect.exit)
          expect(Exit.isFailure(rejected)).toBe(true)
          expect(f.tokenRequests).toEqual([])
          expect(yield* auth.get("issuer-response")).toBeUndefined()
        }
        expect((yield* mcp.finishAuth("issuer-response", "real-code", pending.oauthState, issuer)).status).toBe(
          "connected",
        )
        expect(f.tokenRequests).toEqual([{ endpoint: "a", code: "real-code" }])
        const entry = yield* auth.get("issuer-response")
        expect(entry).toBeUndefined()
        expect(yield* mcp.getAuthStatus("issuer-response")).toBe("authenticated")
      }),
    { config: { mcp: {} } },
  )

  it.instance(
    "actual HttpApi carries iss and rejects a wrong issuer before consuming the current flow",
    () =>
      Effect.gen(function* () {
        const { HttpApiApp } = yield* Effect.promise(() => import("../../src/server/routes/instance/httpapi/server"))
        const f = yield* fixture
        f.control.requireIss = true
        const instance = yield* InstanceRef
        if (!instance) throw new Error("Missing fixture instance")
        const handler = HttpApiApp.webHandler()
        yield* Effect.addFinalizer(() => Effect.promise(() => handler.dispose()))
        const request = (route: string, body?: object) =>
          Effect.promise(() =>
            handler.handler(
              new Request(`http://localhost${route}`, {
                method: "POST",
                headers: {
                  "content-type": "application/json",
                  "x-deepagent-code-directory": instance.directory,
                  authorization: `Basic ${Buffer.from("deepagent-code:scope-fixture-secret").toString("base64")}`,
                },
                ...(body ? { body: JSON.stringify(body) } : {}),
              }),
              Context.empty() as Context.Context<unknown>,
            ),
          )
        expect((yield* request("/mcp", { name: "http-issuer", config: f.config("a") })).status).toBe(200)
        const start = yield* request("/mcp/http-issuer/auth")
        const pending = (yield* Effect.promise(() => start.json())) as { oauthState: string }
        for (const iss of [undefined, "https://wrong.invalid"]) {
          expect(
            (yield* request("/mcp/http-issuer/auth/callback", { code: "wrong", oauthState: pending.oauthState, iss }))
              .status,
          ).toBe(409)
          expect(f.tokenRequests).toEqual([])
        }
        const issuer = new URL(f.config("a").url).origin + "/a"
        const response = yield* request("/mcp/http-issuer/auth/callback", {
          code: "real",
          oauthState: pending.oauthState,
          iss: issuer,
        })
        expect(response.status).toBe(200)
        expect(yield* Effect.promise(() => response.json())).toMatchObject({ status: "connected" })
        expect(f.tokenRequests).toEqual([{ endpoint: "a", code: "real" }])
      }),
    { config: { mcp: {} } },
  )

  it.instance(
    "an unrelated legacy-file generation cannot replace the actual scoped token authority",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture
        const mcp = yield* MCP.Service
        const auth = yield* McpAuth.Service
        yield* mcp.add("persistent-successor", f.config("a"))
        const pending = yield* mcp.startAuth("persistent-successor")
        f.control.blockToken = Promise.withResolvers<void>()
        const finishing = yield* mcp
          .finishAuth("persistent-successor", "late-code", pending.oauthState)
          .pipe(Effect.forkChild)
        yield* Effect.promise(() => f.tokenReceived.promise)
        yield* auth.startFlow("persistent-successor", "synthetic-other-process-generation", f.config("a").url)
        const before = yield* auth.get("persistent-successor")
        f.control.blockToken.resolve()
        const result = yield* Fiber.join(finishing).pipe(Effect.exit)
        expect(Exit.isSuccess(result) && result.value.status === "connected").toBe(true)
        expect(yield* auth.get("persistent-successor")).toEqual(before)
        expect((yield* auth.get("persistent-successor"))?.tokens).toBeUndefined()
        expect(f.tokenRequests).toEqual([{ endpoint: "a", code: "late-code" }])
      }),
    { config: { mcp: {} } },
  )
}
