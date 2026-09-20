import { describe, expect } from "bun:test"
import path from "path"
import { Effect } from "effect"
import { DapClient } from "@/debug/client"
import type { AdapterSpec } from "@/debug/types"
import { TestInstance } from "../fixture/fixture"
import { it } from "../lib/effect"

// D1 (S1-v3.5): DAP client — initialize handshake + launch + receive a `stopped`
// event. Drives the fake adapter directly (no DebugService), proving the client
// speaks DAP framing over stdio and routes events.

const fakeAdapterPath = path.join(__dirname, "../fixture/debug/fake-dap-adapter.js")

const fakeSpec = (): AdapterSpec => ({
  id: "fake",
  languages: ["python"],
  command: process.execPath,
  args: [fakeAdapterPath],
  privileges: [],
  transport: "stdio",
})

describe("DAP client: initialize + launch + stop", () => {
  it.instance("initializes, launches, and receives a stopped event", () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      const client = yield* Effect.promise(() => DapClient.create({ spec: fakeSpec(), cwd: dir }))

      // initialize handshake captured adapter capabilities.
      expect(client.adapterID).toBe("fake")
      expect(client.capabilities.supportsConfigurationDoneRequest).toBe(true)

      // Subscribe BEFORE launch so we catch the stopped event after configurationDone.
      const stopped = new Promise<any>((resolve) => {
        const off = client.onEvent((event) => {
          if (event.event === "stopped") {
            off()
            resolve(event.body)
          }
        })
      })

      yield* Effect.promise(() => client.launch({ program: "/repro/main.py" }))
      yield* Effect.promise(() => client.configurationDone())

      const body = yield* Effect.promise(() =>
        Promise.race([
          stopped,
          new Promise((_, reject) => setTimeout(() => reject(new Error("no stopped event")), 5000)),
        ]),
      )
      expect(body.reason).toBe("breakpoint")
      expect(body.threadId).toBe(1)

      yield* Effect.promise(() => client.shutdown())
    }),
  )

  it.instance("rejects a non-stdio transport (no silent downgrade)", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.promise(() =>
        DapClient.create({ spec: { ...fakeSpec(), transport: "socket" }, cwd: "." }).then(
          () => "ok" as const,
          (e) => e as Error,
        ),
      )
      expect(exit).not.toBe("ok")
    }),
  )

  it.instance("rejects pending work when the adapter exits unexpectedly", () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      const client = yield* Effect.promise(() => DapClient.create({ spec: fakeSpec(), cwd: dir }))
      const failure = yield* Effect.promise(() =>
        client.request("crash").then(
          () => undefined,
          (error) => error as Error,
        ),
      )
      expect(failure?.message).toMatch(/debug adapter (output closed|exited with code 7)/)
      const closed = yield* Effect.promise(() => client.request("threads").catch((error) => error as Error))
      expect(closed.message).toContain("client is closed")
      expect(yield* Effect.promise(() => client.process.exited)).toBe(7)
    }),
  )

  it.instance("fails initialization promptly when the adapter exits", () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      const started = Date.now()
      const failure = yield* Effect.promise(() =>
        DapClient.create({
          spec: { ...fakeSpec(), args: ["-e", "process.exit(7)"] },
          cwd: dir,
        }).then(
          () => undefined,
          (error) => error as Error,
        ),
      )
      expect(failure?.name).toBe("DapInitializeError")
      expect(Date.now() - started).toBeLessThan(5_000)
    }),
  )

  it.instance("bounds pending requests and event subscribers", () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      const client = yield* Effect.promise(() => DapClient.create({ spec: fakeSpec(), cwd: dir }))
      const pending = Array.from({ length: 128 }, () => client.request("hang").catch((error) => error))
      const overflow = yield* Effect.promise(() => client.request("hang").catch((error) => error as Error))
      expect(overflow.message).toContain("pending request limit exceeded (128)")

      const subscriptions = Array.from({ length: 128 }, () => client.onEvent(() => {}))
      expect(() => client.onEvent(() => {})).toThrow("event handler limit exceeded (128)")
      subscriptions.forEach((unsubscribe) => unsubscribe())
      yield* Effect.promise(() => client.shutdown())
      yield* Effect.promise(() => Promise.all(pending))
    }),
  )
})
