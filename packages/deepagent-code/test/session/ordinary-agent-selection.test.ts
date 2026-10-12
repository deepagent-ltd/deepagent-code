import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

test.each([
  "alias",
  "pending",
  "mixed",
  "independent",
  "switch",
  "churn",
  "error",
  "cancel",
  "cold",
  "old-error",
  "old-cancel",
  "old-churn",
  "old-aba",
  "old-context-update",
  "old-stable",
])(
  "ordinary actual host selection: %s",
  async (scenario) => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dac-ordinary-selection-")))
    await Promise.all(
      ["home", "tmp", "config", "data", "cache", "state", "project"].map((name) => fs.mkdir(path.join(root, name))),
    )
    const env = {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      HOME: path.join(root, "home"),
      TMPDIR: path.join(root, "tmp"),
      TMP: path.join(root, "tmp"),
      TEMP: path.join(root, "tmp"),
      XDG_CONFIG_HOME: path.join(root, "config"),
      XDG_DATA_HOME: path.join(root, "data"),
      XDG_CACHE_HOME: path.join(root, "cache"),
      XDG_STATE_HOME: path.join(root, "state"),
      DEEPAGENT_CODE_TEST_HOME: path.join(root, "home"),
      DEEPAGENT_CODE_HOME: path.join(root, "data"),
      DEEPAGENT_CODE_DB: path.join(root, "authority.sqlite"),
      DEEPAGENT_CODE_TEST_MANAGED_CONFIG_DIR: path.join(root, "managed"),
      DEEPAGENT_CODE_MODELS_PATH: path.resolve(import.meta.dir, "../tool/fixtures/models-api.json"),
      DEEPAGENT_CODE_DISABLE_MODELS_FETCH: "1",
      DEEPAGENT_CODE_V2_OWNER_DEV_MINT: "1",
      DEEPAGENT_CODE_V2_OWNER_CAMPAIGN: "",
      DEEPAGENT_CODE_V2_OWNER_PUBLIC_KEY: "",
      DEEPAGENT_IM_AGENT_RESPONDER: "off",
      NO_COLOR: "1",
    }
    const run = async (phase: string) => {
      const child = Bun.spawn(
        [
          process.execPath,
          path.resolve(import.meta.dir, "../fixture/ordinary-agent-selection-host.ts"),
          root,
          scenario,
          phase,
        ],
        {
          cwd: path.join(root, "project"),
          env,
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
      const timer = setTimeout(() => child.kill("SIGKILL"), 40_000)
      try {
        return await child.exited
      } finally {
        clearTimeout(timer)
        await Bun.write(path.join(root, `${phase}.log`), (await output).join("\n"))
        console.info("ORDINARY_SELECTION_EVIDENCE", scenario, phase, root)
      }
    }
    expect(await run("live")).toBe(0)
    const live = await Bun.file(path.join(root, "live-result.json")).json()
    expect(live.loads).toBeLessThanOrEqual(4)
    expect(live.requests).toHaveLength(
      ["churn", "error", "cancel", "old-churn", "old-error", "old-cancel", "old-stable"].includes(scenario) ? 0 : 1,
    )
    if (scenario === "alias") expect(live.facts.sessions[0].agent).toBe("build")
    if (scenario === "mixed") expect(live.requests[0].model).toBe("other-model")
    if (scenario === "cold") {
      expect(await run("cold")).toBe(0)
      const cold = await Bun.file(path.join(root, "cold-result.json")).json()
      expect(cold.pid).not.toBe(live.pid)
      expect(cold.facts.epochs[0].agent).toBe("auto")
      expect(cold.facts.epochs[0].revision).toBeGreaterThan(live.facts.epochs[0].revision)
      expect(cold.requests).toHaveLength(1)
      expect(cold.facts.receipts).toHaveLength(2)
    }
  },
  90_000,
)
