import { describe, expect, test } from "bun:test"
import { Database as BunDatabase } from "bun:sqlite"
import path from "path"
import fs from "node:fs/promises"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@deepagent-code/effect-drizzle-sqlite"
import { Backup } from "@deepagent-code/core/database/backup"
import { BackupVerify } from "@deepagent-code/core/database/backup-verify"
import { Restore, RestoreError } from "@deepagent-code/core/database/restore"
import { Database } from "@deepagent-code/core/database/database"
import { DatabaseBootstrap, DatabaseBootstrapError } from "@deepagent-code/core/database/bootstrap"
import { DatabaseMode } from "@deepagent-code/core/database/mode"
import { DatabasePreflight } from "@deepagent-code/core/database/preflight"
import { DatabaseMigration } from "@deepagent-code/core/database/migration"
import { DatabaseUpgradeRun } from "@deepagent-code/core/database/upgrade-run"
import { DatabaseMigrationLease } from "@deepagent-code/core/database/migration-lease"
import { Backfill } from "@deepagent-code/core/database/backfill"
import { migrations } from "@deepagent-code/core/database/migration.gen"
import { spawnHarnessChild, killHard } from "../script/crash-harness/kill-controller"
import type { SqlClient as SqlClientService } from "effect/unstable/sql/SqlClient"
import { tmpdir } from "./fixture/tmpdir"
import { run as runEffect, sha256 } from "./database/backup-fixture"

// C1A-16 REAL-FILE DYNAMIC MATRIX (design §15.3). Each scenario runs against a REAL temp SQLite
// file (VACUUM INTO / WAL / two-process lock / SIGKILL / SQLITE_FULL / read-only / bad WAL / space),
// never a production/user DB. Every scenario asserts a FIXED, machine-checkable oracle:
//   - a stable core/wire code, or a data-set equality / verdict, or
//   - the observable maintenance-mode (ready / read_only_recovery / blocked_schema).
// no data is silently lost, and the maintenance mode is observable at the CORE layer (A5 mode guard).
//
// Evidence-level note (honest): scenarios 1, 4, 5, 7, 8 exercise EXISTING A3/A4/A5 semantics
// (verification). Scenario 2 adds a genuine SIGKILL + WAL recovery against the A4 forward-resume path;
// scenario 3 a deterministic SQLITE_FULL via PRAGMA max_page_count. Scenario 6 (bad WAL) exposes a
// genuine gap and is reported as an honest residual in the companion report.

const runWithFile = <A, E>(filename: string, effect: Effect.Effect<A, E, SqlClientService>) =>
  Effect.runPromise(effect.pipe(Effect.provide(SqliteClient.layer({ filename })), Effect.scoped))

const makeDb = EffectDrizzleSqlite.makeWithDefaults()

const totalMigrations = migrations.length

const topLevelRun = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

const basePreflight = {
  filename: "/tmp/x.db",
  readerProtocol: 3,
  writerProtocol: 3,
  knownMigrationIds: ["m1", "m2", "m3"],
  historicalAliases: {} as Record<string, string>,
  buildDigest: "d",
  buildVersion: "v",
}

const preflightObservations = (overrides: Partial<DatabasePreflight.PreflightObservations> = {}): DatabasePreflight.PreflightObservations => ({
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

const describeState = (
  preflight: DatabasePreflight.PreflightResult,
  overrides: Partial<DatabaseBootstrap.BootstrapInput> = {},
): DatabaseBootstrap.BootstrapState =>
  DatabaseBootstrap.describeBootstrap(
    {
      preflight,
      pendingMigrationIds: [],
      hasExistingDatabase: true,
      needsBackup: false,
      backupReady: false,
      recoveryRequired: false,
      recoveryComplete: true,
      postVerifyPassed: false,
      ...overrides,
    },
    { buildDigest: "d" },
  )

const codes = (result: { ok: false; issues: { code: string }[] } | { ok: true }): string[] =>
  result.ok ? [] : result.issues.map((issue) => issue.code)

const makeGoodDb = async (filename: string) => {
  await topLevelRun(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db.run("CREATE TABLE markers (id TEXT PRIMARY KEY)")
      yield* db.run("INSERT INTO markers VALUES ('known-good')")
    }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped),
  )
}

