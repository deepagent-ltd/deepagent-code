import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "../../fixture/fixture"

test("Attention cross-project reader uses the real root API and private file database without execution", async () => {
  await using tmp = await tmpdir()
  const host = path.resolve(import.meta.dir, "../../../../deepagent-code")
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/(KEY|TOKEN|SECRET|PASSWORD)$/.test(key)),
  )
  const child = Bun.spawn([process.execPath, path.join(host, "test/fixture/attention-tui-placement.ts"), tmp.path], {
    cwd: host,
    env: {
      ...env,
      HOME: tmp.path,
      TMPDIR: tmp.path,
      DEEPAGENT_CODE_TEST_HOME: tmp.path,
      XDG_DATA_HOME: path.join(tmp.path, "data"),
      XDG_CONFIG_HOME: path.join(tmp.path, "config"),
      XDG_CACHE_HOME: path.join(tmp.path, "cache"),
      DEEPAGENT_CODE_DB: path.join(tmp.path, "attention.db"),
      DEEPAGENT_CODE_ATTENTION_PROFILE: "implicit-local",
      DEEPAGENT_CODE_WORKSPACE_ID: "",
      DEEPAGENT_CODE_GATEWAY: "false",
      DEEPAGENT_CODE_SERVER_PASSWORD: "placement-fixture",
      DEEPAGENT_CODE_SERVER_USERNAME: "operator",
      DEEPAGENT_CODE_DISABLE_MODELS_FETCH: "1",
      DEEPAGENT_IM_AGENT_RESPONDER: "off",
      DEEPAGENT_IM_FACADE_URL: "",
      DEEPAGENT_IM_FACADE_KEY: "",
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const timeout = setTimeout(() => child.kill(), 25_000)
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    if (code !== 0) throw new Error(`Attention placement subprocess failed: ${stdout}\n${stderr}`)
    expect(stdout).toContain("ATTENTION_TUI_FILE_DB_PLACEMENT_PASS")
  } finally {
    clearTimeout(timeout)
    if (child.exitCode === null) child.kill()
    await child.exited
  }
}, 30_000)
