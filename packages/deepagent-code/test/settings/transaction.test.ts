import { afterAll, beforeAll, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import type { WindowsNativeCliCohort } from "../fixture/windows-native-cli-cohort"

const native: { cohort?: Awaited<ReturnType<typeof WindowsNativeCliCohort.build>> } = {}
beforeAll(async () => {
  if (process.platform !== "win32") return
  const { WindowsNativeCliCohort } = await import("../fixture/windows-native-cli-cohort")
  const directory = path.join(process.env.RUNNER_TEMP ?? path.resolve(import.meta.dir, "../../.artifacts"),
    "windows-native-settings-transaction")
  await fs.mkdir(directory, { recursive: true })
  native.cohort = await WindowsNativeCliCohort.build({
    directory: await fs.realpath(directory),
    businessEntry: path.join(import.meta.dir, "transaction-process.ts"),
    extraSources: [import.meta.path, ...["auth", "account", "npm"].map((name) => path.resolve(import.meta.dir, `../fake/${name}.ts`))],
  })
}, 240_000)
afterAll(async () => { await native.cohort?.dispose() })

async function fixture(body: (root: string) => Promise<void>) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(native.cohort?.root ?? os.tmpdir(), "dac-settings-tx-")))
  try {
    await fs.mkdir(path.join(root, "storage"), { mode: 0o700 })
    await fs.mkdir(path.join(root, "workspace"), { mode: 0o700 })
    await fs.mkdir(path.join(root, "tmp"), { mode: 0o700 })
    await fs.writeFile(path.join(root, "storage", "config.jsonc"), '// 保留原注释\n{"model":"original/current"}', {
      mode: 0o600,
    })
    if (native.cohort) {
      const seed = await run(root, "seed")
      expect(seed.code, seed.diagnostic).toBe(0)
    } else {
      await fs.writeFile(
        path.join(root, "storage", "settings.json"),
        JSON.stringify({ deepagent: { agentMode: "general", selfLearning: "manual" } }),
        { mode: 0o600 },
      )
    }
    await body(root)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}

async function start(root: string, mode: string, resultID: string, stage = "") {
  const args = [root, mode, stage, resultID]
  const env = {
    HOME: path.join(root, "home"),
    DEEPAGENT_CODE_TEST_HOME: root,
    DEEPAGENT_CODE_HOME: path.join(root, "storage"),
    TMPDIR: path.join(root, "tmp"),
    DEEPAGENT_CODE_DB: path.join(root, "storage", "database.sqlite"),
    DEEPAGENT_CODE_TEST_MANAGED_CONFIG_DIR: path.join(root, "managed"),
    DEEPAGENT_CODE_MODELS_PATH: path.resolve(import.meta.dir, "../tool/fixtures/models-api.json"),
  }
  const invocation = native.cohort
    ? await native.cohort.invocation({ args, env, inheritEnvironment: false })
    : {
        cmd: [process.execPath, path.join(import.meta.dir, "transaction-process.ts"), ...args],
        cwd: path.resolve(import.meta.dir, "../.."),
        env: { ...env, PATH: process.env.PATH },
      }
  return Bun.spawn({ ...invocation, stdout: "pipe", stderr: "pipe" })
}

async function run(root: string, mode: string) {
  const resultID = randomUUID()
  const resultPath = path.join(root, `child-result-${resultID}.json`)
  const child = await start(root, mode, resultID)
  const timer = setTimeout(() => child.kill("SIGKILL"), 15_000)
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    const diagnostic = JSON.stringify({
      root,
      mode,
      pid: child.pid,
      exitCode: code,
      signal: child.signalCode,
      resultPath,
      stdout: stdout.slice(-65536),
      stderr: stderr.slice(-65536),
    })
    if (stdout.length + stderr.length > 1_048_576)
      throw new Error(`Private fixture output exceeded bound: ${diagnostic}`)
    const result = (await Bun.file(resultPath)
      .json()
      .catch((error: unknown) => {
        throw new Error(`Private settings fixture result unavailable: ${diagnostic}`, { cause: error })
      })) as {
      ok: boolean
      error?: string
      writes: string[]
    }
    return { code, ...result, diagnostic }
  } finally {
    clearTimeout(timer)
    child.kill("SIGKILL")
    await child.exited
  }
}

