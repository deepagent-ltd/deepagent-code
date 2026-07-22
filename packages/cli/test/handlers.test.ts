import { afterAll, beforeEach, describe, expect, it } from "bun:test"
import { Effect, Option, Result } from "effect"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { mkdtemp, readFile, rm } from "fs/promises"
import { tmpdir } from "os"
import path from "path"
import { ServerMode } from "../src/services/server-mode"
import login from "../src/commands/handlers/login"
import logout from "../src/commands/handlers/logout"
import workspaceList from "../src/commands/handlers/workspace/list"
import workspaceUse from "../src/commands/handlers/workspace/use"

// Same gateway contract as test/server-mode.test.ts: camelCase accessToken in
// the body, refresh token as HttpOnly cookie, one container per user.
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === "/control/v1/auth/login" && req.method === "POST") {
      const body = (await req.json()) as { password?: string }
      if (body.password !== "pw") {
        return Response.json({ error: { message: "bad credentials" } }, { status: 401 })
      }
      return Response.json(
        { accessToken: "tok", user: { id: "u-1" } },
        { headers: { "set-cookie": "refresh_token=ref; HttpOnly; Path=/" } },
      )
    }
    if (url.pathname === "/control/v1/containers") {
      return Response.json({ id: "ctr-1", status: "running" })
    }
    if (url.pathname === "/control/v1/auth/logout" && req.method === "POST") {
      return new Response(null, { status: 204 })
    }
    return Response.json({ error: { message: "not found" } }, { status: 404 })
  },
})
const base = `http://127.0.0.1:${server.port}`

const run = <A, E>(effect: Effect.Effect<A, E, ServerMode.Service>) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(ServerMode.defaultLayer), Effect.provide(NodeServices.layer), Effect.scoped),
  )

const capture = async <A>(fn: () => Promise<A>) => {
  const chunks: string[] = []
  const original = process.stdout.write
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"))
    return true
  }) as typeof process.stdout.write
  try {
    return { value: await fn(), output: chunks.join("") }
  } finally {
    process.stdout.write = original
  }
}

let home: string
const homes: string[] = []

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "dacode-cli-test-"))
  homes.push(home)
  process.env.DEEPAGENT_CODE_HOME = home
  delete process.env.DEEPAGENT_GATEWAY_URL
})

afterAll(async () => {
  delete process.env.DEEPAGENT_CODE_HOME
  server.stop()
  await Promise.all(homes.map((dir) => rm(dir, { recursive: true, force: true })))
})

const stateFile = () => path.join(home, "state", "server-mode.json")

const credentials = {
  gateway: Option.some(base),
  email: Option.some("a@b.c"),
  password: Option.some("pw"),
}

describe("login handler", () => {
  it("logs in with flag-provided credentials and points at workspace selection next", async () => {
    const { output } = await capture(() => run(login(credentials)))
    expect(output).toContain(`Logged in to ${base} as a@b.c.`)
    expect(output).toContain("dacode workspace list")
    expect(JSON.parse(await readFile(stateFile(), "utf8")).accessToken).toBe("tok")
  })

  it("fails with a clear message when neither the argument nor DEEPAGENT_GATEWAY_URL is set", async () => {
    const result = await run(
      login({ gateway: Option.none(), email: Option.some("a@b.c"), password: Option.some("pw") }).pipe(
        Effect.result,
      ),
    )
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) expect(String(result.failure)).toContain("Gateway URL required")
  })

  it("falls back to DEEPAGENT_GATEWAY_URL for the gateway argument", async () => {
    process.env.DEEPAGENT_GATEWAY_URL = `${base}/`
    const { output } = await capture(() =>
      run(login({ gateway: Option.none(), email: Option.some("a@b.c"), password: Option.some("pw") })),
    )
    expect(output).toContain(`Logged in to ${base} as a@b.c.`)
  })
})

describe("logout handler", () => {
  it("drops the stored server-mode state", async () => {
    await run(login(credentials))
    const { output } = await capture(() => run(logout({})))
    expect(output).toContain("Logged out.")
    const status = await run(Effect.flatMap(ServerMode.Service, (serverMode) => serverMode.status()))
    expect(Option.isNone(status)).toBe(true)
  })
})

describe("workspace handlers", () => {
  it("list shows the container, use persists and marks the selection", async () => {
    await run(login(credentials))

    const before = await capture(() => run(workspaceList({})))
    expect(before.output).toContain("  ctr-1")
    expect(before.output).not.toContain("* ctr-1")

    const used = await capture(() => run(workspaceUse({ id: "ctr-1" })))
    expect(used.output).toContain("Using workspace ctr-1.")
    expect(JSON.parse(await readFile(stateFile(), "utf8")).workspaceId).toBe("ctr-1")

    const after = await capture(() => run(workspaceList({})))
    expect(after.output).toContain("* ctr-1")
  })

  it("use rejects an unknown workspace id with a list hint", async () => {
    await run(login(credentials))
    const result = await run(workspaceUse({ id: "ctr-bad" }).pipe(Effect.result))
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(String(result.failure)).toContain("ctr-bad")
      expect(String(result.failure)).toContain("dacode workspace list")
    }
  })
})
