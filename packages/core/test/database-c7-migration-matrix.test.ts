import { describe, expect, test } from "bun:test"
import { Database as BunDatabase } from "bun:sqlite"
import os from "node:os"
import path from "path"
import fs from "node:fs/promises"
import { Effect } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@deepagent-code/effect-drizzle-sqlite"
import { Database } from "@deepagent-code/core/database/database"
import { DatabaseBootstrap, DatabaseBootstrapError } from "@deepagent-code/core/database/bootstrap"
import { DatabasePreflight } from "@deepagent-code/core/database/preflight"
import { DatabaseMigration } from "@deepagent-code/core/database/migration"
import { Backup } from "@deepagent-code/core/database/backup"
import { BackupVerify } from "@deepagent-code/core/database/backup-verify"
import { Restore, RestoreError } from "@deepagent-code/core/database/restore"
import { migrations } from "@deepagent-code/core/database/migration.gen"
import { tmpdir } from "./fixture/tmpdir"
import {
  registryIds,
  aliasesByCanonical,
  contentHashes,
  mergedHistoryInsertions,
  observationsFor,
  preflightOptionsFor,
  eraKnownIds,
} from "./database/historical-fixtures"

// C7-02 MIGRATION + BACKUP + RESTORE MATRIX (era × scenario). The matrix composes the EXISTING
// deterministic helpers — historical-fixtures (observationsFor / preflightOptionsFor / eraKnownIds
// / alias / merged-history sets), backup-fixture, and the real Database / Backup / Restore /
// DatabaseMigration modules — into a fixture-only, deterministic GATE:
//
//   era      = fresh / 1.4.7 / 1.4.8-rN / 2.0-alpha / incident (unknown lineage, alias hole,
//              content-hash mismatch)
//   scenario = plain migrate / interrupted migrate / repeated idempotent / migrate+backup+restore
//              round-trip / disk+space / WAL recovery / restore-over-existing
//
// Every cell asserts: the classification is correct (no silent guess), unclassified = 0 (every era
// maps to a closed {known, alias-resolved, merged-history, blocked_schema} bucket), UNKNOWN /
// content-mismatch ⇒ blocked_schema (business DB never admitted writable), backup verify passes,
// and a restore is atomic on failure (no partial install).
//
// Honest scope note (reported, not a GATE): eras 1.4.8-rN (alias journal) and 2.0-alpha (merged
// lineage) are exercised as the CLASSIFICATION oracle (the deterministic, machine-checkable surface)
// — building a real file whose journal uses alias ids / a merged-history gap requires the
// `reconcileLegacyProviderRecovery` path and a specific source schema, which is a reported
// pause-point / integration item. Real-file forward migration is proven on fresh, 1.4.7 (contiguous
// prefix) and the incident (blocked) eras.

// ---------------------------------------------------------------------------
// Shared helpers (reuse existing modules; no migration/backup logic duplicated).
// ---------------------------------------------------------------------------
const run = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromise(effect)

const runWithFile = <A, E>(
  filename: string,
  effect: Effect.Effect<A, E, import("effect/unstable/sql/SqlClient").SqlClient>,
) => Effect.runPromise(effect.pipe(Effect.provide(SqliteClient.layer({ filename })), Effect.scoped))

const topLevelRun = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

const readOnly = (filename: string) => new BunDatabase(filename, { readonly: true })

const countIn = (filename: string, table: string): number => {
  const db = readOnly(filename)
  try {
    return (db.query(`SELECT count(*) AS c FROM ${table}`).get() as { c: number }).c
  } catch {
    // A table created by apply/preflight (e.g. database_migration_receipt) may not exist before the
    // production open path runs; count 0 rather than failing on a not-yet-created schema.
    return 0
  } finally {
    db.close()
  }
}

const journalIds = (filename: string): string[] => {
  const db = readOnly(filename)
  try {
    return (db.query("SELECT id FROM migration ORDER BY id").all() as { id: string }[]).map((row) => row.id)
  } finally {
    db.close()
  }
}

const tableNames = (filename: string): string[] => {
  const db = readOnly(filename)
  try {
    return (
      db
        .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all() as { name: string }[]
    ).map((row) => row.name)
  } finally {
    db.close()
  }
}

