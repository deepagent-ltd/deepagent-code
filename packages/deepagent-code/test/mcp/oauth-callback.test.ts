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

  test("rejects an invalid explicit URI instead of binding another address", () => {
    expect(() => parseRedirectUri("not-a-valid-url")).toThrow()
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
    await McpOAuthCallback.ensureRunning(`http://127.0.0.1:${await freePort()}/custom/callback`)
    const original = McpOAuthCallback.waitForCallback("oauth-state", "demo").catch((error) => error)
    await expect(McpOAuthCallback.waitForCallback("oauth-state", "demo")).rejects.toThrow(
      "OAuth state is already pending",
    )
    McpOAuthCallback.cancelPending("demo")
    expect(await original).toBeInstanceOf(Error)
  })

  test("suppresses provider-controlled error descriptions in the callback page", async () => {
    const port = await freePort()
    const state = "escaped-error-state"
    await McpOAuthCallback.ensureRunning(`http://127.0.0.1:${port}/custom/callback`)
    const pending = McpOAuthCallback.waitForCallback(state, "escaped-error").catch((error) => error)
    const response = await fetch(
      `http://127.0.0.1:${port}/custom/callback?state=${state}&error=denied&error_description=${encodeURIComponent("<script>alert(1)</script>")}`,
    )
    const html = await response.text()
    expect(html).not.toContain("<script>alert(1)</script>")
    expect(html).not.toContain("alert(1)")
    expect(await pending).toBeInstanceOf(Error)
  })

  test("duplicate and wrong issuer callbacks preserve the validated complete response waiter", async () => {
    const port = await freePort()
    await McpOAuthCallback.ensureRunning(`http://127.0.0.1:${port}/custom/callback`)
    const issuer = `http://127.0.0.1:${port}/issuer`
    const { validateAuthorizationResponseIssuer } = await import("@modelcontextprotocol/client")
    const pending = McpOAuthCallback.waitForResponse("issuer-state", "issuer-server", async (params) => {
      validateAuthorizationResponseIssuer({
        iss: params.get("iss") ?? undefined,
        expectedIssuer: issuer,
        issParameterSupported: true,
      })
    })
    const request = (query: string) => fetch(`http://127.0.0.1:${port}/custom/callback?${query}`)
    for (const query of [
      "state=issuer-state&code=first&code=second",
      "state=issuer-state&code=first",
      "state=issuer-state&code=first&iss=https://wrong.invalid",
      `state=issuer-state&code=first&iss=${encodeURIComponent(issuer)}&iss=${encodeURIComponent(issuer)}`,
      `state=issuer-state&code=${"x".repeat(8193)}&iss=${encodeURIComponent(issuer)}`,
    ])
      expect((await request(query)).status).toBe(400)
    const received = await request(`state=issuer-state&code=real-code&iss=${encodeURIComponent(issuer)}`)
    expect(received.status).toBe(200)
    const html = await received.text()
    expect(html).toContain("Authorization Response Received")
    expect(html).not.toContain("Authorization Successful")
    expect(Object.fromEntries(await pending)).toEqual({ state: "issuer-state", code: "real-code", iss: issuer })
  })
})

test("independent exact leases support shared static ports, IPv6, manual URIs and bounded ownership", async () => {
  const dynamic = await McpOAuthCallback.acquire()
  const second = await McpOAuthCallback.acquire()
  expect(dynamic.redirectUri).not.toBe(second.redirectUri)
  const port = new URL(dynamic.redirectUri).port
  const shared = await McpOAuthCallback.acquire(`http://127.0.0.1:${port}/second?fixed=value`)
  const response = shared.waitForResponse("shared-static-state")
  await dynamic.close()
  expect((await fetch(`http://127.0.0.1:${port}/second?fixed=wrong&state=shared-static-state&code=one`)).status).toBe(
    400,
  )
  expect((await fetch(`http://127.0.0.1:${port}/second?fixed=value&state=shared-static-state&code=one`)).status).toBe(
    200,
  )
  expect((await response).get("code")).toBe("one")
  await shared.close()
  await second.close()
  const manual = await McpOAuthCallback.acquire("https://example.invalid/manual?fixed=value")
  expect(manual.automatic).toBe(false)
  expect(McpOAuthCallback.isRunning()).toBe(false)
  await manual.close()
  await expect(McpOAuthCallback.acquire("http://127.0.0.1:0/callback")).rejects.toThrow()
  const leases = await Promise.all(
    Array.from({ length: 64 }, () => McpOAuthCallback.acquire("https://example.invalid/manual")),
  )
  await expect(McpOAuthCallback.acquire()).rejects.toThrow("Too many pending")
  await Promise.all(leases.map((lease) => lease.close()))
  const v6probe = createServer()
  await new Promise<void>((resolve, reject) => {
    v6probe.once("error", reject)
    v6probe.listen(0, "::1", resolve)
  })
  const address = v6probe.address()
  if (!address || typeof address === "string") throw new Error("IPv6 probe unavailable")
  const v6port = address.port
  await new Promise<void>((resolve, reject) => v6probe.close((error) => (error ? reject(error) : resolve())))
  const v6 = await McpOAuthCallback.acquire(`http://[::1]:${v6port}/callback`)
  const v6result = v6.waitForResponse("ipv6-state")
  expect((await fetch(`http://[::1]:${v6port}/callback?state=ipv6-state&code=ipv6`)).status).toBe(200)
  expect((await v6result).get("code")).toBe("ipv6")
  await v6.close()
  const localhost = await McpOAuthCallback.acquire(`http://localhost:${await freePort()}/callback`)
  const localhostResult = localhost.waitForResponse("localhost-state")
  expect((await fetch(`${localhost.redirectUri}?state=localhost-state&code=local`)).status).toBe(200)
  expect((await localhostResult).get("code")).toBe("local")
  await localhost.close()
  expect(McpOAuthCallback.isRunning()).toBe(false)
})