async function pauseAndKill(root: string, stage: string, actualExpiry = false) {
  const child = await start(root, "global", randomUUID(), stage)
  const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
  const timer = setTimeout(() => child.kill("SIGKILL"), 15_000)
  try {
    const pausedPath = path.join(root, "paused")
    const deadline = Date.now() + 12_000
    let paused: { kind: string; stage: string; pid: number } | undefined
    while (!paused && Date.now() < deadline && child.exitCode === null) {
      paused = await Bun.file(pausedPath).json().catch(() => undefined)
      if (!paused) await Bun.sleep(10)
    }
    child.kill("SIGKILL")
    await child.exited
    const bytes = await output
    const diagnostic = JSON.stringify({
      root,
      stage,
      launcher: child.pid,
      exitCode: child.exitCode,
      signal: child.signalCode,
      pausedPath,
      output: bytes.map((value) => value.slice(-65536)),
    })
    expect(paused?.stage, diagnostic).toBe(stage)
    expect(paused?.kind, diagnostic).toBe(native.cohort && stage !== "config.jsonc" ? "native" : "rename")
    expect(child.signalCode, diagnostic).toBe("SIGKILL")
    const owner = paused!.pid
    if (native.cohort) {
      // The Native launcher owns the business subprocess in a KILL_ON_JOB_CLOSE Job.
      // Its PID, rather than the launcher PID, owns the on-disk transaction locks.
      expect(Number.isSafeInteger(owner) && owner > 0 && owner !== child.pid, diagnostic).toBe(true)
      const retired = Date.now() + 3_000
      for (;;) {
        try {
          process.kill(owner, 0)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") break
          throw error
        }
        if (Date.now() >= retired) throw new Error(`Native Settings lock owner remains active: ${diagnostic}`)
        await Bun.sleep(10)
      }
    } else {
      expect(owner, diagnostic).toBe(child.pid)
    }
    if (actualExpiry) await Bun.sleep(61_000)
    if (!actualExpiry) {
      // Other cases mature only this confirmed-dead fixture owner's original heartbeat.
      // This is not evidence of immediate recovery or a product lease-policy change.
      const locks = path.join(root, "storage", ".dac-config-locks")
      for (const name of await fs.readdir(locks)) {
        const directory = path.join(locks, name)
        const meta = await Bun.file(path.join(directory, "meta.json")).json()
        if (meta.pid !== owner) throw new Error("Foreign fixture lock owner")
        await fs.utimes(path.join(directory, "heartbeat"), new Date(Date.now() - 61_000), new Date(Date.now() - 61_000))
      }
    }
    expect(bytes.join("").length, diagnostic).toBeLessThan(1_048_576)
  } finally {
    clearTimeout(timer)
    child.kill("SIGKILL")
    await child.exited
    await output
  }
}

const digest = (value: string) => createHash("sha256").update(value).digest("hex")

test("request hashing encodes a bounded tree once and rejects excess depth before any settings write", async () => {
  for (const mode of ["depth59", "depth60"])
    await fixture(async (root) => {
      const result = await run(root, mode)
      expect(result.code, JSON.stringify(result)).toBe(mode === "depth59" ? 0 : 1)
      if (mode === "depth60") {
        expect(result.error).toContain("capacity")
        expect(result.writes).toEqual([])
        expect(await Bun.file(path.join(root, "storage", ".settings-operation.json")).exists()).toBe(false)
      }
      if (mode === "depth59") expect((await run(root, mode)).writes).toEqual([])
    })
}, 25_000)

test(
  "matching completion cannot stand in for current bytes; exact retry only repairs an original before state",
  () =>
    fixture(async (root) => {
      const config = path.join(root, "storage", "config.jsonc")
      const before = await Bun.file(config).text()
      expect((await run(root, "global")).code).toBe(0)
      const receipt = await Bun.file(path.join(root, "storage", ".settings-receipt.json")).text()
      await fs.writeFile(config, before)
      const cold = await run(root, "read")
      expect(cold.code).toBe(1)
      expect(cold.writes).toEqual([])
      const retry = await run(root, "global")
      expect(retry.code).toBe(0)
      expect(retry.writes).toEqual(["config.jsonc", ".settings-receipt.json"])
      expect(await Bun.file(path.join(root, "storage", ".settings-receipt.json")).text()).toBe(receipt)
      await fs.writeFile(config, '{"model":"foreign/current"}')
      expect((await run(root, "global")).code).toBe(1)
      expect(await Bun.file(config).text()).toBe('{"model":"foreign/current"}')
    }),
  25_000,
)