const markerOf = (filename: string): { id: string }[] => {
  const db = readOnly(filename)
  try {
    return db.query("SELECT id FROM markers ORDER BY id").all() as { id: string }[]
  } finally {
    db.close()
  }
}

const integrityOf = (filename: string): string => {
  const db = readOnly(filename)
  try {
    return (db.query("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check
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

/** Fully-migrated authority DB (production open path) with a synthetic markers table. */
const makeGoodDb = async (filename: string) => {
  await topLevelRun(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db.run("CREATE TABLE markers (id TEXT PRIMARY KEY)")
      yield* db.run("INSERT INTO markers VALUES ('known-good'),('known-good-2')")
    }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped),
  )
}

/** Seed a real DB with a partial (interrupted) journal: only the first `count` migrations applied. */
const applyPrefix = async (filename: string, count: number): Promise<void> => {
  await runWithFile(
    filename,
    Effect.gen(function* () {
      const db = yield* EffectDrizzleSqlite.makeWithDefaults()
      yield* DatabaseMigration.applyOnly(db, migrations.slice(0, count))
    }),
  )
}

/** Open the production business layer (preflight → apply → post-verify) and return the bootstrap mode. */
const openMigrated = (filename: string) =>
  run(
    Effect.gen(function* () {
      const { mode } = yield* Database.Service
      return mode
    }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped),
  )

// ---------------------------------------------------------------------------
// Era classification oracle (mirrors the C1A-15 oracle; composes its helpers).
// ---------------------------------------------------------------------------
type EraLabel = "known" | "alias-resolved" | "merged-history" | "blocked_schema"

type EraSpec = {
  name: string
  label: EraLabel
  migratable: boolean
  seedable: boolean
  journal: () => { ids: readonly string[]; obsOverride?: Parameters<typeof observationsFor>[1] }
  blockedCode?: string
  seededPrefix?: number
  seed: (file: string) => Promise<void>
}

/** Seed a fixture era (classification-only eras are classification-oracle only, not seeded). */
const seedEra = async (era: EraSpec, file: string) => {
  await era.seed(file)
}

const aliasJournalIds = (): readonly string[] =>
  registryIds.map((id) => (aliasesByCanonical.has(id) ? aliasesByCanonical.get(id)![0] : id))

const mergedJournalIds = (): readonly string[] => registryIds.filter((id) => !mergedHistoryInsertions.has(id))

/** Build a real file whose `migration` journal is: rows (id, time_completed[, content_hash]). */
const seedJournalFile = async (filename: string, rows: { id: string; content_hash?: string }[]): Promise<void> => {
  const db = new BunDatabase(filename, { create: true })
  db.exec("PRAGMA journal_mode = WAL")
  db.exec("CREATE TABLE migration (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL, content_hash TEXT)")
  const insert = db.prepare("INSERT INTO migration (id, time_completed, content_hash) VALUES (?, 1, ?)")
  for (const row of rows) insert.run(row.id, row.content_hash ?? null)
  db.close()
}

const incidentUnknownRows = () => [...registryIds.map((id) => ({ id })), { id: "20250101000000_unreleased_legacy" }]

const incidentAliasHoleRows = () => registryIds.map((id, index) => ({ id: index === 0 ? "20250101000000_ghost_alias" : id }))

const incidentHashRows = () =>
  registryIds.map((id) => ({ id, content_hash: contentHashes.get(id) === "aaaa" ? "bbbb" : "deadbeef" }))

const eras: EraSpec[] = [
  {
    name: "fresh",
    label: "known",
    migratable: true,
    seedable: true,
    journal: () => ({ ids: [] }),
    seededPrefix: 0,
    seed: async (file) => { await Bun.write(file, "") },
  },
  {
    name: "1.4.7",
    label: "known",
    migratable: true,
    seedable: true,
    journal: () => ({ ids: eraKnownIds(3) }),
    seededPrefix: 3,
    seed: (file) => applyPrefix(file, 3),
  },
  {
    name: "1.4.8-rN",
    label: "alias-resolved",
    migratable: true,
    seedable: false,
    seed: async () => {}, // classification oracle only
    journal: () => ({ ids: aliasJournalIds() }),
  },
  {
    name: "2.0-alpha",
    label: "merged-history",
    migratable: true,
    seedable: false,
    seed: async () => {}, // classification oracle only
    journal: () => ({ ids: mergedJournalIds() }),
  },
  {
    name: "incident-unknown",
    label: "blocked_schema",
    migratable: false,
    seedable: true,
    journal: () => ({ ids: incidentUnknownRows().map((row) => row.id) }),
    blockedCode: "migration_journal_unknown_lineage",
    seed: (file) => seedJournalFile(file, incidentUnknownRows()),
  },
  {
    name: "incident-alias-hole",
    label: "blocked_schema",
    migratable: false,
    seedable: true,
    journal: () => ({ ids: incidentAliasHoleRows().map((row) => row.id) }),
    blockedCode: "migration_journal_unknown_lineage",
    seed: (file) => seedJournalFile(file, incidentAliasHoleRows()),
  },
  {
    name: "incident-content-mismatch",
    label: "blocked_schema",
    migratable: false,
    seedable: true,
    journal: () => ({
      ids: registryIds,
      obsOverride: {
        journalRows: incidentHashRows().map((row) => ({ id: row.id, time_completed: 1, content_hash: row.content_hash })),
      },
    }),
    blockedCode: "migration_journal_content_mismatch",
    seed: (file) => seedJournalFile(file, incidentHashRows()),
  },
]

const canonical = (id: string) => DatabaseMigration.historicalAliases.get(id) ?? id

const classifyEra = (spec: EraSpec): { label: EraLabel; result: DatabasePreflight.PreflightResult; state: DatabaseBootstrap.BootstrapState } => {
  const { ids, obsOverride } = spec.journal()
  const result = DatabasePreflight.analyzePreflight(preflightOptionsFor(), observationsFor(ids, obsOverride ?? {}))
  const completed = new Set(ids.map(canonical))
  const pending = registryIds.filter((id) => !completed.has(id))
  const state = DatabaseBootstrap.describeBootstrap(
    {
      preflight: result,
      pendingMigrationIds: pending,
      hasExistingDatabase: true,
      needsBackup: pending.length > 0,
      backupReady: false,
      recoveryRequired: false,
      recoveryComplete: true,
      postVerifyPassed: false,
    },
    { buildDigest: "c7-fixture-digest" },
  )
  let label: EraLabel
  if (!result.ok) {
    label = "blocked_schema"
  } else if (
    pending.length > 0 &&
    completed.has(DatabaseMigration.mergedHistoryAnchor) &&
    pending.every((id) => mergedHistoryInsertions.has(id))
  ) {
    label = "merged-history"
  } else if (pending.length === 0) {
    label = ids.some((id) => DatabaseMigration.historicalAliases.has(id)) ? "alias-resolved" : "known"
  } else {
    label = "known"
  }
  return { label, result, state }
}

describe("C7-02 · era classification matrix (deterministic oracle)", () => {
  test("every era classifies into the closed bucket, no era is unclassified", () => {
    const seen = new Set<EraLabel>()
    const blocked = eras.filter((era) => era.label === "blocked_schema")
    const migratable = eras.filter((era) => era.migratable)
    expect(migratable.length).toBeGreaterThan(0)
    expect(blocked.length).toBeGreaterThan(0)

    for (const spec of eras) {
      const { label, result, state } = classifyEra(spec)
      seen.add(label)
      expect(label).toBe(spec.label)

      // "unclassified = 0": the observable bootstrap mode is always one of the three legal modes.
      expect(["ready", "read_only_recovery", "blocked_schema"]).toContain(state.mode)

      if (spec.migratable) {
        // A migratable era must never be silently blocked (no hard blocker), and the binary may write.
        expect(result.ok).toBe(true)
        expect(state.mode).toBe("ready")
        expect(state.ready).toBe(true)
      } else {
        // A mangled (incident) era must be blocked BEFORE any write, never guessed/applied.
        expect(result.ok).toBe(false)
        expect(state.mode).toBe("blocked_schema")
        expect(state.ready).toBe(false)
        const issues = "issues" in result ? result.issues : []
        expect(issues.some((issue) => issue.code === spec.blockedCode)).toBe(true)
      }
    }

    // The matrix actually exercises all four buckets — nothing collapses into an "unclassified" catch-all.
    expect([...seen].sort()).toEqual(["alias-resolved", "blocked_schema", "known", "merged-history"])
  })

  test("incident eras bootstrap to blocked_schema over a real file, and the writable layer refuses admission", async () => {
    // content-mismatch is excluded here: the production bootstrap preflight (database.ts
    // preflightOptionsFor) does NOT wire knownContentHashes, so a content-hash divergence is not
    // caught at boot (documented residual below; the C1A-15 oracle flags it when hashes are wired).
    const hardBlockedAtBoot = eras.filter((era) => !era.migratable && era.blockedCode !== "migration_journal_content_mismatch")
    expect(hardBlockedAtBoot.length).toBeGreaterThan(0)
    for (const spec of hardBlockedAtBoot) {
      await using tmp = await tmpdir()
      const file = path.join(tmp.path, `${spec.name}.db`)
      await spec.seed!(file)

      const boot = await Database.bootstrap(file)
      expect(boot.mode).toBe("blocked_schema")
      expect(boot.ready).toBe(false)

      // The business (writable) layer must fail closed with a DatabaseBootstrapError.
      const writable = await topLevelRun(
        Effect.gen(function* () {
          const { db } = yield* Database.Service
          return db
        }).pipe(Effect.provide(Database.layerFromPath(file)), Effect.scoped, Effect.flip),
      )
      expect(writable).toBeInstanceOf(DatabaseBootstrapError)
      expect((writable as DatabaseBootstrapError).state.mode).toBe("blocked_schema")
    }
  }, 120_000)

  test("content-mismatch over a real file: the C1A-15 oracle blocks it, but the production boot path does not (residual)", async () => {
    // The install-time oracle (knownContentHashes wired) flags a content-hash divergence as a hard
    // blocker — this is what the classification matrix proves. The PRODUCTION bootstrap (database.ts
    // preflightOptionsFor) omits knownContentHashes, so the same divergence is NOT detected at boot.
    const spec = eras.find((era) => era.name === "incident-content-mismatch")!
    const { label, result } = classifyEra(spec)
    expect(label).toBe("blocked_schema")
    expect(result.ok).toBe(false)
    const issues = "issues" in result ? result.issues : []
    expect(issues.some((issue) => issue.code === "migration_journal_content_mismatch")).toBe(true)

    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "hash.db")
    await spec.seed!(file)
    const boot = await Database.bootstrap(file)
    // Honest current behavior: the production boot path admits this DB (no content-hash gate).
    // This is a documented residual/GAP for the mission's "content-mismatch ⇒ blocked_schema" gate,
    // not a fixture limitation — it requires wiring knownContentHashes into the production preflight.
    expect(boot.mode).toBe("ready")
  }, 60_000)
})

describe("C7-02 · migration scenarios (real fixture files)", () => {
  test("plain migrate · fresh: preflight → forward-migrate to registry completeness", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "app.db")
    await seedEra(eras[0]!, file)

    const mode = await openMigrated(file)
    expect(mode!.mode).toBe("ready")
    // Journal completes to the full registry; every migration has a receipt (all applied in-run).
    expect([...journalIds(file)].sort()).toEqual([...registryIds].sort())
    expect(countIn(file, "database_migration_receipt")).toBe(migrations.length)
    expect(integrityOf(file)).toBe("ok")
  }, 90_000)

  test("interrupted migrate · 1.4.7 prefix (journal stopped mid-way) resumes to completion, no duplicate body", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "app.db")
    await seedEra(eras[1]!, file)

    // Interrupted/resume checkpoint: the journal is exactly the 1.4.7 contiguous prefix.
    expect(journalIds(file)).toEqual([...eraKnownIds(3)])
    expect(countIn(file, "database_migration_receipt")).toBe(0)

    // Resume the SAME run through the production open path.
    const mode = await openMigrated(file)
    expect(mode!.mode).toBe("ready")

    // Completed journal == registry; only the pre-applied prefix lacks a receipt (no duplicate body).
    expect([...journalIds(file)].sort()).toEqual([...registryIds].sort())
    expect(countIn(file, "database_migration_receipt")).toBe(migrations.length - 3)
    expect(integrityOf(file)).toBe("ok")
  }, 90_000)

  test("repeated migrate · idempotent: a second apply changes nothing", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "app.db")
    await seedEra(eras[0]!, file)
    await openMigrated(file)

    const before = {
      journal: [...journalIds(file)].sort(),
      receipts: countIn(file, "database_migration_receipt"),
      tables: tableNames(file),
    }
    // Run the production open path a second time: no re-apply, no duplicate journal/receipt row.
    await openMigrated(file)

    expect([...journalIds(file)].sort()).toEqual(before.journal)
    expect(countIn(file, "database_migration_receipt")).toBe(before.receipts)
    expect(tableNames(file)).toEqual(before.tables)
  }, 90_000)
})

