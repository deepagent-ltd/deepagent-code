import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

test("Session GET reads real ordinary eligibility without writes and preserves unknown refusals", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dac-http-ordinary-eligibility-")))
  await Promise.all(["home", "tmp", "config", "data", "cache", "state", "project"].map((name) =>
    fs.mkdir(path.join(root, name))))
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixture/httpapi-session-ordinary-eligibility.ts"), root], {
    cwd: path.join(root, "project"),
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      HOME: process.env.HOME,
      TMPDIR: path.join(root, "tmp"), TMP: path.join(root, "tmp"), TEMP: path.join(root, "tmp"),
      XDG_CONFIG_HOME: path.join(root, "config"), XDG_DATA_HOME: path.join(root, "data"),
      XDG_CACHE_HOME: path.join(root, "cache"), XDG_STATE_HOME: path.join(root, "state"),
      DEEPAGENT_CODE_TEST_HOME: path.join(root, "home"), DEEPAGENT_CODE_HOME: path.join(root, "data"),
      DEEPAGENT_CODE_DB: path.join(root, "authority.sqlite"),
      DEEPAGENT_CODE_TEST_MANAGED_CONFIG_DIR: path.join(root, "managed"),
      DEEPAGENT_CODE_MODELS_PATH: path.resolve(import.meta.dir, "../tool/fixtures/models-api.json"),
      DEEPAGENT_CODE_DISABLE_MODELS_FETCH: "1", DEEPAGENT_CODE_V2_OWNER_DEV_MINT: "1",
      DEEPAGENT_IM_AGENT_RESPONDER: "off", NO_COLOR: "1",
    },
    stdout: "pipe", stderr: "pipe",
  })
  const timer = setTimeout(() => child.kill("SIGKILL"), 60_000)
  try {
    const [status, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ])
    await Bun.write(path.join(root, "child-private.log"), stdout + stderr)
    console.info("HTTP_ORDINARY_ELIGIBILITY_EVIDENCE", root)
    expect({ status, output: status === 0 ? "ok" : stdout + stderr }).toEqual({ status: 0, output: "ok" })
    const result = await Bun.file(path.join(root, "result.json")).json()
    expect(result.pid).toBe(child.pid)
    expect(result.database).toBe(path.join(root, "authority.sqlite"))
    expect(result.cases).toEqual({
      ordinary: { status: 200, ordinaryEligible: true },
      prefixIsNotAuthority: { status: 200, ordinaryEligible: true },
      boundSelf: { status: 200, ordinaryEligible: false },
      boundAncestor: { status: 200, ordinaryEligible: false },
      goalChild: { status: 200, ordinaryEligible: false },
      goalChildAncestor: { status: 200, ordinaryEligible: false },
      notAdopted: { status: 200, ordinaryEligible: false },
      boundMutationStillRefused: { status: 409 },
      unexpectedTyped: { status: 503 }, storageDefect: { status: 503 }, missing: { status: 404 },
    })
    expect(result.providerRequests).toBe(0)
    expect(result.readsChangedDurableFacts).toBe(false)
    expect(result.closed).toBe(true)
  } finally {
    clearTimeout(timer)
    if (child.exitCode === null) child.kill("SIGKILL")
  }
}, 70_000)
