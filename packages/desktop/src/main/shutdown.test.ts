import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { createDesktopShutdown } from "./shutdown"
import { managedBrowserInputFixtureEnvironment, managedBrowserInputFixtureExecutable } from "./fixture/managed-browser-input-runtime"

test("a failed stop is reported once without calling it again or claiming graceful completion", async () => {
  const facts = { stops: 0, quit: 0, exit: 0, relaunch: 0, errors: [] as unknown[] }
  const error = new Error("original stop failed")
  const shutdown = createDesktopShutdown({
    stop: () => {
      facts.stops++
      return Promise.reject(error)
    },
    quit: () => {
      facts.quit++
    },
    exit: () => {
      facts.exit++
    },
    relaunch: () => {
      facts.relaunch++
    },
    onError: (value) => {
      facts.errors.push(value)
    },
  })
  const first = shutdown.stop()
  expect(shutdown.stop()).toBe(first)
  const terminal = shutdown.relaunch()
  const signal = shutdown.signal()
  await expect(first).rejects.toBe(error)
  await Promise.all([terminal, signal, shutdown.signal()])
  expect(facts).toEqual({ stops: 1, quit: 0, exit: 1, relaunch: 0, errors: [error] })
})

for (const scenario of ["quit", "signal", "relaunch", "routine"] as const) {
  test(`actual Electron ${scenario} joins one delayed utility stop before its final action`, async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dac-desktop-shutdown-")))
    await fs.chmod(root, 0o700)
    await fs.mkdir(path.join(root, "home"), { mode: 0o700 })
    const built = await Bun.build({
      entrypoints: [
        path.join(import.meta.dir, "fixture/shutdown-main.ts"),
        path.join(import.meta.dir, "fixture/shutdown-utility.ts"),
      ],
      outdir: root,
      target: "node",
      external: ["electron"],
    })
    expect(built.success).toBe(true)
    await fs.symlink(path.resolve(import.meta.dir, "../../node_modules"), path.join(root, "node_modules"), "dir")
    const child = Bun.spawn(
      [managedBrowserInputFixtureExecutable, path.join(root, "shutdown-main.js")],
      {
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
      },
    )
    const deadline = setTimeout(() => child.kill(), 15_000)
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    clearTimeout(deadline)
    await fs.writeFile(path.join(root, "process.log"), stdout + stderr, { mode: 0o600 })
    console.log("DESKTOP_SHUTDOWN_EVIDENCE", scenario, root)
    expect({ code, error: code ? stdout + stderr : null }).toEqual({ code: 0, error: null })
    const facts = await Bun.file(path.join(root, "main.json")).json()
    const utility = await Bun.file(path.join(root, "utility.json")).json()
    expect(facts.stops).toBe(scenario === "routine" ? 2 : 1)
    expect(facts.emptyStops).toBe(scenario === "routine" ? 1 : 0)
    expect(facts.utilityStops).toBe(1)
    expect(utility.stops).toBe(1)
    expect(utility.exitingAt - utility.acceptedAt).toBeGreaterThanOrEqual(100)
    expect(facts.actionsWhenStopping).toBe(0)
    expect(facts.joined).toBe(true)
    expect(facts.prevented).toBeGreaterThanOrEqual(2)
    expect(facts.childExit).toBe(true)
    expect(facts.childCode).toBe(0)
    expect(facts.actionAt).toBeGreaterThanOrEqual(facts.childExitedAt)
    expect(facts.errors).toEqual([])
    expect(facts.quitActions).toBe(scenario === "quit" || scenario === "routine" ? 1 : 0)
    expect(facts.exitActions).toBe(scenario === "quit" || scenario === "routine" ? 0 : 1)
    expect(facts.relaunchActions).toBe(scenario === "relaunch" ? 1 : 0)
    expect(facts.willQuit).toBe(scenario === "quit" || scenario === "routine" ? 1 : 0)
    if (scenario === "signal") expect(facts.signals).toBeGreaterThanOrEqual(1)
  }, 20_000)
}
