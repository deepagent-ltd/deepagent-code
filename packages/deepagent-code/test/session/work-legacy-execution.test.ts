import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

test("actual legacy EventAdmission cannot enter the ordinary runner, including after process restart", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dac-work-legacy-host-")))
  await Promise.all(
    ["home", "tmp", "config", "data", "cache", "state", "project"].map((name) => fs.mkdir(path.join(root, name))),
  )
  const results = []
  for (const phase of ["warm", "cold"]) {
    const child = Bun.spawn(
      [process.execPath, path.resolve(import.meta.dir, "fixture/work-legacy-execution-host.ts"), root, phase],
      {
        cwd: path.join(root, "project"),
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
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
    const timer = setTimeout(() => child.kill("SIGKILL"), 80_000)
    try {
      const exit = await child.exited
      await Bun.write(path.join(root, `${phase}.log`), (await output).join("\n"))
      expect({ exit, log: exit === 0 ? "ok" : (await output).join("\n") }).toEqual({ exit: 0, log: "ok" })
      results.push(await Bun.file(path.join(root, `${phase}-result.json`)).json())
    } finally {
      clearTimeout(timer)
      if (child.exitCode === null) child.kill("SIGKILL")
      await child.exited
      console.info("WORK_LEGACY_EVIDENCE", phase, root)
    }
  }
  expect(results[0].pid).not.toBe(results[1].pid)
  for (const result of results) {
    expect(result.classification.kind).toBe("legacy_unbound")
    expect(result.before.work).toEqual([])
    expect(result.before.inputs).toHaveLength(1)
    expect(result.legacyRequests).toBe(0)
    for (const field of ["direct", "mutation", "publicResume", "directRunner"])
      expect(result[field]).toContain("WORK_AUTHORITY_MISSING")
    expect(result.otherMutations).toHaveLength(6)
    for (const operation of result.otherMutations) expect(operation.outcome).toBe("WORK_AUTHORITY_MISSING")
    expect(result.afterExecution).toEqual(result.before)
    expect(result.afterMutations).toEqual(result.before)
    expect(result.readable.sessionID).toBe(result.before.session[0].id)
    expect(result.ordinary.outcome).toBe("success")
    expect(result.requests).toBe(1)
    expect(result.ordinaryFacts.receipts).toHaveLength(1)
    expect(result.ordinaryFacts.receipts[0].state).toBe("settled")
  }
}, 170_000)
