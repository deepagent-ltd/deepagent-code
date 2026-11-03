import { afterAll, beforeAll, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"

const state: { cohort?: Awaited<ReturnType<typeof import("./fixture/native-auth-cohort").build>> } = {}
beforeAll(async () => {
  const { build } = await import("./fixture/native-auth-cohort")
  state.cohort = await build(path.resolve(import.meta.dir, "../fixture/mcp-http-auth.ts"))
}, 240_000)
afterAll(async () => {
  await state.cohort?.dispose()
})

for (const mode of ["empty", "authenticated"])
  test(`actual MCP listener ${mode} preserves current authentication and cold reads never initialize OAuth`, async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(state.cohort?.root ?? os.tmpdir(), "dac-mcp-http-auth-")))
    await Promise.all(["home", "tmp", "project"].map((name) => fs.mkdir(path.join(root, name), { mode: 0o700 })))
    const env = {
      PATH: process.env.PATH!,
      HOME: path.join(root, "home"),
      TMPDIR: path.join(root, "tmp"),
      DEEPAGENT_CODE_TEST_HOME: path.join(root, "home"),
      DAC_MCP_HTTP_ROOT: root,
      DEEPAGENT_CODE_DB: path.join(root, "home", ".deepagent", "code", "authority.sqlite"),
      DEEPAGENT_CODE_SERVER_PASSWORD: mode === "authenticated" ? "fixture-mcp-password" : "",
      DEEPAGENT_CODE_DISABLE_DEFAULT_PLUGINS: "1",
      DEEPAGENT_CODE_DISABLE_AUTOUPDATE: "1",
      DEEPAGENT_CODE_DISABLE_MODELS_FETCH: "1",
      DEEPAGENT_CODE_TEST_MANAGED_CONFIG_DIR: path.join(root, "managed"),
      DEEPAGENT_CODE_MODELS_PATH: path.resolve(import.meta.dir, "../tool/fixtures/models-api.json"),
    }
    const command = state.cohort && mode === "authenticated"
      ? await state.cohort.invocation({ args: [mode], cwd: path.join(root, "project"), env })
      : {
          cmd: [
            process.execPath,
            ...(process.platform === "win32"
              ? ["--preload", path.resolve(import.meta.dir, "../fixture/source-empty-settings-preload.ts")]
              : []),
            path.resolve(import.meta.dir, "../fixture/mcp-http-auth.ts"),
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
      expect({ code, diagnostic: code === 0 ? null : stdout + stderr }).toEqual({ code: 0, diagnostic: null })
      const evidence = JSON.parse(await fs.readFile(path.join(root, "evidence.json"), "utf8"))
      expect(evidence.coldGet).toEqual({ http: 200, oauthWrites: 0, externalRequests: 0 })
      console.info("MCP_HTTP_CURRENT_AUTH_EVIDENCE", root)
    } finally {
      clearTimeout(timer)
      child.kill()
    }
  }, 35000)
