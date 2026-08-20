import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test"
import * as Log from "@deepagent-code/core/util/log"
import { withTimeout } from "../../src/util/timeout"

await Log.init({ print: false })

type Event =
  | { kind: "publish"; owner: number; port: number; name: string }
  | { kind: "unpublishAll"; owner: number }
  | { kind: "destroy"; owner: number }
const events: Event[] = []
let nextOwner = 0

void mock.module("bonjour-service", () => ({
  Bonjour: class {
    readonly owner = ++nextOwner
    publish(opts: { port: number; name: string }) {
      events.push({ kind: "publish", owner: this.owner, port: opts.port, name: opts.name })
      return { on: () => {} }
    }
    unpublishAll() {
      events.push({ kind: "unpublishAll", owner: this.owner })
    }
    destroy() {
      events.push({ kind: "destroy", owner: this.owner })
    }
  },
}))

// Import Server AFTER the mock so the MDNS module picks up the stub.
const { Server } = await import("../../src/server/server")

// Release the bonjour-service mock when this file finishes so later files
// that import modules still unloaded see the real dependency.
afterAll(() => {
  mock.restore()
})

beforeEach(() => {
  events.length = 0
  nextOwner = 0
})

describe("HttpApi Server.listen mDNS", () => {
  test("skips publish for loopback hostnames", async () => {
    const listener = await Server.listen({ hostname: "127.0.0.1", port: 0, mdns: true })
    try {
      expect(events.filter((e) => e.kind === "publish")).toEqual([])
    } finally {
      await withTimeout(listener.stop(true), 10_000, "timed out stopping loopback mdns listener")
    }
    expect(events.filter((e) => e.kind === "publish")).toEqual([])
  })

  test("publishes for non-loopback hostnames and unpublishes on stop", async () => {
    const listener = await Server.listen({ hostname: "0.0.0.0", port: 0, mdns: true })
    try {
      const published = events.filter((e) => e.kind === "publish")
      expect(published.length).toBe(1)
      expect(published[0]!.port).toBe(listener.port)
      expect(published[0]!.name).toBe(`deepagent-code-${listener.port}`)
    } finally {
      await withTimeout(listener.stop(true), 10_000, "timed out stopping mdns listener")
    }
    expect(events.filter((e) => e.kind === "unpublishAll")).toEqual([{ kind: "unpublishAll", owner: 1 }])
    expect(events.filter((e) => e.kind === "destroy")).toEqual([{ kind: "destroy", owner: 1 }])
  })

  test("scope finalizer unpublishes even if stop() is not called for force-close", async () => {
    const listener = await Server.listen({ hostname: "0.0.0.0", port: 0, mdns: true })
    expect(events.filter((e) => e.kind === "publish").length).toBe(1)
    // Plain (graceful) stop without close=true should still unpublish.
    await withTimeout(listener.stop(), 10_000, "timed out stopping graceful mdns listener")
    expect(events.some((e) => e.kind === "unpublishAll")).toBe(true)
  })

  test("each listener only unpublishes its own advertisement", async () => {
    const first = await Server.listen({ hostname: "0.0.0.0", port: 0, mdns: true })
    const second = await Server.listen({ hostname: "0.0.0.0", port: 0, mdns: true })
    let firstStopped = false
    try {
      const published = events.filter((event) => event.kind === "publish")
      expect(published.map((event) => event.port)).toEqual([first.port, second.port])

      await withTimeout(first.stop(true), 10_000, "timed out stopping first mdns listener")
      firstStopped = true
      expect(events.filter((event) => event.kind === "unpublishAll")).toEqual([{ kind: "unpublishAll", owner: 1 }])
      expect(events.filter((event) => event.kind === "destroy")).toEqual([{ kind: "destroy", owner: 1 }])
    } finally {
      if (!firstStopped) await withTimeout(first.stop(true), 10_000, "timed out cleaning up first mdns listener")
      await withTimeout(second.stop(true), 10_000, "timed out cleaning up second mdns listener")
    }
    expect(events.filter((event) => event.kind === "unpublishAll")).toEqual([
      { kind: "unpublishAll", owner: 1 },
      { kind: "unpublishAll", owner: 2 },
    ])
  })
})
