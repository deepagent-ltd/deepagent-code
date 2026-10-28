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
    const timeout = { fired: false }
    const deadline = setTimeout(() => { timeout.fired = true; child.kill() }, 10000)
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    clearTimeout(deadline)
    await fs.writeFile(path.join(root, "process.log"), stdout + stderr, { mode: 0o600 })
    console.log("DESKTOP_STARTUP_EVIDENCE", scenario, root)
    if (code !== 0) {
      const receipts = await Promise.all(["entry.json", "safe.json", "terminal.json", "uncaught.json", "effect-failure.json", "startup-stages.jsonl"].map(async (name) => {
        const file = Bun.file(path.join(root, name))
        if (!await file.exists()) return { name, state: "missing" }
        if (file.size > 16_384) return { name, state: "oversized", bytes: file.size }
        const text = await file.text().catch(() => null)
        if (text === null) return { name, state: "unreadable" }
        const parsed: unknown = name.endsWith(".jsonl")
          ? await Promise.all(text.trim().split("\n").slice(-24).map((line) => Promise.resolve().then(() => JSON.parse(line)).catch(() => null)))
          : await file.json().catch(() => null)
        const bounded = (value: unknown, limit: number) => typeof value === "string"
          ? value.replaceAll(root, "<owned-root>").replaceAll(root.replaceAll("\\", "/"), "<owned-root>").slice(0, limit) : undefined
        if (name.endsWith(".jsonl")) return { name, state: "present", stages: Array.isArray(parsed) ? parsed.slice(-24).flatMap((value: unknown) =>
          value && typeof value === "object" && "phase" in value && typeof value.phase === "string" && /^[a-z0-9:-]{1,80}$/.test(value.phase) && "at" in value && typeof value.at === "number" && Number.isFinite(value.at)
            ? [{ phase: value.phase, at: value.at }] : []) : [] }
        if (!parsed || typeof parsed !== "object") return { name, state: "invalid" }
        const value = parsed as Record<string, unknown>
        if (name === "entry.json") return { name, state: "present", ready: value.ready === true, sessionMatchesExpected: typeof value.session === "string" && value.session === value.expected }
        if (name === "safe.json") return { name, state: "present", facts: Object.fromEntries(["ready", "migrationComplete", "readyBeforeMigration", "protectedData", "merge", "repeatedPaths", "lateRefused"].map((key) => [key, value[key] === true])) }
        if (name === "terminal.json") return { name, state: "present", gateTerminated: value.gateTerminated === true, ready: value.ready === true, fiberSettled: value.fiberSettled === true, scenario: value.scenario === scenario ? scenario : "mismatch" }
        return { name, state: "present", origin: bounded(value.origin, 80), nameOfError: bounded(value.name, 80), message: bounded(value.message, 512), stack: bounded(value.stack, 4096), cause: bounded(value.cause, 4096) }
      }))
      console.error("DESKTOP_STARTUP_FAILURE", JSON.stringify({ scenario, code, exitSignal: child.signalCode, deadlineExpired: timeout.fired, receipts }))
    }
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
