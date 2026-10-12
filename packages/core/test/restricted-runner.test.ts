import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

for (const scenario of [
  "missing-profile",
  "retired-placement",
  "missing-placement",
  "retired-after-count",
  "revoked-before-model",
  "revoked-after-count",
  "missing-count",
  "bad-counter-response",
  "missing-runtime",
  "wrong-count",
  "runtime-drift",
  "body-overlay",
  "complete",
  "source-refresh-after-slow-io",
  "source-near-expiry-before-promotion",
  "revoked-before-result",
  "retired-before-result",
  "activity-rollback",
  "drop",
  "missing-usage",
  "interrupt",
  "deadline",
])
  test(`restricted actual main runner: ${scenario}`, async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dac-restricted-runner-")))
    await Promise.all(
      ["home", "tmp", "data", "config", "cache", "state"].map((name) => fs.mkdir(path.join(root, name))),
    )
    const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixture/restricted-runner.ts"), scenario], {
      cwd: path.resolve(import.meta.dir, ".."),
      env: {
        PATH: process.env.PATH,
        HOME: path.join(root, "home"),
        TMPDIR: path.join(root, "tmp"),
        XDG_DATA_HOME: path.join(root, "data"),
        XDG_CONFIG_HOME: path.join(root, "config"),
        XDG_CACHE_HOME: path.join(root, "cache"),
        XDG_STATE_HOME: path.join(root, "state"),
        DEEPAGENT_CODE_DISABLE_MODELS_FETCH: "1",
        NO_COLOR: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const timeout = setTimeout(() => child.kill("SIGKILL"), 30_000)
    try {
      const [status, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      await Bun.write(path.join(root, "child.log"), stdout + stderr)
      console.info("RESTRICTED_RUNNER_EVIDENCE", scenario, root)
      expect({ status, output: status === 0 ? "ok" : stdout + stderr }).toEqual({ status: 0, output: "ok" })
      const file = stdout.match(/RESTRICTED_RESULT (.+)/)?.[1]
      expect(file).toBeDefined()
      const result = await Bun.file(file!).json()
      expect(result.scenario).toBe(scenario)
      expect(result.observed.trips).toEqual([])
      if (result.cold) expect(result.cold.pid).not.toBe(result.pid)
    } finally {
      clearTimeout(timeout)
      child.kill()
    }
  }, 40_000)
