// C1A-16 fixture child: a REAL upgrade-run forward-resume crash scenario.
//
// This is a PRODUCTION-FREE harness child (script+test only). It opens a real temp
// SQLite database file in WAL mode, drives the REAL migration registry bodies for
// the first `FR_SEED_COUNT` migrations, and records a content-addressed receipt +
// journal row per migration in the SAME transaction (design §10.5) — exactly the
// durable batch boundary `apply()` leaves after a crash mid-run. It also writes a
// fsync'd sentinel marker per migrated migration so the restart oracle can prove the
// body ran exactly once. It then prints HARNESS_READY and SLEEPS while the DB
// connection stays OPEN (holding the WAL with uncheckpointed frames), so the parent
// can SIGKILL the child mid-run and later reopen + resume. Killed or not, the run is
// left at the batch boundary (state 'applying', K receipts) and `apply()` resumes the
// SAME run on the next call — never re-applying a completed migration.
//
// Usage: bun run fixture-child-forward-resume.ts -- <dbPath> <markersDir>

import { mkdirSync, writeFileSync, fsyncSync, openSync, closeSync } from "node:fs"
import { join } from "node:path"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@deepagent-code/effect-drizzle-sqlite"
import { DatabaseUpgradeRun } from "@deepagent-code/core/database/upgrade-run"
import { migrations } from "@deepagent-code/core/database/migration.gen"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import type { SqlClient as SqlClientService } from "effect/unstable/sql/SqlClient"

const args = process.argv.slice(2)
const dbPath = args[0]!
const markersDir = args[1]!
mkdirSync(markersDir, { recursive: true })
const sleepMs = Number(process.env.CRASH_SLEEP_MS ?? "5000")
const seedCount = Number(process.env.FR_SEED_COUNT ?? "3")

const makeDb = EffectDrizzleSqlite.makeWithDefaults()
const run = <A, E>(effect: Effect.Effect<A, E, SqlClientService>) =>
  Effect.runPromise(effect.pipe(Effect.provide(SqliteClient.layer({ filename: dbPath })), Effect.scoped))

function mark(name: string): void {
  const path = join(markersDir, name)
  const fd = openSync(path, "w")
  writeFileSync(fd, "marker:" + name)
  fsyncSync(fd)
  closeSync(fd)
}

type Db = EffectDrizzleSqlite.EffectSQLiteDatabase

const ensureStateTables = (db: Db) =>
  Effect.gen(function* () {
    yield* db.run("PRAGMA foreign_keys = ON")
    yield* db.run("PRAGMA journal_mode = WAL")
    yield* db.run("PRAGMA synchronous = FULL")
    yield* DatabaseUpgradeRun.ensureTables(db)
    yield* db.run(sql`CREATE TABLE IF NOT EXISTS migration (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)`)
  })

const defaultReceipt = (runId: string, migrationId: string, ordinal: number): DatabaseUpgradeRun.ReceiptInput => ({
  runId,
  migrationId,
  contentHash: DatabaseUpgradeRun.migrationContentHash(migrations[ordinal - 1]!),
  bodyHash: DatabaseUpgradeRun.migrationBodyHash(migrations[ordinal - 1]!),
  ordinal,
  buildIdentity: "build-1",
  packageVersion: "2.0.0-alpha.0",
  result: "applied",
  startedAt: 1,
  completedAt: 1,
})

const seedActiveRun = (db: Db) =>
  Effect.gen(function* () {
    const runValue = yield* DatabaseUpgradeRun.beginRun(db, {
      sourceRegistryDigest: "source-digest",
      targetRegistryDigest: DatabaseUpgradeRun.registryDigest(migrations),
      sourceProtocol: { reader: "2", writer: "2" },
      targetProtocol: { reader: "3", writer: "3" },
      buildIdentity: "build-1",
      packageVersion: "2.0.0-alpha.0",
      pendingMigrationIds: migrations.map((migration) => migration.id),
      totalMigrations: migrations.length,
    })
    yield* DatabaseUpgradeRun.advanceRun(db, runValue.runId, "backup_verified")
    yield* DatabaseUpgradeRun.advanceRun(db, runValue.runId, "applying")
    return runValue
  })

const seedAppliedPrefix = (db: Db, runId: string, count: number) =>
  Effect.gen(function* () {
    for (let i = 0; i < count; i++) {
      const migration = migrations[i]!
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* migration.up(tx)
            yield* tx.run(sql`INSERT INTO migration (id, time_completed) VALUES (${migration.id}, ${Date.now()})`)
            yield* DatabaseUpgradeRun.recordReceipt(tx, defaultReceipt(runId, migration.id, i + 1))
            mark("migrated-" + migration.id)
          }),
        )
        .pipe(Effect.orDie)
    }
  })

// Hold the DB connection OPEN during the sleep so the kill lands on a live WAL migrator.
await run(
  Effect.gen(function* () {
    const db = yield* makeDb
    yield* ensureStateTables(db)
    const runValue = yield* seedActiveRun(db)
    yield* seedAppliedPrefix(db, runValue.runId, seedCount)
    console.log("HARNESS_READY")
    // Keep the connection open (scope not closed) through the kill window.
    yield* Effect.sleep(sleepMs)
  }),
)
