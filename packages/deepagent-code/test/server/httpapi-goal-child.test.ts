import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

test("actual HTTP ingress preserves managed Goal child refusal and ordinary Session admission", async () => {
  // Full server suites share process-global mocks and mutable flags. Run the production root
  // in its own process, with no test preload resetting its file-backed authority to :memory:.
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dac-http-goal-child-")))
  await Promise.all(
    ["home", "tmp", "config", "data", "cache", "state", "project"].map((name) => fs.mkdir(path.join(root, name))),
  )
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixture/httpapi-goal-child.ts"), root], {
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
  })
  const timer = setTimeout(() => child.kill("SIGKILL"), 60_000)
  try {
    const [status, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    await Bun.write(path.join(root, "child.log"), stdout + stderr)
    console.info("HTTP_GOAL_CHILD_EVIDENCE", root)
    expect({ status, output: status === 0 ? "ok" : stdout + stderr }).toEqual({ status: 0, output: "ok" })
    const result = await Bun.file(path.join(root, "result.json")).json()
    expect(result.pid).toBe(child.pid)
    expect(result.pid).not.toBe(process.pid)
    expect(result.database).toBe(path.join(root, "authority.sqlite"))
    expect(result.providerRequests).toBe(0)
    expect(result.closed).toBe(true)
    expect(result.cases.directMainRunner).toBe("GOAL_CHILD_RECOVERY_REQUIRED")
    expect(result.cases.directMutators).toBe(21)
    expect(result.cases.ordinary).toBe(200)
    console.info("HTTP_GOAL_CHILD_RESULT", JSON.stringify(result))
  } finally {
    clearTimeout(timer)
    child.kill()
  }
}, 70_000)
