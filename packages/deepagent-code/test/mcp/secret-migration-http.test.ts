import { afterAll, beforeAll, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"

const native: { cohort?: Awaited<ReturnType<typeof import("../fixture/windows-native-cli-cohort").WindowsNativeCliCohort.build>> } = {}
beforeAll(async () => {
  if (process.platform !== "win32") return
  const { WindowsNativeCliCohort } = await import("../fixture/windows-native-cli-cohort")
  const directory = path.join(process.env.RUNNER_TEMP ?? path.resolve(import.meta.dir, "../../.artifacts"), "windows-native-mcp-migration-http")
  await fs.mkdir(directory, { recursive: true })
  native.cohort = await WindowsNativeCliCohort.build({
    directory: await fs.realpath(directory),
    businessEntry: path.join(import.meta.dir, "fixture/secret-migration-process.ts"),
    extraSources: [import.meta.path, ...["auth", "npm"].map((name) => path.resolve(import.meta.dir, `../fake/${name}.ts`))],
  })
}, 240_000)
afterAll(async () => {
  await native.cohort?.dispose()
})

test("authenticated production MCP handlers use the original private migration services without bootstrap or a second database", async () => {
  const directory = native.cohort ? await fs.mkdtemp(path.join(native.cohort.root, "secret-migration-http-")) : undefined
  await using root = directory
    ? { path: directory, [Symbol.asyncDispose]: async () => fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
    : await tmpdir()
  const home = path.join(root.path, "private-home")
  await fs.mkdir(home, { recursive: true, mode: 0o700 })
  const env = {
    PATH: process.env.PATH!,
    HOME: home,
    DEEPAGENT_CODE_TEST_HOME: home,
    XDG_CONFIG_HOME: path.join(home, "config"),
    XDG_DATA_HOME: path.join(home, "data"),
    XDG_STATE_HOME: path.join(home, "state"),
    XDG_CACHE_HOME: path.join(home, "cache"),
    DEEPAGENT_CODE_DB: path.join(home, "database.sqlite"),
    DEEPAGENT_CODE_TEST_MANAGED_CONFIG_DIR: path.join(home, "managed"),
    DEEPAGENT_CODE_MODELS_PATH: path.resolve(import.meta.dir, "../tool/fixtures/models-api.json"),
    ...(native.cohort ? {
      TEMP: path.join(root.path, "tmp"), TMP: path.join(root.path, "tmp"),
      DEEPAGENT_CODE_HOME: path.join(home, ".deepagent", "code"),
    } : {}),
  }
  const command = native.cohort
    ? await native.cohort.invocation({ args: [root.path, "api"], cwd: root.path, env })
    : { cmd: [process.execPath, path.join(import.meta.dir, "fixture/secret-migration-process.ts"), root.path, "api"], cwd: path.resolve(import.meta.dir, "../.."), env }
  const child = Bun.spawn({ ...command, stdout: "pipe", stderr: "pipe" })
  const timer = setTimeout(() => child.kill(), 30_000)
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(code, stderr).toBe(0)
    const line = stdout.split("\n").findLast((value) => value.startsWith('{"fixture":"mcp-secret-migration",'))
    expect(line).toBeDefined()
    expect(JSON.parse(line!)).toMatchObject({
      actualHandlers: true,
      actualServices: true,
      middlewareRouteContext: "controlled-local",
      initialized: true,
      migrated: 2,
      repaired: true,
      exactRetryPutDelta: 0,
      wrongNameRejected: true,
      executionRows: [0, 0, 0, 0, 0, 0],
      put: 2,
      network: 0,
    })
    expect(stdout).not.toContain("secret://")
    expect(stdout).not.toContain("fixture-a-client")
  } finally {
    clearTimeout(timer)
    child.kill()
    await child.exited
  }
}, 40_000)
