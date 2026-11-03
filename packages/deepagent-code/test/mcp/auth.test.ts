import { afterAll, beforeAll, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"

const fixture = path.resolve(import.meta.dir, "../fixture/mcp-auth-store.ts")
const state: { cohort?: Awaited<ReturnType<typeof import("./fixture/native-auth-cohort").build>> } = {}
beforeAll(async () => {
  const { build } = await import("./fixture/native-auth-cohort")
  state.cohort = await build(fixture)
}, 240_000)
afterAll(async () => {
  await state.cohort?.dispose()
})

async function root(prefix: string) {
  const directory = await fs.mkdtemp(path.join(state.cohort?.root ?? os.tmpdir(), prefix))
  await Promise.all(["home", "tmp"].map((name) => fs.mkdir(path.join(directory, name))))
  return directory
}

async function spawn(directory: string, mode?: string, expected?: string, milliseconds = 10_000) {
  const env = {
    PATH: process.env.PATH!,
    HOME: path.join(directory, "home"),
    TMPDIR: path.join(directory, "tmp"),
    DEEPAGENT_CODE_TEST_HOME: path.join(directory, "home"),
    DEEPAGENT_CODE_HOME: path.join(directory, "home", ".deepagent", "code"),
    DAC_MCP_AUTH_STORE_ROOT: directory,
    ...(state.cohort ? { DAC_MCP_NATIVE_AUTH: "cli" } : {}),
  }
  const args = [mode, expected].filter((value): value is string => value !== undefined)
  const command = state.cohort
    ? await state.cohort.invocation({ args, cwd: directory, env })
    : { cmd: [process.execPath, "run", fixture, ...args], cwd: path.resolve(import.meta.dir, "../.."), env }
  const child = Bun.spawn({ ...command, stdout: "pipe", stderr: "pipe" })
  const timer = setTimeout(() => void terminate(child), milliseconds)
  return { child, timer }
}

async function terminate(child: Bun.Subprocess) {
  if (child.exitCode !== null) return
  if (state.cohort && process.platform === "win32") {
    const killer = Bun.spawn(
      [path.win32.join(process.env.SystemRoot!, "System32", "taskkill.exe"), "/PID", String(child.pid), "/T", "/F"],
      { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
    )
    await killer.exited
  }
  if (child.exitCode === null) child.kill("SIGKILL")
  await child.exited
}

async function collect(directory: string, label: string, mode?: string, expected?: string, milliseconds = 10_000) {
  const process = await spawn(directory, mode, expected, milliseconds)
  try {
    const [code, stdout, stderr] = await Promise.all([
      process.child.exited,
      new Response(process.child.stdout).text(),
      new Response(process.child.stderr).text(),
    ])
    await fs.writeFile(path.join(directory, `${label}.log`), stdout + stderr)
    expect({ code, diagnostic: code === 0 ? "ok" : stdout + stderr }).toEqual({ code: 0, diagnostic: "ok" })
  } finally {
    clearTimeout(process.timer)
    await terminate(process.child)
  }
}

test("explicit zero OAuth lifetime stays expired in the actual persistent provider", async () => {
  const directory = await root("dac-mcp-auth-expiry-")
  await collect(directory, "process", "expiry")
  console.info("MCP_AUTH_EXPIRY_EVIDENCE", directory)
  expect(await Bun.file(path.join(directory, "expiry.json")).json()).toEqual({
    epochExpired: true,
    epochRemaining: 0,
    deadlinePresent: true,
    deadlineInSaveWindow: true,
    immediateRemaining: 0,
  })
}, 15_000)

test("actual MCP credential file rejects damage and commits concurrent updates durably", async () => {
  const directory = await root("dac-mcp-auth-store-")
  await collect(directory, "process", undefined, undefined, 20_000)
  console.info("MCP_AUTH_STORE_EVIDENCE", directory)
  const result = await Bun.file(path.join(directory, "result.json")).json()
  expect(result.corruptionRejected).toBe(true)
  expect(result.concurrentFields).toBe(true)
  expect(result.originalPreserved).toBe(true)
  expect(result.oversizeRejected).toBe(true)
  expect(result.multibyteRejected).toBe(true)
  expect(result.symlinkRejected).toBe(true)
  if (state.cohort) expect(result.nativeAcl).toBe(true)
  if (!state.cohort) expect(result.fileMode).toBe(0o600)
  expect(result.actualHttpRequests).toBe(0)
}, 25_000)

test("real independent processes preserve concurrent fields and cold SIGKILL publication windows", async () => {
  const directory = await root("dac-mcp-auth-cold-")
  await collect(directory, "setup", "setup")
  await Promise.all([
    collect(directory, "update_tokens", "update_tokens"),
    collect(directory, "update_client", "update_client"),
  ])
  await collect(directory, "read_concurrent", "read_concurrent")
  const windows: { stage: string; code: number; expected: string }[] = []
  for (const stage of ["before_rename", "after_rename", "after_sync"]) {
    const stageRoot = path.join(directory, stage)
    await Promise.all(["home", "tmp"].map((name) => fs.mkdir(path.join(stageRoot, name), { recursive: true })))
    await collect(stageRoot, "setup", "setup")
    const process = await spawn(stageRoot, stage)
    try {
      const ready = path.join(stageRoot, "ready.json")
      const deadline = Date.now() + 9000
      while (!(await Bun.file(ready).exists()) && Date.now() < deadline) await Bun.sleep(20)
      expect(await Bun.file(ready).exists()).toBe(true)
      if (state.cohort) expect((await Bun.file(ready).json()).pid).not.toBe(process.child.pid)
      else expect((await Bun.file(ready).json()).pid).toBe(process.child.pid)
      await terminate(process.child)
      const [code, stdout, stderr] = await Promise.all([
        process.child.exited,
        new Response(process.child.stdout).text(),
        new Response(process.child.stderr).text(),
      ])
      await fs.writeFile(path.join(stageRoot, `${stage}.log`), stdout + stderr)
      expect(code).not.toBe(0)
      const expected = stage === "before_rename" ? "old" : "new"
      await collect(stageRoot, `read-${expected}`, "read", expected)
      windows.push({ stage, code, expected })
    } finally {
      clearTimeout(process.timer)
      await terminate(process.child)
    }
  }
  await Bun.write(path.join(directory, "windows.json"), JSON.stringify(windows))
  console.info("MCP_AUTH_COLD_EVIDENCE", directory)
}, 45_000)

test("issuer discovery and generation survive an actual cold credential-store reopen", async () => {
  const directory = await root("dac-mcp-issuer-store-")
  for (const mode of ["issuer", "issuer_cold"]) await collect(directory, mode, mode)
  expect(await Bun.file(path.join(directory, "issuer.json")).json()).toEqual({
    legacyReadOnly: true,
    durableGeneration: true,
    wrongIssuerRejected: true,
    resourceReset: true,
  })
  expect(await Bun.file(path.join(directory, "issuer-cold.json")).json()).toEqual({
    coldDiscovery: true,
    issuerBound: true,
    wrongIssuerRejected: true,
  })
  console.info("MCP_ISSUER_STORE_EVIDENCE", directory)
}, 25_000)
