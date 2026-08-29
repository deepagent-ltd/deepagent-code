import { describe, expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@deepagent-code/effect-drizzle-sqlite"
import { DatabaseUpgradeRun } from "@deepagent-code/core/database/upgrade-run"
import { Backfill } from "@deepagent-code/core/database/backfill"
import { migrations } from "@deepagent-code/core/database/migration.gen"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import path from "node:path"
import { tmpdir } from "./fixture/tmpdir"
import type { SqlClient as SqlClientService } from "effect/unstable/sql/SqlClient"

// C1A-09 batched backfill. A large backfill runs in bounded batches, each in its own transaction,
// with durable per-batch progress, a space budget check before starting, and cancel semantics at
// batch boundaries. A cancelled run stays at a batch boundary; the next call resumes from the next
// batch without re-applying completed batches or duplicating work.

const run = <A, E>(effect: Effect.Effect<A, E, SqlClientService>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })),
      Effect.scoped,
    ),
  )

const makeDb = EffectDrizzleSqlite.makeWithDefaults()

const ensureFixtureTables = (db: EffectDrizzleSqlite.EffectSQLiteDatabase) =>
  Effect.gen(function* () {
    yield* db.run("PRAGMA foreign_keys = ON")
    yield* DatabaseUpgradeRun.ensureTables(db)
    yield* Backfill.ensureTables(db)
    yield* db.run(sql`CREATE TABLE IF NOT EXISTS backfill_target (id INTEGER PRIMARY KEY, filled INTEGER NOT NULL)`)
  })

// A fixed 50-row backfill in batches of 10 (5 batches). Each batch inserts rows [offset, offset+rows)
// into an initially-empty backfill_target (id is the primary key, so a stale re-apply would collide).
const seedTarget = (db: EffectDrizzleSqlite.EffectSQLiteDatabase, total: number) =>
  Effect.gen(function* () {
    void total
    yield* db.run(sql`CREATE TABLE IF NOT EXISTS backfill_target (id INTEGER PRIMARY KEY, filled INTEGER NOT NULL)`)
  })

const makeBackfill = (total: number, cancelToken: { cancelled: boolean } | undefined, onBatch?: () => void) =>
  Effect.gen(function* () {
    const db = yield* makeDb
    yield* DatabaseUpgradeRun.ensureTables(db)
    yield* Backfill.ensureTables(db)
    yield* seedTarget(db, total)
    const runValue = yield* DatabaseUpgradeRun.beginRun(db, {
      sourceRegistryDigest: "source-digest",
      targetRegistryDigest: DatabaseUpgradeRun.registryDigest(migrations),
      sourceProtocol: { reader: "2", writer: "2" },
      targetProtocol: { reader: "3", writer: "3" },
      buildIdentity: "build-1",
      packageVersion: "2.0.0-alpha.0",
      pendingMigrationIds: [],
      totalMigrations: 0,
    })
    yield* DatabaseUpgradeRun.advanceRun(db, runValue.runId, "backup_verified")
    yield* DatabaseUpgradeRun.advanceRun(db, runValue.runId, "applying")
    const input = {
      runId: runValue.runId,
      migrationId: "fixture-backfill",
      batchSize: 10,
      cancelToken,
      nextBatch: (offset: number, batchSize: number) =>
        offset >= total
          ? Effect.succeed(null)
          : Effect.succeed({ offset, rows: Math.min(batchSize, total - offset) }),
      applyBatch: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0], batch: { offset: number; rows: number }) =>
        Effect.gen(function* () {
          onBatch?.()
          for (let i = batch.offset; i < batch.offset + batch.rows; i++)
            yield* tx.run(sql`INSERT INTO backfill_target (id, filled) VALUES (${i}, 1)`).pipe(Effect.orDie)
        }),
    }
    return { db, runValue, input }
  })

