// PARITY-003 (Wave 0): daemon mounting the legacy deepagent-code server.
//
// Covers the legacy-specific daemon paths without touching the v2 behavior:
//   * status() resolves a legacy registration through GET /global/health (Basic auth + version)
//   * an unauthenticated/unknown legacy server is treated as unhealthy and deregistered
//   * start() spawns the legacy entrypoint with the password in the environment, completes the
//     version handshake, and stop() tears the process down and removes the registration
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test"
import { InstallationVersion } from "@deepagent-code/core/installation/version"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Effect } from "effect"
import { mkdir, readFile, rm, writeFile, access } from "fs/promises"
import { mkdtemp } from "fs/promises"
import { tmpdir } from "os"
import path from "path"
import { Daemon } from "../src/services/daemon"

const run = <A, E>(effect: Effect.Effect<A, E, Daemon.Service>) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(Daemon.defaultLayer), Effect.provide(NodeServices.layer), Effect.scoped),
  )

const withDaemon = <A>(use: (daemon: Daemon.Interface) => Effect.Effect<A, unknown, never>) =>
  run(Effect.flatMap(Daemon.Service, use))

const exists = (file: string) => access(file).then(
  () => true,
  () => false,
)

const fixtureEntrypoint = path.join(__dirname, "fixtures", "legacy-entry.ts")

let home: string
const homes: string[] = []

const stateFile = () => path.join(home, "state", "server.json")

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "dacode-daemon-test-"))
  homes.push(home)
  await mkdir(path.join(home, "state"), { recursive: true })
  process.env.DEEPAGENT_CODE_TEST_HOME = home
  process.env.DEEPAGENT_CODE_HOME = home
  process.env.DEEPAGENT_CODE_DAEMON_BACKEND = "legacy"
  delete process.env.DEEPAGENT_CODE_DAEMON_LEGACY_ENTRYPOINT
  delete process.env.DEEPAGENT_CODE_DAEMON_FIXTURE_VERSION
})

afterEach(() => {
  delete process.env.DEEPAGENT_CODE_DAEMON_BACKEND
  delete process.env.DEEPAGENT_CODE_DAEMON_LEGACY_ENTRYPOINT
  delete process.env.DEEPAGENT_CODE_DAEMON_FIXTURE_VERSION
})

afterAll(async () => {
  delete process.env.DEEPAGENT_CODE_HOME
  delete process.env.DEEPAGENT_CODE_TEST_HOME
  await Promise.all(homes.map((dir) => rm(dir, { recursive: true, force: true })))
})

function fakeLegacyServer(version: string, expectedPassword?: () => string) {
  let seenAuth: string | undefined
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === "/global/health") {
        seenAuth = request.headers.get("authorization") ?? undefined
        const expected = `Basic ${Buffer.from(`deepagent-code:${expectedPassword?.() ?? ""}`).toString("base64")}`
        if (seenAuth !== expected) return Response.json({ error: "unauthorized" }, { status: 401 })
        return Response.json({ healthy: true, version, runtimeId: "fake" })
      }
      return Response.json({ error: "not found" }, { status: 404 })
    },
  })
  return { server, url: `http://127.0.0.1:${server.port}`, seenAuth: () => seenAuth }
}

describe("daemon legacy backend (PARITY-003)", () => {
  it("resolves a legacy registration through /global/health with Basic auth", async () => {
    let password = ""
    const fake = fakeLegacyServer(InstallationVersion, () => password)
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

  it("treats an unauthenticated legacy server as unhealthy and clears the registration", async () => {
    // The fake demands a password the daemon does not know (none generated yet on its side;
    // generate one that differs from the fake's expected credential).
    const fake = fakeLegacyServer(InstallationVersion, () => "some-other-secret")
    try {
      await withDaemon((daemon) => daemon.password("daemon-secret"))
      await writeFile(
        stateFile(),
        JSON.stringify({ id: "fixed", version: InstallationVersion, url: fake.url, pid: process.pid }),
      )
      const url = await withDaemon((daemon) => daemon.status())
      expect(url).toBeUndefined()
      expect(await exists(stateFile())).toBe(false)
    } finally {
      fake.server.stop()
    }
  })

  it("start() spawns the legacy entrypoint, completes the handshake, and stop() tears it down", async () => {
    process.env.DEEPAGENT_CODE_DAEMON_LEGACY_ENTRYPOINT = fixtureEntrypoint
    process.env.DEEPAGENT_CODE_DAEMON_FIXTURE_VERSION = InstallationVersion

    const url = await withDaemon((daemon) => daemon.start())
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)

    const registration = JSON.parse(await readFile(stateFile(), "utf8"))
    expect(registration.version).toBe(InstallationVersion)
    expect(registration.url).toBe(url)
    expect(registration.pid).toBeGreaterThan(0)

    // The spawned server received the daemon's password and authenticates health checks with it.
    const password = await withDaemon((daemon) => daemon.password())
    const health = await fetch(`${url}/global/health`, {
      headers: { Authorization: `Basic ${Buffer.from(`deepagent-code:${password}`).toString("base64")}` },
    })
    expect(health.status).toBe(200)
    expect(await health.json()).toMatchObject({ healthy: true, version: InstallationVersion })

    await withDaemon((daemon) => daemon.stop())
    expect(await exists(stateFile())).toBe(false)

    // The spawned process stepped down on SIGTERM.
    const pid = registration.pid as number
    for (let i = 0; i < 100; i++) {
      try {
        process.kill(pid, 0)
      } catch {
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error(`Legacy server process ${pid} is still running after stop()`)
  }, 15_000)
})
