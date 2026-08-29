import { describe, expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@deepagent-code/effect-drizzle-sqlite"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { DatabaseUpgradeRun } from "@deepagent-code/core/database/upgrade-run"
import type { SqlClient as SqlClientService } from "effect/unstable/sql/SqlClient"

const run = <A, E>(effect: Effect.Effect<A, E, SqlClientService>) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
  )

const makeDb = EffectDrizzleSqlite.makeWithDefaults()

const runInput = () => ({
  sourceRegistryDigest: "source-digest",
  targetRegistryDigest: "target-digest",
  sourceProtocol: { reader: "2", writer: "2" },
  targetProtocol: { reader: "3", writer: "3" },
  buildIdentity: "build-1",
  packageVersion: "2.0.0-alpha.0",
  pendingMigrationIds: ["migration-a", "migration-b"],
  totalMigrations: 2,
})

describe("DatabaseUpgradeRun", () => {
  test("begins a run in planned and loads it back", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* DatabaseUpgradeRun.ensureTables(db)
        const runValue = yield* DatabaseUpgradeRun.beginRun(db, runInput())
        expect(runValue.state).toBe("planned")
        expect(runValue.appliedOrdinal).toBe(0)
        expect(runValue.totalMigrations).toBe(2)
        const loaded = yield* DatabaseUpgradeRun.loadRun(db, runValue.runId)
        expect(loaded).not.toBeUndefined()
        expect(loaded!.state).toBe("planned")
        expect(loaded!.targetRegistryDigest).toBe("target-digest")
      }),
    )
  })

  test("enforces the frozen allowed transitions", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* DatabaseUpgradeRun.ensureTables(db)
        const runValue = yield* DatabaseUpgradeRun.beginRun(db, runInput())
        const runId = runValue.runId

        // planned -> applying is not allowed under the frozen contract.
        const illegal = yield* DatabaseUpgradeRun.advanceRun(db, runId, "applying").pipe(Effect.exit)
        expect(illegal._tag).toBe("Failure")
        expect(String(illegal)).toContain("InvalidTransitionError")

        yield* DatabaseUpgradeRun.advanceRun(db, runId, "backup_verified")
        yield* DatabaseUpgradeRun.advanceRun(db, runId, "applying")
        yield* DatabaseUpgradeRun.advanceRun(db, runId, "verifying")
        yield* DatabaseUpgradeRun.advanceRun(db, runId, "ready")

        // ready is terminal.
        const terminal = yield* DatabaseUpgradeRun.advanceRun(db, runId, "recovery_required").pipe(Effect.exit)
        expect(terminal._tag).toBe("Failure")
        expect(String(terminal)).toContain("already terminal")
      }),
    )
  })

  test("records a content-addressed receipt with immutable identity", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* DatabaseUpgradeRun.ensureTables(db)
        const runValue = yield* DatabaseUpgradeRun.beginRun(db, runInput())
        const runId = runValue.runId
        yield* DatabaseUpgradeRun.advanceRun(db, runId, "backup_verified")
        yield* DatabaseUpgradeRun.advanceRun(db, runId, "applying")

        const cid = DatabaseUpgradeRun.receiptContentAddress({
          runId,
          migrationId: "migration-a",
          contentHash: "c1",
          bodyHash: "b1",
          ordinal: 1,
          buildIdentity: "build-1",
          packageVersion: "2.0.0-alpha.0",
          result: "applied",
          startedAt: 1,
          completedAt: 2,
        })
        expect(cid).toMatch(/^[0-9a-f]{64}$/)

        // Same identity -> same content address; different ordinal -> different address.
        const same = DatabaseUpgradeRun.receiptContentAddress({
          runId,
          migrationId: "migration-a",
          contentHash: "c1",
          bodyHash: "b1",
          ordinal: 1,
          buildIdentity: "build-1",
          packageVersion: "2.0.0-alpha.0",
          result: "applied",
          startedAt: 9,
          completedAt: 9,
        })
        expect(same).toBe(cid)
        const other = DatabaseUpgradeRun.receiptContentAddress({
          runId,
          migrationId: "migration-a",
          contentHash: "c1",
          bodyHash: "b1",
          ordinal: 2,
          buildIdentity: "build-1",
          packageVersion: "2.0.0-alpha.0",
          result: "applied",
          startedAt: 1,
          completedAt: 2,
        })
        expect(other).not.toBe(cid)

        // Write a receipt inside a transaction and verify immutability + run ordinal.
        yield* db.transaction((tx) =>
          Effect.gen(function* () {
            yield* DatabaseUpgradeRun.recordReceipt(tx, {
              runId,
              migrationId: "migration-a",
              contentHash: "c1",
              bodyHash: "b1",
              ordinal: 1,
              buildIdentity: "build-1",
              packageVersion: "2.0.0-alpha.0",
              result: "applied",
              startedAt: 1,
              completedAt: 2,
            })
          }),
        )
        const count = yield* db.get<{ count: number }>(sql`SELECT count(*) AS count FROM database_migration_receipt`)
        expect(count!.count).toBe(1)
        const update = yield* db
          .run(sql`UPDATE database_migration_receipt SET content_hash = 'x' WHERE migration_id = 'migration-a'`)
          .pipe(Effect.exit)
        expect(update._tag).toBe("Failure")
        expect(String(update)).toContain("database_migration_receipt_immutable")
        const updated = yield* db.get<{ content_hash: string }>(sql`SELECT content_hash FROM database_migration_receipt WHERE migration_id = 'migration-a'`)
        expect(updated!.content_hash).toBe("c1")
        const runRow = yield* db.get<{ applied_ordinal: number }>(sql`SELECT applied_ordinal FROM database_upgrade_run WHERE run_id = ${runId}`)
        expect(runRow!.applied_ordinal).toBe(1)
      }),
    )
  })

  test("rejects a skipped migration receipt lacking content identity", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* DatabaseUpgradeRun.ensureTables(db)
        const runValue = yield* DatabaseUpgradeRun.beginRun(db, runInput())
        const runId = runValue.runId
        const result = yield* db
          .transaction((tx) =>
            DatabaseUpgradeRun.recordReceipt(tx, {
              runId,
              migrationId: "migration-a",
              contentHash: "   ",
              bodyHash: "",
              ordinal: 1,
              buildIdentity: "build-1",
              packageVersion: "2.0.0-alpha.0",
              result: "applied",
              startedAt: 1,
              completedAt: 2,
            }),
          )
          .pipe(Effect.exit)
        expect(result._tag).toBe("Failure")
        expect(String(result)).toContain("SkipMigrationError")
        expect(yield* db.get<{ count: number }>(sql`SELECT count(*) AS count FROM database_migration_receipt`)).toEqual({ count: 0 })
      }),
    )
  })

  test("a failure transitions into recovery_required and is terminal", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* DatabaseUpgradeRun.ensureTables(db)
        const runValue = yield* DatabaseUpgradeRun.beginRun(db, runInput())
        const runId = runValue.runId
        yield* DatabaseUpgradeRun.advanceRun(db, runId, "backup_verified")
        yield* DatabaseUpgradeRun.failRun(db, runId, "migration_body_failed")
        const recovered = yield* DatabaseUpgradeRun.loadRun(db, runId)
        expect(recovered!.state).toBe("recovery_required")
        expect(recovered!.failureCode).toBe("migration_body_failed")
        // recovery_required is terminal under the frozen contract.
        const retry = yield* DatabaseUpgradeRun.advanceRun(db, runId, "ready").pipe(Effect.exit)
        expect(retry._tag).toBe("Failure")
        expect(String(retry)).toContain("already terminal")
        const completed = yield* db.get<{ completed_at: number }>(sql`SELECT completed_at FROM database_upgrade_run WHERE run_id = ${runId}`)
        expect(completed!.completed_at).toBe(0)
      }),
    )
  })

  test("migration content hash is deterministic and content-addressed", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        void db
        const first = { id: "migration-a", up: () => Effect.void }
        const second = { id: "migration-a", up: () => Effect.void }
        const changed = { id: "migration-a", up: () => Effect.fail("different") }
        const h1 = DatabaseUpgradeRun.migrationContentHash(first)
        const h2 = DatabaseUpgradeRun.migrationContentHash(second)
        const h3 = DatabaseUpgradeRun.migrationContentHash(changed)
        expect(h1).toBe(h2)
        expect(h1).not.toBe(h3)
        expect(DatabaseUpgradeRun.migrationBodyHash(first)).toBe(DatabaseUpgradeRun.migrationBodyHash(second))
      }),
    )
  })
})
