import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Cause, Effect, Exit, Layer } from "effect"
import { SecretStore } from "@/mcp/secret-store"
import { tmpdir, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

describe("MCP fallback destructive-read guard", () => {
  test.each([
    ["broken JSON", Buffer.from('{"retained":"fixture-original",')],
    ["invalid UTF-8", Buffer.concat([Buffer.from('{"retained":"'), Buffer.from([0xff]), Buffer.from('"}')])],
    ["array", Buffer.from('["fixture-original"]')],
    ["null", Buffer.from("null")],
    ["non-string value", Buffer.from('{"retained":"fixture-original","invalid":1}')],
  ] as const)("%s rejects put/remove without replacing the original file", async (_, bytes) => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "mcp-secrets.json")
    fs.writeFileSync(file, bytes, { mode: 0o600 })
    const before = fs.statSync(file)
    const backend = SecretStore.fileBackend(file)

    await expect(backend.put("new", "fixture-new")).rejects.toMatchObject({
      _tag: "McpSecretFileError",
      reason: "invalid",
    })
    await expect(backend.remove("retained")).rejects.toMatchObject({
      _tag: "McpSecretFileError",
      reason: "invalid",
    })
    expect(fs.readFileSync(file)).toEqual(bytes)
    expect(fs.statSync(file).ino).toBe(before.ino)
    expect(fs.statSync(file).mtimeMs).toBe(before.mtimeMs)
  })

  test("an IO error is not an empty store or a missing credential", async () => {
    await using tmp = await tmpdir()
    const parent = path.join(tmp.path, "not-a-directory")
    fs.writeFileSync(parent, "fixture-parent", { mode: 0o600 })
    const backend = SecretStore.fileBackend(path.join(parent, "mcp-secrets.json"))

    await expect(backend.get("retained")).rejects.toMatchObject({ _tag: "McpSecretFileError", reason: "io" })
    await expect(backend.put("new", "fixture-new")).rejects.toMatchObject({ _tag: "McpSecretFileError", reason: "io" })
    await expect(backend.remove("retained")).rejects.toMatchObject({ _tag: "McpSecretFileError", reason: "io" })
    expect(fs.readFileSync(parent, "utf8")).toBe("fixture-parent")
    expect(fs.readdirSync(tmp.path)).toEqual(["not-a-directory"])
  })

  test("service resolution and removal preserve safe file defects instead of returning success", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "mcp-secrets.json")
    const bytes = Buffer.from('{"retained":"fixture-original",')
    fs.writeFileSync(file, bytes, { mode: 0o600 })
    const store = SecretStore.make(SecretStore.fileBackend(file))
    const resolved = await Effect.runPromiseExit(
      SecretStore.resolveRecord({ AUTH: "secret://retained" }, store).pipe(Effect.asVoid),
    )
    const removed = await Effect.runPromiseExit(store.remove("secret://retained"))

    for (const exit of [resolved, removed]) {
      expect(Exit.isFailure(exit)).toBe(true)
      if (!Exit.isFailure(exit)) continue
      const error = Cause.squash(exit.cause)
      expect(error).toMatchObject({ _tag: "McpSecretFileError", reason: "invalid" })
      expect(error).toBeInstanceOf(Error)
      expect(String(error)).toBe("McpSecretFileError: MCP secret file invalid")
      expect(String(error)).not.toContain(file)
      expect(String(error)).not.toContain("fixture-original")
    }
    expect(fs.readFileSync(file)).toEqual(bytes)
  })

  test("valid updates and removals preserve other accounts and ignore prototype properties", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "mcp-secrets.json")
    const store = SecretStore.make(SecretStore.fileBackend(file))
    await Effect.runPromise(store.put("retained", "fixture-original"))
    await Effect.runPromise(store.put("updated", "fixture-before"))
    await Effect.runPromise(store.put("updated", "fixture-after"))
    expect(await Effect.runPromise(store.resolve("retained"))).toBe("fixture-original")
    expect(await Effect.runPromise(store.resolve("updated"))).toBe("fixture-after")
    expect(await Effect.runPromise(store.resolve("toString"))).toBeUndefined()
    await Effect.runPromise(store.put("__proto__", "fixture-account"))
    expect(await Effect.runPromise(store.resolve("__proto__"))).toBe("fixture-account")
    await Effect.runPromise(store.remove("updated"))
    expect(await Effect.runPromise(store.resolve("updated"))).toBeUndefined()
    expect(await Effect.runPromise(store.resolve("retained"))).toBe("fixture-original")
    expect(await Effect.runPromise(store.resolve("__proto__"))).toBe("fixture-account")
  })

  test("only a missing file is empty and removing a missing account does not write", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "mcp-secrets.json")
    const store = SecretStore.make(SecretStore.fileBackend(file))
    expect(await Effect.runPromise(store.resolve("secret://missing"))).toBeUndefined()
    await Effect.runPromise(store.remove("secret://missing"))
    expect(fs.existsSync(file)).toBe(false)
    // Serialization can retain its empty lock parent; no secret or held lock is published.
    expect(fs.readdirSync(tmp.path)).toEqual([".dac-config-locks"])
    expect(fs.readdirSync(path.join(tmp.path, ".dac-config-locks"))).toEqual([])

    await Effect.runPromise(store.put("retained", "fixture-original"))
    const before = fs.statSync(file)
    const bytes = fs.readFileSync(file)
    await Effect.runPromise(store.remove("missing"))
    expect(fs.readFileSync(file)).toEqual(bytes)
    expect(fs.statSync(file).mtimeMs).toBe(before.mtimeMs)
  })
})

