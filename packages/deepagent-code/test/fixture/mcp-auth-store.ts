import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { Context, Effect, Exit, Layer } from "effect"
import { Global } from "@deepagent-code/core/global"
import { McpAuth } from "../../src/mcp/auth"
import { NativeAuthStorage } from "./mcp-native-auth-storage"
import { McpWindowsStorage } from "../../src/mcp/windows-storage"

const root = process.env.DAC_MCP_AUTH_STORE_ROOT!
assert(root)
const file = path.join(Global.Path.config, "mcp-auth.json")
const mode = process.argv[2]!

async function run(storage?: Layer.Layer<NativeAuthStorage.Services>, nativePort?: McpWindowsStorage.Port) {
  const barrier = async () => {
    await Bun.write(path.join(root, "ready.json"), JSON.stringify({ pid: process.pid, mode }))
    await new Promise<void>(() => {})
  }

  if (!nativePort && (mode === "before_rename" || mode === "after_rename")) {
    const rename = fs.rename
    fs.rename = async (from, to) => {
      if (String(to) !== file) return rename(from, to)
      if (mode === "before_rename") await barrier()
      await rename(from, to)
      if (mode === "after_rename") await barrier()
    }
  }
  if (!nativePort && mode === "after_sync") {
    const open = fs.open
    fs.open = async (...args) => {
      const handle = await open(...args)
      if (String(args[0]) !== path.dirname(file)) return handle
      const sync = handle.sync.bind(handle)
      handle.sync = async () => {
        await sync()
        await barrier()
      }
      return handle
    }
  }

  const port: McpWindowsStorage.Port | undefined =
    nativePort && ["before_rename", "after_rename", "after_sync"].includes(mode)
      ? {
          ...nativePort,
          publish: async (purpose, text, expected) => {
            if (mode === "before_rename") await barrier()
            const result = await nativePort.publish(purpose, text, expected)
            if (mode === "after_rename" || mode === "after_sync") await barrier()
            return result
          },
        }
      : nativePort
  const authLayer = port
    ? McpAuth.defaultLayer.pipe(Layer.provide(Layer.succeed(McpWindowsStorage.Current, port)))
    : storage
      ? McpAuth.defaultLayer.pipe(Layer.provideMerge(storage))
      : McpAuth.defaultLayer
  const writeFixture = async (text: string, missing = false) => {
    if (nativePort) {
      const current = missing ? undefined : await nativePort.read("mcp_legacy_auth")
      await nativePort.publish("mcp_legacy_auth", text, current?.witness ?? null)
      return
    }
    await fs.writeFile(file, text, { mode: 0o600 })
  }
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const first = Context.get(yield* Layer.build(authLayer), McpAuth.Service)
        const second = Context.get(yield* Layer.build(authLayer), McpAuth.Service)
        if (mode === "expiry") {
          const { McpOAuthProvider } = yield* Effect.promise(() => import("../../src/mcp/oauth-provider"))
          const url = "https://example.invalid/mcp"
          const provider = new McpOAuthProvider("fixture", url, {}, { onRedirect: () => {} }, first)
          yield* first.set(
            "fixture",
            { tokens: { accessToken: "synthetic-expired", expiresAt: 0, issuer: "https://example.invalid" } },
            url,
          )
          const epochExpired = yield* first.isTokenExpired("fixture")
          const epochRemaining = (yield* Effect.promise(() => provider.tokens()))?.expires_in
          const before = Date.now() / 1000
          yield* Effect.promise(() =>
            provider.saveTokens({
              access_token: "synthetic-zero-lifetime",
              token_type: "Bearer",
              expires_in: 0,
              issuer: "https://example.invalid",
            }),
          )
          const deadline = (yield* first.get("fixture"))?.tokens?.expiresAt
          const immediateRemaining = (yield* Effect.promise(() => provider.tokens()))?.expires_in
          yield* Effect.promise(() =>
            Bun.write(
              path.join(root, "expiry.json"),
              JSON.stringify({
                epochExpired,
                epochRemaining: epochRemaining ?? null,
                deadlinePresent: deadline !== undefined,
                deadlineInSaveWindow: deadline !== undefined && deadline >= before && deadline <= Date.now() / 1000,
                immediateRemaining: immediateRemaining ?? null,
              }),
            ),
          )
          assert.equal(epochExpired, true, "an explicit epoch expiry must remain expired")
          assert.equal(epochRemaining, 0, "an expired token must expose zero remaining lifetime")
          assert(
            deadline !== undefined && deadline >= before && deadline <= Date.now() / 1000,
            "zero lifetime must persist a real immediate expiry",
          )
          assert.equal(immediateRemaining, 0)
          yield* Effect.promise(() =>
            provider.saveTokens({
              access_token: "synthetic-unspecified-lifetime",
              token_type: "Bearer",
              issuer: "https://example.invalid",
            }),
          )
          assert.equal((yield* first.get("fixture"))?.tokens?.expiresAt, undefined)
          assert.equal((yield* Effect.promise(() => provider.tokens()))?.expires_in, undefined)
          return
        }
        if (mode === "issuer" || mode === "issuer_cold") {
          yield* Effect.promise(async () => {
            const { McpOAuthProvider } = await import("../../src/mcp/oauth-provider")
            const url = "https://example.invalid/mcp"
            const issuer = "https://example.invalid"
            const discovery = {
              authorizationServerUrl: issuer,
              authorizationServerMetadata: {
                issuer,
                authorization_endpoint: `${issuer}/authorize`,
                token_endpoint: `${issuer}/token`,
                response_types_supported: ["code"],
                authorization_response_iss_parameter_supported: true,
              },
            }
            const provider = (generation: string) =>
              new McpOAuthProvider(
                "issuer",
                url,
                {},
                { onRedirect: () => {}, authorizationGeneration: generation },
                first,
              )
            if (mode === "issuer_cold") {
              const p = provider("generation-new")
              assert.deepEqual(await p.discoveryState(), discovery)
              await assert.rejects(() => p.validateCallback("https://other.invalid"))
              await assert.rejects(() => p.validateCallback())
              await p.validateCallback(issuer)
              assert.equal((await p.tokens({ issuer }))?.issuer, issuer)
              assert.equal((await p.clientInformation({ issuer }))?.issuer, issuer)
              assert.equal(await p.tokens({ issuer: "https://other.invalid" }), undefined)
              assert.equal(await p.clientInformation({ issuer: "https://other.invalid" }), undefined)
              await Bun.write(
                path.join(root, "issuer-cold.json"),
                JSON.stringify({ coldDiscovery: true, issuerBound: true, wrongIssuerRejected: true }),
              )
              return
            }
            await Effect.runPromise(
              first.set(
                "legacy",
                { tokens: { accessToken: "synthetic-legacy" }, clientInfo: { clientId: "synthetic-legacy" } },
                url,
              ),
            )
            const legacy = new McpOAuthProvider("legacy", url, {}, { onRedirect: () => {} }, first)
            const legacyBytes = await fs.readFile(file)
            assert.equal(await legacy.tokens({ issuer }), undefined)
            assert.equal(await legacy.clientInformation({ issuer }), undefined)
            assert.deepEqual(await fs.readFile(file), legacyBytes)
            await Effect.runPromise(first.startFlow("issuer", "generation-old", url))
            const old = provider("generation-old")
            await old.saveDiscoveryState(discovery)
            await old.saveCodeVerifier("synthetic-verifier")
            await old.saveTokens({ access_token: "synthetic-old", token_type: "Bearer", issuer })
            await old.saveClientInformation({ client_id: "synthetic-client", issuer, redirect_uris: [old.redirectUrl] })
            await Effect.runPromise(first.startFlow("issuer", "generation-new", url))
            const current = provider("generation-new")
            assert.equal(await current.discoveryState(), undefined)
            assert.equal((await Effect.runPromise(first.get("issuer")))?.codeVerifier, undefined)
            await current.saveDiscoveryState(discovery)
            const beforeRedirect = await fs.readFile(file)
            await assert.rejects(() =>
              current.redirectToAuthorization(
                new URL(
                  `${issuer}/authorize?state=generation-new&redirect_uri=${encodeURIComponent("http://127.0.0.1:1/wrong")}`,
                ),
              ),
            )
            assert.deepEqual(await fs.readFile(file), beforeRedirect)
            await current.redirectToAuthorization(
              new URL(
                `${issuer}/authorize?state=generation-new&redirect_uri=${encodeURIComponent(current.redirectUrl)}`,
              ),
            )
            await current.saveTokens({ access_token: "synthetic-new", token_type: "Bearer", issuer })
            const bytes = await fs.readFile(file)
            await assert.rejects(() => old.saveTokens({ access_token: "synthetic-late", token_type: "Bearer", issuer }))
            const stale = await Effect.runPromise(
              first
                .updateTokens("issuer", { accessToken: "synthetic-late", issuer }, url, "generation-old")
                .pipe(Effect.exit),
            )
            assert(Exit.isFailure(stale))
            await Effect.runPromise(first.clearFlow("issuer", "generation-old"))
            assert.deepEqual(await fs.readFile(file), bytes)
            await assert.rejects(() =>
              current.saveDiscoveryState({ ...discovery, authorizationServerUrl: "https://other.invalid" }),
            )
            await assert.rejects(() =>
              current.saveDiscoveryState({
                ...discovery,
                authorizationServerMetadata: {
                  ...discovery.authorizationServerMetadata,
                  scopes_supported: ["界".repeat(12000)],
                },
              }),
            )
            await assert.rejects(() =>
              current.saveDiscoveryState({
                ...discovery,
                authorizationServerMetadata: {
                  ...discovery.authorizationServerMetadata,
                  token_endpoint: "https://other.invalid/token",
                },
              }),
            )
            assert.deepEqual(await fs.readFile(file), bytes)
            const secret = new McpOAuthProvider(
              "issuer",
              url,
              { clientId: "synthetic-client", clientSecret: "synthetic-secret", expectedIssuer: issuer },
              { onRedirect: () => {}, authorizationGeneration: "generation-new" },
              first,
            )
            await assert.rejects(() => secret.clientInformation({ issuer: "https://other.invalid" }))
            const unbound = new McpOAuthProvider(
              "issuer",
              url,
              { clientId: "synthetic-client", clientSecret: "synthetic-secret" },
              { onRedirect: () => {} },
              first,
            )
            await assert.rejects(() => unbound.clientInformation({ issuer }))
            await Effect.runPromise(
              first.set(
                "different",
                {
                  tokens: { accessToken: "synthetic-private", issuer },
                  clientInfo: { clientId: "synthetic-private", issuer },
                },
                url,
              ),
            )
            await Effect.runPromise(first.startFlow("different", "generation-other-url", "https://other.invalid/mcp"))
            assert.equal((await Effect.runPromise(first.get("different")))?.tokens, undefined)
            assert.equal((await Effect.runPromise(first.get("different")))?.clientInfo, undefined)
            await Bun.write(
              path.join(root, "issuer.json"),
              JSON.stringify({
                legacyReadOnly: true,
                durableGeneration: true,
                wrongIssuerRejected: true,
                resourceReset: true,
              }),
            )
          })
          return
        }
        if (mode === "setup") {
          yield* first.set("fixture", { tokens: { accessToken: "synthetic-old" } }, "https://example.invalid/mcp")
          return
        }
        if (mode === "read") {
          const entry = yield* first.get("fixture")
          const expected = process.argv[3]
          assert.equal(entry?.tokens?.accessToken, expected === "old" ? "synthetic-old" : "synthetic-new")
          yield* Effect.promise(() =>
            Bun.write(path.join(root, "cold.json"), JSON.stringify({ expected, valid: true })),
          )
          return
        }
        if (mode === "update_tokens" || mode === "before_rename" || mode === "after_rename" || mode === "after_sync") {
          yield* first.updateTokens("fixture", { accessToken: "synthetic-new" }, "https://example.invalid/mcp")
          return
        }
        if (mode === "update_client") {
          yield* first.updateClientInfo("fixture", { clientId: "synthetic-concurrent" }, "https://example.invalid/mcp")
          return
        }
        if (mode === "read_concurrent") {
          const entry = yield* first.get("fixture")
          assert.equal(entry?.tokens?.accessToken, "synthetic-new")
          assert.equal(entry?.clientInfo?.clientId, "synthetic-concurrent")
          return
        }
        const damaged = '{"retained":'
        yield* Effect.promise(() => writeFixture(damaged))
        const failed = yield* first
          .updateTokens("fixture", { accessToken: "synthetic-token" }, "https://example.invalid/mcp")
          .pipe(Effect.exit)
        const afterDamage = yield* Effect.promise(() => fs.readFile(file, "utf8"))
        yield* Effect.promise(() =>
          Bun.write(
            path.join(root, "corruption.json"),
            JSON.stringify({ rejected: Exit.isFailure(failed), originalPreserved: afterDamage === damaged }),
          ),
        )
        assert(Exit.isFailure(failed), "damaged credential update must fail")
        assert.equal(afterDamage, damaged, "damaged original must remain byte identical")
        // Real SDK transport must fail before any body reaches the actual HTTP listener.
        const { Client, StreamableHTTPClientTransport } = yield* Effect.promise(
          () => import("@modelcontextprotocol/client"),
        )
        const { McpOAuthProvider } = yield* Effect.promise(() => import("../../src/mcp/oauth-provider"))
        let requests = 0
        const listener = Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          fetch: () => {
            requests++
            return new Response(null, { status: 401 })
          },
        })
        const client = new Client({ name: "durable-auth-fixture", version: "1" })
        const transport = new StreamableHTTPClientTransport(listener.url, {
          authProvider: new McpOAuthProvider("fixture", listener.url.href, {}, { onRedirect: () => {} }, first),
        })
        yield* Effect.promise(async () => {
          try {
            await assert.rejects(() => client.connect(transport))
            assert.equal(requests, 0, "corrupted credential store must dispatch no actual HTTP")
          } finally {
            await client.close()
            await transport.close()
            await listener.stop(true)
          }
        })
        yield* Effect.promise(() => writeFixture("{}"))
        yield* Effect.all(
          [
            first.updateTokens("fixture", { accessToken: "synthetic-token" }, "https://example.invalid/mcp"),
            second.updateClientInfo("fixture", { clientId: "synthetic-client" }, "https://example.invalid/mcp"),
          ],
          { concurrency: "unbounded" },
        )
        const entry = yield* first.get("fixture")
        assert.equal(entry?.tokens?.accessToken, "synthetic-token")
        assert.equal(entry?.clientInfo?.clientId, "synthetic-client")
        const stored = yield* Effect.promise(() => fs.readFile(file))
        const oversized = yield* first.updateTokens("oversized", { accessToken: "x".repeat(16385) }).pipe(Effect.exit)
        assert(Exit.isFailure(oversized), "oversized credential must fail")
        assert.deepEqual(yield* Effect.promise(() => fs.readFile(file)), stored)
        const multibyte = yield* first.updateTokens("multibyte", { accessToken: "界".repeat(5462) }).pipe(Effect.exit)
        assert(Exit.isFailure(multibyte), "credential bound must count UTF-8 bytes")
        assert.deepEqual(yield* Effect.promise(() => fs.readFile(file)), stored)
        const stat = yield* Effect.promise(() => fs.stat(file))
        const other = path.join(root, "other.json")
        yield* Effect.promise(async () => {
          await fs.writeFile(other, stored, { mode: 0o600 })
          await fs.unlink(file)
          await fs.symlink(other, file)
        })
        const symlinked = yield* first.updateOAuthState("fixture", "synthetic-state").pipe(Effect.exit)
        assert(Exit.isFailure(symlinked), "symlinked credential file must fail")
        assert.deepEqual(yield* Effect.promise(() => fs.readFile(other)), stored)
        yield* Effect.promise(async () => {
          await fs.unlink(file)
          await writeFixture(stored.toString(), true)
          const nativeAcl =
            storage && process.platform === "win32"
              ? await (async () => {
                  const { spawnSync } = await import("node:child_process")
                  const { MediaFiles } = await import("../../src/im/media-files")
                  const invocation = MediaFiles.windowsPrivateInvocation(
                    process.env.SystemRoot ?? "",
                    file,
                    false,
                    false,
                  )
                  const checked = spawnSync(invocation.cmd[0], invocation.cmd.slice(1), {
                    env: invocation.env,
                    stdio: "ignore",
                    windowsHide: true,
                    shell: false,
                  })
                  return checked.status === 0
                })()
              : undefined
          await Bun.write(
            path.join(root, "result.json"),
            JSON.stringify({
              corruptionRejected: true,
              originalPreserved: true,
              concurrentFields: true,
              oversizeRejected: true,
              multibyteRejected: true,
              symlinkRejected: true,
              fileMode: stat.mode & 0o777,
              nativeAcl,
              actualHttpRequests: requests,
            }),
          )
        })
      }),
    ),
  )
}

export async function main() {
  if (process.env.DAC_MCP_NATIVE_AUTH === "cli") return NativeAuthStorage.run((storage, port) => run(storage, port))
  return run()
}

if (import.meta.main || process.env.DAC_MCP_NATIVE_AUTH === "cli") await main()