test.skipIf(process.platform === "win32")(
  "canonical global parent aliases preserve settled journals and cannot authorize a foreign config",
  () =>
    fixture(async (root) => {
      // POSIX ancestor aliases include macOS /var -> /private/var; the private storage parent stays real.
      const alias = path.join(root, "ancestor-alias")
      await fs.symlink(root, alias, "dir")
      expect((await run(alias, "global")).code).toBe(0)
      const settled = await run(alias, "read")
      expect(settled.code).toBe(0)
      expect(settled.writes).toEqual([])
      const retry = await run(alias, "global")
      expect(retry.code, retry.diagnostic).toBe(0)
      expect(retry.writes).toEqual([])
      const file = path.join(root, "storage", ".settings-operation.json")
      const operation = await Bun.file(file).json()
      operation.config.path = path.join(root, "workspace", "config.jsonc")
      await fs.writeFile(operation.config.path, await Bun.file(path.join(root, "storage", "config.jsonc")).text(), {
        mode: 0o600,
      })
      await fs.writeFile(file, JSON.stringify(operation), { mode: 0o600 })
      const denied = await run(alias, "read")
      expect(denied.code).toBe(1)
      expect(denied.error).toContain("Settings transaction invalid")
      expect(denied.writes).toEqual([])
    }),
  25_000,
)

test(
  "actual Config global caller rejects stale source before changing settings or creating an intent",
  () =>
    fixture(async (root) => {
      const before = await Bun.file(path.join(root, "storage", "settings.json")).text()
      const result = await run(root, "stale")
      expect(result.code, result.diagnostic).toBe(1)
      expect(result.error).toContain("Configuration file changed")
      expect(result.writes).toEqual([])
      expect(await Bun.file(path.join(root, "storage", "settings.json")).text()).toBe(before)
      expect(await Bun.file(path.join(root, "storage", ".settings-operation.json")).exists()).toBe(false)
    }),
  20_000,
)

test(
  "real SIGKILL after settings publication preserves a retryable partial intent; third state cannot be overwritten",
  () =>
    fixture(async (root) => {
      const config = path.join(root, "storage", "config.jsonc")
      const settings = path.join(root, "storage", "settings.json")
      const original = await Bun.file(config).text()
      await pauseAndKill(root, "settings.json", process.env.DAC_SETTINGS_ACTUAL_LEASE_EXPIRY === "1")
      const after = await Bun.file(settings).text()
      const operation = await Bun.file(path.join(root, "storage", ".settings-operation.json")).json()
      expect(operation.settings.after).toBe(digest(after))
      expect(await Bun.file(config).text()).toBe(original)
      const cold = await run(root, "read")
      expect(cold.code).toBe(1)
      expect(cold.error).toContain("partially committed")
      expect(cold.writes).toEqual([])
      const different = await run(root, "direct")
      expect(different.code).toBe(1)
      expect(different.writes).toEqual([])
      await fs.writeFile(settings, '{"deepagent":{"agentMode":"ultra"}}')
      const foreign = await Bun.file(settings).text()
      const refused = await run(root, "global")
      expect(refused.code).toBe(1)
      expect(refused.writes).toEqual([])
      expect(await Bun.file(settings).text()).toBe(foreign)
      await fs.writeFile(settings, after)
      const retry = await run(root, "global")
      expect(retry.code).toBe(0)
      expect(retry.writes).toEqual(["config.jsonc", ".settings-receipt.json"])
      const receipt = await Bun.file(path.join(root, "storage", ".settings-receipt.json")).json()
      expect(receipt.operationHash).toBe(digest(JSON.stringify(operation)))
      expect((await run(root, "read")).code).toBe(0)
      expect((await run(root, "global")).writes).toEqual([])
    }),
  100_000,
)

