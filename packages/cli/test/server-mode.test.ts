import { afterAll, beforeEach, describe, expect, it } from "bun:test"
import { Effect, Option, Result } from "effect"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { mkdtemp, readFile, rm, stat } from "fs/promises"
import { tmpdir } from "os"
import path from "path"
import { ServerMode } from "../src/services/server-mode"

// Behavior-controllable mock of the Server Edition gateway, matching the
// contract verified against deepagent-server (see packages/app/src/utils/gateway-client.ts):
//   - login returns camelCase { accessToken, user } + Set-Cookie refresh_token
//   - refresh reads the refresh_token cookie and returns { accessToken }
//   - one container per user: GET /control/v1/containers (200 object | 404),
//     POST /control/v1/containers provisions it (200 exists | 202 creating)
//   - data-plane proxy base is a bare /w, located by JWT
const gateway = {
  validAccess: "tok-1",
  refreshCalls: 0,
  provisioned: true,
  sessionBodies: [] as string[],
}

const container = () => ({ id: "ctr-1", userId: "u-1", status: "running", imageVersion: "v1", createdAt: 0 })

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url)
    const auth = req.headers.get("authorization")
    const cookie = req.headers.get("cookie")

    if (url.pathname === "/control/v1/auth/login" && req.method === "POST") {
      const body = (await req.json()) as { email?: string; password?: string }
      if (body.password !== "pw") {
        return Response.json({ error: { code: "UNAUTHORIZED", message: "bad credentials" } }, { status: 401 })
      }
      gateway.validAccess = "tok-1"
      if (body.email === "body@x.y") {
        // Tolerated legacy shape: refresh token in the JSON body, no cookie.
        return Response.json({ accessToken: "tok-1", refresh_token: "ref-body", user: { id: "u-1" } })
      }
      return Response.json(
        { accessToken: "tok-1", user: { id: "u-1", email: body.email, role: "user", orgId: "o-1" } },
        { headers: { "set-cookie": "refresh_token=ref-1; HttpOnly; Path=/" } },
      )
    }

    if (url.pathname === "/control/v1/auth/refresh" && req.method === "POST") {
      gateway.refreshCalls++
      if (auth === "Bearer ref-1" || cookie?.includes("refresh_token=ref-1")) {
        gateway.validAccess = "tok-2"
        return Response.json(
          { accessToken: "tok-2" },
          { headers: { "set-cookie": "refresh_token=ref-2; HttpOnly; Path=/" } },
        )
      }
      return Response.json({ error: { code: "UNAUTHORIZED", message: "invalid refresh token" } }, { status: 401 })
    }

    if (url.pathname === "/control/v1/containers") {
      if (auth !== `Bearer ${gateway.validAccess}`) {
        return Response.json({ error: { code: "UNAUTHORIZED", message: "stale token" } }, { status: 401 })
      }
      if (req.method === "GET") {
        if (!gateway.provisioned) {
          return Response.json({ error: { code: "CONTAINER_NOT_FOUND", message: "no container" } }, { status: 404 })
        }
        return Response.json(container())
      }
      if (req.method === "POST") {
        const existed = gateway.provisioned
        gateway.provisioned = true
        return Response.json(
          existed ? container() : { ...container(), status: "creating" },
          { status: existed ? 200 : 202 },
        )
      }
    }

    if (url.pathname === "/control/v1/auth/logout" && req.method === "POST") {
      return new Response(null, { status: 204 })
    }

    if (url.pathname === "/w/ping" && req.method === "GET") {
      if (auth !== `Bearer ${gateway.validAccess}`) {
        return Response.json({ error: { code: "UNAUTHORIZED", message: "stale token" } }, { status: 401 })
      }
      return Response.json({ ok: true })
    }

    if (url.pathname === "/w/session" && req.method === "POST") {
      gateway.sessionBodies.push(await req.text())
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
  gateway.provisioned = true
  gateway.sessionBodies = []
})

afterAll(async () => {
  delete process.env.DEEPAGENT_CODE_HOME
  server.stop()
  await Promise.all(homes.map((dir) => rm(dir, { recursive: true, force: true })))
})

const stateFile = () => path.join(home, "state", "server-mode.json")

