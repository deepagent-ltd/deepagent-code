import { describe, expect, test } from "bun:test"
import { Database as BunDatabase } from "bun:sqlite"
import path from "path"
import { DatabasePreflight } from "@deepagent-code/core/database/preflight"
import type { PreflightObservations, PreflightOptions } from "@deepagent-code/core/database/preflight"
import { tmpdir } from "./fixture/tmpdir"

const baseOptions: PreflightOptions = {
  filename: "/tmp/x.db",
  readerProtocol: 3,
  writerProtocol: 3,
  knownMigrationIds: ["m1", "m2", "m3"],
  historicalAliases: {},
  buildDigest: "digest",
  buildVersion: "2.0.0-alpha.0",
}

const observations = (overrides: Partial<PreflightObservations> = {}): PreflightObservations => ({
  filename: "/tmp/x.db",
  exists: true,
  size: 4096,
  mode: 0o100644,
  sqliteHeaderValid: true,
  pageSize: 4096,
  pageCount: 10,
  journalMode: "wal",
  dbReadable: true,
  journalRows: [],
  capabilities: [],
  upgradeRuns: [],
  walExists: true,
  walSize: 1024,
  shmExists: true,
  shmSize: 1024,
  freeSpaceBytes: 512 * 1024 * 1024,
  localFilesystem: true,
  activeProcess: false,
  ...overrides,
})

const codes = (result: { ok: false; issues: { code: string }[] } | { ok: true }): string[] =>
  result.ok ? [] : result.issues.map((issue) => issue.code)

describe("DatabasePreflight analysis", () => {
  test("valid DB with no pending migration passes", () => {
    const result = DatabasePreflight.analyzePreflight(
      baseOptions,
      observations({
        journalRows: [
          { id: "m1", time_completed: 1 },
          { id: "m2", time_completed: 1 },
          { id: "m3", time_completed: 1 },
        ],
      }),
    )
    expect(result.ok).toBe(true)
  })

  test("fresh/absent file treated as needs-init (not a blocker)", () => {
    const result = DatabasePreflight.analyzePreflight(baseOptions, observations({ exists: false, size: 0 }))
    expect(result.ok).toBe(true)
  })

  test("incompatible binary capability is rejected before any migration", () => {
    const result = DatabasePreflight.analyzePreflight(baseOptions, observations({
      capabilities: [{ capability: "future_v2", minimum_reader_protocol: 4, minimum_writer_protocol: 4 }],
    }))
    expect(result.ok).toBe(false)
    expect(codes(result)).toContain("incompatible_binary")
  })

  test("invalid SQLite header is rejected", () => {
    const result = DatabasePreflight.analyzePreflight(baseOptions, observations({ sqliteHeaderValid: false }))
    expect(result.ok).toBe(false)
    expect(codes(result)).toContain("not_a_sqlite_database")
  })

  test("unknown migration lineage is rejected", () => {
    const result = DatabasePreflight.analyzePreflight(baseOptions, observations({
      journalRows: [{ id: "foreign-migration", time_completed: 1 }],
    }))
    expect(result.ok).toBe(false)
    expect(codes(result)).toContain("migration_journal_unknown_lineage")
  })

  test("journal gap is rejected", () => {
    const result = DatabasePreflight.analyzePreflight(baseOptions, observations({
      journalRows: [
        { id: "m1", time_completed: 1 },
        { id: "m3", time_completed: 1 }, // m2 missing -> gap
      ],
    }))
    expect(result.ok).toBe(false)
    expect(codes(result)).toContain("migration_journal_gap")
  })

  test("duplicate journal id is rejected", () => {
    const result = DatabasePreflight.analyzePreflight(baseOptions, observations({
      journalRows: [
        { id: "m1", time_completed: 1 },
        { id: "m1", time_completed: 2 },
      ],
    }))
    expect(result.ok).toBe(false)
    expect(codes(result)).toContain("migration_journal_duplicate_id")
  })

  test("same id with different content hash is rejected", () => {
    const result = DatabasePreflight.analyzePreflight(
      { ...baseOptions, knownContentHashes: { m1: "hash-a" } },
      observations({ journalRows: [{ id: "m1", time_completed: 1, content_hash: "hash-b" }] }),
    )
    expect(result.ok).toBe(false)
    expect(codes(result)).toContain("migration_journal_content_mismatch")
  })

  test("unfinished upgrade run is rejected as read-only recovery", () => {
    const result = DatabasePreflight.analyzePreflight(baseOptions, observations({ upgradeRuns: [{ run_id: "r1", state: "applying" }] }))
    expect(result.ok).toBe(false)
    expect(codes(result)).toContain("unfinished_upgrade_run")
  })

  test("insufficient free space is rejected", () => {
    const result = DatabasePreflight.analyzePreflight(baseOptions, observations({ freeSpaceBytes: 1024 }))
    expect(result.ok).toBe(false)
    expect(codes(result)).toContain("insufficient_space")
  })

  test("non-local filesystem is rejected", () => {
    const result = DatabasePreflight.analyzePreflight(baseOptions, observations({ localFilesystem: false }))
    expect(result.ok).toBe(false)
    expect(codes(result)).toContain("non_local_filesystem")
  })

  test("another active process (two-window race) is rejected as recovery", () => {
    const result = DatabasePreflight.analyzePreflight(baseOptions, observations({ activeProcess: true }))
    expect(result.ok).toBe(false)
    expect(codes(result)).toContain("another_process_active")
  })

  test("merged-history insertion gap is reconciled (not a hard block)", () => {
    const result = DatabasePreflight.analyzePreflight(
      {
        ...baseOptions,
        knownMigrationIds: ["m1", "anchor", "insert", "m2"],
        mergedHistoryAnchor: "anchor",
        mergedHistoryInsertions: new Set(["insert"]),
      },
      observations({
        journalRows: [
          { id: "m1", time_completed: 1 },
          { id: "anchor", time_completed: 1 },
          { id: "m2", time_completed: 1 },
        ],
      }),
    )
    expect(result.ok).toBe(true)
  })
})

