import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"

test("actual bare Node HTTP refuses native creation without host or configured authentication", async () => {
  const root = await fs.realpath(await fs.mkdtemp("/tmp/dac-browser-http-closed-"))
  await fs.chmod(root, 0o700)
  // Node sidecar externals are shipped by Desktop, including its Node-ABI PTY selector.
  await fs.symlink(path.resolve(import.meta.dir, "../../../desktop/node_modules"), path.join(root, "node_modules"), "dir")
  const build = await Bun.build({ entrypoints: [path.join(import.meta.dir, "fixture/http-closed.ts")],
    outdir: root, naming: "main.mjs", target: "node", external: ["@lydell/node-pty", "jsonc-parser", "bun"],
    define: { DEEPAGENT_CODE_VERSION: '"2.0.3"', DEEPAGENT_CODE_CHANNEL: '"dev"' }, files: { "deepagent-code-web-ui.gen.ts": "" } })
  expect(build.success).toBe(true)
  const node = Bun.which("node")
  expect(node).not.toBeNull()
  for (const mode of ["authenticated", "empty"]) {
    const instance = path.join(root, mode)
    await fs.mkdir(instance, { mode: 0o700 })
    await Promise.all(["home", "tmp", "config", "data", "cache", "state"].map((name) => fs.mkdir(path.join(instance, name), { mode: 0o700 })))
    const child = Bun.spawn([node!, build.outputs[0]!.path], {
      cwd: instance, env: { PATH: process.env.PATH, HOME: path.join(instance, "home"), TMPDIR: path.join(instance, "tmp"),
        XDG_DATA_HOME: path.join(instance, "data"), XDG_CONFIG_HOME: path.join(instance, "config"), XDG_CACHE_HOME: path.join(instance, "cache"), XDG_STATE_HOME: path.join(instance, "state"),
        DEEPAGENT_CODE_HOME: path.join(instance, "data"), DEEPAGENT_CODE_TEST_HOME: path.join(instance, "home"), DEEPAGENT_CODE_DB: path.join(instance, "authority.sqlite"),
        DEEPAGENT_CODE_SERVER_USERNAME: "operator", DEEPAGENT_CODE_SERVER_PASSWORD: mode === "authenticated" ? "private-fixture" : "",
        DEEPAGENT_CODE_DISABLE_MODELS_FETCH: "1", DEEPAGENT_IM_AGENT_RESPONDER: "off", DAC_BROWSER_TEST_ROOT: instance, NO_COLOR: "1" },
      stdout: "pipe", stderr: "pipe" })
    const timeout = setTimeout(() => child.kill(), 45_000)
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    clearTimeout(timeout)
    await Bun.write(path.join(instance, "process.log"), stdout + "\n" + stderr)
    expect({ code, error: code ? stderr : null }).toEqual({ code: 0, error: null })
  }
  console.log("BROWSER_HTTP_CLOSED_EVIDENCE", root)
  const result = await Bun.file(path.join(root, "authenticated/result.json")).json()
  const empty = await Bun.file(path.join(root, "empty/result.json")).json()
  expect(result.noHost.status).toBe(503)
  expect(result.noHost.body).toContain("BROWSER_HOST_UNAVAILABLE")
  expect(result.wrongAuth.status).toBe(401)
  expect(empty.emptyPassword.status).toBe(403)
  expect(empty.emptyPassword.body).toContain("BROWSER_AUTHORITY_REQUIRED")
  expect(result.noAction.status).toBe(404)
  expect(result.absent.status).toBe(404)
  expect(result.controls).toBe(0)
  expect(result.actions).toBe(0)
  expect(result.hostAvailable).toBe(false)
  expect(result.bunLoaded).toBe(false)
}, 60_000)
