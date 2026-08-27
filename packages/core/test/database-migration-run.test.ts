import { describe, expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@deepagent-code/effect-drizzle-sqlite"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { DatabaseMigration } from "@deepagent-code/core/database/migration"
import { migrations } from "@deepagent-code/core/database/migration.gen"
import type { SqlClient as SqlClientService } from "effect/unstable/sql/SqlClient"

const run = <A, E>(effect: Effect.Effect<A, E, SqlClientService>) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
  )

const makeDb = EffectDrizzleSqlite.makeWithDefaults()

describe("DatabaseMigration upgrade run integration", () => {
  test("apply creates a content-addressed receipt per migration and reaches ready", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        const run = yield* DatabaseMigration.apply(db)
        expect(run).not.toBeUndefined()
        expect(run!.state).toBe("ready")
        const runs = yield* db.all(sql`SELECT state, applied_ordinal, total_migrations FROM database_upgrade_run`)
        expect(runs).toHaveLength(1)
        expect(runs[0]).toEqual({ state: "ready", applied_ordinal: migrations.length, total_migrations: migrations.length })
        const count = yield* db.get<{ count: number }>(sql`SELECT count(*) AS count FROM database_migration_receipt`)
        expect(count!.count).toBe(migrations.length)
        const receipts = yield* db.all<{
          receipt_id: string
          content_hash: string
          body_hash: string
          ordinal: number
          run_id: string
          result: string
        }>(sql`SELECT receipt_id, content_hash, body_hash, ordinal, run_id, result FROM database_migration_receipt ORDER BY ordinal`)
        expect(receipts).toHaveLength(migrations.length)
        expect(receipts.every((receipt) => receipt.receipt_id.length === 64)).toBe(true)
        expect(receipts.every((receipt) => receipt.content_hash.length === 64)).toBe(true)
        expect(receipts.every((receipt) => receipt.body_hash.length === 64)).toBe(true)
        expect(receipts.every((receipt) => receipt.ordinal >= 1)).toBe(true)
        expect(receipts.every((receipt) => receipt.result === "applied")).toBe(true)
        // The run row still exists (ready), so the receipt FK is satisfied.
        expect(yield* db.all(sql`PRAGMA foreign_key_check`)).toEqual([])
      }),
    )
  })

  test("reapplying is a no-op and does not create a second run", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* DatabaseMigration.apply(db)
        const beforeRun = yield* db.get<{ count: number }>(sql`SELECT count(*) AS count FROM database_upgrade_run`)
        const beforeReceipt = yield* db.get<{ count: number }>(sql`SELECT count(*) AS count FROM database_migration_receipt`)
        const second = yield* DatabaseMigration.apply(db)
        expect(second).toBeUndefined()
        expect(yield* db.get<{ count: number }>(sql`SELECT count(*) AS count FROM database_upgrade_run`)).toEqual(beforeRun)
        expect(yield* db.get<{ count: number }>(sql`SELECT count(*) AS count FROM database_migration_receipt`)).toEqual(beforeReceipt)
      }),
    )
  })

  test("a migration body is never skipped by the legacy env var", async () => {
    const previous = process.env.DEEPAGENT_CODE_SKIP_MIGRATIONS
    process.env.DEEPAGENT_CODE_SKIP_MIGRATIONS = "1"
    try {
      await run(
        Effect.gen(function* () {
          const db = yield* makeDb
          const marker = {
            id: "skip-marker",
            up: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => tx.run(sql`CREATE TABLE skip_marker (id TEXT PRIMARY KEY)`),
          }
          yield* DatabaseMigration.applyOnly(db, [marker])
          // The body ran despite the env var being set — a skipped migration is illegal.
          expect(yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'skip_marker'`)).toEqual({ name: "skip_marker" })
        }),
      )
    } finally {
      if (previous === undefined) delete process.env.DEEPAGENT_CODE_SKIP_MIGRATIONS
      else process.env.DEEPAGENT_CODE_SKIP_MIGRATIONS = previous
    }
  })
})