test("real SIGKILL after intent and after config publication reconciles only the remaining original files", async () => {
  for (const stage of [".settings-operation.json", "config.jsonc"])
    await fixture(async (root) => {
      await pauseAndKill(root, stage)
      const cold = await run(root, "read")
      expect(cold.writes).toEqual([])
      expect(cold.code).toBe(stage === "config.jsonc" ? 0 : 1)
      const retry = await run(root, "global")
      expect(retry.code).toBe(0)
      expect(retry.writes).toEqual(
        stage === "config.jsonc"
          ? [".settings-receipt.json"]
          : ["settings.json", "config.jsonc", ".settings-receipt.json"],
      )
      expect((await run(root, "global")).writes).toEqual([])
    })
}, 40_000)

test(
  "original direct store and global caller share locks across two processes and preserve both patches",
  () =>
    fixture(async (root) => {
      const results = await Promise.all([run(root, "direct"), run(root, "global")])
      expect(
        results.map((result) => result.code),
        JSON.stringify(results),
      ).toEqual([0, 0])
      const settings = await Bun.file(path.join(root, "storage", "settings.json")).json()
      expect(settings.deepagent).toEqual({ agentMode: "high", selfLearning: "auto" })
      expect(await Bun.file(path.join(root, "storage", "config.jsonc")).text()).toContain("保留原注释")
      expect((await run(root, "read")).code).toBe(0)
    }),
  20_000,
)

test(
  "original global partial patch preserves an already committed direct-store sibling",
  () =>
    fixture(async (root) => {
      expect((await run(root, "direct")).code).toBe(0)
      expect((await run(root, "global")).code).toBe(0)
      expect((await Bun.file(path.join(root, "storage", "settings.json")).json()).deepagent).toEqual({
        agentMode: "high",
        selfLearning: "auto",
      })
    }),
  20_000,
)

test(
  "actual startup first-party migration preserves legacy wish settings and completes the same journal protocol",
  () =>
    fixture(async (root) => {
      await fs.rm(path.join(root, "storage", "settings.json"))
      await fs.writeFile(
        path.join(root, "storage", "config.jsonc"),
        '{"provider":{"deepagent":{"options":{"promptMode":"wish","wishModel":"fixture/legacy"}}}}',
      )
      const result = await run(root, "load")
      expect(result.code, JSON.stringify(result)).toBe(0)
      const settings = await Bun.file(path.join(root, "storage", "settings.json")).json()
      expect(settings.deepagent).toEqual({ promptMode: "intelligence", intelligenceModel: "fixture/legacy" })
      expect(await Bun.file(path.join(root, "storage", "config.jsonc")).text()).not.toContain('"deepagent"')
      expect(await Bun.file(path.join(root, "storage", ".settings-receipt.json")).exists()).toBe(true)
      expect((await run(root, "load")).writes).toEqual([])
    }),
  20_000,
)

test("private settings reject unsafe inode, invalid UTF8 and excess bytes before publication", async () => {
  for (const boundary of ["mode", "hardlink", "utf8", "capacity"])
    await fixture(async (root) => {
      const file = path.join(root, "storage", "settings.json")
      if (boundary === "mode" && native.cohort) {
        const { windowsNativePublisherTools } = await import("../../../desktop/scripts/test-native-publisher")
        const acl = Bun.spawnSync([windowsNativePublisherTools().acl, file, "/grant:r", "*S-1-1-0:(W)"], {
          stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 15_000,
        })
        expect(acl.exitCode, acl.stderr.toString()).toBe(0)
      }
      if (boundary === "mode" && !native.cohort) await fs.chmod(file, 0o644)
      if (boundary === "hardlink") await fs.link(file, path.join(root, "linked.json"))
      if (boundary === "utf8") await fs.writeFile(file, Buffer.from([0xc0, 0xaf]))
      if (boundary === "capacity") await fs.writeFile(file, Buffer.alloc(1_048_577, 32))
      const before = await Bun.file(file).arrayBuffer()
      const result = await run(root, "direct")
      expect(result.code, result.diagnostic).toBe(1)
      if (native.cohort) {
        expect(result.diagnostic).toContain("PRIVATE_STORAGE_FAILURE stage=read-storage")
      }
      expect(result.writes).toEqual([])
      expect(await Bun.file(file).arrayBuffer()).toEqual(before)
      expect(await Bun.file(path.join(root, "storage", ".settings-operation.json")).exists()).toBe(false)
    })
}, 30_000)
