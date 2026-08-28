import { describe, expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@deepagent-code/effect-drizzle-sqlite"
import { DatabaseMigration } from "@deepagent-code/core/database/migration"
import { migrations } from "../src/database/migration.gen"
import { Data, Effect } from "effect"
import { sql } from "drizzle-orm"
import type { SqlClient as SqlClientService } from "effect/unstable/sql/SqlClient"

// §16.4 DATA-AND-RECOVERY D-3 — migration interruption oracle. Every migration's `up` runs in
// one transaction with its journal insert (migration.ts), so an interruption must leave either
// the full migration or nothing. This oracle proves it for EVERY registry migration: simulate an
// interruption by forcing a rollback after `up` and assert zero leakage (schema objects, row
// counts, journal all unchanged), then apply for real and assert the journal row lands.

class SimulatedInterruption extends Data.TaggedError("MigrationInterruptionOracle.SimulatedInterruption") {}

const run = <A, E>(effect: Effect.Effect<A, E, SqlClientService>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })),
      Effect.scoped,
    ),
  )

type SchemaRow = { type: string; name: string; tbl_name: string; sql: string | null }

const snapshot = (db: EffectDrizzleSqlite.EffectSQLiteDatabase) =>
  Effect.gen(function* () {
    const schema = yield* db.all<SchemaRow>(sql`SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY name`)
    const tables = yield* db.all<{ name: string }>(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
    const counts: Record<string, number> = {}
    for (const table of tables) {
      const row = yield* db.get<{ n: number }>(sql`SELECT COUNT(*) AS n FROM ${sql.identifier(table.name)}`)
      counts[table.name] = row?.n ?? 0
    }
    const journal = yield* db.all<{ id: string }>(sql`SELECT id FROM migration ORDER BY id`)
    return { schema, counts, journal: journal.map((row) => row.id) }
  })

describe("migration interruption oracle", () => {
  test("every migration is atomic: forced rollback leaks nothing, then the real apply lands", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* EffectDrizzleSqlite.makeWithDefaults()
        yield* db.run(sql`PRAGMA foreign_keys = ON`)
        // The journal table is created by applyMigrations on first use; create it up front so the
        // pre-first-migration snapshot can read it.
        yield* db.run(sql`CREATE TABLE migration (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)`)
        for (const migration of migrations) {
          const before = yield* snapshot(db)

          // Simulate an interruption: run `up` inside the real transaction, then fail AFTER the
          // migration body but BEFORE the journal insert. The transaction must roll everything
          // back — schema objects, data rows, and the journal alike.
          const interrupted = yield* db
            .transaction((tx) =>
              Effect.gen(function* () {
                yield* migration.up(tx)
                yield* Effect.fail(new SimulatedInterruption())
              }),
            )
            .pipe(Effect.exit)
          expect(interrupted._tag).toBe("Failure")

          const after = yield* snapshot(db)
          expect(after.schema).toEqual(before.schema)
          expect(after.counts).toEqual(before.counts)
          expect(after.journal).toEqual(before.journal)

          // The real apply must then complete atomically: migration body + journal row together.
          // (Journal ids are read id-sorted; out-of-order merged-history ids mean the newest
          // row is not necessarily the largest id, so assert membership + exactly one new row.)
          yield* DatabaseMigration.applyOnly(db, [migration])
          const landed = yield* snapshot(db)
          expect(landed.journal.includes(migration.id)).toBe(true)
          expect(landed.journal.length).toBe(before.journal.length + 1)
        }
      }),
    )
  })
})
