import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

test("actual AppRuntime HTTP/fileDB shared files: immutable exact history, private Native readiness and no public dispatch", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dac-shared-files-http-")))
  await Promise.all(["home", "tmp", "config", "data", "cache", "state", "project"].map((name) => fs.mkdir(path.join(root, name), { mode: 0o700 })))
  const child = Bun.spawn([process.execPath, path.resolve(import.meta.dir, "../fixture/browser-shared-files-http-host.ts"), root], {
    cwd: path.join(root, "project"), stdout: "pipe", stderr: "pipe", env: {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: path.join(root, "home"), TMPDIR: path.join(root, "tmp"), TMP: path.join(root, "tmp"), TEMP: path.join(root, "tmp"),
      XDG_CONFIG_HOME: path.join(root, "config"), XDG_DATA_HOME: path.join(root, "data"), XDG_CACHE_HOME: path.join(root, "cache"), XDG_STATE_HOME: path.join(root, "state"),
      DEEPAGENT_CODE_TEST_HOME: path.join(root, "home"), DEEPAGENT_CODE_HOME: path.join(root, "data"), DEEPAGENT_CODE_DB: path.join(root, "authority.sqlite"),
      DEEPAGENT_CODE_TEST_MANAGED_CONFIG_DIR: path.join(root, "managed"), DEEPAGENT_CODE_DISABLE_MODELS_FETCH: "1", DEEPAGENT_IM_AGENT_RESPONDER: "off",
      DEEPAGENT_CODE_MODELS_PATH: path.resolve(import.meta.dir, "../tool/fixtures/models-api.json"),
      DEEPAGENT_CODE_ATTENTION_PROFILE: "implicit-local", DEEPAGENT_CODE_SERVER_USERNAME: "deepagent-code", DEEPAGENT_CODE_SERVER_PASSWORD: "shared-files-http-fixture", NO_COLOR: "1",
    },
  })
  const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
  const timeout = setTimeout(() => child.kill("SIGKILL"), 45_000)
  try {
    const status = await child.exited
    const log = (await output).join("\n")
    await Bun.write(path.join(root, "output.log"), log)
    expect({ status, root, log }).toMatchObject({ status: 0 })
    const result = await Bun.file(path.join(root, "result.json")).json()
    expect(result.cleanup).toEqual({ listenerClosed: true, runtimeDisposed: true })
    expect(result.status.body.state).toBe("unavailable")
    expect(result.replay.body.replayed).toBe(true)
    expect(result.replay.body.grant.state).toBe("unavailable")
    expect(result.conflict.status).toBe(409)
    expect(result.fresh.status).toBe(503)
    expect(result.preview.status).toBe(503)
    expect(result.excess.body.code).toBe("BROWSER_FILE_INVALID")
    expect(result.wrongAuth.status).toBe(401)
    expect(result.foreign.status).toBe(403)
    expect(result.missing.status).toBe(404)
    expect(result.publicDispatchStatus).toBe(404)
    expect(result.facts).toEqual({ confirms: 1, accepts: 1 })
    expect(result.unchangedGrantBytes).toBe(true)
    expect([result.artifacts, result.oldControls, result.providers, result.receipts]).toEqual([0, 0, 0, 0])
    expect(result.nativeHostAvailable).toBe(false)
  } finally {
    clearTimeout(timeout)
    if (child.exitCode === null) child.kill("SIGKILL")
  }
}, 50_000)
