import { afterAll, beforeEach, describe, expect, it } from "bun:test"
import { Effect, Option, Result } from "effect"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { mkdtemp, readFile, rm, stat } from "fs/promises"
import { tmpdir } from "os"
import path from "path"
import { ServerMode } from "../src/services/server-mode"

// Behavior-controllable mock of the Server Edition gateway (server-v1 §7/§8).
const gateway = {
  validAccess: "tok-1",
  refreshCalls: 0,
  wrapped: false,
}

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url)
    const auth = req.headers.get("authorization")

    if (url.pathname === "/control/v1/auth/login" && req.method === "POST") {
      const body = (await req.json()) as { email?: string; password?: string }
      if (body.password !== "pw") {
        return Response.json({ error: { code: "UNAUTHORIZED", message: "bad credentials" } }, { status: 401 })
      }
      gateway.validAccess = "tok-1"
      if (body.email === "cookie@x.y") {
        return new Response(JSON.stringify({ access_token: "tok-1", expires_in: 900 }), {
          headers: {
            "content-type": "application/json",
            "set-cookie": "refresh_token=ref-cookie; HttpOnly; Path=/",
          },
        })
      }
      return Response.json({ access_token: "tok-1", refresh_token: "ref-1", expires_in: 900 })
    }

    if (url.pathname === "/control/v1/auth/refresh" && req.method === "POST") {
      gateway.refreshCalls++
      if (auth === "Bearer ref-1" || auth === "Bearer ref-cookie") {
        gateway.validAccess = "tok-2"
        return Response.json({ access_token: "tok-2", refresh_token: "ref-2", expires_in: 900 })
      }
      return Response.json({ error: { code: "UNAUTHORIZED", message: "invalid refresh token" } }, { status: 401 })
    }

    if (url.pathname === "/control/v1/workspaces" && req.method === "GET") {
      if (auth !== `Bearer ${gateway.validAccess}`) {
        return Response.json({ error: { code: "UNAUTHORIZED", message: "stale token" } }, { status: 401 })
      }
      const list = [{ id: "ws-1", name: "proj-a", status: "RUNNING" }]
      return gateway.wrapped ? Response.json({ workspaces: list }) : Response.json(list)
    }

    if (url.pathname === "/control/v1/auth/logout" && req.method === "POST") {
      return new Response(null, { status: 204 })
    }

    if (url.pathname === "/w/ws-1/ping" && req.method === "GET") {
      if (auth !== `Bearer ${gateway.validAccess}`) {
        return Response.json({ error: { code: "UNAUTHORIZED", message: "stale token" } }, { status: 401 })
      }
      return Response.json({ ok: true })
    }

    return Response.json({ error: { code: "NOT_FOUND", message: "not found" } }, { status: 404 })
  },
})

const base = `http://127.0.0.1:${server.port}`

const run = <A, E>(effect: Effect.Effect<A, E, ServerMode.Service>) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(ServerMode.defaultLayer), Effect.provide(NodeServices.layer), Effect.scoped),
  )

const service = Effect.gen(function* () {
  return yield* ServerMode.Service
})

let home: string
const homes: string[] = []

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "dacode-cli-test-"))
  homes.push(home)
  process.env.DEEPAGENT_CODE_HOME = home
  delete process.env.DEEPAGENT_GATEWAY_URL
  gateway.validAccess = "tok-1"
  gateway.refreshCalls = 0
  gateway.wrapped = false
})

afterAll(async () => {
  delete process.env.DEEPAGENT_CODE_HOME
  server.stop()
  await Promise.all(homes.map((dir) => rm(dir, { recursive: true, force: true })))
})

const stateFile = () => path.join(home, "state", "server-mode.json")

describe("ServerMode.login", () => {
  it("stores state with 0600 permissions and tokens from the response body", async () => {
    const state = await run(service.pipe(Effect.flatMap((s) => s.login(base, "a@b.c", "pw"))))

    expect(state.gatewayUrl).toBe(base)
    expect(state.accessToken).toBe("tok-1")
    expect(state.refreshToken).toBe("ref-1")
    expect(state.expiresAt).toBeGreaterThan(Date.now())

    const info = await stat(stateFile())
    expect(info.mode & 0o777).toBe(0o600)
    const persisted = JSON.parse(await readFile(stateFile(), "utf8"))
    expect(persisted.accessToken).toBe("tok-1")
    expect(persisted.refreshToken).toBe("ref-1")
  })

  it("falls back to the Set-Cookie refresh token when the body omits it", async () => {
    const state = await run(service.pipe(Effect.flatMap((s) => s.login(base, "cookie@x.y", "pw"))))
    expect(state.accessToken).toBe("tok-1")
    expect(state.refreshToken).toBe("ref-cookie")
  })

  it("fails with the gateway error message on bad credentials", async () => {
    const result = await run(service.pipe(Effect.flatMap((s) => s.login(base, "a@b.c", "nope")), Effect.result))
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) expect(String(result.failure)).toContain("bad credentials")
  })
})

