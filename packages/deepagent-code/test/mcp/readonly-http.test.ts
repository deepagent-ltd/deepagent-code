import { afterAll, beforeAll, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"

const state: { cohort?: Awaited<ReturnType<typeof import("./fixture/native-auth-cohort").build>> } = {}
beforeAll(async () => {
  const { build } = await import("./fixture/native-auth-cohort")
  state.cohort = await build(path.resolve(import.meta.dir, "../fixture/mcp-readonly-http.ts"))
}, 240_000)
afterAll(async () => {
  await state.cohort?.dispose()
})

for (const mode of ["idle", "reads", "denied", "warm", "pending", "oversized", "proxy", "proxyread", "account", "damaged"])
  test(`actual MCP ${mode} bypasses instance bootstrap and preserves the complete cold source`, async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(state.cohort?.root ?? os.tmpdir(), "dac-mcp-readonly-")))
    await Promise.all(["home", "tmp", "project"].map((name) => fs.mkdir(path.join(root, name), { mode: 0o700 })))
    const env = {
      PATH: process.env.PATH!,
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
    }
    const command = state.cohort && (mode === "warm" || mode === "account")
      ? await state.cohort.invocation({ args: [mode], cwd: path.join(root, "project"), env })
      : {
          cmd: [
            process.execPath,
            ...(process.platform === "win32"
              ? ["--preload", path.resolve(import.meta.dir, "../fixture/source-empty-settings-preload.ts")]
              : []),
            path.resolve(import.meta.dir, "../fixture/mcp-readonly-http.ts"),
            mode,
          ],
          cwd: path.resolve(import.meta.dir, "../.."),
          env,
        }
    const child = Bun.spawn({ ...command, stdout: "pipe", stderr: "pipe" })
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