if (!process.env.DAC_MCP_SECRET_CALLER_CHILD) {
  test("actual MCP callers run with canonical private installation paths", async () => {
    const child = Bun.spawn({
      cmd: [process.execPath, "test", import.meta.path, "--test-name-pattern", "bad fallback blocks|actual auth-scope"],
      cwd: path.resolve(import.meta.dir, "../.."),
      env: {
        PATH: process.env.PATH,
        TMPDIR: fs.realpathSync(os.tmpdir()),
        DAC_MCP_SECRET_CALLER_CHILD: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const deadline = setTimeout(() => child.kill(), 20_000)
    try {
      const [status, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      console.info(stdout + stderr)
      expect({ status, output: status === 0 ? "ok" : stdout + stderr }).toEqual({ status: 0, output: "ok" })
      expect(stdout + stderr).toMatch(/\b2 pass\b/)
      expect(stdout + stderr).toMatch(/\b0 fail\b/)
    } finally {
      clearTimeout(deadline)
      child.kill()
    }
  }, 25_000)
}

if (process.env.DAC_MCP_SECRET_CALLER_CHILD) {
  const { MCP } = await import("@/mcp")
  const { Config } = await import("@/config/config")
  const { EventV2Bridge } = await import("@/event-v2-bridge")
  const { CrossSpawnSpawner } = await import("@deepagent-code/core/cross-spawn-spawner")
  const { FSUtil } = await import("@deepagent-code/core/fs-util")
  const { Global } = await import("@deepagent-code/core/global")
  const { McpAuthScope } = await import("@/mcp/auth-scope")
  const { McpAuth } = await import("@/mcp/auth")
  const { AccountRepo } = await import("@/account/repo")
  const { Account } = await import("@/account/account")
  const { LocationIdentity } = await import("@deepagent-code/core/context-federation/identity")
  const { Server, createMcpHandler } = await import("@modelcontextprotocol/server")

  // The package preload isolates Global.Path.config. Injecting this backend avoids OS keychains.
  const callerFile = path.join(Global.Path.config, "destructive-read-fixture.json")
  const secretLayer = SecretStore.testLayer(SecretStore.fileBackend(callerFile))
  const configuration = Config.defaultLayer
  const scopedAuth = McpAuthScope.layer.pipe(
    Layer.provide(secretLayer),
    Layer.provide(configuration),
    Layer.provide(AccountRepo.defaultLayer),
    Layer.provide(Account.defaultLayer),
    Layer.provide(LocationIdentity.defaultLayer),
    Layer.provide(McpAuth.defaultLayer),
  )
  const mcpLayer = MCP.layer.pipe(
    Layer.provide(secretLayer),
    Layer.provide(scopedAuth),
    Layer.provide(configuration),
    Layer.provide(EventV2Bridge.defaultLayer),
    Layer.provide(CrossSpawnSpawner.defaultLayer),
    Layer.provide(FSUtil.defaultLayer),
  )
  const callers = testEffect(Layer.mergeAll(mcpLayer, scopedAuth, CrossSpawnSpawner.defaultLayer))

  callers.instance(
    "bad fallback blocks actual HTTP and stdio while a healthy startup sibling remains connected",
    () =>
      Effect.gen(function* () {
        const instance = yield* TestInstance
        const marker = path.join(instance.directory, "bad-stdio-spawned")
        const requests: string[] = []
        const handler = createMcpHandler(
          () => new Server({ name: "healthy-fallback-probe", version: "1" }, { capabilities: {} }),
          { legacy: "reject", keepAliveMs: 0 },
        )
        const listener = Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          fetch(request) {
            requests.push(new URL(request.url).pathname)
            return handler.fetch(request)
          },
        })
        yield* Effect.addFinalizer(() =>
          Effect.promise(async () => {
            await handler.close()
            await listener.stop(true)
          }),
        )
        const bytes = Buffer.from('{"retained":"fixture-original",')
        fs.mkdirSync(path.dirname(callerFile), { recursive: true })
        fs.writeFileSync(callerFile, bytes, { mode: 0o600 })
        yield* Effect.addFinalizer(() => Effect.sync(() => fs.rmSync(callerFile, { force: true })))
        fs.writeFileSync(
          path.join(instance.directory, "deepagent-code.json"),
          JSON.stringify({
            mcp: {
              bad_http: {
                type: "remote",
                url: new URL("/bad", listener.url).href,
                oauth: false,
                protocol: "2026-07-28",
                headers: { "x-fixture": "secret://retained" },
                timeout: 500,
              },
              bad_stdio: {
                type: "local",
                command: [process.execPath, "-e", `await Bun.write(${JSON.stringify(marker)}, "spawned")`],
                environment: { FIXTURE_SECRET: "secret://retained" },
                timeout: 500,
              },
              healthy: {
                type: "remote",
                url: new URL("/healthy", listener.url).href,
                oauth: false,
                protocol: "2026-07-28",
                timeout: 1000,
              },
            },
          }),
        )
        const mcp = yield* MCP.Service
        expect(yield* mcp.tools()).toEqual({})
        expect((yield* mcp.status()).bad_http).toEqual({ status: "failed", error: "MCP secret file invalid" })
        expect((yield* mcp.status()).bad_stdio).toEqual({ status: "failed", error: "MCP secret file invalid" })
        expect((yield* mcp.status()).healthy).toMatchObject({ status: "connected" })
        expect(Object.keys(yield* mcp.clients())).toEqual(["healthy"])
        const beforeReconnect = requests.length
        yield* mcp.connect("bad_http")
        yield* mcp.connect("bad_stdio")
        expect((yield* mcp.status()).bad_http).toEqual({ status: "failed", error: "MCP secret file invalid" })
        expect((yield* mcp.status()).bad_stdio).toEqual({ status: "failed", error: "MCP secret file invalid" })
        expect(requests.length).toBe(beforeReconnect)
        expect(requests.length).toBeGreaterThan(0)
        expect(requests.every((value) => value === "/healthy")).toBe(true)
        expect(fs.existsSync(marker)).toBe(false)
        expect(fs.readFileSync(callerFile)).toEqual(bytes)
      }),
    { config: { mcp: {} } },
  )

  callers.instance(
    "actual auth-scope returns typed unavailable before OAuth requests without changing the corrupt file",
    () =>
      Effect.gen(function* () {
        const instance = yield* TestInstance
        const requests: string[] = []
        const listener = Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          fetch(request) {
            requests.push(new URL(request.url).pathname)
            return new Response(null, { status: 500 })
          },
        })
        yield* Effect.addFinalizer(() => Effect.promise(() => listener.stop(true)))
        const bytes = Buffer.from('{"retained":"fixture-original",')
        fs.mkdirSync(path.dirname(callerFile), { recursive: true })
        fs.writeFileSync(callerFile, '{"retained":"fixture-original"}', { mode: 0o600 })
        yield* Effect.addFinalizer(() => Effect.sync(() => fs.rmSync(callerFile, { force: true })))
        const config = {
          type: "remote" as const,
          url: new URL("/oauth", listener.url).href,
          oauth: { clientId: "fixture-client" },
          headers: { "x-fixture": "secret://retained" },
        }
        fs.writeFileSync(
          path.join(instance.directory, "deepagent-code.json"),
          JSON.stringify({ mcp: { bad_oauth: config } }),
        )
        const scope = yield* McpAuthScope.Service
        yield* scope.configure("bad_oauth", config)
        const valid = yield* scope.begin("bad_oauth", config, true)
        yield* Effect.promise(async () => {
          await valid.revoke()
          valid.close()
        })
        fs.writeFileSync(callerFile, bytes, { mode: 0o600 })
        const result = yield* scope.begin("bad_oauth", config, true).pipe(Effect.exit)
        if (Exit.isSuccess(result)) {
          yield* Effect.promise(async () => {
            await result.value.revoke()
            result.value.close()
          })
        }
        expect(Exit.isFailure(result)).toBe(true)
        if (Exit.isFailure(result))
          expect(Cause.squash(result.cause)).toMatchObject({ _tag: "McpAuthJournalError", reason: "unavailable" })
        const mcp = yield* MCP.Service
        const authorized = yield* mcp.startAuth("bad_oauth").pipe(Effect.exit)
        expect(Exit.isFailure(authorized)).toBe(true)
        if (Exit.isFailure(authorized))
          expect(Cause.squash(authorized.cause)).toMatchObject({
            _tag: "MCP.OAuthFlowError",
            message: "MCP authentication journal unavailable",
          })
        expect(yield* mcp.tools()).toEqual({})
        expect((yield* mcp.status()).bad_oauth).toEqual({
          status: "failed",
          error: "MCP authentication storage or scope is unavailable",
        })
        expect(requests).toEqual([])
        expect(fs.readFileSync(callerFile)).toEqual(bytes)
      }),
    { config: { mcp: {} } },
  )
}
