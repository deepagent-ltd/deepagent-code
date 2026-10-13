import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "node:os"

test("actual authenticated Node HTTP MCP Apps routes read only explicitly approved current resources", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "dac-mcp-apps-http-")))
  await Promise.all(["home", "tmp", "project"].map((name) => mkdir(path.join(root, name), { mode: 0o700 })))
  const child = Bun.spawn({
    cmd: [process.execPath, path.join(import.meta.dir, "fixture/mcp-apps-http.ts"), root],
    cwd: path.resolve(import.meta.dir, "../.."),
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      HOME: path.join(root, "home"),
      TMPDIR: path.join(root, "tmp"),
      DEEPAGENT_CODE_TEST_HOME: path.join(root, "home"),
      XDG_CONFIG_HOME: path.join(root, "home", "config"),
      XDG_DATA_HOME: path.join(root, "home", "data"),
      XDG_CACHE_HOME: path.join(root, "home", "cache"),
      XDG_STATE_HOME: path.join(root, "home", "state"),
      DEEPAGENT_CODE_DB: path.join(root, "home", ".deepagent", "code", "authority.sqlite"),
      DEEPAGENT_CODE_SERVER_PASSWORD: "private-apps-http-test-password",
      DEEPAGENT_CODE_TEST_MANAGED_CONFIG_DIR: path.join(root, "managed"),
      DEEPAGENT_CODE_DISABLE_DEFAULT_PLUGINS: "1",
      DEEPAGENT_CODE_DISABLE_AUTOUPDATE: "1",
      DEEPAGENT_CODE_DISABLE_MODELS_FETCH: "1",
      DEEPAGENT_CODE_MODELS_PATH: path.resolve(import.meta.dir, "../tool/fixtures/models-api.json"),
      DEEPAGENT_CODE_EXPERIMENTAL_WORKSPACES: "false",
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const timer = setTimeout(() => child.kill(), 55000)
  try {
    const [status, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    if (process.env.DEEPAGENT_TEST_MCP_APPS_HTTP_EVIDENCE) {
      await Bun.write(`${process.env.DEEPAGENT_TEST_MCP_APPS_HTTP_EVIDENCE}.log`, stdout + stderr)
      if (status === 0)
        await Bun.write(
          `${process.env.DEEPAGENT_TEST_MCP_APPS_HTTP_EVIDENCE}.json`,
          await readFile(path.join(root, "result.json")),
        )
    }
    expect({ status, output: status === 0 ? "ok" : stdout + stderr }).toEqual({ status: 0, output: "ok" })
    const result = JSON.parse(await readFile(path.join(root, "result.json"), "utf8"))
    expect(result).toMatchObject({
      fixture: "mcp-apps-http",
      actualRoot: true,
      actualNodeHttp: true,
      actualSdkServer: true,
      htmlRead: true,
      authReadDelta: 0,
      invalidReadDelta: 0,
      toolsCalled: 0,
      executionRows: [0, 0, 0, 0, 0, 0, 0, 0],
      stopped: true,
    })
    expect(result.failures.map((item: { status: number }) => item.status)).toEqual([
      401, 401, 401, 401, 400, 400, 409, 409,
    ])
    expect(["changed", "unavailable"]).toContain(result.lateCode)
    expect(stdout).not.toContain("private-apps-http-test-password")
    expect(stdout).not.toContain("synthetic-config-header-secret")
  } finally {
    clearTimeout(timer)
    child.kill()
    await child.exited
    await rm(root, { recursive: true, force: true })
  }
}, 60000)
