import { afterAll, expect, mock, beforeEach } from "bun:test"
import { Deferred, Effect, Layer, Option } from "effect"
import { awaitWithTimeout, testEffect } from "../lib/effect"
import { oauthHttp } from "../fixture/mcp-oauth-http"
import { browserOpenState, openBrowser, resetBrowserOpen } from "../fixture/windows-oauth-browser"
import { windowsMcpStorage } from "../fixture/windows-mcp-storage"
import type { MCP as MCPNS } from "../../src/mcp/index"

afterAll(() => {
  if (process.platform !== "win32") mock.restore()
})

if (process.platform !== "win32") void mock.module("open", () => ({ default: openBrowser }))

beforeEach(() => {
  resetBrowserOpen()
})

// Import modules after mocking
const { MCP } = await import("../../src/mcp/index")
const { EventV2Bridge } = await import("../../src/event-v2-bridge")
const { Config } = await import("../../src/config/config")
const { McpAuth } = await import("../../src/mcp/auth")
const { McpAuthScope } = await import("../../src/mcp/auth-scope")
const { SecretStore } = await import("../../src/mcp/secret-store")
const { McpOAuthCallback } = await import("../../src/mcp/oauth-callback")
const { FSUtil } = await import("@deepagent-code/core/fs-util")
const { CrossSpawnSpawner } = await import("@deepagent-code/core/cross-spawn-spawner")
const mcpTest = testEffect(
  MCP.layer.pipe(
    Layer.provide(McpAuth.defaultLayer),
    Layer.provide(McpAuthScope.defaultLayer),
    Layer.provide(SecretStore.testLayer()),
    Layer.provideMerge(EventV2Bridge.defaultLayer),
    Layer.provide(Config.defaultLayer),
    Layer.provide(CrossSpawnSpawner.defaultLayer),
    Layer.provide(FSUtil.defaultLayer),
  ),
  windowsMcpStorage,
)
const service = MCP.Service as unknown as Effect.Effect<MCPNS.Interface, never, never>

const withCallbackStop = Effect.addFinalizer(() => Effect.promise(() => McpOAuthCallback.stop()).pipe(Effect.ignore))

const trackBrowserOpen = Effect.gen(function* () {
  const opened = yield* Deferred.make<string>()
  browserOpenState.deferred = opened
  yield* Effect.addFinalizer(() => Effect.sync(() => (browserOpenState.deferred = undefined)))
  return opened
})

const trackBrowserOpenFailed = Effect.gen(function* () {
  const events = yield* EventV2Bridge.Service
  const event = yield* Deferred.make<{ mcpName: string; url: string }>()
  const unsubscribe = yield* events.listen((evt) => {
    if (evt.type === MCP.BrowserOpenFailed.type)
      Deferred.doneUnsafe(event, Effect.succeed(evt.data as { mcpName: string; url: string }))
    return Effect.void
  })
  yield* Effect.addFinalizer(() => unsubscribe)
  return event
})

const authenticateScoped = (name: string) =>
  Effect.gen(function* () {
    const mcp = yield* service
    yield* mcp.authenticate(name).pipe(
      Effect.ignore,
      Effect.catchCause(() => Effect.void),
      Effect.forkScoped,
    )
  })

mcpTest.instance(
  "BrowserOpenFailed event is published when open() throws",
  () =>
    Effect.gen(function* () {
      yield* withCallbackStop
      const f = yield* oauthHttp
      yield* (yield* service).add("test-oauth-server", f.config)
      browserOpenState.shouldFail = true

      const event = yield* trackBrowserOpenFailed
      yield* authenticateScoped("test-oauth-server")

      const failure = yield* awaitWithTimeout(
        Deferred.await(event),
        "Timed out waiting for BrowserOpenFailed event",
        "5 seconds",
      )

      expect(failure.mcpName).toBe("test-oauth-server")
      expect(new URL(failure.url).origin).toBe(new URL(f.config.url).origin)
    }),
  { config: { mcp: {} } },
)

mcpTest.instance(
  "BrowserOpenFailed event is NOT published when open() succeeds",
  () =>
    Effect.gen(function* () {
      yield* withCallbackStop
      const f = yield* oauthHttp
      yield* (yield* service).add("test-oauth-server-2", f.config)
      browserOpenState.shouldFail = false

      const opened = yield* trackBrowserOpen
      const event = yield* trackBrowserOpenFailed
      yield* authenticateScoped("test-oauth-server-2")

      yield* awaitWithTimeout(Deferred.await(opened), "Timed out waiting for open()", "5 seconds")
      const failure = yield* Deferred.await(event).pipe(Effect.timeoutOption("700 millis"))

      expect(failure).toEqual(Option.none())
      expect(browserOpenState.calledWith).toBeDefined()
    }),
  { config: { mcp: {} } },
)

mcpTest.instance(
  "open() is called with the authorization URL",
  () =>
    Effect.gen(function* () {
      yield* withCallbackStop
      const f = yield* oauthHttp
      yield* (yield* service).add("test-oauth-server-3", f.config)
      browserOpenState.shouldFail = false
      browserOpenState.calledWith = undefined

      const opened = yield* trackBrowserOpen
      const event = yield* trackBrowserOpenFailed
      yield* authenticateScoped("test-oauth-server-3")

      const url = yield* awaitWithTimeout(Deferred.await(opened), "Timed out waiting for open()", "5 seconds")
      const failure = yield* Deferred.await(event).pipe(Effect.timeoutOption("700 millis"))

      expect(failure).toEqual(Option.none())
      expect(typeof url).toBe("string")
      expect(new URL(url).origin).toBe(new URL(f.config.url).origin)
    }),
  { config: { mcp: {} } },
)