describe("Batched backfill (C1A-09)", () => {
  test("runs bounded batches to completion with durable per-batch progress", async () => {
    await run(
      Effect.gen(function* () {
        const { db, input } = yield* makeBackfill(50, undefined)
        const outcome = yield* Backfill.runBatchedBackfill(db, input)
        expect(outcome.cancelled).toBe(false)
        expect(outcome.completedBatches).toBe(5)
        expect(outcome.processedRows).toBe(50)
        // Every target row was inserted exactly once (no duplicates / no gaps).
        const filled = yield* db.get<{ count: number; sum: number }>(
          sql`SELECT count(*) AS count, sum(filled) AS sum FROM backfill_target`,
        )
        expect(filled).toEqual({ count: 50, sum: 50 })
        const progress = yield* db.all<{ batch_index: number; processed_rows: number; state: string }>(
          sql`SELECT batch_index, processed_rows, state FROM database_backfill_progress ORDER BY batch_index`,
        )
        expect(progress).toHaveLength(5)
        expect(progress.every((row) => row.state === "completed")).toBe(true)
        expect(progress.map((row) => row.processed_rows)).toEqual([10, 10, 10, 10, 10])
      }),
    )
  })

  test("space budget check refuses a backfill before any batch runs", async () => {
    // Use a real temp DB file so statfs has a path; an absurd budget guarantees the refusal.
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "bf.db")
    await Bun.write(filename, "")
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        void filename
        yield* DatabaseUpgradeRun.ensureTables(db)
        const runValue = yield* DatabaseUpgradeRun.beginRun(db, {
          sourceRegistryDigest: "s",
          targetRegistryDigest: DatabaseUpgradeRun.registryDigest(migrations),
          sourceProtocol: { reader: "2", writer: "2" },
          targetProtocol: { reader: "3", writer: "3" },
          buildIdentity: "b",
          packageVersion: "v",
          pendingMigrationIds: [],
          totalMigrations: 0,
        })
        const outcome = yield* Backfill.runBatchedBackfill(db, {
          runId: runValue.runId,
          migrationId: "fixture-backfill",
          filename: filename,
          spaceBudgetBytes: Number.MAX_SAFE_INTEGER,
          batchSize: 10,
          nextBatch: () => Effect.succeed({ offset: 0, rows: 10 }),
          applyBatch: (tx, batch) => tx.run(sql`INSERT INTO backfill_target (id, filled) VALUES (0, 1)`).pipe(Effect.orDie),
        }).pipe(Effect.exit)
        expect(outcome._tag).toBe("Failure")
        expect(String(outcome)).toContain("BackfillSpaceBudgetExceeded")
        // No batch ran and no progress row was written.
        expect(yield* db.get<{ count: number }>(sql`SELECT count(*) AS count FROM database_backfill_progress`)).toEqual({
          count: 0,
        })
      }),
    )
  })

  test("cancel stops at a batch boundary; the run stays applying; resume continues the next batch", async () => {
    await run(
      Effect.gen(function* () {
        const cancelToken = { cancelled: false }
        let batchCount = 0
        const { db, runValue, input } = yield* makeBackfill(50, cancelToken, () => {
          batchCount += 1
          if (batchCount === 2) cancelToken.cancelled = true
        })

        const first = yield* Backfill.runBatchedBackfill(db, input)
        expect(first.cancelled).toBe(true)
        // Batches 0 and 1 completed; batch 2 was never started.
        expect(first.completedBatches).toBe(2)
        expect(first.processedRows).toBe(20)
        // The run is untouched by the backfill: still 'applying' (caller decides when to advance).
        const afterFirst = yield* DatabaseUpgradeRun.loadRun(db, runValue.runId)
        expect(afterFirst!.state).toBe("applying")

        // Resume with a fresh (non-cancelled) token: skip completed batches 0,1, continue from batch 2.
        const resumed = yield* Backfill.runBatchedBackfill(db, { ...input, cancelToken: { cancelled: false } })
        expect(resumed.cancelled).toBe(false)
        expect(resumed.completedBatches).toBe(5)
        expect(resumed.processedRows).toBe(50)
        // No duplicate rows (the 50 primary-key inserts never collide) and no row left unfilled.
        const filled = yield* db.get<{ count: number; sum: number }>(
          sql`SELECT count(*) AS count, sum(filled) AS sum FROM backfill_target`,
        )
        expect(filled).toEqual({ count: 50, sum: 50 })
      }),
    )
  })

  test("idempotent resume after completion does not re-apply completed batches", async () => {
    await run(
      Effect.gen(function* () {
        let applyCalls = 0
        const { db, input } = yield* makeBackfill(50, undefined, () => {
          applyCalls += 1
        })
        const first = yield* Backfill.runBatchedBackfill(db, input)
        expect(first.completedBatches).toBe(5)
        // Running again: all batches are already completed, so nothing is re-applied.
        const second = yield* Backfill.runBatchedBackfill(db, input)
        expect(second.cancelled).toBe(false)
        expect(second.completedBatches).toBe(5)
        expect(second.processedRows).toBe(50)
        // The second pass runs no batches at all (all completed), so applyBatch is never re-invoked.
        expect(applyCalls).toBe(5)
        const count = yield* db.get<{ count: number }>(sql`SELECT count(*) AS count FROM backfill_target`)
        expect(count).toEqual({ count: 50 })
      }),
    )
  })
})
