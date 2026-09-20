import { describe, expect, test } from "bun:test"
import net from "node:net"
import path from "node:path"
import { Server } from "../../src/server/server"

// RI-70: port-fallback boundary oracle. The EADDRINUSE fallback (port 0 prefers
// 4096, then any free port) already has a dynamic oracle in httpapi-listen.test.ts.
// This file pins the OTHER side of the boundary: a listen failure that is NOT
// EADDRINUSE must surface as-is and must never be retried under a random port.
// The packages/cli serve entry keeps its listen helper unexported (reachable only
// through the full command runtime), so that entry is pinned by source assertion
// alongside the same assertion for src/server/server.ts.

function errorCodes(error: unknown): string[] {
  if (typeof error !== "object" || error === null) return []
  const own = "code" in error && typeof error.code === "string" ? [error.code] : []
  return [...own, ...("cause" in error ? errorCodes(error.cause) : [])]
}

function occupyPort(port: number) {
  return new Promise<net.Server | undefined>((resolve) => {
    const server = net.createServer()
    server.once("error", () => resolve(undefined))
    server.listen(port, "127.0.0.1", () => resolve(server))
  })
}

describe("Server.listen fallback boundary", () => {
  test("a persistent listen failure rejects after the fallback attempt and never rebuilds on a random port", async () => {
    // The .invalid TLD is reserved (RFC 2606), so resolution fails deterministically.
    // NOTE (runtime constraint): Bun's node:http emulation reports EVERY listen
    // failure (ENOTFOUND, EADDRNOTAVAIL, …) with code "EADDRINUSE", so a
    // non-EADDRINUSE-coded listen failure is not reachable through Server.listen
    // under Bun — the observable boundary is that the listener MUST reject (a
    // successful rebuild on a random port would resolve instead).
    const failure = await Server.listen({ hostname: "listen-fallback.invalid", port: 0 }).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(failure).toBeDefined()
    expect(errorCodes(failure).length).toBeGreaterThan(0)
  }, 30_000)

  test("an explicit port with EADDRINUSE rejects as-is (fallback only exists for port 0)", async () => {
    const blocker = await occupyPort(4096)
    if (!blocker) return
    try {
      const failure = await Server.listen({ hostname: "127.0.0.1", port: 4096 }).then(
        () => undefined,
        (error: unknown) => error,
      )
      expect(failure).toBeDefined()
      expect(errorCodes(failure)).toContain("EADDRINUSE")
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()))
    }
  }, 30_000)
})

describe("port-fallback source gate (both entries)", () => {
  // The static gate: each fallback site must test the squashed cause chain for
  // exactly EADDRINUSE and re-throw everything else (Effect.failCause), never
  // rebuilding on a random port for unrelated bootstrap/listen failures.
  test("src/server/server.ts startWithPortFallback gates on EADDRINUSE and re-fails otherwise", async () => {
    const source = await Bun.file(path.resolve(import.meta.dir, "../../src/server/server.ts")).text()
    expect(source).toMatch(
      /errorCode\(Cause\.squash\(cause\)\) === "EADDRINUSE"\s*\?\s*startListener\(opts, 0\)\s*:\s*Effect\.failCause\(cause\)/,
    )
  })

  test("packages/cli serve.ts listen gates on EADDRINUSE and re-fails otherwise", async () => {
    const source = await Bun.file(path.resolve(import.meta.dir, "../../../cli/src/commands/handlers/serve.ts")).text()
    expect(source).toMatch(
      /errorCode\(Cause\.squash\(cause\)\) === "EADDRINUSE"\s*\?\s*bind\(hostname, 0, password\)\s*:\s*Effect\.failCause\(cause\)/,
    )
  })
})
