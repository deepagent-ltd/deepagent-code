import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"

test("actual Server Root authenticated refusal is durable, source-independent reduction and zero execution", async () => {
  const root = await fs.realpath(await fs.mkdtemp("/tmp/dac-task-status-http-"))
  await Promise.all(["home", "tmp", "config", "data", "cache", "state", "project", "other"].map((name) => fs.mkdir(path.join(root, name))))
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixture/task-status-notice-http.ts"), root], {
    cwd: path.join(root, "project"), env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
      HOME: path.join(root, "home"), TMPDIR: path.join(root, "tmp"), TMP: path.join(root, "tmp"), TEMP: path.join(root, "tmp"),
      XDG_CONFIG_HOME: path.join(root, "config"), XDG_DATA_HOME: path.join(root, "data"), XDG_CACHE_HOME: path.join(root, "cache"), XDG_STATE_HOME: path.join(root, "state"),
      DEEPAGENT_CODE_TEST_HOME: path.join(root, "home"), DEEPAGENT_CODE_HOME: path.join(root, "data"), DEEPAGENT_CODE_DB: path.join(root, "private.sqlite"),
      DEEPAGENT_CODE_TEST_MANAGED_CONFIG_DIR: path.join(root, "managed"), DEEPAGENT_CODE_MODELS_PATH: path.resolve(import.meta.dir, "../tool/fixtures/models-api.json"),
      DEEPAGENT_CODE_DISABLE_MODELS_FETCH: "1", DEEPAGENT_CODE_V2_OWNER_DEV_MINT: "1", DEEPAGENT_CODE_V2_OWNER_CAMPAIGN: "", DEEPAGENT_CODE_V2_OWNER_PUBLIC_KEY: "",
      DEEPAGENT_CODE_SERVER_USERNAME: "status-operator", DEEPAGENT_CODE_SERVER_PASSWORD: "private-status-password", DEEPAGENT_IM_AGENT_RESPONDER: "on", NO_COLOR: "1" }, stdout: "pipe", stderr: "pipe" })
  const timer = setTimeout(() => child.kill("SIGKILL"), 90000)
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    await fs.writeFile(path.join(root, "actual.log"), stdout + stderr, { mode: 0o600 })
    console.info("TASK_STATUS_HTTP_PRIVATE", root)
    expect({ code, output: code === 0 ? "ok" : stdout + stderr }).toEqual({ code: 0, output: "ok" })
    const result = await Bun.file(path.join(root, "result.json")).json()
    expect(result.noticeCount).toBe(1)
    expect(result.readHashUnchanged).toBe(true)
    expect(result.noExecution).toEqual({ sessions: 0, inputs: 0, work: 0, providers: 0, counts: 0, dispatches: 0, grants: 0 })
    expect(result.receipt.state).toBe("refused")
    expect(result.purposeChecks).toMatchObject({ localCurrentAccepted: true, copyDenied: true, foreignFactoryDenied: true, disposedDenied: true })
    expect(result.locator).toMatchObject({ state: "available", notice: { kind: "refused" }, task: { disposition: "refused", work: null } })
  } finally { clearTimeout(timer); child.kill(); await child.exited }
}, 100000)
