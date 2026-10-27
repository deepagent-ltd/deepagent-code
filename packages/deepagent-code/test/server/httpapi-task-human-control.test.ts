import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

test("formal HTTP human Task control authenticates the real operator and keeps unknown execution in custody", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dac-task-human-control-")))
  await Promise.all(
    ["home", "tmp", "config", "data", "cache", "state", "project"].map((name) => fs.mkdir(path.join(root, name))),
  )
  const child = Bun.spawn(
    [
      process.execPath,
      ...(process.platform === "win32"
        ? ["--preload", path.resolve(import.meta.dir, "../fixture/source-empty-settings-preload.ts")]
        : []),
      path.resolve(import.meta.dir, "../fixture/task-human-control-host.ts"),
      root,
    ],
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
        DEEPAGENT_CODE_TEST_HOME: process.platform === "win32" ? root : path.join(root, "home"),
        DEEPAGENT_CODE_HOME: path.join(root, "data"),
        DEEPAGENT_CODE_DB: path.join(root, "authority.sqlite"),
        DEEPAGENT_CODE_TEST_MANAGED_CONFIG_DIR: path.join(root, "managed"),
        DEEPAGENT_CODE_MODELS_PATH: path.resolve(import.meta.dir, "../tool/fixtures/models-api.json"),
        DEEPAGENT_CODE_DISABLE_MODELS_FETCH: "1",
        DEEPAGENT_IM_AGENT_RESPONDER: "off",
        DEEPAGENT_CODE_ATTENTION_PROFILE: "implicit-local",
        DEEPAGENT_CODE_SERVER_PASSWORD: "task-human-control-fixture",
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
    expect(result.cleanup).toEqual({ listenerClosed: true, runtimeDisposed: true })
    expect(result.known.state).toBe("closed")
    expect(result.known.nullChild).toBeTrue()
    expect(result.exactRetry).toBeTrue()
    expect(result.unknown.state).toBe("recovery_required")
    expect(result.unknown.controlState).toBe("close_requested")
    expect(result.unknown.claimRetained).toBeTrue()
    expect(result.denied.every((item: { unchanged: boolean }) => item.unchanged)).toBeTrue()
    expect(result.advertisements).toHaveLength(2)
    expect(result.advertisements[0].actions).toEqual(["task_request_close", "task_resolve_failed", "task_resolve_closed"])
    expect(result.advertisements[1].actions).toEqual(["task_request_close"])
    expect(result.advertisements.every((item: { unchanged: boolean; seen: boolean; denied: number }) => item.unchanged && item.seen && item.denied === 2)).toBeTrue()
    expect(result.providers).toBe(0)
    expect(result.taskControlReceipts).toBe(2)
  } finally {
    clearTimeout(timeout)
    if (child.exitCode === null) child.kill("SIGKILL")
  }
}, 50000)
