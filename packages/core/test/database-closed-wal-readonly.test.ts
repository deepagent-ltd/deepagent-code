import { afterAll, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Database } from "bun:sqlite"
import { Effect } from "effect"
import { EffectDrizzleSqlite } from "@deepagent-code/effect-drizzle-sqlite"
import { layer } from "../src/database/sqlite.bun"
import { DatabasePreflight } from "../src/database/preflight"
import { DatabaseMigrationLease } from "../src/database/migration-lease"
import { openImmutableReadOnly } from "../src/database/sqlite-native.bun"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"

const root = await fs.mkdtemp(path.join(tmpdir(), "dac-closed-wal-readonly-"))
afterAll(() => fs.rm(root, { recursive: true, force: true }))
const options = (filename: string) => ({
  filename,
  readerProtocol: 3,
  writerProtocol: 3,
  knownMigrationIds: ["m1"],
  historicalAliases: {},
  buildDigest: "candidate",
  buildVersion: "2.0.3",
})
const fixture = async (name: string, future = false) => {
  await fs.mkdir(root, { recursive: true, mode: 0o700 })
  const filename = path.join(await fs.mkdtemp(path.join(root, name + "-")), "authority.sqlite")
  const node = Bun.which("node")
  if (!node) throw new Error("actual Node SQLite fixture runtime is required")
  const created = Bun.spawn(
    [
      node,
      "--input-type=module",
      "-e",
      `
    import { DatabaseSync } from "node:sqlite"
    const db = new DatabaseSync(process.argv[1])
    db.exec("PRAGMA journal_mode = WAL; CREATE TABLE migration(id TEXT PRIMARY KEY,time_completed INTEGER NOT NULL); INSERT INTO migration VALUES('m1',1); CREATE TABLE database_capability(capability TEXT PRIMARY KEY,minimum_reader_protocol INTEGER,minimum_writer_protocol INTEGER)")
    if (process.argv[2] === "future") db.exec("INSERT INTO database_capability VALUES('future',999,999)")
    db.close()
  `,
      filename,
      future ? "future" : "current",
    ],
    { stdout: "ignore", stderr: "pipe" },
  )
  expect(await created.exited).toBe(0)
  return filename
}
const exists = (filename: string) => Bun.file(filename).exists()
const sha = async (filename: string) =>
  createHash("sha256")
    .update(await Bun.file(filename).bytes())
    .digest("hex")

test("normally closed WAL is physically readonly, fenced and byte-preserving", async () => {
  const filename = await fixture("closed")
  const before = await fs.stat(filename)
  const hash = await sha(filename)
  expect(await exists(filename + "-wal")).toBe(false)
  expect(await exists(filename + "-shm")).toBe(false)
  const result = await DatabasePreflight.withReadOnlyPreflight(
    options(filename),
    async (result, uri) => {
      expect(result.ok).toBe(true)
      const immutable = uri.includes("immutable=1")
      if (!immutable) expect(uri).toBe(filename)
      expect(await DatabaseMigrationLease.processLockActive(filename + ".runtime.lock")).toBe(immutable)
      const db = openImmutableReadOnly(filename)
      try {
        expect(db.query("SELECT count(*) AS n FROM migration").get()).toEqual({
          n: 1,
        })
        expect(() => db.run("DELETE FROM migration")).toThrow()
      } finally {
        db.close()
      }
      const inventoryReader = await Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* EffectDrizzleSqlite.makeWithDefaults()
          const rows = yield* sql.all<{ n: number }>("SELECT count(*) AS n FROM migration")
          const write = yield* sql.run("DELETE FROM migration").pipe(Effect.result)
          return { rows, writeFailed: write._tag === "Failure" }
        }).pipe(Effect.provide(layer({ filename: uri, readonly: true, disableWAL: true })), Effect.scoped),
      )
      expect(inventoryReader).toEqual({ rows: [{ n: 1 }], writeFailed: true })
      expect(await DatabaseMigrationLease.processLockActive(filename + ".runtime.lock")).toBe(immutable)
      return result
    },
    (result) => result,
  )
  expect(result.ok).toBe(true)
  const after = await fs.stat(filename)
  expect([after.dev, after.ino, after.size, after.mtimeMs]).toEqual([
    before.dev,
    before.ino,
    before.size,
    before.mtimeMs,
  ])
  expect(await sha(filename)).toBe(hash)
  expect(await exists(filename + "-wal")).toBe(false)
  expect(await exists(filename + "-shm")).toBe(false)
  expect(await DatabaseMigrationLease.processLockActive(filename + ".runtime.lock")).toBe(false)
})

