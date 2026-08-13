export * as DatabaseMigration from "./migration"

import { sql } from "drizzle-orm"
import { Effect, Semaphore } from "effect"
import type { EffectDrizzleSqlite } from "@deepagent-code/effect-drizzle-sqlite"
import { migrations } from "./migration.gen"

type Database = EffectDrizzleSqlite.EffectSQLiteDatabase
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0]
const lock = Semaphore.makeUnsafe(1)
const historicalAliases = new Map([["20260530232709_lovely_romulus", "20260511173437_session-metadata"]])

export type Migration = {
  id: string
  up: (tx: Transaction) => Effect.Effect<void, unknown>
}

export function apply(db: Database) {
  return lock.withPermit(applyMigrations(db, migrations, true))
}

export function applyOnly(db: Database, input: Migration[]) {
  return applyMigrations(db, input, false)
}

function applyMigrations(db: Database, input: Migration[], requireLinearHistory: boolean) {
  return Effect.gen(function* () {
    const duplicate = input.find(
      (migration, index) => input.findIndex((candidate) => candidate.id === migration.id) !== index,
    )
    if (duplicate) return yield* Effect.die(new Error(`duplicate database migration id: ${duplicate.id}`))
    yield* db.run(
      sql`CREATE TABLE IF NOT EXISTS ${sql.identifier("migration")} (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)`,
    )
    let completed = new Set(
      (yield* db.all<{ id: string }>(sql`SELECT id FROM ${sql.identifier("migration")}`)).map((row) => row.id),
    )
    if (completed.size === 0) {
      // Existing installs used Drizzle's migration journal. Seed the new
      // journal once so TypeScript migrations don't replay old SQL.
      if (
        yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${"__drizzle_migrations"}`)
      ) {
        yield* db.run(sql`
          INSERT OR IGNORE INTO ${sql.identifier("migration")} (id, time_completed)
          SELECT name, ${Date.now()}
          FROM ${sql.identifier("__drizzle_migrations")}
          WHERE name IS NOT NULL
        `)
        completed = new Set(
          (yield* db.all<{ id: string }>(sql`SELECT id FROM ${sql.identifier("migration")}`)).map((row) => row.id),
        )
      }
    }

    if (requireLinearHistory) {
      const known = new Set(input.map((migration) => migration.id))
      for (const [alias, canonical] of historicalAliases) {
        if (completed.has(alias) && known.has(canonical)) completed.add(canonical)
      }
      const unknown = [...completed].filter((id) => !known.has(id) && !historicalAliases.has(id)).sort()
      if (unknown.length > 0)
        return yield* Effect.die(
          new Error(`database migration history belongs to an incompatible lineage: ${unknown.join(", ")}`),
        )
      const firstMissing = input.findIndex((migration) => !completed.has(migration.id))
      const gap = firstMissing < 0 ? undefined : input.slice(firstMissing + 1).find((migration) => completed.has(migration.id))
      if (gap)
        return yield* Effect.die(
          new Error(`database migration history has a gap before ${gap.id}: ${input[firstMissing]!.id} is missing`),
        )
    }

    for (const migration of input) {
      if (completed.has(migration.id)) continue
      yield* db.transaction((tx) =>
        Effect.gen(function* () {
          if (!process.env.DEEPAGENT_CODE_SKIP_MIGRATIONS) yield* migration.up(tx)
          yield* tx.run(
            sql`INSERT INTO ${sql.identifier("migration")} (id, time_completed) VALUES (${migration.id}, ${Date.now()})`,
          )
        }),
      )
    }
  })
}
