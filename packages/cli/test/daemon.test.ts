import { afterAll, beforeEach, describe, expect, it } from "bun:test"
import { InstallationVersion } from "@deepagent-code/core/installation/version"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Effect, FileSystem, Layer } from "effect"
import { access, mkdir, readFile, rm, writeFile } from "fs/promises"
import { mkdtemp } from "fs/promises"
import { tmpdir } from "os"
import path from "path"
import { Daemon } from "../src/services/daemon"

const withDaemon = <A>(
  use: (daemon: Daemon.Interface) => Effect.Effect<A, unknown, never>,
  layer: Layer.Layer<Daemon.Service, never, FileSystem.FileSystem> = Daemon.defaultLayer,
) =>
  Effect.runPromise(
    Effect.flatMap(Daemon.Service, use).pipe(Effect.provide(layer), Effect.provide(NodeServices.layer), Effect.scoped),
  )

const exists = (file: string) =>
  access(file).then(
    () => true,
    () => false,
  )

const fixtureEntrypoint = path.join(__dirname, "fixtures", "v2-entry.ts")

let home: string
const homes: string[] = []

const stateFile = () => path.join(home, "state", "server.json")

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "lildax-daemon-test-"))
  homes.push(home)
  await mkdir(path.join(home, "state"), { recursive: true })
  process.env.DEEPAGENT_CODE_TEST_HOME = home
  process.env.DEEPAGENT_CODE_HOME = home
  process.env.DEEPAGENT_CODE_DAEMON_FIXTURE_VERSION = InstallationVersion
})

afterAll(async () => {
  delete process.env.DEEPAGENT_CODE_DAEMON_FIXTURE_VERSION
  delete process.env.DEEPAGENT_CODE_HOME
  delete process.env.DEEPAGENT_CODE_TEST_HOME
  await Promise.all(homes.map((dir) => rm(dir, { recursive: true, force: true })))
})

function fakeV2Server(expectedPassword: () => string) {
  let seenAuth: string | undefined
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const url = new URL(request.url)
      if (url.pathname !== "/api/health") return Response.json({ error: "not found" }, { status: 404 })
      seenAuth = request.headers.get("authorization") ?? undefined
      const expected = `Basic ${Buffer.from(`deepagent-code:${expectedPassword()}`).toString("base64")}`
      if (seenAuth !== expected) return Response.json({ error: "unauthorized" }, { status: 401 })
      return Response.json({ healthy: true })
    },
  })
  return { server, url: `http://127.0.0.1:${server.port}`, seenAuth: () => seenAuth }
}

describe("daemon Core V2 backend", () => {
  it("resolves a V2 registration through authenticated /api/health", async () => {
    let password = ""
    const fake = fakeV2Server(() => password)
    try {
      password = await withDaemon((daemon) => daemon.password())
      await writeFile(
        stateFile(),
        JSON.stringify({ id: "fixed", version: InstallationVersion, url: fake.url, pid: process.pid }),
      )
      const url = await withDaemon((daemon) => daemon.status())
      expect(url).toBe(fake.url)
      expect(fake.seenAuth()).toBe(`Basic ${Buffer.from(`deepagent-code:${password}`).toString("base64")}`)
    } finally {
      fake.server.stop()
    }
  })

  it("treats an unauthenticated V2 server as unhealthy and clears the registration", async () => {
    const fake = fakeV2Server(() => "some-other-secret")
    try {
      await withDaemon((daemon) => daemon.password("daemon-secret"))
      await writeFile(
        stateFile(),
        JSON.stringify({ id: "fixed", version: InstallationVersion, url: fake.url, pid: process.pid }),
      )
      expect(await withDaemon((daemon) => daemon.status())).toBeUndefined()
      expect(await exists(stateFile())).toBe(false)
    } finally {
      fake.server.stop()
    }
  })

  it("spawns only the V2 entrypoint and stops the registered process", async () => {
    const daemonLayer = Daemon.layerForEntrypoint(fixtureEntrypoint)
    const url = await withDaemon((daemon) => daemon.start(), daemonLayer)
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)

    const registration = JSON.parse(await readFile(stateFile(), "utf8"))
    expect(registration.version).toBe(InstallationVersion)
    expect(registration.url).toBe(url)
    expect(registration.pid).toBeGreaterThan(0)

    const password = await withDaemon((daemon) => daemon.password(), daemonLayer)
    const health = await fetch(`${url}/api/health`, {
      headers: { Authorization: `Basic ${Buffer.from(`deepagent-code:${password}`).toString("base64")}` },
    })
    expect(health.status).toBe(200)
    expect(await health.json()).toEqual({ healthy: true })

    await withDaemon((daemon) => daemon.stop(), daemonLayer)
    expect(await exists(stateFile())).toBe(false)

    const pid = registration.pid as number
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        process.kill(pid, 0)
      } catch {
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error(`V2 server process ${pid} is still running after stop()`)
  }, 15_000)
})
