import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { createSidecarShutdown } from "./sidecar-shutdown"
import { managedBrowserInputFixtureEnvironment, managedBrowserInputFixtureExecutable } from "./fixture/managed-browser-input-runtime"

test("sidecar shutdown caches the failed stop and emits only fixed diagnostic plus nonzero exit", async () => {
  const release = Promise.withResolvers<void>()
  const facts = { stops: 0, clears: 0, messages: [] as unknown[], exits: [] as number[] }
  const stop = createSidecarShutdown({
    stop: async () => {
      facts.stops++
      await release.promise
      throw new Error("secret /private/user/path")
    },
    clear: () => {
      facts.clears++
    },
    report: (message) => {
      facts.messages.push(message)
    },
    exit: (code) => {
      facts.exits.push(code)
    },
  })
  const first = stop()
  expect(stop()).toBe(first)
  release.resolve()
  await first
  await stop()
  expect(facts).toEqual({
    stops: 1,
    clears: 1,
    messages: [{ type: "error", error: { message: "SIDECAR_SHUTDOWN_FAILED" } }],
    exits: [1],
  })
})

for (const scenario of ["normal", "failed", "interrupted", "timeout"] as const) {
  test(`actual production sidecar reports and exits truthfully after ${scenario} real Scope stop`, async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dac-sidecar-shutdown-")))
    await fs.chmod(root, 0o700)
    await fs.mkdir(path.join(root, "home"), { mode: 0o700 })
    const built = await Bun.build({
      entrypoints: [
        path.join(import.meta.dir, "fixture/sidecar-shutdown-main.ts"),
        path.join(import.meta.dir, "sidecar.ts"),
      ],
      outdir: root,
      naming: "[name].js",
      target: "node",
      external: ["electron"],
    })
    const server = await Bun.build({
      entrypoints: [path.join(import.meta.dir, "fixture/sidecar-shutdown-server.ts")],
      outdir: path.join(root, "chunks"),
      naming: "node.js",
      target: "node",
      external: ["effect"],
    })
    expect(built.success).toBe(true)
    expect(server.success).toBe(true)
    await fs.symlink(path.resolve(import.meta.dir, "../../node_modules"), path.join(root, "node_modules"), "dir")
    const child = Bun.spawn(
      [managedBrowserInputFixtureExecutable, path.join(root, "sidecar-shutdown-main.js")],
      {
        cwd: root,
        env: {
          ...managedBrowserInputFixtureEnvironment,
          PATH: process.env.PATH,
          HOME: path.join(root, "home"),
          TMPDIR: root,
          DAC_SIDECAR_SHUTDOWN_ROOT: root,
          DAC_SIDECAR_SHUTDOWN_SCENARIO: scenario,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const deadline = setTimeout(() => child.kill(), 12_000)
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    clearTimeout(deadline)
    await fs.writeFile(path.join(root, "process.log"), stdout + stderr, { mode: 0o600 })
    console.log("SIDECAR_SHUTDOWN_EVIDENCE", scenario, root)
    expect({ code, error: code ? stdout + stderr : null }).toEqual({ code: 0, error: null })
    const facts = await Bun.file(path.join(root, "main.json")).json()
    const utility = await Bun.file(path.join(root, "utility.json")).json()
    expect(facts.utilityPID).toBe(utility.pid)
    expect(facts.exitCode).toBe(scenario === "normal" ? 0 : 1)
    expect(facts.messages).toEqual([
      { type: "ready" },
      scenario === "normal" ? { type: "stopped" } : { type: "error", error: { message: "SIDECAR_SHUTDOWN_FAILED" } },
    ])
    expect(JSON.stringify(facts.messages)).not.toMatch(/secret|private|password|stack/i)
    expect(utility.stopCalls).toBe(1)
    expect(utility.entered).toBe(1)
    expect(utility.finalized).toBe(scenario === "normal" ? 1 : 0)
    expect(utility.stages).toEqual(["mdns", "websockets", "http"])
    if (scenario === "timeout") expect(facts.exitedAt - facts.stoppedAt).toBeGreaterThanOrEqual(1_950)
  }, 15_000)
}
