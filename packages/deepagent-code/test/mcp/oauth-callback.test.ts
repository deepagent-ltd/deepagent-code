import { test, expect, describe, afterEach } from "bun:test"
import { createServer } from "node:http"
import { McpOAuthCallback } from "../../src/mcp/oauth-callback"
import { parseRedirectUri } from "../../src/mcp/oauth-provider"

// Bind a probe server on port 0 (kernel-assigned free port), read the port,
// close it, and hand the port back to the test. Never hardcode a fixed port:
// it collides with unrelated local services (e.g. an ssh tunnel) and the
// callback server then silently can't start.
const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const probe = createServer()
    probe.once("error", reject)
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address()
      const port = typeof address === "object" && address ? address.port : 0
      probe.close(() => resolve(port))
    })
  })

describe("parseRedirectUri", () => {
  test("returns defaults when no URI provided", () => {
    const result = parseRedirectUri()
    expect(result.port).toBe(19876)
    expect(result.path).toBe("/mcp/oauth/callback")
  })

  test("parses port and path from URI", () => {
    const result = parseRedirectUri("http://127.0.0.1:8080/oauth/callback")
    expect(result.port).toBe(8080)
    expect(result.path).toBe("/oauth/callback")
  })

  test("returns defaults for invalid URI", () => {
    const result = parseRedirectUri("not-a-valid-url")
    expect(result.port).toBe(19876)
    expect(result.path).toBe("/mcp/oauth/callback")
  })
})

describe("McpOAuthCallback.ensureRunning", () => {
  afterEach(async () => {
    await McpOAuthCallback.stop()
  })

  test("starts server with custom redirectUri port and path", async () => {
    const port = await freePort()
    await McpOAuthCallback.ensureRunning(`http://127.0.0.1:${port}/custom/callback`)
    expect(McpOAuthCallback.isRunning()).toBe(true)
  })

  test("fails when another process owner already holds the callback port", async () => {
    const occupied = createServer()
    await new Promise<void>((resolve, reject) => {
      occupied.once("error", reject)
      occupied.listen(0, "127.0.0.1", resolve)
    })
    const address = occupied.address()
    const port = typeof address === "object" && address ? address.port : 0

    await expect(McpOAuthCallback.ensureRunning(`http://127.0.0.1:${port}/custom/callback`)).rejects.toMatchObject({
      code: "EADDRINUSE",
    })
    expect(McpOAuthCallback.isRunning()).toBe(false)
    await new Promise<void>((resolve, reject) => occupied.close((error) => (error ? reject(error) : resolve())))
  })

  test("serializes concurrent starts onto one listener", async () => {
    const port = await freePort()
    await Promise.all([
      McpOAuthCallback.ensureRunning(`http://127.0.0.1:${port}/custom/callback`),
      McpOAuthCallback.ensureRunning(`http://127.0.0.1:${port}/custom/callback`),
    ])
    expect(McpOAuthCallback.isRunning()).toBe(true)
  })

  test("rejects duplicate pending state without replacing the original callback", async () => {
    const original = McpOAuthCallback.waitForCallback("oauth-state", "demo").catch((error) => error)
    await expect(McpOAuthCallback.waitForCallback("oauth-state", "demo")).rejects.toThrow(
      "OAuth state is already pending",
    )
    McpOAuthCallback.cancelPending("demo")
    expect(await original).toBeInstanceOf(Error)
  })

  test("escapes provider-controlled error descriptions in the callback page", async () => {
    const port = await freePort()
    const state = "escaped-error-state"
    const pending = McpOAuthCallback.waitForCallback(state, "escaped-error").catch((error) => error)
    await McpOAuthCallback.ensureRunning(`http://127.0.0.1:${port}/custom/callback`)
    const response = await fetch(
      `http://127.0.0.1:${port}/custom/callback?state=${state}&error=denied&error_description=${encodeURIComponent("<script>alert(1)</script>")}`,
    )
    const html = await response.text()
    expect(html).not.toContain("<script>alert(1)</script>")
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;")
    expect(await pending).toBeInstanceOf(Error)
  })
})
