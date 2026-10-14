import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { createDesktopShutdown } from "./shutdown"
import { managedBrowserInputFixtureEnvironment, managedBrowserInputFixtureExecutable } from "./fixture/managed-browser-input-runtime"

test("terminal shutdown closes a queued acquisition before it produces any side effects", async () => {
  const facts = { acquisitions: 0, stops: 0, exits: 0 }
  const shutdown = createDesktopShutdown({
    stop: async () => { facts.stops++ },
    quit: () => {},
    relaunch: () => {},
    exit: () => { facts.exits++ },
    onError: () => { throw new Error("stop must not fail") },
  })
  const pending = shutdown.start(async () => { facts.acquisitions++ })
  const terminal = shutdown.signal()
  expect(shutdown.closing).toBe(true)
  await expect(pending).rejects.toHaveProperty("code", "DESKTOP_STARTUP_CLOSED")
  await terminal
  await expect(shutdown.start(async () => { facts.acquisitions++ })).rejects.toHaveProperty("code", "DESKTOP_STARTUP_CLOSED")
  expect(facts).toEqual({ acquisitions: 0, stops: 1, exits: 1 })
})

test("terminal cancellation runs once while joining an already pending routine stop", async () => {
  const started = Promise.withResolvers<void>()
  const finish = Promise.withResolvers<void>()
  const facts = { cancellations: 0, stops: 0, exits: 0 }
  const shutdown = createDesktopShutdown({
    cancelBootstrap: async () => { facts.cancellations++ },
    stop: async () => { facts.stops++; started.resolve(); await finish.promise },
    quit: () => {},
    relaunch: () => {},
    exit: () => { facts.exits++ },
    onError: () => { throw new Error("stop must not fail") },
  })
  const routine = shutdown.stop()
  await started.promise
  const terminal = shutdown.signal()
  expect(shutdown.signal()).toBe(terminal)
  finish.resolve()
  await Promise.all([routine, terminal])
  expect(facts).toEqual({ cancellations: 1, stops: 1, exits: 1 })
})

for (const scenario of ["early", "acquiring", "signal"] as const) {
  test(`actual Electron ${scenario} shutdown owns original bootstrap and any late-adopted utility`, async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dac-desktop-bootstrap-")))
    await fs.chmod(root, 0o700)
    await fs.mkdir(path.join(root, "home"), { mode: 0o700 })
    const built = await Bun.build({
      entrypoints: [
        path.join(import.meta.dir, "fixture/shutdown-bootstrap.ts"),
        path.join(import.meta.dir, "fixture/shutdown-utility.ts"),
      ],
      outdir: root,
      target: "node",
      external: ["electron"],
    })
    expect(built.success).toBe(true)
    await fs.symlink(path.resolve(import.meta.dir, "../../node_modules"), path.join(root, "node_modules"), "dir")
    const child = Bun.spawn([managedBrowserInputFixtureExecutable, path.join(root, "shutdown-bootstrap.js")], {
      cwd: root,
      env: {
        ...managedBrowserInputFixtureEnvironment,
        PATH: process.env.PATH,
        HOME: path.join(root, "home"),
        TMPDIR: root,
        DAC_SHUTDOWN_ROOT: root,
        DAC_SHUTDOWN_UTILITY: path.join(root, "shutdown-utility.js"),
        DAC_SHUTDOWN_SCENARIO: scenario,
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const deadline = setTimeout(() => child.kill(), 15_000)
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    clearTimeout(deadline)
    await fs.writeFile(path.join(root, "process.log"), stdout + stderr, { mode: 0o600 })
    console.log("DESKTOP_BOOTSTRAP_EVIDENCE", scenario, root)
    expect({ code, error: code ? stdout + stderr : null }).toEqual({ code: 0, error: null })
    const facts = await Bun.file(path.join(root, "main.json")).json()
    expect(facts.bootstrapJoined).toBe(true)
    expect(facts.continuedBootstrap).toBe(0)
    expect(facts.publishedReady).toBe(0)
    expect(facts.stops).toBe(1)
    expect(facts.prevented).toBeGreaterThanOrEqual(2)
    expect(facts.errors).toEqual([])
    expect(facts.quitActions).toBe(scenario === "signal" ? 0 : 1)
    expect(facts.exitActions).toBe(scenario === "signal" ? 1 : 0)
    if (scenario === "signal") expect(facts.signals).toBeGreaterThanOrEqual(1)
    if (scenario === "early") {
      expect(facts.acquisitions).toBe(0)
      expect(facts.adopted).toBe(0)
      expect(facts.utilityStops).toBe(0)
      expect(await Bun.file(path.join(root, "utility.json")).exists()).toBe(false)
      return
    }
    const utility = await Bun.file(path.join(root, "utility.json")).json()
    expect(facts.acquisitions).toBe(1)
    expect(facts.adopted).toBe(1)
    expect(facts.utilityStops).toBe(1)
    expect(utility.stops).toBe(1)
    expect(facts.actionsWhileAcquiring).toBe(0)
    expect(facts.actionsWhenStopping).toBe(0)
    expect(facts.childExit).toBe(true)
    expect(facts.childCode).toBe(0)
    expect(facts.actionAt).toBeGreaterThanOrEqual(facts.childExitedAt)
  }, 20_000)
}
