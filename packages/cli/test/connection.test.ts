import { afterAll, beforeEach, describe, expect, it } from "bun:test"
import { Effect, Layer, Result } from "effect"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { mkdtemp, rm } from "fs/promises"
import { tmpdir } from "os"
import path from "path"
import { Connection } from "../src/services/connection"
import { Daemon } from "../src/services/daemon"
import { ServerMode } from "../src/services/server-mode"

// Minimal gateway: login + one-container-per-user endpoints (the full contract
// is covered by test/server-mode.test.ts).
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === "/control/v1/auth/login" && req.method === "POST") {
      return Response.json(
        { accessToken: "tok", user: { id: "u-1" } },
        { headers: { "set-cookie": "refresh_token=ref; HttpOnly; Path=/" } },
      )
    }
    if (url.pathname === "/control/v1/containers") {
      return Response.json({ id: "ctr-1", status: "running" })
    }
    return Response.json({ error: { message: "not found" } }, { status: 404 })
  },
})
const base = `http://127.0.0.1:${server.port}`

// The daemon is stubbed at the service boundary (booting the real one spawns a
// process). The sentinel URL and call count prove which transport won.
const daemon = { calls: 0 }
const daemonLayer = Layer.succeed(
  Daemon.Service,
  Daemon.Service.of({
    client: () => Effect.die("unused"),
    transport: () =>
      Effect.sync(() => {
        daemon.calls++
        return { url: "daemon://local", headers: {} }
      }),
    start: () => Effect.die("unused"),
    status: () => Effect.succeed(undefined),
    stop: () => Effect.void,
    password: () => Effect.die("unused"),
    register: () => Effect.die("unused"),
  }),
)

const run = <A, E>(effect: Effect.Effect<A, E, Connection.Service | ServerMode.Service>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(Connection.defaultLayer),
      Effect.provide(ServerMode.defaultLayer),
      Effect.provide(daemonLayer),
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

const transport = Effect.flatMap(Connection.Service, (connection) => connection.transport())

const login = Effect.fnUntraced(function* (selectWorkspace: boolean) {
  const serverMode = yield* ServerMode.Service
  yield* serverMode.login(base, "a@b.c", "pw")
  if (selectWorkspace) yield* serverMode.useWorkspace("ctr-1")
})

let home: string
const homes: string[] = []

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "dacode-cli-test-"))
  homes.push(home)
  process.env.DEEPAGENT_CODE_HOME = home
  delete process.env.DEEPAGENT_GATEWAY_URL
  daemon.calls = 0
})

afterAll(async () => {
  delete process.env.DEEPAGENT_CODE_HOME
  server.stop()
  await Promise.all(homes.map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("Connection.transport", () => {
  it("falls back to the local daemon when server mode is not active", async () => {
    const result = await run(transport)
    expect(result.url).toBe("daemon://local")
    expect(daemon.calls).toBe(1)
  })

  it("prefers the server-mode gateway once logged in with a workspace selected", async () => {
    const result = await run(login(true).pipe(Effect.andThen(transport)))
    expect(result.url).toBe(`${base}/w`)
    expect(daemon.calls).toBe(0)
  })

  it("fails fast with a workspace hint instead of silently falling back when no workspace is selected", async () => {
    const result = await run(login(false).pipe(Effect.andThen(transport), Effect.result))
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) expect(String(result.failure)).toContain("No workspace selected")
    expect(daemon.calls).toBe(0)
  })
})