describe("DatabasePreflight against real files", () => {
  test("read-only preflight passes a migrated fixture DB and does not write", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "app.db")
    const db = new BunDatabase(filename, { create: true })
    db.run("PRAGMA journal_mode = WAL")
    db.run("CREATE TABLE migration (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)")
    db.run("CREATE TABLE database_capability (capability TEXT PRIMARY KEY, minimum_reader_protocol INTEGER, minimum_writer_protocol INTEGER)")
    db.run("INSERT INTO migration VALUES ('m1', 1), ('m2', 1), ('m3', 1)")
    db.run("INSERT INTO database_capability VALUES ('bounded_event_snapshot_v1', 2, 2)")
    const before = db.query("SELECT count(*) AS count FROM migration").get()
    db.close()

    const result = await DatabasePreflight.preflight({
      ...baseOptions,
      filename,
    })

    expect(result.ok).toBe(true)
    const after = new BunDatabase(filename, { readonly: true })
    expect(after.query("SELECT count(*) AS count FROM migration").get()).toEqual(before)
    expect(after.query("SELECT count(*) AS count FROM database_capability").get()).toEqual({ count: 1 })
    after.close()
  })

  test("incompatible binary oracle: fails then passes when capability is supported", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "cap.db")
    const db = new BunDatabase(filename, { create: true })
    db.run("PRAGMA journal_mode = WAL")
    db.run("CREATE TABLE migration (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)")
    db.run("CREATE TABLE database_capability (capability TEXT PRIMARY KEY, minimum_reader_protocol INTEGER, minimum_writer_protocol INTEGER)")
    db.run("INSERT INTO migration VALUES ('m1', 1), ('m2', 1), ('m3', 1)")
    db.run("INSERT INTO database_capability VALUES ('future_v2', 4, 4)")
    const before = db.query("SELECT count(*) AS count FROM migration").get()
    db.close()

    // Fail: a future binary requires protocol 4, this runtime supports 3.
    const failResult = await DatabasePreflight.preflight({ ...baseOptions, filename })
    expect(failResult.ok).toBe(false)
    expect(codes(failResult)).toContain("incompatible_binary")

    // Fix the capability to a supported protocol, then it must pass.
    const db2 = new BunDatabase(filename, { create: true })
    db2.run("DELETE FROM database_capability")
    db2.run("INSERT INTO database_capability VALUES ('bounded_event_snapshot_v1', 2, 2)")
    db2.close()

    const passResult = await DatabasePreflight.preflight({ ...baseOptions, filename })
    expect(passResult.ok).toBe(true)
    // Preflight never wrote to the migration journal.
    const after = new BunDatabase(filename, { readonly: true })
    expect(after.query("SELECT count(*) AS count FROM migration").get()).toEqual(before)
    after.close()
  })

  test("active process probe deterministically detects a second window", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "race.db")
    const db = new BunDatabase(filename, { create: true })
    db.run("PRAGMA journal_mode = WAL")
    db.run("CREATE TABLE migration (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)")
    db.run("INSERT INTO migration VALUES ('m1', 1), ('m2', 1), ('m3', 1)")
    db.close()

    // Deterministic: the active-process probe reports a second window is running,
    // so the preflight must not approve a concurrent migration.
    const withProbe = await DatabasePreflight.preflight(
      { ...baseOptions, filename },
      {
        stat: async () => ({ size: 4096, mode: 0o100644 }),
        readHeader: async () => ({ headerValid: true, pageSize: 4096 }),
        readJournalMode: async () => ({ journalMode: "wal", pageCount: 10 }),
        readJournalRows: async () => [
          { id: "m1", time_completed: 1 },
          { id: "m2", time_completed: 1 },
          { id: "m3", time_completed: 1 },
        ],
        readCapabilities: async () => [],
        readUpgradeRuns: async () => [],
        walShm: async () => ({ walExists: true, walSize: 1024, shmExists: true, shmSize: 1024 }),
        freeSpace: async () => 512 * 1024 * 1024,
        localFilesystem: async () => true,
        activeProcess: async () => true,
      },
    )
    expect(withProbe.ok).toBe(false)
    expect(codes(withProbe)).toContain("another_process_active")

    // Control: no active window passes.
    const withoutProbe = await DatabasePreflight.preflight(
      { ...baseOptions, filename },
      {
        stat: async () => ({ size: 4096, mode: 0o100644 }),
        readHeader: async () => ({ headerValid: true, pageSize: 4096 }),
        readJournalMode: async () => ({ journalMode: "wal", pageCount: 10 }),
        readJournalRows: async () => [
          { id: "m1", time_completed: 1 },
          { id: "m2", time_completed: 1 },
          { id: "m3", time_completed: 1 },
        ],
        readCapabilities: async () => [],
        readUpgradeRuns: async () => [],
        walShm: async () => ({ walExists: true, walSize: 1024, shmExists: true, shmSize: 1024 }),
        freeSpace: async () => 512 * 1024 * 1024,
        localFilesystem: async () => true,
        activeProcess: async () => false,
      },
    )
    expect(withoutProbe.ok).toBe(true)
  })

  test("read-only preflight is safe while a second window holds the DB", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "concurrent.db")
    const db = new BunDatabase(filename, { create: true })
    db.run("PRAGMA journal_mode = WAL")
    db.run("CREATE TABLE migration (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)")
    db.run("INSERT INTO migration VALUES ('m1', 1), ('m2', 1), ('m3', 1)")
    db.close()

    // A second window opens the DB read-write while preflight runs.
    const second = new BunDatabase(filename, { create: true })
    second.run("PRAGMA journal_mode = WAL")
    second.run("BEGIN")
    second.run("INSERT INTO migration VALUES ('m4', 1)")
    second.run("ROLLBACK")
    const result = await DatabasePreflight.preflight({ ...baseOptions, filename })
    expect(result.ok).toBe(true)
    second.close()
  })
})
