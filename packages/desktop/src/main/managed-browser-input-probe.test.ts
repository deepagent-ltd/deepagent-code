import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { createHash } from "node:crypto"
import { managedBrowserInputRuntime } from "../../scripts/managed-browser-input-runtime"
import { managedBrowserInputFixtureEnvironment, managedBrowserInputFixtureExecutable } from "./fixture/managed-browser-input-runtime"

test("original Electron native input hooks are classified against the raw CDP call stack without granting a pending window", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dac-browser-input-probe-")))
  await fs.chmod(root, 0o700)
  await fs.mkdir(path.join(root, "home"), { mode: 0o700 })
  const fixture = path.join(import.meta.dir, "fixture/managed-browser-input-probe.ts")
  const production = ["managed-browser.ts", "managed-browser-actions.ts"].map((name) => path.join(import.meta.dir, name))
  const before = await Promise.all(production.map(async (filename) => ({ filename, sha256: createHash("sha256").update(await fs.readFile(filename)).digest("hex") })))
  const built = await Bun.build({ entrypoints: [fixture], outdir: root, target: "node", format: "cjs", external: ["electron"] })
  expect(built.success).toBe(true)
  const started = performance.now()
  const state = { deadlineExpired: false }
  const child = Bun.spawn([managedBrowserInputFixtureExecutable, built.outputs[0]!.path], {
    cwd: root, env: { ...managedBrowserInputFixtureEnvironment, PATH: process.env.PATH, HOME: path.join(root, "home"), TMPDIR: root, DAC_BROWSER_INPUT_PROBE_ROOT: root },
    stdout: "pipe", stderr: "pipe" })
  const timer = setTimeout(() => { state.deadlineExpired = true; child.kill("SIGTERM") }, 15_000)
  const code = await child.exited
  clearTimeout(timer)
  const diagnostic = await new Response(child.stdout).text() + await new Response(child.stderr).text()
  await fs.writeFile(path.join(root, "process.log"), diagnostic, { mode: 0o600 })
  if (code !== 0) {
    const read = async (name: string) => {
      const file = Bun.file(path.join(root, name))
      return await file.exists() ? (await file.text()).slice(0, 8192) : null
    }
    console.error("INPUT_PROBE_FAILURE", JSON.stringify({ root, code, exitSignal: child.signalCode,
      deadlineExpired: state.deadlineExpired, elapsedMs: Math.round(performance.now() - started),
      phase: await read("phase.json"), failure: await read("failure.json") }))
  }
  expect({ code, diagnostic: code ? diagnostic : null }).toEqual({ code: 0, diagnostic: null })
  const result = await Bun.file(path.join(root, "result.json")).json()
  expect(result.electron).toBe(managedBrowserInputRuntime.electronVersion)
  expect(result.destroyed).toBe(true)
  expect(result.provider).toBe(0)
  expect(result.clipboardOperations).toBe(0)
  expect(result.networkAttempts).toBe(0)
  expect(result.commands.length).toBeGreaterThan(0)
  expect(result.events.length).toBeGreaterThan(0)
  if (result.asyncFirst) {
    expect(result.synchronousTicketEligible).toBe(false)
    expect(result.continuityProven).toBe(false)
    expect(result.asyncFirst.rawCalling).toBe(false)
    expect(result.stoppedAt).toBeDefined()
  }
  const after = await Promise.all(production.map(async (filename) => ({ filename, sha256: createHash("sha256").update(await fs.readFile(filename)).digest("hex") })))
  expect(after).toEqual(before)
  await fs.writeFile(path.join(root, "safe.json"), JSON.stringify({ root, result, before, after, processExited: true,
    fixtureSHA256: createHash("sha256").update(await fs.readFile(fixture)).digest("hex"),
    boundary: "actual raw Main input timing, no production source change/permission/Work/Native installation" }, null, 2), { mode: 0o600 })
  process.stderr.write(`INPUT_PROBE_EVIDENCE ${root}\n`)
}, 20_000)
