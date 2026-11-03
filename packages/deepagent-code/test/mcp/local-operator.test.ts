import { afterAll, beforeAll, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"

const state: { cohort?: Awaited<ReturnType<typeof import("../fixture/windows-native-cli-cohort").build>> } = {}

beforeAll(async () => {
  if (process.platform !== "win32") return
  const runner = process.env.RUNNER_TEMP
  if (!runner || path.win32.parse(runner).root.toUpperCase() !== "D:\\")
    throw new Error("Native MCP operator tests require D: scratch space")
  await fs.mkdir(runner, { recursive: true })
  const { WindowsNativeCliCohort } = await import("../fixture/windows-native-cli-cohort")
  state.cohort = await WindowsNativeCliCohort.build({
    directory: await fs.mkdtemp(path.join(runner, "dac-mcp-operator-build-")),
    businessEntry: path.resolve(import.meta.dir, "../fixture/mcp-local-operator.ts"),
  })
}, 240_000)

afterAll(async () => {
  await state.cohort?.dispose()
})

for (const mode of [
  "canonical",
  "legacy",
  "listener",
  "cancel",
  "late-source",
  "startup",
  "account-aba",
  "legacy-binding",
  "legacy-git-binding",
])
  test(`actual ${mode}: no-password TUI worker uses fixed native MCP actions while raw HTTP stays unauthorized`, async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(state.cohort?.root ?? os.tmpdir(), "dac-mcp-operator-")))
    await Promise.all(["home", "tmp", "project"].map((name) => fs.mkdir(path.join(root, name), { mode: 0o700 })))
    if (mode === "legacy-git-binding") {
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
    const data = path.join(root, "home", ".deepagent", "code")
    const env = {
      PATH: process.env.PATH!,
      HOME: path.join(root, "home"),
      TMPDIR: path.join(root, "tmp"),
      DEEPAGENT_CODE_TEST_HOME: path.join(root, "home"),
      DEEPAGENT_CODE_HOME: data,
      DEEPAGENT_CODE_SERVER_PASSWORD: "",
      DAC_MCP_OPERATOR_ROOT: root,
      DAC_MCP_OPERATOR_MODE: mode,
      DEEPAGENT_CODE_DB: path.join(data, "authority.sqlite"),
      DEEPAGENT_CODE_TEST_MANAGED_CONFIG_DIR: path.join(root, "managed"),
      DEEPAGENT_CODE_MODELS_PATH: path.resolve(import.meta.dir, "../tool/fixtures/models-api.json"),
    }
    const command = state.cohort
      ? await state.cohort.invocation({ args: ["host"], cwd: path.join(root, "project"), env })
      : {
          cmd: [process.execPath, path.resolve(import.meta.dir, "../fixture/mcp-local-operator.ts"), "host"],
          cwd: path.join(root, "project"),
          env,
        }
    const child = Bun.spawn({ ...command, stdout: "pipe", stderr: "pipe" })
    const deadline = setTimeout(() => child.kill(), 55000)
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    clearTimeout(deadline)
    await fs.writeFile(path.join(root, "output.log"), stdout + stderr)
    console.log("MCP_OPERATOR_EVIDENCE", root)
    expect({ code, error: code === 0 ? undefined : stdout + stderr }).toEqual({ code: 0, error: undefined })
  }, 60000)
