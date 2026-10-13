import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

function spawn(root: string, scenario: string) {
  return Bun.spawn(
    [process.execPath, path.resolve(import.meta.dir, "../fixture/goal-child-c1-host.ts"), root, scenario],
    {
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
        DEEPAGENT_CODE_V2_OWNER_CAMPAIGN: "",
        DEEPAGENT_CODE_V2_OWNER_PUBLIC_KEY: "",
        DEEPAGENT_IM_AGENT_RESPONDER: "off",
        NO_COLOR: "1",
      },
    },
  )
}

for (const scenario of [
  "plain",
  "structured",
  "missing-usage",
  "result-rollback",
  "anthropic",
  "settle-rollback",
  "control-race",
  "ledger-limits",
  "prior-result-unknown",
  "steering",
]) {
  test(`C1 actual owned main runner: ${scenario}`, async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dac-goal-c1-host-")))
    await Promise.all(
      ["home", "tmp", "config", "data", "cache", "state", "project"].map((name) => fs.mkdir(path.join(root, name))),
    )
    const child = spawn(root, scenario)
    const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
    const timeout = setTimeout(() => child.kill("SIGKILL"), 45000)
    try {
      const status = await child.exited
      const [stdout, stderr] = await output
      await Bun.write(path.join(root, "output.log"), stdout + stderr)
      expect({ status, stderr, root }).toMatchObject({ status: 0 })
      const result = await Bun.file(path.join(root, "result.json")).json()
      expect(result.requests).toBe(scenario === "structured" ? 3 : 1)
      expect(result.result.inputs).toHaveLength(scenario === "structured" ? 3 : 1)
      expect(result.result.checkpoint.journal.results).toHaveLength(
        scenario === "missing-usage" ? 0 : scenario === "structured" ? 3 : 1,
      )
      if (scenario !== "missing-usage") {
        expect(result.result.checkpoint.journal.cursor.role).toBe(scenario === "prior-result-unknown" ? 0 : 1)
        expect(result.result.checkpoint.journal.results.at(-1).usage).toEqual(
          scenario === "anthropic"
            ? {
                input: 20,
                nonCachedInput: 15,
                output: 10,
                reasoning: null,
                visibleOutput: null,
                cacheRead: 3,
                cacheWrite: 2,
              }
            : {
                input: 20,
                nonCachedInput: 20,
                output: 10,
                reasoning: 0,
                visibleOutput: 10,
                cacheRead: 0,
                cacheWrite: 0,
              },
        )
      }
      if (scenario === "control-race")
        expect(await Bun.file(path.join(root, "race-proof.json")).json()).toMatchObject({
          documentVersion: 2,
          projection: "confirmed",
          afterControl: "paused",
          settle: "rejected",
        })
      if (process.env.DEEPAGENT_TEST_C1_EVIDENCE)
        await fs.cp(root, path.join(process.env.DEEPAGENT_TEST_C1_EVIDENCE, scenario), { recursive: true })
      await fs.rm(root, { recursive: true, force: true })
    } finally {
      clearTimeout(timeout)
      if (child.exitCode === null) {
        child.kill("SIGKILL")
        await child.exited
      }
    }
  }, 50000)
}

for (const phase of ["before", "after", "conflict", "paused"]) {
  test(`C1 actual SIGKILL/fileDB cold projection only: ${phase}`, async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dac-goal-c1-cold-")))
    await Promise.all(
      ["home", "tmp", "config", "data", "cache", "state", "project"].map((name) => fs.mkdir(path.join(root, name))),
    )
    const child = spawn(root, `cold-${phase}`)
    const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
    const timeout = setTimeout(() => child.kill("SIGKILL"), 30000)
    try {
      const started = Date.now()
      while (!(await Bun.file(path.join(root, "kill-ready.json")).exists())) {
        if (child.exitCode !== null || Date.now() - started > 25000) {
          if (child.exitCode === null) child.kill("SIGKILL")
          await child.exited
          await Bun.write(path.join(root, "live.log"), (await output).join("\n"))
          throw new Error(`Owned live fixture did not reach exact crash boundary: ${root}`)
        }
        await new Promise((resolve) => setTimeout(resolve, 30))
      }
      expect((await Bun.file(path.join(root, "provider.json")).json()).length).toBe(1)
      child.kill("SIGKILL")
      await child.exited
      expect(child.signalCode).toBe("SIGKILL")
      await Bun.write(path.join(root, "live.log"), (await output).join("\n"))
    } finally {
      clearTimeout(timeout)
      if (child.exitCode === null) {
        child.kill("SIGKILL")
        await child.exited
      }
    }
    const cold = spawn(root, `recover-${phase}`)
    const outputCold = Promise.all([new Response(cold.stdout).text(), new Response(cold.stderr).text()])
    const coldTimeout = setTimeout(() => cold.kill("SIGKILL"), 15000)
    try {
      const status = await cold.exited
      const log = (await outputCold).join("\n")
      await Bun.write(path.join(root, "cold.log"), log)
      expect({ status, log, root }).toMatchObject({ status: 0 })
      const result = await Bun.file(path.join(root, "recovered.json")).json()
      expect(result.providerReceipts).toBe(1)
      expect(result.inputs).toHaveLength(1)
      expect((await Bun.file(path.join(root, "provider.json")).json()).length).toBe(1)
      const success = phase === "before" || phase === "after"
      expect(result.projection).toBe(success ? "confirmed" : "rejected")
      expect(result.checkpoint.state).toBe(success ? "committed" : "mirror_pending")
      expect(result.permits[0].state).toBe(success ? "settled" : "issued")
      expect(result.controls[0].next_seq).toBe(success ? 1 : 0)
      if (!success) expect(result.checkpoint.reserved_bytes).toBe(1048576)
      if (phase === "after") {
        const retry = spawn(root, "recover-committed")
        const retriedOutput = Promise.all([new Response(retry.stdout).text(), new Response(retry.stderr).text()])
        const retryTimeout = setTimeout(() => retry.kill("SIGKILL"), 15000)
        try {
          const status = await retry.exited
          const log = (await retriedOutput).join("\n")
          await Bun.write(path.join(root, "cold-exact-retry.log"), log)
          expect({ status, log, root }).toMatchObject({ status: 0 })
          expect(await Bun.file(path.join(root, "recovered.json")).json()).toEqual(result)
          expect((await Bun.file(path.join(root, "provider.json")).json()).length).toBe(1)
        } finally {
          clearTimeout(retryTimeout)
          if (retry.exitCode === null) {
            retry.kill("SIGKILL")
            await retry.exited
          }
        }
      }
      if (process.env.DEEPAGENT_TEST_C1_EVIDENCE)
        await fs.cp(root, path.join(process.env.DEEPAGENT_TEST_C1_EVIDENCE, `cold-${phase}`), { recursive: true })
      await fs.rm(root, { recursive: true, force: true })
    } finally {
      clearTimeout(coldTimeout)
      if (cold.exitCode === null) {
        cold.kill("SIGKILL")
        await cold.exited
      }
    }
  }, 50000)
}
