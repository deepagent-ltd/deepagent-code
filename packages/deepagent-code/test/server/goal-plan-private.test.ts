import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

for (const mode of [
  "allow",
  "ask-approve",
  "ask-close",
  "ask-timeout",
  "listener-before",
  "ask-listener",
  "ask-listener-http",
])
  test(`private native Goal channel: ${mode}`, async () => {
    const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dac-goal-private-")))
    for (const name of ["home", "tmp", "config", "data", "cache", "state", "project"])
      await fs.mkdir(path.join(directory, name), { mode: 0o700 })
    await fs.writeFile(
      path.join(directory, "project/deepagent-code.json"),
      JSON.stringify({ permission: { "*": mode === "allow" ? "allow" : "ask" }, mcp: {}, lsp: false }),
    )
    const output = Bun.file(path.join(directory, "output.log"))
    const child = Bun.spawn([
      process.execPath,
      "--preload",
      path.resolve(import.meta.dir, "../fixture/cli-secret-store.ts"),
      path.resolve(import.meta.dir, "fixture/goal-plan-private.ts"),
    ], {
      cwd: path.join(directory, "project"),
      stdout: output,
      stderr: output,
      env: {
        PATH: process.env.PATH,
        HOME: path.join(directory, "home"),
        TMPDIR: path.join(directory, "tmp"),
        XDG_CONFIG_HOME: path.join(directory, "config"),
        XDG_DATA_HOME: path.join(directory, "data"),
        XDG_CACHE_HOME: path.join(directory, "cache"),
        XDG_STATE_HOME: path.join(directory, "state"),
        DEEPAGENT_CODE_DB: path.join(directory, "data/dac.db"),
        DEEPAGENT_CODE_DISABLE_MODELS_FETCH: "1",
        DEEPAGENT_CODE_DISABLE_LSP_DOWNLOAD: "1",
        // This fixture owns private plan edits and permissions, not the autonomous tick driver.
        DEEPAGENT_CODE_V4_MULTI_AGENT_RUNTIME: "false",
        DEEPAGENT_CODE_V4_GOAL_TICK_EVENT_DRIVEN: "false",
        DEEPAGENT_CODE_TEST_HOME: path.join(directory, "home"),
        DAC_GOAL_PLAN_FIXTURE_ROOT: directory,
        DAC_GOAL_PLAN_FIXTURE_MODE: mode,
      },
    })
    const timer = setTimeout(() => child.kill("SIGKILL"), 85000)
    try {
      expect(await child.exited, await output.text()).toBe(0)
      const result = await Bun.file(path.join(directory, "private-result.json")).json()
      expect(
        result.some(
          (entry: { kind: string }) =>
            entry.kind ===
            (mode === "allow" || mode === "ask-approve"
              ? "committed"
              : mode === "listener-before"
                ? "listener-denied"
                : "unknown-after-settled"),
        ),
      ).toBe(true)
      const snapshot = result.find((entry: { kind: string }) => entry.kind === "final-snapshot").data
      expect(snapshot.data.inputs).toEqual(snapshot.before.inputs)
      expect(snapshot.data.events).toEqual(snapshot.before.events)
      expect(snapshot.before.providers).toEqual([])
      expect(snapshot.data.providers).toEqual([])
      expect(snapshot.before.permits).toEqual([])
      expect(snapshot.data.permits).toEqual([])
      expect(snapshot.before.goalInFlight).toBe(false)
      expect(snapshot.data.goalInFlight).toBe(false)
      const evidence = process.env.DAC_GOAL_PLAN_EVIDENCE
      if (evidence) {
        await fs.mkdir(evidence, { recursive: true })
        await fs.copyFile(path.join(directory, "output.log"), path.join(evidence, `private-${mode}.log`))
        await fs.copyFile(path.join(directory, "private-result.json"), path.join(evidence, `private-${mode}.json`))
      }
    } finally {
      clearTimeout(timer)
      if (child.exitCode === null) {
        child.kill("SIGKILL")
        await child.exited
      }
      // A failed case remains private for diagnosis; successful cases contain no retained runtime keys.
      if (child.exitCode === 0) await fs.rm(directory, { recursive: true, force: true })
      else console.error(`Private Goal evidence retained: ${directory}`)
    }
  }, 90000)