describe("ServerMode.login", () => {
  it("stores state with 0600 permissions, the camelCase access token, and the cookie refresh token", async () => {
    const state = await run(service.pipe(Effect.flatMap((s) => s.login(base, "a@b.c", "pw"))))

    expect(state.gatewayUrl).toBe(base)
    expect(state.accessToken).toBe("tok-1")
    expect(state.refreshToken).toBe("ref-1")

    const info = await stat(stateFile())
    expect(info.mode & 0o777).toBe(0o600)
    const persisted = JSON.parse(await readFile(stateFile(), "utf8"))
    expect(persisted.accessToken).toBe("tok-1")
    expect(persisted.refreshToken).toBe("ref-1")
  })

  it("falls back to a refresh token in the response body when no cookie is set", async () => {
    const state = await run(service.pipe(Effect.flatMap((s) => s.login(base, "body@x.y", "pw"))))
    expect(state.accessToken).toBe("tok-1")
    expect(state.refreshToken).toBe("ref-body")
  })

  it("fails with the gateway error message on bad credentials", async () => {
    const result = await run(service.pipe(Effect.flatMap((s) => s.login(base, "a@b.c", "nope")), Effect.result))
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) expect(String(result.failure)).toContain("bad credentials")
  })

  it("keeps the selected workspace when re-logging into the same gateway", async () => {
    const state = await run(
      service.pipe(
        Effect.flatMap((s) => s.login(base, "a@b.c", "pw")),
        Effect.flatMap(() => service),
        Effect.flatMap((s) => s.useWorkspace("ctr-1")),
        Effect.flatMap(() => service),
        Effect.flatMap((s) => s.login(base, "a@b.c", "pw")),
        Effect.flatMap(() => service),
        Effect.flatMap((s) => s.status()),
      ),
    )
    expect(Option.isSome(state)).toBe(true)
    if (Option.isSome(state)) expect(state.value.workspaceId).toBe("ctr-1")
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

    expect(list).toEqual([{ id: "ctr-1", status: "running" }])
    expect(gateway.refreshCalls).toBe(1)

    const persisted = JSON.parse(await readFile(stateFile(), "utf8"))
    expect(persisted.accessToken).toBe("tok-2")
    expect(persisted.refreshToken).toBe("ref-2")
  })

  it("provisions the container via POST when GET returns 404", async () => {
    gateway.provisioned = false
    const list = await run(
      service.pipe(
        Effect.flatMap((s) => s.login(base, "a@b.c", "pw")),
        Effect.flatMap(() => service),
        Effect.flatMap((s) => s.workspaces()),
      ),
    )
    expect(list).toEqual([{ id: "ctr-1", status: "creating" }])
    expect(gateway.provisioned).toBe(true)
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

  it("accepts a pinned DEEPAGENT_GATEWAY_URL with a trailing slash", async () => {
    const transport = await run(
      service.pipe(
        Effect.flatMap((s) => s.login(base, "a@b.c", "pw")),
        Effect.flatMap(() => service),
        Effect.flatMap((s) => s.useWorkspace("ctr-1")),
        Effect.tap(() => Effect.sync(() => (process.env.DEEPAGENT_GATEWAY_URL = `${base}/`))),
        Effect.flatMap(() => service),
        Effect.flatMap((s) => s.transport()),
      ),
    )
    expect(Option.isSome(transport)).toBe(true)
  })
})

describe("ServerMode.useWorkspace", () => {
  it("persists the selection and rejects unknown ids", async () => {
    const found = await run(
      service.pipe(
        Effect.flatMap((s) => s.login(base, "a@b.c", "pw")),
        Effect.flatMap(() => service),
        Effect.flatMap((s) => s.useWorkspace("ctr-1")),
      ),
    )
    expect(found.id).toBe("ctr-1")
    expect(JSON.parse(await readFile(stateFile(), "utf8")).workspaceId).toBe("ctr-1")

    const missing = await run(service.pipe(Effect.flatMap((s) => s.useWorkspace("ctr-bad")), Effect.result))
    expect(Result.isFailure(missing)).toBe(true)
    if (Result.isFailure(missing)) expect(String(missing.failure)).toContain("ctr-bad")
  })
})

describe("ServerMode.transport", () => {
  it("is none when server mode is not active", async () => {
    const transport = await run(service.pipe(Effect.flatMap((s) => s.transport())))
    expect(Option.isNone(transport)).toBe(true)
  })

  it("targets the bare /w proxy and its fetch injects auth with 401 refresh retry", async () => {
    const transport = await run(
      service.pipe(
        Effect.flatMap((s) => s.login(base, "a@b.c", "pw")),
        Effect.flatMap(() => service),
        Effect.flatMap((s) => s.useWorkspace("ctr-1")),
        Effect.flatMap(() => service),
        Effect.flatMap((s) => s.transport()),
      ),
    )
    expect(Option.isSome(transport)).toBe(true)
    if (Option.isNone(transport)) return
    expect(transport.value.url).toBe(`${base}/w`)

    // Stale token on the wire: the fetch must refresh and retry transparently
    gateway.validAccess = "tok-2"
    const response = await transport.value.fetch(`${transport.value.url}/ping`)
    expect(response.status).toBe(200)
    expect(gateway.refreshCalls).toBe(1)
  })

  it("replays a POST Request with a body after a 401 refresh", async () => {
    const transport = await run(
      service.pipe(
        Effect.flatMap((s) => s.login(base, "a@b.c", "pw")),
        Effect.flatMap(() => service),
        Effect.flatMap((s) => s.useWorkspace("ctr-1")),
        Effect.flatMap(() => service),
        Effect.flatMap((s) => s.transport()),
      ),
    )
    expect(Option.isSome(transport)).toBe(true)
    if (Option.isNone(transport)) return

    // The SDK passes a single Request object; its body is consumed by the
    // first attempt, so the retry must replay a clone.
    gateway.validAccess = "tok-2"
    const payload = JSON.stringify({ prompt: "hello" })
    const request = new Request(`${base}/w/session`, {
      method: "POST",
      body: payload,
      headers: { "content-type": "application/json" },
    })
    const response = await transport.value.fetch(request)
    expect(response.status).toBe(200)
    expect(gateway.refreshCalls).toBe(1)
    expect(gateway.sessionBodies).toEqual([payload, payload])
  })

  it("fails when logged in but no workspace is selected", async () => {
    const result = await run(
      service.pipe(Effect.flatMap((s) => s.login(base, "a@b.c", "pw")), Effect.flatMap(() => service), Effect.flatMap((s) => s.transport()), Effect.result),
    )
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) expect(String(result.failure)).toContain("No workspace selected")
  })
})
