import { describe, expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@deepagent-code/effect-drizzle-sqlite"
import { DatabaseMigration } from "@deepagent-code/core/database/migration"
import { DatabaseUpgradeRun } from "@deepagent-code/core/database/upgrade-run"
import { migrations } from "@deepagent-code/core/database/migration.gen"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import type { SqlClient as SqlClientService } from "effect/unstable/sql/SqlClient"

// C1A-08 upgrade run FORWARD RESUME. A crash/kill at any point must leave the database at a batch
// boundary (a migration body + journal row + receipt are written in ONE transaction, design §10.5),
// and apply() must resume the SAME run from the last VERIFIED receipt, continuing ordinals and never
// re-applying completed migrations or duplicating backfill.
//
// The resume source of truth is the run's content-addressed receipts, validated against the legacy
// `migration` journal and the registry. A divergence (stale target digest, receipt↔journal↔registry
// mismatch, failed result) is NEVER silently skipped: it routes the run to recovery_required under a
// stable code. An old-binary fence refuses (non-mutating) when the run targets a protocol the running
// binary does not support.

const run = <A, E>(effect: Effect.Effect<A, E, SqlClientService>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })),
      Effect.scoped,
    ),
  )

const makeDb = EffectDrizzleSqlite.makeWithDefaults()

const ensureStateTables = (db: EffectDrizzleSqlite.EffectSQLiteDatabase) =>
  Effect.gen(function* () {
    yield* db.run("PRAGMA foreign_keys = ON")
    yield* DatabaseUpgradeRun.ensureTables(db)
    yield* db.run(sql`CREATE TABLE IF NOT EXISTS migration (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)`)
  })

const defaultReceipt = (runId: string, migrationId: string, ordinal: number) => ({
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

/** Seed an active run (state `applying`) with a target registry, protocol, and pending scope. */
const seedActiveRun = (
  db: EffectDrizzleSqlite.EffectSQLiteDatabase,
  overrides: { targetDigest?: string; targetReader?: string; targetWriter?: string } = {},
) =>
  Effect.gen(function* () {
    const runValue = yield* DatabaseUpgradeRun.beginRun(db, {
      sourceRegistryDigest: "source-digest",
      targetRegistryDigest: overrides.targetDigest ?? DatabaseUpgradeRun.registryDigest(migrations),
      sourceProtocol: { reader: "2", writer: "2" },
      targetProtocol: { reader: overrides.targetReader ?? "3", writer: overrides.targetWriter ?? "3" },
      buildIdentity: "build-1",
      packageVersion: "2.0.0-alpha.0",
      pendingMigrationIds: migrations.map((migration) => migration.id),
      totalMigrations: migrations.length,
    })
    yield* DatabaseUpgradeRun.advanceRun(db, runValue.runId, "backup_verified")
    yield* DatabaseUpgradeRun.advanceRun(db, runValue.runId, "applying")
    return runValue
  })

/**
 * Run the REAL migration body for the first `count` migrations in registry order, each in its own
 * transaction together with the journal row + receipt. This is exactly the state a production apply()
 * leaves after a crash mid-run: body + journal + receipt are atomic, so the next apply resumes at the
 * batch boundary with the schema already in place.
 */
const seedAppliedPrefix = (
  db: EffectDrizzleSqlite.EffectSQLiteDatabase,
  runId: string,
  count: number,
) =>
  Effect.gen(function* () {
    for (let i = 0; i < count; i++) {
      const migration = migrations[i]!
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* migration.up(tx)
            yield* tx.run(sql`INSERT INTO migration (id, time_completed) VALUES (${migration.id}, ${Date.now()})`)
            yield* DatabaseUpgradeRun.recordReceipt(tx, defaultReceipt(runId, migration.id, i + 1))
          }),
        )
        .pipe(Effect.orDie)
    }
  })

