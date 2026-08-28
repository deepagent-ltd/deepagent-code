// C1A-16 fixture child (two-process migration LEASE, A2/C1A-05). A PRODUCTION-FREE
// harness child that acquires the fenced migration lease (OS directory lock + DB lease
// with owner/generation/expiry) on a real temp DB and HOLDS it, printing HARNESS_READY
// and sleeping. A parent migrator running apply() against the same DB sees a live,
// non-stale lease and must REFUSE (bounded timeout -> LeaseTimeout) rather than run DDL
// concurrently — no double DDL. Killed or released, the lease is recoverable.
//
// Usage: bun run fixture-child-lease-holder.ts -- <dbPath>

import { join } from "node:path"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@deepagent-code/effect-drizzle-sqlite"
import { DatabaseUpgradeRun } from "@deepagent-code/core/database/upgrade-run"
import { DatabaseMigrationLease } from "@deepagent-code/core/database/migration-lease"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import type { SqlClient as SqlClientService } from "effect/unstable/sql/SqlClient"

const dbPath = process.argv[2]!
const sleepMs = Number(process.env.CRASH_SLEEP_MS ?? "5000")

const makeDb = EffectDrizzleSqlite.makeWithDefaults()
const run = <A, E>(effect: Effect.Effect<A, E, SqlClientService>) =>
  Effect.runPromise(effect.pipe(Effect.provide(SqliteClient.layer({ filename: dbPath })), Effect.scoped))

type Db = EffectDrizzleSqlite.EffectSQLiteDatabase

await run(
  Effect.gen(function* () {
    const db = yield* makeDb
    yield* db.run("PRAGMA foreign_keys = ON")
    yield* db.run("PRAGMA journal_mode = WAL")
    yield* db.run("PRAGMA synchronous = FULL")
    yield* DatabaseUpgradeRun.ensureTables(db)
    yield* DatabaseMigrationLease.ensureTables(db)
    yield* db.run(sql`CREATE TABLE IF NOT EXISTS migration (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)`)
    // Acquire and HOLD the fenced migration lease; create the OS lock dir beside the DB.
    yield* DatabaseMigrationLease.acquire(
      db,
      { leaseMs: 60_000, staleMs: 60_000, timeoutMs: 2_000 },
      dbPath,
    )
    console.log("HARNESS_READY")
    // Hold the lease + OS lock for the whole window; release/refresh keeps it alive.
    yield* Effect.sleep(sleepMs)
  }),
)
