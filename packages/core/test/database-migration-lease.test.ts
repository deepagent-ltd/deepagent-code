import { describe, expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@deepagent-code/effect-drizzle-sqlite"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { DatabaseMigrationLease } from "@deepagent-code/core/database/migration-lease"
import { DatabaseUpgradeRun } from "@deepagent-code/core/database/upgrade-run"
import type { SqlClient as SqlClientService } from "effect/unstable/sql/SqlClient"
import { tmpdir } from "./fixture/tmpdir"
import path from "path"

const makeDb = EffectDrizzleSqlite.makeWithDefaults()

const run = <A, E>(effect: Effect.Effect<A, E, SqlClientService>) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
  )

const runFile = (filename: string) => <A, E>(effect: Effect.Effect<A, E, SqlClientService>) =>
  Effect.runPromise(effect.pipe(Effect.provide(SqliteClient.layer({ filename, disableWAL: true })), Effect.scoped))

describe("DatabaseMigrationLease", () => {
  test("acquires a DB lease with owner/generation/expiry and releases it", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* DatabaseMigrationLease.ensureTables(db)
        const lease = yield* DatabaseMigrationLease.acquire(db, { leaseMs: 5000 })
        expect(lease.token.length).toBeGreaterThan(0)
        expect(lease.generation).toBe(1)
        expect(lease.expiresAt).toBeGreaterThan(Date.now())
        const row = yield* db.get(sql`SELECT owner_token, generation, expires_at FROM database_migration_lease`)
        expect(row).toEqual({ owner_token: lease.token, generation: 1, expires_at: lease.expiresAt })

        yield* lease.release()
        const after = yield* db.get(sql`SELECT owner_token FROM database_migration_lease`)
        expect(after).toBeUndefined()
      }),
    )
  })

  test("only one migrator holds the lease and contention is bounded into a timeout", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "lease.sqlite")
    await runFile(filename)(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* DatabaseMigrationLease.ensureTables(db)
        const first = yield* DatabaseMigrationLease.acquire(db, { staleMs: 60_000 }, filename)
        expect(first.generation).toBe(1)
        const second = yield* DatabaseMigrationLease.acquire(db, { staleMs: 60_000, timeoutMs: 300 }, filename).pipe(
          Effect.exit,
        )
        expect(second._tag).toBe("Failure")
        expect(String(second)).toContain("lease timed out")
        yield* first.release()
      }),
    )
  })

  test("a migrated generation invalidates a stale lease token so it cannot commit a receipt", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* DatabaseMigrationLease.ensureTables(db)
        yield* DatabaseUpgradeRun.ensureTables(db)
        const lease = yield* DatabaseMigrationLease.acquire(db, { leaseMs: 60_000 })
        const runValue = yield* DatabaseUpgradeRun.beginRun(db, {
          sourceRegistryDigest: "s",
          targetRegistryDigest: "t",
          sourceProtocol: { reader: "2", writer: "2" },
          targetProtocol: { reader: "3", writer: "3" },
          buildIdentity: "b",
          packageVersion: "v",
          pendingMigrationIds: ["migration-a"],
          totalMigrations: 1,
        })
        yield* DatabaseUpgradeRun.advanceRun(db, runValue.runId, "backup_verified")
        yield* DatabaseUpgradeRun.advanceRun(db, runValue.runId, "applying")

        // A new owner bumps generation, stealing the lease from the first holder.
        yield* DatabaseMigrationLease.acquireDatabaseLease(db, "other-owner", { leaseMs: 60_000 })

        const receipt = yield* db
          .transaction((tx) =>
            DatabaseUpgradeRun.recordReceipt(tx, {
              runId: runValue.runId,
              migrationId: "migration-a",
              contentHash: "c1",
              bodyHash: "b1",
              ordinal: 1,
              buildIdentity: "b",
              packageVersion: "v",
              result: "applied",
              startedAt: 1,
              completedAt: 2,
            }, lease),
          )
          .pipe(Effect.exit)
        expect(receipt._tag).toBe("Failure")
        expect(String(receipt)).toContain("lease")
        expect(yield* db.get<{ count: number }>(sql`SELECT count(*) AS count FROM database_migration_receipt`)).toEqual({ count: 0 })
      }),
    )
  })

  test("assertCurrent fails when the lease has been transferred or expired", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* DatabaseMigrationLease.ensureTables(db)
        const lease = yield* DatabaseMigrationLease.acquire(db, { leaseMs: 60_000 })
        const ok = yield* db.transaction((tx) => DatabaseMigrationLease.assertCurrent(tx, lease)).pipe(Effect.exit)
        expect(ok._tag).toBe("Success")

        // Transfer to a new owner bumps generation.
        yield* DatabaseMigrationLease.acquireDatabaseLease(db, "new-owner", { leaseMs: 60_000 })
        const transferred = yield* db.transaction((tx) => DatabaseMigrationLease.assertCurrent(tx, lease)).pipe(Effect.exit)
        expect(transferred._tag).toBe("Failure")
        expect(String(transferred)).toContain("lease")
      }),
    )
  })
})