/**
 * Write ONLY the journal row + receipt for the first `count` migrations (no body) so a specific
 * divergence test can drive `validateResumeRun` to the exact mismatch. These tests fail in
 * beginOrResumeRun BEFORE any migration body runs, so the schema is not required.
 */
const seedStatePrefix = (
  db: EffectDrizzleSqlite.EffectSQLiteDatabase,
  runId: string,
  count: number,
  overrideAt?: { index: number; receipt: Record<string, unknown> },
) =>
  Effect.gen(function* () {
    for (let i = 0; i < count; i++) {
      const migration = migrations[i]!
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* tx.run(sql`INSERT INTO migration (id, time_completed) VALUES (${migration.id}, ${Date.now()})`)
            const base = defaultReceipt(runId, migration.id, i + 1)
            const receipt = overrideAt && overrideAt.index === i ? { ...base, ...overrideAt.receipt } : base
            yield* DatabaseUpgradeRun.recordReceipt(tx, receipt)
          }),
        )
        .pipe(Effect.orDie)
    }
  })

describe("DatabaseMigration forward resume (C1A-08)", () => {
  test("crash at a batch boundary resumes the SAME run, continues ordinals, no re-apply", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* ensureStateTables(db)
        const seeds = 5
        const runValue = yield* seedActiveRun(db)
        yield* seedAppliedPrefix(db, runValue.runId, seeds)

        const resumed = yield* DatabaseMigration.apply(db)
        expect(resumed).not.toBeUndefined()
        expect(resumed!.runId).toBe(runValue.runId)
        expect(resumed!.state).toBe("ready")

        // Exactly one run, and the SAME run id (no new run started on top).
        expect(yield* db.get<{ count: number }>(sql`SELECT count(*) AS count FROM database_upgrade_run`)).toEqual({
          count: 1,
        })
        // Every registry migration has exactly one receipt and one journal row (no duplicates / re-applies).
        expect(yield* db.get<{ count: number }>(sql`SELECT count(*) AS count FROM database_migration_receipt`))
          .toEqual({ count: migrations.length })
        expect(yield* db.get<{ count: number }>(sql`SELECT count(*) AS count FROM migration`)).toEqual({
          count: migrations.length,
        })
        // Ordinals are continuous 1..N with no gaps (the pre-crash receipts keep their ordinals).
        const ordinals = yield* db.all<{ ordinal: number }>(
          sql`SELECT ordinal FROM database_migration_receipt ORDER BY ordinal`,
        )
        expect(ordinals.map((o) => o.ordinal)).toEqual(migrations.map((_, i) => i + 1))
        expect(yield* db.all(sql`PRAGMA foreign_key_check`)).toEqual([])
      }),
    )
  })

  test("receipt content mismatch routes the run to recovery_required", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* ensureStateTables(db)
        const runValue = yield* seedActiveRun(db)
        yield* seedStatePrefix(db, runValue.runId, 2, { index: 1, receipt: { contentHash: "wrong-hash" } })

        const outcome = yield* DatabaseMigration.apply(db).pipe(Effect.exit)
        expect(outcome._tag).toBe("Failure")
        const loaded = yield* DatabaseUpgradeRun.loadRun(db, runValue.runId)
        expect(loaded!.state).toBe("recovery_required")
        expect(loaded!.failureCode).toBe("resume_receipt_content_mismatch")
      }),
    )
  })

  test("receipt ordinal mismatch routes the run to recovery_required", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* ensureStateTables(db)
        const runValue = yield* seedActiveRun(db)
        yield* seedStatePrefix(db, runValue.runId, 2, { index: 1, receipt: { ordinal: 1 } })

        const outcome = yield* DatabaseMigration.apply(db).pipe(Effect.exit)
        expect(outcome._tag).toBe("Failure")
        const loaded = yield* DatabaseUpgradeRun.loadRun(db, runValue.runId)
        expect(loaded!.state).toBe("recovery_required")
        expect(loaded!.failureCode).toBe("resume_receipt_ordinal_mismatch")
      }),
    )
  })

  test("receipt under the active run without a journal row routes to recovery_required", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* ensureStateTables(db)
        const runValue = yield* seedActiveRun(db)
        yield* seedStatePrefix(db, runValue.runId, 1)
        const migration = migrations[1]!
        yield* db
          .transaction((tx) => DatabaseUpgradeRun.recordReceipt(tx, defaultReceipt(runValue.runId, migration.id, 2)))
          .pipe(Effect.orDie)

        const outcome = yield* DatabaseMigration.apply(db).pipe(Effect.exit)
        expect(outcome._tag).toBe("Failure")
        const loaded = yield* DatabaseUpgradeRun.loadRun(db, runValue.runId)
        expect(loaded!.state).toBe("recovery_required")
        expect(loaded!.failureCode).toBe("resume_receipt_without_journal")
      }),
    )
  })

  test("journal row in the run's pending scope without a receipt routes to recovery_required", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* ensureStateTables(db)
        const runValue = yield* seedActiveRun(db)
        // Journal row for migration 0 but no receipt under the run (applied outside the run).
        yield* db
          .run(sql`INSERT INTO migration (id, time_completed) VALUES (${migrations[0]!.id}, ${Date.now()})`)
          .pipe(Effect.orDie)

        const outcome = yield* DatabaseMigration.apply(db).pipe(Effect.exit)
        expect(outcome._tag).toBe("Failure")
        const loaded = yield* DatabaseUpgradeRun.loadRun(db, runValue.runId)
        expect(loaded!.state).toBe("recovery_required")
        expect(loaded!.failureCode).toBe("resume_journal_without_receipt")
      }),
    )
  })

  test("a receipt that recorded a failed result routes to recovery_required", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* ensureStateTables(db)
        const runValue = yield* seedActiveRun(db)
        yield* seedStatePrefix(db, runValue.runId, 1, { index: 0, receipt: { result: "verify_failed" } })

        const outcome = yield* DatabaseMigration.apply(db).pipe(Effect.exit)
        expect(outcome._tag).toBe("Failure")
        const loaded = yield* DatabaseUpgradeRun.loadRun(db, runValue.runId)
        expect(loaded!.state).toBe("recovery_required")
        expect(loaded!.failureCode).toBe("resume_receipt_failed_result")
      }),
    )
  })

  test("a stale run (target digest changed) routes to recovery_required without starting a new run", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* ensureStateTables(db)
        const runValue = yield* seedActiveRun(db, { targetDigest: "stale-digest" })

        const outcome = yield* DatabaseMigration.apply(db).pipe(Effect.exit)
        expect(outcome._tag).toBe("Failure")
        // No new run was started on top — the stale run is the only run.
        expect(yield* db.get<{ count: number }>(sql`SELECT count(*) AS count FROM database_upgrade_run`)).toEqual({
          count: 1,
        })
        const loaded = yield* DatabaseUpgradeRun.loadRun(db, runValue.runId)
        expect(loaded!.state).toBe("recovery_required")
        expect(loaded!.failureCode).toBe("stale_run_target_digest")
      }),
    )
  })

  test("old-binary fence refuses (non-mutating) a run targeting a higher protocol", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* ensureStateTables(db)
        const runValue = yield* seedActiveRun(db, { targetReader: "4", targetWriter: "4" })

        const outcome = yield* DatabaseMigration.apply(db, { readerProtocol: "3", writerProtocol: "3" }).pipe(Effect.exit)
        expect(outcome._tag).toBe("Failure")
        // Non-mutating: the run is NOT routed to recovery_required; left for a capable binary.
        const loaded = yield* DatabaseUpgradeRun.loadRun(db, runValue.runId)
        expect(loaded!.state).toBe("applying")
        expect(loaded!.failureCode).toBeUndefined()
      }),
    )
  })
})
