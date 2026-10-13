import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"

for (const mode of ["idle", "reads", "denied", "warm", "pending", "oversized", "proxy", "proxyread", "account"])
  test(`actual MCP ${mode} bypasses instance bootstrap and preserves the complete cold source`, async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dac-mcp-readonly-")))
    await Promise.all(["home", "tmp", "project"].map((name) => fs.mkdir(path.join(root, name), { mode: 0o700 })))
    const child = Bun.spawn(
      [process.execPath, path.resolve(import.meta.dir, "../fixture/mcp-readonly-http.ts"), mode],
      {
        cwd: path.resolve(import.meta.dir, "../.."),
        env: {
          PATH: process.env.PATH,
          HOME: path.join(root, "home"),
          TMPDIR: path.join(root, "tmp"),
          DEEPAGENT_CODE_TEST_HOME: path.join(root, "home"),
          DAC_MCP_READONLY_ROOT: root,
          DEEPAGENT_CODE_DB: path.join(root, "home", ".deepagent", "code", "authority.sqlite"),
          DEEPAGENT_CODE_SERVER_PASSWORD: mode === "warm" || mode === "oversized" ? "fixture-readonly-password" : "",
          DEEPAGENT_CODE_DISABLE_DEFAULT_PLUGINS: "1",
          DEEPAGENT_CODE_DISABLE_AUTOUPDATE: "1",
          DEEPAGENT_CODE_TEST_MANAGED_CONFIG_DIR: path.join(root, "managed"),
          DEEPAGENT_CODE_DISABLE_MODELS_FETCH: "1",
          DEEPAGENT_CODE_EXPERIMENTAL_WORKSPACES: mode === "proxy" || mode === "proxyread" ? "true" : "false",
          DEEPAGENT_CODE_MODELS_PATH: path.resolve(import.meta.dir, "../tool/fixtures/models-api.json"),
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const timer = setTimeout(() => child.kill(), 30000)
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      await fs.writeFile(path.join(root, "process.log"), stdout + stderr)
      console.info("MCP_READONLY_PRODUCER_EVIDENCE", root)
      expect({ code, diagnostic: code === 0 ? null : stdout + stderr }).toEqual({ code: 0, diagnostic: null })
    } finally {
      clearTimeout(timer)
      child.kill()
    }
  }, 35000)