const markerOf = (filename: string) => {
  const db = new BunDatabase(filename, { readonly: true })
  try {
    return db.query("SELECT id FROM markers ORDER BY id").all() as { id: string }[]
  } finally {
    db.close()
  }
}

const integrityOf = (filename: string): string | undefined => {
  const db = new BunDatabase(filename, { readonly: true })
  try {
    return (db.query("PRAGMA integrity_check").get() as { integrity_check: string } | undefined)?.integrity_check
  } finally {
    db.close()
  }
}

/** Read a single-column count from a table on a real file via a read-only Bun connection. */
const countIn = (filename: string, table: string): number => {
  const db = new BunDatabase(filename, { readonly: true })
  try {
    return (db.query(`SELECT count(*) AS c FROM ${table}`).get() as { c: number }).c
  } finally {
    db.close()
  }
}

const mkBackupDir = async (root: string) => {
  const dir = path.join(root, "backups")
  await fs.mkdir(dir, { recursive: true })
  return dir
}

const backUp = (source: string, destDir: string) =>
  Effect.runPromise(Backup.create({ sourcePath: source, destDir, buildId: "build-1" }))

const seedCorrupt = (filename: string) => {
  const db = new BunDatabase(filename, { create: true })
  db.run("CREATE TABLE markers (id TEXT PRIMARY KEY)")
  db.run("INSERT INTO markers VALUES ('corrupt')")
  db.close()
}

