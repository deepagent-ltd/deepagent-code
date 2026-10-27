import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { testEffect } from "../lib/effect"
import { oauthHttp } from "../fixture/mcp-oauth-http"
import { MCP } from "../../src/mcp/index"
import { McpAuth } from "../../src/mcp/auth"
import { McpOAuthProvider } from "../../src/mcp/oauth-provider"
import { Config } from "../../src/config/config"
import { CrossSpawnSpawner } from "@deepagent-code/core/cross-spawn-spawner"
import { windowsMcpStorage } from "../fixture/windows-mcp-storage"

const mcpTest = testEffect(
  Layer.mergeAll(MCP.defaultLayer, McpAuth.defaultLayer, Config.defaultLayer, CrossSpawnSpawner.defaultLayer),
  windowsMcpStorage,
)

mcpTest.instance(
  "incomplete pre-registered secret configuration fails before HTTP or flow admission",
  () =>
    Effect.gen(function* () {
      const f = yield* oauthHttp
      const mcp = yield* MCP.Service
      const result = yield* mcp.add("missing-issuer", {
        ...f.config,
        oauth: { ...f.config.oauth, clientSecret: "synthetic-client-secret" },
      })
      expect(result.status).toMatchObject({
        "missing-issuer": { status: "failed", error: expect.stringContaining("oauth.expectedIssuer") },
      })
      const failure = yield* mcp.startAuth("missing-issuer").pipe(Effect.flip)
      expect(failure).toBeInstanceOf(MCP.OAuthFlowError)
      expect(failure.message).toContain("oauth.expectedIssuer")
      expect(f.requests).toEqual([])
      expect(yield* McpAuth.use.get("missing-issuer")).toBeUndefined()
    }),
  { config: { mcp: {} } },
)

mcpTest.instance(
  "a correctly pinned pre-registered secret completes the genuine SDK token exchange",
  () =>
    Effect.gen(function* () {
      const f = yield* oauthHttp
      const issuer = new URL(f.config.url).origin
      const mcp = yield* MCP.Service
      const result = yield* mcp.add("pinned-secret", {
        ...f.config,
        oauth: { ...f.config.oauth, clientSecret: "synthetic-client-secret", expectedIssuer: issuer },
      })
      expect(result.status).toMatchObject({ "pinned-secret": { status: "needs_auth" } })
      const pending = yield* mcp.startAuth("pinned-secret")
      f.control.open = true
      expect((yield* mcp.finishAuth("pinned-secret", "synthetic-code", pending.oauthState, issuer)).status).toBe(
        "connected",
      )
      expect(f.requests.filter((request) => request === "POST /token")).toHaveLength(1)
      expect(yield* McpAuth.use.get("pinned-secret")).toBeUndefined()
      expect(yield* mcp.getAuthStatus("pinned-secret")).toBe("authenticated")
      expect(f.requests.filter((request) => request === "POST /register")).toEqual([])
    }),
  { config: { mcp: {} } },
)

mcpTest.instance(
  "explicit issuer mismatch stops real discovery before DCR, authorization redirect or tokens",
  () =>
    Effect.gen(function* () {
      const f = yield* oauthHttp
      const mcp = yield* MCP.Service
      const result = yield* mcp.add("wrong-issuer", {
        ...f.config,
        oauth: { ...f.config.oauth, expectedIssuer: "https://other-issuer.invalid" },
      })
      expect(result.status).toMatchObject({ "wrong-issuer": { status: "failed" } })
      expect(f.requests.some((request) => request.includes("well-known"))).toBe(true)
      expect(f.requests.filter((request) => /\/(register|token|authorize)$/.test(request))).toEqual([])
      expect((yield* McpAuth.use.get("wrong-issuer"))?.clientInfo).toBeUndefined()
      expect((yield* McpAuth.use.get("wrong-issuer"))?.tokens).toBeUndefined()
    }),
  { config: { mcp: {} } },
)

mcpTest.instance(
  "first real SDK connect persists discovery and shows needs_auth",
  () =>
    Effect.gen(function* () {
      const f = yield* oauthHttp
      const mcp = yield* MCP.Service
      const result = yield* mcp.add("test-oauth", f.config)
      expect(result.status).toMatchObject({ "test-oauth": { status: "needs_auth" } })
      expect((yield* mcp.status())["test-oauth"]?.status).toBe("needs_auth")
    }),
  { config: { mcp: {} } },
)

mcpTest.instance("state() generates a new state when none is saved", () =>
  Effect.gen(function* () {
    const auth = yield* McpAuth.Service
    const provider = new McpOAuthProvider(
      "test-state-gen",
      "https://example.com/mcp",
      {},
      { onRedirect: async () => {} },
      auth,
    )

    const entryBefore = yield* McpAuth.use.get("test-state-gen")
    expect(entryBefore?.oauthState).toBeUndefined()

    // state() should generate and return a new state, not throw
    const state = yield* Effect.promise(() => provider.state())
    expect(typeof state).toBe("string")
    expect(state.length).toBe(64) // 32 bytes as hex

    // The generated state should be persisted
    const entryAfter = yield* McpAuth.use.get("test-state-gen")
    expect(entryAfter?.oauthState).toBe(state)
  }),
)

mcpTest.instance("state() returns existing state when one is saved", () =>
  Effect.gen(function* () {
    const auth = yield* McpAuth.Service
    const provider = new McpOAuthProvider(
      "test-state-existing",
      "https://example.com/mcp",
      {},
      { onRedirect: async () => {} },
      auth,
    )

    // Pre-save a state
    const existingState = "pre-saved-state-value"
    yield* McpAuth.use.updateOAuthState("test-state-existing", existingState)

    // state() should return the existing state
    const state = yield* Effect.promise(() => provider.state())
    expect(state).toBe(existingState)
  }),
)

mcpTest.instance(
  "authenticate() stores an actual connected client without redirect",
  () =>
    Effect.gen(function* () {
      const f = yield* oauthHttp
      const mcp = yield* MCP.Service
      expect((yield* mcp.add("test-oauth-connect", f.config)).status).toMatchObject({
        "test-oauth-connect": { status: "needs_auth" },
      })
      f.control.open = true
      expect((yield* mcp.authenticate("test-oauth-connect")).status).toBe("connected")
      expect((yield* mcp.status())["test-oauth-connect"]?.status).toBe("connected")
      expect(f.methods).toContain("initialize")
    }),
  { config: { mcp: {} } },
)

mcpTest.instance(
  "authenticate() connects an actual resource-only server without listing tools",
  () =>
    Effect.gen(function* () {
      const f = yield* oauthHttp
      const mcp = yield* MCP.Service
      expect((yield* mcp.add("test-oauth-resources", f.config)).status).toMatchObject({
        "test-oauth-resources": { status: "needs_auth" },
      })
      f.control.open = true
      f.control.resourcesOnly = true
      expect((yield* mcp.authenticate("test-oauth-resources")).status).toBe("connected")
      expect(f.methods.filter((method) => method === "tools/list")).toHaveLength(0)
      expect(Object.keys(yield* mcp.resources())).toEqual(["test-oauth-resources:docs"])
    }),
  { config: { mcp: {} } },
)
