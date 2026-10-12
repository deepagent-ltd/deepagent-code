import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

test("two actual HTTP instances locate only their own delivered task and preserve execution rows", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dac-im-task-result-http-")))
  const run = async (identity: string) => {
    const directory = path.join(root, identity)
    await Promise.all(["home", "tmp", "config", "data", "cache", "state", "project", "other/project"].map((name) =>
      fs.mkdir(path.join(directory, name), { recursive: true }),
    ))
    const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixture/httpapi-im-task-result.ts"), directory, identity], {
      cwd: path.join(directory, "project"),
      env: {
        PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
        HOME: path.join(directory, "home"), TMPDIR: path.join(directory, "tmp"), TMP: path.join(directory, "tmp"), TEMP: path.join(directory, "tmp"),
        XDG_CONFIG_HOME: path.join(directory, "config"), XDG_DATA_HOME: path.join(directory, "data"), XDG_CACHE_HOME: path.join(directory, "cache"), XDG_STATE_HOME: path.join(directory, "state"),
        DEEPAGENT_CODE_TEST_HOME: path.join(directory, "home"), DEEPAGENT_CODE_HOME: path.join(directory, "data"),
        DEEPAGENT_CODE_DB: path.join(directory, "authority.sqlite"), DEEPAGENT_CODE_TEST_MANAGED_CONFIG_DIR: path.join(directory, "managed"),
        DEEPAGENT_CODE_MODELS_PATH: path.resolve(import.meta.dir, "../tool/fixtures/models-api.json"), DEEPAGENT_CODE_DISABLE_MODELS_FETCH: "1",
        DEEPAGENT_CODE_SERVER_USERNAME: "result-reader", DEEPAGENT_CODE_SERVER_PASSWORD: "private-result-password",
        DEEPAGENT_CODE_V2_OWNER_DEV_MINT: "", DEEPAGENT_IM_AGENT_RESPONDER: "off", NO_COLOR: "1",
      }, stdout: "pipe", stderr: "pipe",
    })
    const deadline = setTimeout(() => child.kill("SIGKILL"), 60_000)
    try {
      const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      await Bun.write(path.join(directory, "child.log"), stdout + stderr)
      expect({ status, output: status === 0 ? "ok" : stdout + stderr }).toEqual({ status: 0, output: "ok" })
      return await Bun.file(path.join(directory, "result.json")).json()
    } finally {
      clearTimeout(deadline)
      child.kill()
    }
  }
  const results = await Promise.all([run("1"), run("2")])
  console.info("IM_TASK_RESULT_HTTP_EVIDENCE", root)
  results.forEach((result) => expect(result).toMatchObject({ closed: true, protectedDrift: 0, providerAttempts: 0,
    statuses: { denied: 401, crossProject: 404, missing: 404, foreignMessage: 404, foreignInstance: 404 } }))
  expect(results[0].identity).not.toBe(results[1].identity)
  expect(results[0].exact.placement.directory).not.toBe(results[1].exact.placement.directory)
}, 75_000)