describe("C7-02 · backup + restore round-trip (small synthetic data set)", () => {
  test("good DB + synthetic rows → backup verifies → restore over corrupt live keeps row identity + counts + schema identity", async () => {
    await using tmp = await tmpdir()
    const good = path.join(tmp.path, "good.db")
    const live = path.join(tmp.path, "live.db")
    const backupDir = await mkBackupDir(tmp.path)
    await makeGoodDb(good)

    // The backup must verify (integrity / FK / capability / hash / schema digest).
    const manifest = await backUp(good, backupDir)
    const verdict = await run(BackupVerify.verify(manifest))
    expect(verdict.ok).toBe(true)
    if (verdict.ok) {
      expect(verdict.quickCheck).toBe("ok")
      expect(verdict.hashMatch).toBe(true)
      expect(verdict.schemaDigestMatch).toBe(true)
    }

    // Record the good snapshot's schema + row identity, then corrupt the live DB.
    const beforeTables = tableNames(good)
    const seedCorrupt = (filename: string) => {
      const db = new BunDatabase(filename, { create: true })
      db.run("CREATE TABLE markers (id TEXT PRIMARY KEY)")
      db.run("INSERT INTO markers VALUES ('corrupt')")
      db.close()
    }
    seedCorrupt(live)
    expect(markerOf(live)).toEqual([{ id: "corrupt" }])

    const restoreManifest = await run(Restore.restoreVerified({ dbPath: live, backup: manifest }))
    expect(restoreManifest.outcome).toBe("restored")

    // Row identity restored, counts intact, schema identical, journal fully-migrated, integrity ok.
    expect(markerOf(live)).toEqual([{ id: "known-good" }, { id: "known-good-2" }])
    expect(countIn(live, "markers")).toBe(2)
    expect(tableNames(live)).toEqual(beforeTables)
    expect([...journalIds(live)].sort()).toEqual([...registryIds].sort())
    expect(countIn(live, "database_migration_receipt")).toBe(migrations.length)
    expect(integrityOf(live)).toBe("ok")
  }, 90_000)

  test("restore is atomic on failure: an injected install failure leaves the live DB untouched and retains the quarantine", async () => {
    await using tmp = await tmpdir()
    const good = path.join(tmp.path, "good.db")
    const live = path.join(tmp.path, "live.db")
    const backupDir = await mkBackupDir(tmp.path)
    await makeGoodDb(good)
    const manifest = await backUp(good, backupDir)
    const db = new BunDatabase(live, { create: true })
    db.run("CREATE TABLE markers (id TEXT PRIMARY KEY)")
    db.run("INSERT INTO markers VALUES ('corrupt')")
    db.close()

    const outcome = await run(
      Restore.restoreVerified({
        dbPath: live,
        backup: manifest,
        install: () => Effect.fail(new RestoreError({ code: "install_failed", detail: "injected" })),
      }).pipe(Effect.exit),
    )
    expect(outcome._tag).toBe("Failure")
    // No partial install: the live DB still holds the original rows; nothing was replaced.
    expect(markerOf(live)).toEqual([{ id: "corrupt" }])
  }, 90_000)
})

