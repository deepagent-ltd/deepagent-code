import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { managedBrowserInputFixtureEnvironment, managedBrowserInputFixtureExecutable } from "./fixture/managed-browser-input-runtime"

for (const scenario of ["merge", "occupied", "failure", "interrupt"]) {
  test(`actual Electron pre-ready storage awaits migration and preserves ${scenario} data`, async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dac-desktop-startup-")))
    await fs.chmod(root, 0o700)
    await fs.mkdir(path.join(root, "home"), { mode: 0o700 })
    const built = await Bun.build({ entrypoints: [path.join(import.meta.dir, "fixture/startup-entry.ts")], outdir: root, target: "node", external: ["electron"], splitting: true,
      define: { "import.meta.env.DEEPAGENT_CODE_CHANNEL": JSON.stringify("dev") } })
    expect(built.success).toBe(true)
    await Bun.write(path.join(root, "package.json"), JSON.stringify({ type: "module" }))
    await fs.symlink(path.resolve(import.meta.dir, "../../node_modules"), path.join(root, "node_modules"), "dir")
    const child = Bun.spawn([managedBrowserInputFixtureExecutable, path.join(root, "startup-entry.js")], {
      cwd: root,
      env: { ...managedBrowserInputFixtureEnvironment, PATH: process.env.PATH, HOME: path.join(root, "home"), TMPDIR: root,
        DEEPAGENT_CODE_TEST_ONBOARDING: "1", DEEPAGENT_CODE_TEST_ROOT: path.join(root, "home"),
        DAC_STARTUP_ROOT: root, DAC_STARTUP_SCENARIO: scenario },
      stdout: "pipe", stderr: "pipe",
    })
    const deadline = setTimeout(() => child.kill(), 10000)
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    clearTimeout(deadline)
    await fs.writeFile(path.join(root, "process.log"), stdout + stderr, { mode: 0o600 })
    console.log("DESKTOP_STARTUP_EVIDENCE", scenario, root)
    expect({ code, error: code ? stdout + stderr : null }).toEqual({ code: 0, error: null })
    const entry = await Bun.file(path.join(root, "entry.json")).json()
    expect(entry.ready).toBe(false)
    expect(entry.session).toBe(entry.expected)
    if (["failure", "interrupt"].includes(scenario)) {
      expect(await Bun.file(path.join(root, "terminal.json")).json()).toEqual({ gateTerminated: true, ready: false, fiberSettled: true, scenario })
      return
    }
    expect(await Bun.file(path.join(root, "safe.json")).json()).toEqual({ ready: true, migrationComplete: true, readyBeforeMigration: false,
      protectedData: scenario === "occupied", merge: scenario === "merge", repeatedPaths: true, lateRefused: true })
  }, 15000)
}