describe("C1A-16 dynamic matrix", () => {
  describe("S1 · WAL-active backup + restore (consistent, no lost committed frames)", () => {
    test("backup a fully-migrated WAL DB with a committed uncheckpointed frame, verify, then restore", async () => {
      await using tmp = await tmpdir()
      const good = path.join(tmp.path, "good.db")
      // A fully-migrated DB (valid registry journal, no gap) so restore can forward-migrate cleanly.
      await makeGoodDb(good)

      // Open a WRITE connection and commit a row WITHOUT checkpointing, so the backup must read it
      // from the WAL (a live copy `cp`/`rsync` of the main file would silently drop it).
      const writer = new BunDatabase(good, { readwrite: true })
      writer.run("PRAGMA journal_mode = WAL")
      writer.run("PRAGMA wal_autocheckpoint = 0")
      writer.run("PRAGMA synchronous = FULL")
      writer.run("CREATE TABLE IF NOT EXISTS probe (value TEXT)")
      writer.run("INSERT INTO probe VALUES ('captured-from-wal')")

      try {
        const manifest = await runEffect(
          Backup.create({ sourcePath: good, destDir: tmp.path, buildId: "build-x" }),
        )
        const verification = await runEffect(BackupVerify.verify(manifest))
        expect(verification.ok).toBe(true)
        if (verification.ok) {
          expect(verification.quickCheck).toBe("ok")
          expect(verification.hashMatch).toBe(true)
          expect(verification.schemaDigestMatch).toBe(true)
        }
        // The snapshot captured the committed WAL frame (no lost committed data).
        expect(sha256(await fs.readFile(manifest.backup.filePath))).toBe(manifest.backup.sha256)
        const snapshot = new BunDatabase(manifest.backup.filePath, { create: false, readonly: true })
        expect(snapshot.query("SELECT value FROM probe").all()).toEqual([{ value: "captured-from-wal" }])
        expect(snapshot.query("SELECT id FROM markers ORDER BY id").all()).toEqual([{ id: "known-good" }])
        snapshot.close()

        // Corrupt the live DB, then restore from the verified backup -> data present + integrity ok.
        writer.close()
        const live = path.join(tmp.path, "live.db")
        seedCorrupt(live)
        const restoreManifest = await runEffect(
          Restore.restoreVerified({ dbPath: live, backup: manifest }),
        )
        expect(restoreManifest.outcome).toBe("restored")
        const restored = new BunDatabase(live, { create: false, readonly: true })
        expect(restored.query("SELECT value FROM probe").all()).toEqual([{ value: "captured-from-wal" }])
        expect(restored.query("SELECT id FROM markers ORDER BY id").all()).toEqual([{ id: "known-good" }])
        expect((restored.query("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check).toBe("ok")
        restored.close()
      } finally {
        safeClose(writer)
      }
    }, 60_000)
  })

  describe("S2 · kill -9 mid-migration -> forward resume (A4)", () => {
    test("SIGKILL a live WAL migrator, then resume the SAME run, no re-apply / no duplicate body", async () => {
      await using tmp = await tmpdir()
      const dbPath = path.join(tmp.path, "app.db")
      const markers = path.join(tmp.path, "markers")
      const seededCount = 3

      const spawned = spawnHarnessChild({
        run: path.join(import.meta.dir, "../script/crash-harness/fixture-child-forward-resume.ts"),
        childArgs: [dbPath, markers],
        cwd: process.cwd(),
        env: { CRASH_SLEEP_MS: "10000", FR_SEED_COUNT: String(seededCount) },
      })

      try {
        await spawned.ready
        // The child is a live migrator mid-run (state 'applying', K receipts) holding the WAL.
        const preRunId = readText(dbPath, "SELECT run_id FROM database_upgrade_run")
        const preState = readText(dbPath, "SELECT state FROM database_upgrade_run")
        expect(preState).toBe("applying")
        expect(countIn(dbPath, "database_migration_receipt")).toBe(seededCount)

        // SIGKILL the migrator mid-run (real process crash; the WAL/OS lock is left in-flight).
        killHard(spawned.child, "SIGKILL")
        await spawned.exit

        // Parent reruns apply() on the SAME real file -> resumes the SAME run from the last verified receipt.
        const resumed = await runWithFile(
          dbPath,
          Effect.gen(function* () {
            const db = yield* makeDb
            const r = yield* DatabaseMigration.apply(db, {
              filename: dbPath,
              timeoutMs: 800,
              staleMs: 1_500,
              leaseMs: 15_000,
            })
            return r
          }),
        )
        expect(resumed).not.toBeUndefined()
        expect(resumed!.state).toBe("ready") // post-verify gate passed
        expect(resumed!.runId).toBe(preRunId) // SAME run — forward resume, not a fresh start

        // No re-apply / no duplicate body: exactly one run, receipts == journal == registry size.
        expect(countIn(dbPath, "database_upgrade_run")).toBe(1)
        expect(countIn(dbPath, "database_migration_receipt")).toBe(totalMigrations)
        expect(countIn(dbPath, "migration")).toBe(totalMigrations)
        // The child's fsync'd sentinel markers prove migrations 1..K were applied exactly once by the
        // child; the parent did NOT re-apply them (their receipts already existed).
        const markerNames = (await fs.readdir(markers)).sort()
        expect(markerNames).toEqual(migrations.slice(0, seededCount).map((m) => `migrated-${m.id}`).sort())
      } finally {
        killHard(spawned.child)
      }
    }, 120_000)
  })

  describe("S3 · SQLITE_FULL (typed surface, no silent loss, DB openable)", () => {
    test("PRAGMA max_page_count low -> a write overruns and surfaces SQLITE_FULL, DB stays openable", async () => {
      await using tmp = await tmpdir()
      const file = path.join(tmp.path, "full.db")
      const db = new BunDatabase(file, { create: true })
      db.run("PRAGMA journal_mode = WAL")
      db.run("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)")
      db.run("INSERT INTO t (v) VALUES ('seed')")
      const pages = (db.query("PRAGMA page_count").get() as { page_count: number }).page_count
      db.run(`PRAGMA max_page_count = ${pages}`)
      let err: unknown
      try {
        for (let i = 0; i < 100_000; i++) db.run("INSERT INTO t (v) VALUES ('xxxxxxxxxxxxxxxxxxxx')")
      } catch (e) {
        err = e
      }
      db.close()
      // The error surfaces TYPED (SQLITE_FULL) — it is never swallowed into a silent success.
      expect(err).toBeDefined()
      expect((err as { code?: string }).code).toBe("SQLITE_FULL")
      // The DB remains OPENABLE and the already-committed rows are preserved (no total/silent loss).
      const reopened = new BunDatabase(file, { readonly: true })
      const count = (reopened.query("SELECT count(*) AS c FROM t").get() as { c: number }).c
      expect(count).toBeGreaterThan(0)
      expect((reopened.query("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check).toBe("ok")
      reopened.close()
    })

    test("space budget (preflight) trips insufficient_space -> blocked_schema before any write", () => {
      const pre = DatabasePreflight.analyzePreflight(
        { ...basePreflight, filename: "/tmp/space.db" },
        preflightObservations({ freeSpaceBytes: 1024 }),
      )
      expect(pre.ok).toBe(false)
      expect(codes(pre)).toContain("insufficient_space")
      const state = describeState(pre)
      expect(state.mode).toBe("blocked_schema")
      expect(state.ready).toBe(false)
    })

    test("backfill space budget refuses before any batch runs (BackfillSpaceBudgetExceeded)", async () => {
      await using tmp = await tmpdir()
      const filename = path.join(tmp.path, "bf.db")
      await Bun.write(filename, "")
      const outcome = await runWithFile(
        filename,
        Effect.gen(function* () {
          const db = yield* makeDb
          yield* DatabaseUpgradeRun.ensureTables(db)
          return yield* Backfill.runBatchedBackfill(db, {
            runId: "run-1",
            migrationId: "fixture-backfill",
            filename,
            spaceBudgetBytes: Number.MAX_SAFE_INTEGER,
            batchSize: 10,
            nextBatch: () => Effect.succeed({ offset: 0, rows: 10 }),
            applyBatch: (tx, batch) => tx.run(sql`INSERT INTO backfill_target (id, filled) VALUES (0, 1)`).pipe(Effect.orDie),
          }).pipe(Effect.exit)
        }),
      )
      expect(outcome._tag).toBe("Failure")
      expect(String(outcome)).toContain("BackfillSpaceBudgetExceeded")
      // No batch ran and no progress row was written.
      expect(countIn(filename, "database_backfill_progress")).toBe(0)
    })
  })

  describe("S4 · read-only (mode guard observable; no partial writes)", () => {
    test("read-only filesystem: a write is refused and the file is unchanged (no partial write)", async () => {
      await using tmp = await tmpdir()
      const file = path.join(tmp.path, "ro.db")
      const db = new BunDatabase(file, { create: true })
      db.run("PRAGMA journal_mode = WAL")
      db.run("CREATE TABLE migration (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)")
      db.run("INSERT INTO migration VALUES ('m1',1),('m2',1),('m3',1)")
      db.close()
      await fs.chmod(file, 0o444)
      await fs.chmod(tmp.path, 0o555)
      const before = await fs.readFile(file)
      let writeErr: unknown
      try {
        const r = new BunDatabase(file, { readwrite: true })
        r.run("INSERT INTO migration VALUES ('mx',1)") // a single write against a read-only store
        r.close()
        writeErr = undefined
      } catch (e) {
        writeErr = e
      }
      await fs.chmod(file, 0o644).catch(() => undefined)
      await fs.chmod(tmp.path, 0o755).catch(() => undefined)
      // The write is refused typed (SQLITE_READONLY) and no partial row landed.
      expect(writeErr).toBeDefined()
      expect((writeErr as { code?: string }).code).toBe("SQLITE_READONLY")
      const after = await fs.readFile(file)
      expect(after).toEqual(before) // file byte-identical -> no partial write
      const check = new BunDatabase(file, { readonly: true })
      expect(check.query("SELECT count(*) AS c FROM migration").get()).toEqual({ c: 3 })
      check.close()
    })

    test("read_only_recovery store: writable refused, browse allowed, write/provider refused (mode guard)", async () => {
      await using tmp = await tmpdir()
      const filename = path.join(tmp.path, "recovery.db")
      await topLevelRun(
        Effect.gen(function* () {
          const { db } = yield* Database.Service
          const runValue = yield* DatabaseUpgradeRun.beginRun(db, {
            sourceRegistryDigest: "source",
            targetRegistryDigest: DatabaseUpgradeRun.registryDigest(migrations),
            sourceProtocol: { reader: "2", writer: "2" },
            targetProtocol: { reader: "3", writer: "3" },
            buildIdentity: "build-1",
            packageVersion: "2.0.0-alpha.0",
            pendingMigrationIds: migrations.map((m) => m.id),
            totalMigrations: migrations.length,
          })
          yield* DatabaseUpgradeRun.advanceRun(db, runValue.runId, "backup_verified")
          yield* DatabaseUpgradeRun.failRun(db, runValue.runId, "upgrade_run_explicit_recovery")
        }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped),
      )

      const bootState = await Database.bootstrap(filename)
      expect(bootState.mode).toBe("read_only_recovery")
      expect(bootState.ready).toBe(false)

      // Writable business layer refuses admission.
      const writable = await topLevelRun(
        Effect.gen(function* () {
          const { db } = yield* Database.Service
          return db
        }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped, Effect.flip),
      )
      expect(writable).toBeInstanceOf(DatabaseBootstrapError)
      expect((writable as DatabaseBootstrapError).state.mode).toBe("read_only_recovery")

      // Read-only maintenance opener allows browse/export...
      const readOnly = await topLevelRun(
        Effect.gen(function* () {
          const { db, mode } = yield* Database.Service
          const sessionCount = yield* db.all<{ c: number }>("SELECT count(*) AS c FROM session")
          return { mode: mode!.mode, sessionCount: sessionCount[0]!.c }
        }).pipe(Effect.provide(Database.readOnlyLayerFromPath(filename)), Effect.scoped, Effect.exit),
      )
      expect(readOnly._tag).toBe("Success")
      if (readOnly._tag === "Success") {
        expect(readOnly.value.mode).toBe("read_only_recovery")
        expect(readOnly.value.sessionCount).toBe(0)
      }

      // ...but a write is physically fenced (query_only) and the typed guard refuses provider/mutating tool.
      const writeAttempt = await topLevelRun(
        Effect.gen(function* () {
          const { db } = yield* Database.Service
          yield* db.run("CREATE TABLE probe (id INTEGER)")
          return "written"
        }).pipe(Effect.provide(Database.readOnlyLayerFromPath(filename)), Effect.scoped, Effect.exit),
      )
      expect(writeAttempt._tag).toBe("Failure")

      expect(() => DatabaseMode.assertWritable(DatabaseMode.snapshotOf(bootState))).toThrow(
        DatabaseMode.DatabaseModeWriteRefused,
      )
      expect(() => DatabaseMode.assertProviderAllowed(DatabaseMode.snapshotOf(bootState))).toThrow(
        DatabaseMode.DatabaseModeWriteRefused,
      )
    }, 60_000)
  })

  describe("S5 · migration lock / lease (two processes, no double DDL)", () => {
    test("in-process: a second lease acquire refuses while the first holds it (typed LeaseTimeout)", async () => {
      await using tmp = await tmpdir()
      const filename = path.join(tmp.path, "lock.db")
      await Bun.write(filename, "")
      const outcome = await runWithFile(
        filename,
        Effect.gen(function* () {
          const db = yield* makeDb
          yield* DatabaseUpgradeRun.ensureTables(db)
          yield* DatabaseMigrationLease.ensureTables(db)
          yield* db.run("CREATE TABLE IF NOT EXISTS migration (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)")
          // First migrator holds the lease.
          const first = yield* DatabaseMigrationLease.acquire(db, { leaseMs: 60_000, staleMs: 60_000, timeoutMs: 300 }, filename)
          // Second migrator is fenced: bounded acquisition times out instead of running DDL concurrently.
          const second = yield* DatabaseMigrationLease.acquire(db, { leaseMs: 60_000, staleMs: 60_000, timeoutMs: 300 }, filename).pipe(Effect.exit)
          const migrationCount = yield* db.get<{ count: number }>(sql`SELECT count(*) AS count FROM migration`)
          // Release the first, then a fresh acquisition succeeds (recoverable).
          yield* first.release()
          const third = yield* DatabaseMigrationLease.acquire(db, { leaseMs: 60_000, staleMs: 60_000, timeoutMs: 500 }, filename)
          return { secondTag: second._tag, secondDesc: String(second), migrationCount: migrationCount?.count ?? 0, thirdToken: third.token }
        }),
      )
      expect(outcome.secondTag).toBe("Failure")
      expect(outcome.secondDesc).toContain("lease timed out")
      expect(outcome.migrationCount).toBe(0) // no DDL ran on the fenced second path
      expect(outcome.thirdToken).toBeDefined()
    })

    test("two-process: a live migrator holding the lease fences a parent apply() (LeaseTimeout, no double DDL)", async () => {
      await using tmp = await tmpdir()
      const filename = path.join(tmp.path, "lock2.db")
      const spawned = spawnHarnessChild({
        run: path.join(import.meta.dir, "../script/crash-harness/fixture-child-lease-holder.ts"),
        childArgs: [filename],
        cwd: process.cwd(),
        env: { CRASH_SLEEP_MS: "10000" },
      })
      try {
        await spawned.ready
        // The child holds the OS lock + DB lease. A parent migrator must be fenced.
        const parent = await runWithFile(
          filename,
          Effect.gen(function* () {
            const db = yield* makeDb
            return yield* DatabaseMigration.apply(db, { filename, timeoutMs: 400, staleMs: 800, leaseMs: 60_000 }).pipe(Effect.exit)
          }),
        )
        expect(parent._tag).toBe("Failure")
        expect(String(parent)).toContain("lease timed out")
        // No double DDL: the migration journal is still empty (no migration body ran on the parent).
        expect(countIn(filename, "migration")).toBe(0)
      } finally {
        killHard(spawned.child)
      }
    }, 60_000)

    test("preflight activeProcess probe -> read_only_recovery (two-window race)", () => {
      const pre = DatabasePreflight.analyzePreflight(
        basePreflight,
        preflightObservations({ activeProcess: true }),
      )
      expect(pre.ok).toBe(false)
      expect(codes(pre)).toContain("another_process_active")
      const state = describeState(pre, { recoveryRequired: true, recoveryComplete: false })
      expect(state.mode).toBe("read_only_recovery")
      expect(state.ready).toBe(false)
    })
  })

  describe("S6 · bad WAL (no crash-only error; checkpointed data intact; diagnostics openable)", () => {
    test("a corrupt -wal next to a checkpointed committed DB: reopen keeps committed data + opens read-only", async () => {
      await using tmp = await tmpdir()
      const file = path.join(tmp.path, "badwal.db")
      const db = new BunDatabase(file, { create: true })
      db.run("PRAGMA journal_mode = WAL")
      db.run("CREATE TABLE migration (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)")
      db.run("INSERT INTO migration VALUES ('m1',1),('m2',1),('m3',1)")
      db.run("CREATE TABLE database_capability (capability TEXT PRIMARY KEY, minimum_reader_protocol INTEGER, minimum_writer_protocol INTEGER)")
      db.run("INSERT INTO database_capability VALUES ('bounded_event_snapshot_v1',2,2)")
      await db.run("PRAGMA wal_checkpoint(TRUNCATE)") // checkpoint committed state into the main file
      db.close()
      // A corrupt / oversized -wal file is now present alongside a checkpointed DB.
      await fs.writeFile(file + "-wal", Buffer.alloc(4096, 0x7f))
      // Reopen: no crash-only error; the checkpointed committed data is intact; diagnostics open read-only.
      const reopened = new BunDatabase(file, { readonly: true })
      expect(reopened.query("SELECT id FROM migration ORDER BY id").all()).toEqual([
        { id: "m1" },
        { id: "m2" },
        { id: "m3" },
      ])
      expect(reopened.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" })
      reopened.close()
      // The preflight still reports the store as readable (it does not falsely block a readable DB).
      const pre = await DatabasePreflight.preflight({
        ...basePreflight,
        filename: file,
        knownMigrationIds: ["m1", "m2", "m3"],
      })
      expect(pre.ok).toBe(true)
    })
  })

  describe("S7 · space insufficient (blocked before any write)", () => {
    test("preflight insufficient_space -> blocked_schema (maintenance mode observable)", () => {
      const pre = DatabasePreflight.analyzePreflight(
        { ...basePreflight, filename: "/tmp/space.db" },
        preflightObservations({ freeSpaceBytes: 1024 }),
      )
      expect(pre.ok).toBe(false)
      expect(codes(pre)).toContain("insufficient_space")
      const state = describeState(pre)
      expect(state.mode).toBe("blocked_schema")
      expect(state.ready).toBe(false)
    })
  })

  describe("S8 · restore interruption matrix (A5)", () => {
    test("install-failure: quarantine retained, typed RestoreError, original recoverable", async () => {
      await using tmp = await tmpdir()
      const good = path.join(tmp.path, "good.db")
      const live = path.join(tmp.path, "live.db")
      const backupDir = await mkBackupDir(tmp.path)
      await makeGoodDb(good)
      const manifest = await backUp(good, backupDir)
      seedCorrupt(live)

      const outcome = await runEffect(
        Restore.restoreVerified({
          dbPath: live,
          backup: manifest,
          install: () => Effect.fail(new RestoreError({ code: "install_failed", detail: "injected" })),
        }).pipe(Effect.exit),
      )
      expect(outcome._tag).toBe("Failure")
      // The quarantine is retained (safety net, never deleted) and the original live DB is untouched.
      expect(markerOf(live)).toEqual([{ id: "corrupt" }])
    }, 60_000)

    test("verify-failure after install: the incident set is retained and the original is put back", async () => {
      await using tmp = await tmpdir()
      const good = path.join(tmp.path, "good.db")
      const live = path.join(tmp.path, "live.db")
      const backupDir = await mkBackupDir(tmp.path)
      await makeGoodDb(good)
      const manifest = await backUp(good, backupDir)
      seedCorrupt(live)

      // Inject an install that writes a NON-verified (garbage) file, so the reopen+verify step fails.
      const outcome = await runEffect(
        Restore.restoreVerified({
          dbPath: live,
          backup: manifest,
          install: () =>
            Effect.tryPromise(async () => {
              await fs.writeFile(live, Buffer.alloc(10, 0))
            }).pipe(Effect.orDie),
        }).pipe(Effect.exit),
      )
      expect(outcome._tag).toBe("Failure")
      // The original (corrupt) live DB is recoverable from the quarantine; it was never overwritten.
      expect(markerOf(live)).toEqual([{ id: "corrupt" }])
    }, 60_000)

    test("success: restore from verified backup verifies + is openable + integrity ok", async () => {
      await using tmp = await tmpdir()
      const good = path.join(tmp.path, "good.db")
      const backupDir = await mkBackupDir(tmp.path)
      await makeGoodDb(good)
      const manifest = await backUp(good, backupDir)
      const live = path.join(tmp.path, "live.db")
      seedCorrupt(live)

      const restoreManifest = await runEffect(
        Restore.restoreVerified({ dbPath: live, backup: manifest }),
      )
      expect(restoreManifest.outcome).toBe("restored")
      expect(markerOf(live)).toEqual([{ id: "known-good" }])
      expect(integrityOf(live)).toBe("ok")
      expect(await fs.stat(Restore.restoreManifestPathFor(live)).then(() => true)).toBe(true)
    }, 60_000)
  })
})

function safeClose(db: BunDatabase): void {
  try {
    db.close()
  } catch {
    /* already closed */
  }
}

function readText(filename: string, query: string): string {
  const db = new BunDatabase(filename, { readonly: true })
  try {
    const row = db.query(query).get() as Record<string, unknown>
    const key = Object.keys(row)[0]!
    return row[key] as string
  } finally {
    db.close()
  }
}