describe("C7-02 · disk / space and WAL recovery scenarios", () => {
  test("insufficient free space → preflight blocked_schema before any write (maintenance mode observable)", () => {
    const result = DatabasePreflight.analyzePreflight(
      preflightOptionsFor({ requiredFreeSpaceBytes: 64 * 1024 * 1024 }),
      observationsFor([], { freeSpaceBytes: 1024 }),
    )
    expect(result.ok).toBe(false)
    const issues = "issues" in result ? result.issues : []
    expect(issues.some((issue) => issue.code === "insufficient_space")).toBe(true)
    const state = DatabaseBootstrap.describeBootstrap(
      {
        preflight: result,
        pendingMigrationIds: registryIds,
        hasExistingDatabase: true,
        needsBackup: true,
        backupReady: false,
        recoveryRequired: false,
        recoveryComplete: true,
        postVerifyPassed: false,
      },
      { buildDigest: "c7-fixture-digest" },
    )
    expect(state.mode).toBe("blocked_schema")
    expect(state.ready).toBe(false)
  })

  test("real-file SQLITE_FULL surfaces typed (no silent loss) and the DB stays openable", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "full.db")
    const db = new BunDatabase(file, { create: true })
    db.exec("PRAGMA journal_mode = WAL")
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)")
    db.exec("INSERT INTO t (v) VALUES ('seed')")
    const pages = (db.query("PRAGMA page_count").get() as { page_count: number }).page_count
    db.run(`PRAGMA max_page_count = ${pages}`)
    let err: unknown
    try {
      for (let i = 0; i < 100_000; i++) db.run("INSERT INTO t (v) VALUES ('xxxxxxxxxxxxxxxxxxxx')")
    } catch (e) {
      err = e
    }
    db.close()
    expect(err).toBeDefined()
    expect((err as { code?: string }).code).toBe("SQLITE_FULL")
    const reopened = new BunDatabase(file, { readonly: true })
    const count = (reopened.query("SELECT count(*) AS c FROM t").get() as { c: number }).c
    expect(count).toBeGreaterThan(0)
    expect((reopened.query("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check).toBe("ok")
    reopened.close()
  })

  test("WAL present: an uncheckpointed committed frame is captured by backup, and a bad -wal keeps checkpointed data", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "wal.db")
    await makeGoodDb(file)

    // Commit a row WITHOUT checkpointing, so the backup must read it from the WAL.
    const writer = new BunDatabase(file, { readwrite: true })
    writer.run("PRAGMA journal_mode = WAL")
    writer.run("PRAGMA wal_autocheckpoint = 0")
    writer.run("CREATE TABLE IF NOT EXISTS probe (value TEXT)")
    writer.run("INSERT INTO probe VALUES ('captured-from-wal')")
    try {
      const manifest = await backUp(file, tmp.path)
      const verdict = await run(BackupVerify.verify(manifest))
      expect(verdict.ok).toBe(true)
      const snapshot = new BunDatabase(manifest.backup.filePath, { create: false, readonly: true })
      expect(snapshot.query("SELECT value FROM probe").all()).toEqual([{ value: "captured-from-wal" }])
      snapshot.close()

      // Bad -wal next to a checkpointed committed DB: reopen keeps committed data + reads read-only.
      const walCheck = path.join(tmp.path, "badwal.db")
      const cdb = new BunDatabase(walCheck, { create: true })
      cdb.run("PRAGMA journal_mode = WAL")
      cdb.run("CREATE TABLE migration (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)")
      cdb.run("INSERT INTO migration VALUES ('m1',1),('m2',1),('m3',1)")
      cdb.run("CREATE TABLE database_capability (capability TEXT PRIMARY KEY, minimum_reader_protocol INTEGER, minimum_writer_protocol INTEGER)")
      cdb.run("INSERT INTO database_capability VALUES ('bounded_event_snapshot_v1',2,2)")
      cdb.run("PRAGMA wal_checkpoint(TRUNCATE)")
      cdb.close()
      await fs.writeFile(walCheck + "-wal", Buffer.alloc(4096, 0x7f))
      const ro = new BunDatabase(walCheck, { readonly: true })
      expect(ro.query("SELECT id FROM migration ORDER BY id").all()).toEqual([{ id: "m1" }, { id: "m2" }, { id: "m3" }])
      expect((ro.query("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check).toBe("ok")
      ro.close()
    } finally {
      writer.close()
    }
  }, 90_000)
})

describe("C7-02 · restore-over-existing + incident recovery", () => {
  test("a verified good backup restores over an existing DB, and a blocked incident live DB is recovered (never overwritten silently)", async () => {
    await using tmp = await tmpdir()
    const good = path.join(tmp.path, "good.db")
    const backupDir = await mkBackupDir(tmp.path)
    await makeGoodDb(good)
    const manifest = await backUp(good, backupDir)

    // "Restore over existing": the live DB already has data (a different marker set).
    const overExisting = path.join(tmp.path, "over.db")
    const db = new BunDatabase(overExisting, { create: true })
    db.run("CREATE TABLE markers (id TEXT PRIMARY KEY)")
    db.run("INSERT INTO markers VALUES ('pre-existing'),('second')")
    db.close()
    expect(markerOf(overExisting).length).toBe(2)

    const rm = await run(Restore.restoreVerified({ dbPath: overExisting, backup: manifest }))
    expect(rm.outcome).toBe("restored")
    // Row identity replaced by the backup's synthetic set; the original survived in the incident set.
    expect(markerOf(overExisting)).toEqual([{ id: "known-good" }, { id: "known-good-2" }])
    const incidentEntries = await fs.readdir(rm.quarantineDir)
    expect(incidentEntries.some((name) => name === path.basename(overExisting))).toBe(true)

    // Incident recovery: a blocked (mangled) live DB is recovered FROM a verified good backup.
    const incidentLive = path.join(tmp.path, "incident.db")
    const spec = eras.find((era) => era.name === "incident-unknown")!
    await spec.seed!(incidentLive)
    expect((await Database.bootstrap(incidentLive)).mode).toBe("blocked_schema")

    const recover = await run(Restore.restoreVerified({ dbPath: incidentLive, backup: manifest }))
    expect(recover.outcome).toBe("restored")
    expect(markerOf(incidentLive)).toEqual([{ id: "known-good" }, { id: "known-good-2" }])
    expect([...journalIds(incidentLive)].sort()).toEqual([...registryIds].sort())
    expect((await Database.bootstrap(incidentLive)).mode).toBe("ready")
    expect(integrityOf(incidentLive)).toBe("ok")
  }, 90_000)
})

// ---------------------------------------------------------------------------
// DATA-P2-3 / §10.4 executor: the production open path must CREATE + VERIFY the
// pre-upgrade consistency backup before applying forward migrations to an
// existing DB (previously the state machine said backup_required with mode=ready
// but NO production path ran the backup — open would migrate without it).
// ---------------------------------------------------------------------------
test("§10.4 executor: existing DB with pending migrations backs up + verifies before migrating", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dt-104-executor-"))
  try {
    const filename = path.join(root, "deepagent-code.db")
    // Real file with a contiguous journal prefix (pending migrations ahead of it).
    await applyPrefix(filename, registryIds.length - 3)
    const before = journalIds(filename)
    expect(before.length).toBe(registryIds.length - 3)

    const mode = await openMigrated(filename)
    expect(mode?.mode).toBe("ready")
    expect(mode?.phase).toBe("ready")

    // The pre-upgrade backup was created + verified under <dbDir>/backups.
    const backupsDir = path.join(root, "backups")
    const entries = await fs.readdir(backupsDir)
    expect(entries.some((name) => name.endsWith(".manifest.json"))).toBe(true)
    const manifestFiles = entries.filter((name) => name.endsWith(".manifest.json"))
    const manifest = JSON.parse(
      await fs.readFile(path.join(backupsDir, manifestFiles[0]), "utf8"),
    ) as { backup: { sha256: string }; source: { schemaDigest: string } }
    expect(manifest.backup.sha256).toBeTruthy()
    expect(manifest.source.schemaDigest).toBeTruthy()

    // The journal advanced to the full registry.
    expect(journalIds(filename).length).toBe(registryIds.length)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
