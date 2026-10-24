import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

test("Goal pause preserves actual interrupted native writes and refuses recovery at real logical reservation capacity", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dac-goal-pause-edges-")))
  await Promise.all(
    ["home", "tmp", "config", "data", "cache", "state", "project"].map((name) => fs.mkdir(path.join(root, name))),
  )
  const child = Bun.spawn(
    [process.execPath, path.resolve(import.meta.dir, "../fixture/goal-pause-failure-edges.ts"), root],
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
        DEEPAGENT_IM_AGENT_RESPONDER: "off",
        DEEPAGENT_CODE_SERVER_PASSWORD: "pause-edge-fixture",
        NO_COLOR: "1",
      },
    },
  )
  const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
  const timer = setTimeout(() => child.kill("SIGKILL"), 150000)
  try {
    const status = await child.exited
    const log = (await output).join("\n")
    await Bun.write(path.join(root, "output.log"), log)
    expect({ status, root, log }).toMatchObject({ status: 0 })
    const result = await Bun.file(path.join(root, "result.json")).json()
    expect(result.providerReceipts).toBe(0)
    expect(result.writeInterrupted).toMatchObject({
      ordinaryResumeRefused: true,
      boundaryAbsent: true,
      documentCASCrashProven: false,
      custody: { live: 0, quarantine: 0 },
      nativeEffect: { state: "stop_confirmed", containment: "single-process", stopProof: "owned_process_exit" },
    })
    expect(result.capacity).toMatchObject({
      records: 256,
      bytes: 268435456,
      pauseRevoked: true,
      ordinaryResumeRefused: true,
      boundaryAbsent: true,
      stopSucceeded: true,
    })
    expect(result.cleanup).toEqual({ server: true, runtime: true })
  } finally {
    clearTimeout(timer)
    if (child.exitCode === null) child.kill("SIGKILL")
  }
}, 155000)