describe("ServerMode.workspaces", () => {
  it("refreshes a stale access token and retries once", async () => {
    const list = await run(
      service.pipe(
        Effect.flatMap((s) => s.login(base, "a@b.c", "pw")),
        // Simulate the gateway having rotated the token server-side
        Effect.tap(() => Effect.sync(() => (gateway.validAccess = "tok-2"))),
        Effect.flatMap(() => service),
        Effect.flatMap((s) => s.workspaces()),
      ),
    )

    expect(list).toEqual([{ id: "ws-1", name: "proj-a", status: "RUNNING" }])
    expect(gateway.refreshCalls).toBe(1)

    const persisted = JSON.parse(await readFile(stateFile(), "utf8"))
    expect(persisted.accessToken).toBe("tok-2")
    expect(persisted.refreshToken).toBe("ref-2")
  })

  it("accepts a wrapped { workspaces: [...] } response shape", async () => {
    gateway.wrapped = true
    const list = await run(service.pipe(Effect.flatMap((s) => s.login(base, "a@b.c", "pw")), Effect.flatMap(() => service), Effect.flatMap((s) => s.workspaces())))
    expect(list).toEqual([{ id: "ws-1", name: "proj-a", status: "RUNNING" }])
  })

  it("fails with a login hint when DEEPAGENT_GATEWAY_URL pins a different gateway", async () => {
    const result = await run(
      service.pipe(
        Effect.flatMap((s) => s.login(base, "a@b.c", "pw")),
        Effect.tap(() => Effect.sync(() => (process.env.DEEPAGENT_GATEWAY_URL = "http://127.0.0.1:1"))),
        Effect.flatMap(() => service),
        Effect.flatMap((s) => s.workspaces()),
        Effect.result,
      ),
    )
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) expect(String(result.failure)).toContain("Not logged in to http://127.0.0.1:1")
  })
})

describe("ServerMode.useWorkspace", () => {
  it("persists the selection and rejects unknown ids", async () => {
    const found = await run(
      service.pipe(
        Effect.flatMap((s) => s.login(base, "a@b.c", "pw")),
        Effect.flatMap(() => service),
        Effect.flatMap((s) => s.useWorkspace("ws-1")),
      ),
    )
    expect(found.name).toBe("proj-a")
    expect(JSON.parse(await readFile(stateFile(), "utf8")).workspaceId).toBe("ws-1")

    const missing = await run(service.pipe(Effect.flatMap((s) => s.useWorkspace("ws-bad")), Effect.result))
    expect(Result.isFailure(missing)).toBe(true)
    if (Result.isFailure(missing)) expect(String(missing.failure)).toContain("ws-bad")
  })
})

describe("ServerMode.transport", () => {
  it("is none when server mode is not active", async () => {
    const transport = await run(service.pipe(Effect.flatMap((s) => s.transport())))
    expect(Option.isNone(transport)).toBe(true)
  })

  it("targets /w/:id and its fetch injects auth with 401 refresh retry", async () => {
    const transport = await run(
      service.pipe(
        Effect.flatMap((s) => s.login(base, "a@b.c", "pw")),
        Effect.flatMap(() => service),
        Effect.flatMap((s) => s.useWorkspace("ws-1")),
        Effect.flatMap(() => service),
        Effect.flatMap((s) => s.transport()),
      ),
    )
    expect(Option.isSome(transport)).toBe(true)
    if (Option.isNone(transport)) return
    expect(transport.value.url).toBe(`${base}/w/ws-1`)

    // Stale token on the wire: the fetch must refresh and retry transparently
    gateway.validAccess = "tok-2"
    const response = await transport.value.fetch(`${transport.value.url}/ping`)
    expect(response.status).toBe(200)
    expect(gateway.refreshCalls).toBe(1)
  })

  it("fails when logged in but no workspace is selected", async () => {
    const result = await run(
      service.pipe(Effect.flatMap((s) => s.login(base, "a@b.c", "pw")), Effect.flatMap(() => service), Effect.flatMap((s) => s.transport()), Effect.result),
    )
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) expect(String(result.failure)).toContain("No workspace selected")
  })
})
