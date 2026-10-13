import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

test("actual no-password TUI parent channel controls original Tasks while HTTP and foreign scope remain denied", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dac-private-task-tui-")))
  await Promise.all(
    ["home", "tmp", "config", "data", "cache", "state", "project"].map((name) => fs.mkdir(path.join(root, name))),
  )
  const child = Bun.spawn(
    [process.execPath, path.resolve(import.meta.dir, "./fixture/task-tui-private-host.ts"), root],
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
        DEEPAGENT_IM_AGENT_RESPONDER: "off",
        DEEPAGENT_CODE_ATTENTION_PROFILE: "implicit-local",
        DEEPAGENT_CODE_SERVER_PASSWORD: "",
        NO_COLOR: "1",
      },
    },
  )
  const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
  const timeout = setTimeout(() => child.kill("SIGKILL"), 45000)
  try {
    const status = await child.exited
    const log = (await output).join("\n")
    await Bun.write(path.join(root, "output.log"), log)
    expect({ status, root, log }).toMatchObject({ status: 0 })
    const result = await Bun.file(path.join(root, "result.json")).json()
    expect(result.cleanup).toBeTrue()
    expect(result.state).toBe("closed")
    expect(result.exactRetry).toBeTrue()
    expect(result.ordinaryReadsUnchanged).toBeTrue()
    expect(result.foreignScopeDenied).toBeTrue()
    expect(result.unauthenticatedListenerDenied).toBeTrue()
    expect(result.rawHTTPStatus).toBe(401)
    expect(result.unknownCustody).toBeTrue()
    expect(result.preAbortedUnchanged).toBeTrue()
    expect(result.census.ledger[0].providers).toBe(0)
    expect(result.census.ledger[0].attempts).toBe(0)
    expect(result.census.ledger[0].tools).toBe(0)
    expect(result.census.ledger[0].claims).toBe(1)
  } finally {
    clearTimeout(timeout)
    if (child.exitCode === null) child.kill("SIGKILL")
  }
}, 50000)
