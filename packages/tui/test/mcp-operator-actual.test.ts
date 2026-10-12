import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

for (const variant of [
  { width: 100, locale: "en", git: false },
  { width: 50, locale: "zh", git: false },
  { width: 100, locale: "en", git: true },
])
  test(`actual TUI MCP native keys and remote relay guard ${variant.locale}/${variant.width}/${variant.git ? "git" : "registered"}`, async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dac-mcp-tui-actual-")))
    await Promise.all(["home", "tmp", "project"].map((name) => fs.mkdir(path.join(root, name), { mode: 0o700 })))
    if (variant.git) {
      for (const args of [
        ["init", "--quiet"],
        [
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.test",
          "commit",
          "--allow-empty",
          "--quiet",
          "-m",
          "fixture",
        ],
      ]) {
        const git = Bun.spawn(["git", "-C", path.join(root, "project"), ...args], {
          env: { PATH: process.env.PATH, HOME: path.join(root, "home") },
          stdout: "pipe",
          stderr: "pipe",
        })
        expect(await git.exited, await new Response(git.stderr).text()).toBe(0)
      }
    }
    const output = Bun.file(path.join(root, "output.log"))
    const child = Bun.spawn(
      [
        process.execPath,
        "--preload",
        path.resolve(import.meta.dir, "../node_modules/@opentui/solid/scripts/preload.js"),
        path.resolve(import.meta.dir, "fixture/mcp-operator-actual.tsx"),
      ],
      {
        cwd: path.join(root, "project"),
        stdout: output,
        stderr: output,
        env: {
          PATH: process.env.PATH,
          HOME: path.join(root, "home"),
          TMPDIR: path.join(root, "tmp"),
          DEEPAGENT_CODE_TEST_HOME: path.join(root, "home"),
          DEEPAGENT_CODE_SERVER_PASSWORD: "",
          DEEPAGENT_CODE_DB: path.join(root, "home/.deepagent/code/authority.sqlite"),
          DEEPAGENT_CODE_TEST_MANAGED_CONFIG_DIR: path.join(root, "managed"),
          DEEPAGENT_CODE_MODELS_PATH: path.resolve(
            import.meta.dir,
            "../../deepagent-code/test/tool/fixtures/models-api.json",
          ),
          DEEPAGENT_CODE_DISABLE_TERMINAL_TITLE: "1",
          DAC_MCP_OPERATOR_ROOT: root,
          DAC_MCP_OPERATOR_WIDTH: String(variant.width),
          LANG: variant.locale === "zh" ? "zh_CN.UTF-8" : "en_US.UTF-8",
        },
      },
    )
    const timer = setTimeout(() => child.kill("SIGKILL"), 65000)
    try {
      expect(await child.exited, await output.text()).toBe(0)
      const result = await Bun.file(path.join(root, "result.json")).json()
      expect(result.native.sends).toEqual(["startAuth", "finishAuth", "clearAuth"])
      expect(result.publicMcpWrites).toBe(0)
      expect(result.relayEvents).toBeGreaterThanOrEqual(12)
      console.log("MCP_TUI_EVIDENCE", root)
    } finally {
      clearTimeout(timer)
      if (child.exitCode === null) {
        child.kill("SIGKILL")
        await child.exited
      }
      if (child.exitCode !== 0) console.error("MCP_TUI_FAILURE", root)
    }
  }, 70000)
