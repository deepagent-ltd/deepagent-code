import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

test.each([
  "complete",
  "tool-success",
  "alias-agent",
  "pause-seal",
  "pause-body",
  "pause-tool",
  "permission",
  "interrupt",
  "kill",
])(
  "actual owned main runner: %s",
  async (scenario) => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dac-goal-owned-host-")))
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
    const start = (phase: string) => {
      const child = Bun.spawn(
        [process.execPath, path.resolve(import.meta.dir, "../fixture/goal-child-owned-host.ts"), root, scenario, phase],
        {
          cwd: path.join(root, "project"),
          env,
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
      const timer = setTimeout(() => child.kill("SIGKILL"), 55_000)
      return { child, output, timer, phase }
    }
    const hosts: ReturnType<typeof start>[] = []
    try {
      const live = start("live")
      hosts.push(live)
      if (scenario === "kill") {
        const deadline = Date.now() + 40_000
        while (!(await Bun.file(path.join(root, "kill-ready.json")).exists())) {
          if (Date.now() >= deadline || live.child.exitCode !== null)
            throw new Error("live owner did not reach actual HTTP dispatch")
          await new Promise((resolve) => setTimeout(resolve, 20))
        }
        live.child.kill("SIGKILL")
        await live.child.exited
        const cold = start("cold")
        hosts.push(cold)
        expect(await cold.child.exited).toBe(0)
        const result = await Bun.file(path.join(root, "cold-result.json")).json()
        expect(result.pid).not.toBe(live.child.pid)
        expect(result.requests).toEqual([])
        expect(result.before).toEqual(result.after)
        expect(result.before.receipts).toHaveLength(1)
        expect(result.before.inputs).toHaveLength(1)
        expect(
          result.before.sessions.some(
            (row: { execution_claim_token: number | null }) => row.execution_claim_token !== null,
          ),
        ).toBeTrue()
      } else {
        expect(await live.child.exited).toBe(0)
        const result = await Bun.file(path.join(root, "result.json")).json()
        expect(result.pid).toBe(live.child.pid)
        expect(result.requests).toHaveLength(
          ["alias-agent", "pause-seal"].includes(scenario) ? 0 : scenario === "tool-success" ? 2 : 1,
        )
        expect(result.marker).toBe(scenario === "tool-success")
        expect(result.facts.inputs).toHaveLength(1)
        expect(result.facts.receipts).toHaveLength(scenario === "alias-agent" ? 0 : scenario === "tool-success" ? 2 : 1)
        const inputs = JSON.parse(result.facts.units[0].inputs)
        expect(inputs[0].resultRef).toBeNull()
        expect(inputs[0].execution.state).toBe(
          ["complete", "tool-success"].includes(scenario)
            ? "settled"
            : scenario === "interrupt"
              ? "interrupted"
              : "recovery_required",
        )
        expect(result.facts.units[0].state).toBe("admitted")
        if (scenario === "complete") expect(result.facts.receipts[0].state).toBe("settled")
        if (scenario === "pause-tool") expect(result.facts.tools).toHaveLength(0)
        if (scenario === "permission" || scenario === "pause-body") {
          expect(result.facts.tools).toHaveLength(1)
          expect(result.facts.effects).toHaveLength(0)
        }
      }
    } finally {
      for (const host of hosts) {
        clearTimeout(host.timer)
        if (host.child.exitCode === null) host.child.kill("SIGKILL")
        await host.child.exited
        await Bun.write(path.join(root, `${host.phase}.log`), (await host.output).join("\n"))
      }
      console.info("GOAL_OWNED_EVIDENCE", scenario, root)
    }
  },
  110_000,
)
