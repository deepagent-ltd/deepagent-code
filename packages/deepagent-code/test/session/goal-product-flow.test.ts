import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

for (const scenario of ["roles", "control", "rebase"]) {
  test(`Goal product Manager/Event/Session flow: ${scenario}`, async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dac-goal-product-")))
    await Promise.all(["home", "tmp", "config", "data", "cache", "state", "project"].map((name) => fs.mkdir(path.join(root, name))))
    const child = Bun.spawn([process.execPath, path.resolve(import.meta.dir, "../fixture/goal-product-flow.ts"), root, scenario], {
      cwd: path.join(root, "project"),
      stdout: "pipe",
      stderr: "pipe",
      env: {
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
        DEEPAGENT_IM_AGENT_RESPONDER: "off",
        DEEPAGENT_CODE_SERVER_PASSWORD: "goal-product-fixture",
        NO_COLOR: "1",
      },
    })
    const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
    const timeout = setTimeout(() => child.kill("SIGKILL"), 60000)
    try {
      const status = await child.exited
      const log = (await output).join("\n")
      await Bun.write(path.join(root, "output.log"), log)
      expect({ status, root, log }).toMatchObject({ status: 0 })
      const result = await Bun.file(path.join(root, "result.json")).json()
      expect(result.scenario).toBe(scenario)
      expect(result.cleanup).toEqual({ listenerClosed: true, providerClosed: true, runtimeDisposed: true })
      if (scenario === "control") {
        expect(result.controls.map((item: { action: string }) => item.action)).toEqual(["pause", "stop"])
        expect(result.controls.every((item: { requests: number; checkpointState: string; permitState: string }) =>
          item.requests === 1 && item.checkpointState === "recovery_required" && item.permitState === "unknown")).toBeTrue()
        expect(result.requests).toBe(2)
        return
      }
      expect(result.checkpoints).toHaveLength(2)
      expect(result.checkpoints.every((item: { state: string }) => item.state === "committed")).toBeTrue()
      expect(result.phase).toBe("done")
      expect(result.active).toEqual([])
      expect(result.ledger.providerCount).toBe(result.requests)
      expect(result.ledger.input).toBe(result.requests * 20)
      expect(result.ledger.output).toBe(result.requests * 10)
      expect(result.roles).toEqual(["panel", "reviewer", "worker"])
      expect(result.plan.steps.every((item: { status: string }) => item.status === "done")).toBeTrue()
      if (scenario === "roles") {
        expect(result.invalidFinalizers).toBe(1)
        expect(result.secondFinalizers).toBe(1)
        expect(result.skippedPanels).toBe(6)
        expect(result.requests).toBe(21)
        return
      }
      expect(result.rebase.beginState).toBe("waiting_boundary")
      expect(result.rebase.appliedState).toBe("committed")
      expect(result.rebase.planRevision).toBe(1)
      expect(result.rebase.firstCheckpointUnchanged).toBeTrue()
      expect(result.rebase.noExecutionBeforeResume).toBeTrue()
      expect(result.rebase.lineage).toBe(result.rebase.receiptHash)
      expect(result.plan.steps[1].title).toBe("Operator revised second step")
    } finally {
      clearTimeout(timeout)
      if (child.exitCode === null) child.kill("SIGKILL")
    }
  }, 65000)
}
