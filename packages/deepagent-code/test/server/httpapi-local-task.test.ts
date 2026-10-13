import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

test("local task HTTP boundary uses real offline enrollment, socket auth and atomic origin receipts", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dac-local-task-http-")))
  await Promise.all(
    ["home", "tmp", "config", "data", "cache", "state", "project", "other"].map((name) =>
      fs.mkdir(path.join(root, name)),
    ),
  )
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixture/httpapi-local-task.ts"), root], {
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
      DEEPAGENT_CODE_SERVER_USERNAME: "isolated-operator",
      DEEPAGENT_CODE_SERVER_PASSWORD: "isolated-local-task-password",
      DEEPAGENT_IM_AGENT_RESPONDER: "on",
      NO_COLOR: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const timer = setTimeout(() => child.kill("SIGKILL"), 90_000)
  try {
    const [status, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    await Bun.write(path.join(root, "child.log"), stdout + stderr)
    console.info("LOCAL_TASK_HTTP_EVIDENCE", root)
    expect({ status, output: status === 0 ? "ok" : stdout + stderr }).toEqual({ status: 0, output: "ok" })
    const result = await Bun.file(path.join(root, "result.json")).json()
    expect(result.closed).toBe(true)
    expect(result.counts).toEqual({
      origins: 1,
      requests: 1,
      grants: 0,
      work: 0,
      sessions: 0,
      inputs: 0,
      providers: 0,
      intents: 0,
    })
    expect(result.cases).toEqual({
      enrolled: "active",
      enrollmentRetry: "exact",
      capability: 200,
      crossProject: 403,
      enabled: 200,
      wrongOrigin: 403,
      otherLoopbackOrigin: 403,
      sameListenerOrigin: 200,
      explicitOrigin: 200,
      nativeOrigin: 200,
      forgedHostOrigin: 403,
      originWithPath: 403,
      queryCredential: 403,
      plainOrigin: 0,
      freshOrigin: 1,
      proposal: 200,
      proposalRetry: "exact",
      accepted: 400,
      acceptedCode: "IM_TASK_INVALID_REQUEST",
      liveEnrollmentLock: "refused",
      queryRead: 403,
      revoked: "revoked",
      revokedRead: 403,
      generation: 2,
    })
  } finally {
    clearTimeout(timer)
    child.kill()
  }
}, 100_000)