test("closed runtime lock contention keeps current owner and refuses immutable fallback", async () => {
  const filename = await fixture("contended")
  const lock = await Effect.runPromise(DatabaseMigrationLease.acquireProcessLock(filename + ".runtime.lock"))
  try {
    const result = await DatabasePreflight.withReadOnlyPreflight(
      options(filename),
      (result, uri) => {
        expect(uri).toBe(filename)
        return result
      },
      (result) => result,
    )
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("refusal required")
    expect(result.issues.some((issue) => issue.code === "another_process_active")).toBe(true)
    const meta = await Bun.file(path.join(lock.dir, "meta.json")).json()
    expect(meta.token).toBe(lock.token)
  } finally {
    await Effect.runPromise(lock.release)
  }
})

test("active WAL remains ordinary RO and includes committed WAL, never immutable", async () => {
  const filename = await fixture("active")
  const lock = await Effect.runPromise(DatabaseMigrationLease.acquireProcessLock(filename + ".runtime.lock"))
  const writer = new Database(filename)
  try {
    writer.run("INSERT INTO migration VALUES('m2',2)")
    expect(await exists(filename + "-wal")).toBe(true)
    const result = await DatabasePreflight.withReadOnlyPreflight(
      { ...options(filename), knownMigrationIds: ["m1", "m2"] },
      (result, uri) => {
        expect(uri).toBe(filename)
        expect(result.observations.journalRows.map((row) => row.id)).toEqual(["m1", "m2"])
        return result
      },
      (result) => result,
    )
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("owner refusal required")
    expect(result.issues.some((issue) => issue.code === "another_process_active")).toBe(true)
  } finally {
    writer.close()
    await Effect.runPromise(lock.release)
  }
})

test("incompatible capability survives closed immutable inspection", async () => {
  const filename = await fixture("future", true)
  const result = await DatabasePreflight.preflight(options(filename))
  expect(result.ok).toBe(false)
  if (result.ok) throw new Error("compatibility refusal required")
  expect(result.issues.some((issue) => issue.code === "incompatible_binary")).toBe(true)
  expect(await DatabaseMigrationLease.processLockActive(filename + ".runtime.lock")).toBe(false)
})

test("immutable fallback fences a changed stamp while ordinary RO preserves its original result, without repeating callback", async () => {
  const filename = await fixture("changed")
  const calls = { use: 0, unavailable: 0, immutable: false }
  const result = await DatabasePreflight.withReadOnlyPreflight(
    options(filename),
    async (result, uri) => {
      calls.use++
      calls.immutable = uri.includes("immutable=1")
      expect(result.ok).toBe(true)
      const current = await fs.stat(filename)
      await fs.utimes(filename, current.atime, new Date(current.mtimeMs + 1000))
      return result
    },
    (result) => {
      calls.unavailable++
      return result
    },
  )
  // Ordinary RO uses SQLite's read transactions. The immutable fallback alone
  // needs the retained owner lease and post-callback file stamp fence.
  expect(result.ok).toBe(!calls.immutable)
  expect(calls).toEqual({ use: 1, unavailable: calls.immutable ? 1 : 0, immutable: calls.immutable })
  expect(await DatabaseMigrationLease.processLockActive(filename + ".runtime.lock")).toBe(false)
})
