import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"

test("actual default TUI worker RPC cannot authorize OAuth using an empty-password HTTP context", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dac-mcp-tui-rpc-")))
  await Promise.all(["home", "tmp", "project"].map((name) => fs.mkdir(path.join(root, name))))
  const child = Bun.spawn([process.execPath, path.resolve(import.meta.dir, "../fixture/mcp-tui-rpc.ts")], {
    cwd: path.resolve(import.meta.dir, "../.."),
    env: {
      PATH: process.env.PATH,
      HOME: path.join(root, "home"),
      TMPDIR: path.join(root, "tmp"),
      DEEPAGENT_CODE_TEST_HOME: path.join(root, "home"),
      DAC_MCP_TUI_ROOT: root,
      DEEPAGENT_CODE_SERVER_PASSWORD: "",
      DEEPAGENT_CODE_DB: path.join(root, "home", ".deepagent", "code", "authority.sqlite"),
      DEEPAGENT_CODE_DISABLE_DEFAULT_PLUGINS: "1",
      DEEPAGENT_CODE_DISABLE_AUTOUPDATE: "1",
      DEEPAGENT_CODE_TEST_MANAGED_CONFIG_DIR: path.join(root, "managed"),
      DEEPAGENT_CODE_MODELS_PATH: path.resolve(import.meta.dir, "../tool/fixtures/models-api.json"),
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const timer = setTimeout(() => child.kill(), 35000)
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    await fs.writeFile(path.join(root, "process.log"), stdout + stderr)
    expect({ code, diagnostic: code === 0 ? null : stdout + stderr }).toEqual({ code: 0, diagnostic: null })
    expect(JSON.parse(await fs.readFile(path.join(root, "evidence.json"), "utf8"))).toMatchObject({
      httpStatus: 401,
      externalRequests: 0,
      actualRpc: true,
    })
    console.info("MCP_DEFAULT_TUI_NEGATIVE_EVIDENCE", root)
  } finally {
    clearTimeout(timer)
    child.kill()
  }
}, 40000)
