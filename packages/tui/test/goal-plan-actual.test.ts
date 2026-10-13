import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

for (const variant of [
  { mode: "approval", width: 100, locale: "en", theme: "dark" },
  { mode: "timeout", width: 100, locale: "en", theme: "dark" },
  { mode: "approval", width: 50, locale: "zh", theme: "light" },
])
  test(`actual TUI keyboard and HTTP relay preserve private Goal authority: ${variant.mode}/${variant.width}/${variant.locale}`, async () => {
    const mode = variant.mode
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dac-goal-tui-actual-")))
    for (const name of ["home", "tmp", "config", "data", "cache", "state", "project"])
      await fs.mkdir(path.join(root, name), { mode: 0o700 })
    const execute = async (mode: string) => {
      const output = Bun.file(path.join(root, "output.log"))
      const child = Bun.spawn(
        [
          process.execPath,
          "--preload",
          path.resolve(import.meta.dir, "../node_modules/@opentui/solid/scripts/preload.js"),
          path.resolve(import.meta.dir, "fixture/goal-plan-actual.tsx"),
        ],
        {
          cwd: path.join(root, "project"),
          stdout: output,
          stderr: output,
          env: {
            PATH: process.env.PATH,
            HOME: path.join(root, "home"),
            TMPDIR: path.join(root, "tmp"),
            XDG_CONFIG_HOME: path.join(root, "config"),
            XDG_DATA_HOME: path.join(root, "data"),
            XDG_CACHE_HOME: path.join(root, "cache"),
            XDG_STATE_HOME: path.join(root, "state"),
            DEEPAGENT_CODE_DB: path.join(root, "data/dac.db"),
            DEEPAGENT_CODE_DISABLE_MODELS_FETCH: "1",
            DEEPAGENT_CODE_DISABLE_LSP_DOWNLOAD: "1",
            DEEPAGENT_CODE_TEST_HOME: path.join(root, "home"),
            DEEPAGENT_CODE_SERVER_USERNAME: "fixture-operator",
            DEEPAGENT_CODE_SERVER_PASSWORD: "isolated-tui-fixture-password",
            DEEPAGENT_CODE_DISABLE_TERMINAL_TITLE: "1",
            DAC_GOAL_PLAN_FIXTURE_ROOT: root,
            DAC_GOAL_PLAN_FIXTURE_PORT: "0",
            DAC_GOAL_PLAN_TUI_MODE: mode,
            LANG: variant.locale === "zh" ? "zh_CN.UTF-8" : "en_US.UTF-8",
            DAC_GOAL_PLAN_TUI_WIDTH: String(variant.width),
            DAC_GOAL_PLAN_TUI_THEME: variant.theme,
          },
        },
      )
      const timeout = setTimeout(() => child.kill("SIGKILL"), 80000)
      try {
        expect(await child.exited, await output.text()).toBe(0)
        const result = await Bun.file(path.join(root, "tui-actual-result.json")).json()
        expect(result.providerRequests).toBe(0)
        expect(result.final.data.inputs).toEqual(result.before.data.inputs)
        expect(result.final.data.events).toEqual(result.before.data.events)
        expect(result.final.data.edits).toHaveLength(1)
        expect(result.final.data.edits[0].state).toBe(mode === "timeout" ? "ready" : "committed")
        if (mode !== "cold-view")
          expect(
            result.events.filter(
              (event: { payload?: { type: string } }) => event.payload?.type === "tui.command.execute",
            ).length,
          ).toBeGreaterThanOrEqual(6)
        if (mode !== "cold-view")
          expect(result.frames.some((frame: { name: string }) => frame.name === "approval-relay-guard")).toBe(true)
        const evidence = process.env.DAC_GOAL_PLAN_EVIDENCE
        if (evidence) {
          await fs.mkdir(evidence, { recursive: true })
          await fs.copyFile(
            path.join(root, "output.log"),
            path.join(evidence, `tui-${mode}-${variant.width}-${variant.locale}.log`),
          )
          await fs.copyFile(
            path.join(root, "tui-actual-result.json"),
            path.join(evidence, `tui-${mode}-${variant.width}-${variant.locale}.json`),
          )
        }
      } finally {
        clearTimeout(timeout)
        if (child.exitCode === null) {
          child.kill("SIGKILL")
          await child.exited
        }
        if (child.exitCode !== 0) console.error(`Private TUI evidence retained: ${root}`)
      }
    }
    await execute(mode)
    if (mode === "approval") await execute("cold-view")
    await fs.rm(root, { recursive: true, force: true })
  }, 110000)
