import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"

test("actual Node HTTP TUI owner endpoints cannot mint a Desktop origin with Basic authentication alone", async () => {
  const root = await fs.realpath(await fs.mkdtemp("/tmp/dac-tui-owner-http-"))
  await fs.chmod(root, 0o700)
  await fs.symlink(
    path.resolve(import.meta.dir, "../../../desktop/node_modules"),
    path.join(root, "node_modules"),
    "dir",
  )
  const build = await Bun.build({
    entrypoints: [path.join(import.meta.dir, "fixture/tui-owner-http.ts")],
    outdir: root,
    naming: "main.mjs",
    target: "node",
    external: ["@lydell/node-pty", "jsonc-parser", "bun"],
    define: { DEEPAGENT_CODE_VERSION: '"2.0.5"', DEEPAGENT_CODE_CHANNEL: '"dev"' },
    files: { "deepagent-code-web-ui.gen.ts": "" },
  })
  expect(build.success).toBe(true)
  const node = Bun.which("node")
  expect(node).not.toBeNull()
  await Promise.all(
    ["home", "tmp", "config", "data", "cache", "state"].map((name) => fs.mkdir(path.join(root, name), { mode: 0o700 })),
  )
  const child = Bun.spawn([node!, build.outputs[0]!.path], {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      HOME: path.join(root, "home"),
      TMPDIR: path.join(root, "tmp"),
      XDG_DATA_HOME: path.join(root, "data"),
      XDG_CONFIG_HOME: path.join(root, "config"),
      XDG_CACHE_HOME: path.join(root, "cache"),
      XDG_STATE_HOME: path.join(root, "state"),
      DEEPAGENT_CODE_HOME: path.join(root, "data"),
      DEEPAGENT_CODE_TEST_HOME: path.join(root, "home"),
      DEEPAGENT_CODE_DB: path.join(root, "authority.sqlite"),
      DEEPAGENT_CODE_SERVER_USERNAME: "operator",
      DEEPAGENT_CODE_SERVER_PASSWORD: "private-fixture",
      DEEPAGENT_CODE_DISABLE_MODELS_FETCH: "1",
      DEEPAGENT_IM_AGENT_RESPONDER: "off",
      DAC_BROWSER_TEST_ROOT: root,
      NO_COLOR: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const timeout = setTimeout(() => child.kill(), 45_000)
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  clearTimeout(timeout)
  await Bun.write(path.join(root, "process.log"), stdout + "\n" + stderr)
  expect({ code, error: code ? stderr : null }).toEqual({ code: 0, error: null })
  const result = await Bun.file(path.join(root, "result.json")).json()
  expect(result.results.map((entry: { status: number }) => entry.status)).toEqual([503, 503, 503, 503, 503])
  expect(result.results.every((entry: { body: string }) => entry.body.includes("BROWSER_HOST_UNAVAILABLE"))).toBe(true)
  expect(result.results.every((entry: { body: string }) => !entry.body.includes('"stamp"'))).toBe(true)
  expect(result.wrongAuth).toBe(401)
  expect(result.nativeHost).toBe(false)
  console.log("TUI_OWNER_HTTP_EVIDENCE", root)
}, 60_000)
