import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"

async function child(root: string, mode: string) {
  const home = path.join(root, "private-home")
  await fs.mkdir(home, { recursive: true, mode: 0o700 })
  const process = Bun.spawn({
    cmd: [globalThis.process.execPath, path.join(import.meta.dir, "fixture/secret-migration-process.ts"), root, mode],
    cwd: path.resolve(import.meta.dir, "../.."),
    env: {
      PATH: globalThis.process.env.PATH,
      HOME: home,
      DEEPAGENT_CODE_TEST_HOME: home,
      XDG_CONFIG_HOME: path.join(home, "config"),
      XDG_DATA_HOME: path.join(home, "data"),
      XDG_STATE_HOME: path.join(home, "state"),
      XDG_CACHE_HOME: path.join(home, "cache"),
      DEEPAGENT_CODE_DB: path.join(home, "database.sqlite"),
      DEEPAGENT_CODE_TEST_MANAGED_CONFIG_DIR: path.join(home, "managed"),
      DEEPAGENT_CODE_MODELS_PATH: path.resolve(import.meta.dir, "../tool/fixtures/models-api.json"),
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const timer = setTimeout(() => process.kill(), 30_000)
  try {
    const [code, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ])
    return { code, stdout, stderr }
  } finally {
    clearTimeout(timer)
    process.kill()
    await process.exited
  }
}

function summary(stdout: string) {
  const line = stdout.split("\n").findLast((line) => line.startsWith('{"fixture":"mcp-secret-migration",'))
  if (!line) throw new Error("Private migration fixture did not return its final result")
  return JSON.parse(line)
}

test("explicit three-field migration uses actual private Config/Location/store and refuses borrowed or bare refs", async () => {
  await using root = await tmpdir()
  const result = await child(root.path, "positive")
  expect(result.code, result.stderr).toBe(0)
  expect(summary(result.stdout)).toMatchObject({
    distinctScopes: true,
    moved: 5,
    bareRejected: true,
    exactRetryPutDelta: 0,
    network: 0,
  })
  expect(result.stdout).not.toContain("secret://")
  expect(result.stdout).not.toContain("fixture-a-client")
}, 40_000)

test("preview followed by a same-byte leaf replacement rejects before a scoped store put", async () => {
  await using root = await tmpdir()
  const result = await child(root.path, "changed")
  expect(result.code, result.stderr).toBe(0)
  expect(summary(result.stdout)).toMatchObject({ rejected: true, put: 0, network: 0 })
}, 40_000)

test("a stored/Config conflict is retained and a real cold process never blindly re-puts or rewrites it", async () => {
  await using root = await tmpdir()
  const first = await child(root.path, "stored-gap")
  expect(first.code, first.stderr).toBe(0)
  expect(summary(first.stdout)).toMatchObject({ state: "stored", put: 2, network: 0 })
  const cold = await child(root.path, "cold")
  expect(cold.code, cold.stderr).toBe(0)
  expect(summary(cold.stdout)).toMatchObject({ state: "stored", rejected: true, put: 0, network: 0 })
}, 70_000)

test("the original MCP runtime rejects a borrowed scoped reference before its owned HTTP transport sends", async () => {
  await using root = await tmpdir()
  const result = await child(root.path, "runtime")
  expect(result.code, result.stderr).toBe(0)
  expect(summary(result.stdout)).toMatchObject({ physicalHTTP: 0, network: 0, bareRejected: true })
}, 40_000)

test("an empty private HOME requires explicit init before readonly preview and confirmed migration", async () => {
  await using root = await tmpdir()
  const result = await child(root.path, "first-empty")
  expect(result.code, result.stderr).toBe(0)
  expect(summary(result.stdout)).toMatchObject({
    previewWasReadonly: true,
    initialized: true,
    state: "committed",
    moved: 2,
    put: 2,
    network: 0,
  })
  expect(result.stdout).not.toContain("secret://")
  expect(result.stdout).not.toContain("fixture-a-client")
}, 40_000)

test("an old registered-root binding requires explicit preview and repair before secret preview is available", async () => {
  await using root = await tmpdir()
  const result = await child(root.path, "binding-repair")
  expect(result.code, result.stderr).toBe(0)
  expect(summary(result.stdout)).toMatchObject({ sameScope: true, secretPreviewAvailable: true, put: 0, network: 0 })
  expect(result.stdout).not.toContain("secret://")
  expect(result.stdout).not.toContain("fixture-a-client")
}, 40_000)

test("explicit binding repair refuses actual unknown Work custody without changing the old binding", async () => {
  await using root = await tmpdir()
  const result = await child(root.path, "binding-unknown")
  expect(result.code, result.stderr).toBe(0)
  expect(summary(result.stdout)).toMatchObject({ rejected: true, code: "work_unsettled", put: 0, network: 0 })
}, 40_000)
