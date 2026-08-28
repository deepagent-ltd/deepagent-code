import { describe, expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@deepagent-code/effect-drizzle-sqlite"
import { DataIntegrity } from "@deepagent-code/core/database/data-integrity"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import type { SqlClient as SqlClientService } from "effect/unstable/sql/SqlClient"

const run = <A, E>(effect: Effect.Effect<A, E, SqlClientService>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })),
      Effect.scoped,
    ),
  )

const setup = Effect.gen(function* () {
  const db = yield* EffectDrizzleSqlite.makeWithDefaults()
  yield* db.run(sql`PRAGMA foreign_keys = ON`)
  yield* db.run(sql`CREATE TABLE parent (id TEXT PRIMARY KEY)`)
  yield* db.run(sql`CREATE TABLE child (id TEXT PRIMARY KEY, parent_id TEXT REFERENCES parent(id))`)
  yield* db.run(sql`INSERT INTO parent VALUES ('p-1')`)
  yield* db.run(sql`INSERT INTO child VALUES ('c-1', 'p-1')`)
  return db
})

describe("DataIntegrity oracle", () => {
  test("passes a clean foreign-key graph", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* setup
        const verdict = yield* DataIntegrity.check(db)
        expect(verdict).toEqual({ ok: true, quickCheck: "ok", foreignKeyCount: 0 })
      }),
    )
  })

  test("reports every orphaned foreign-key reference", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* setup
        yield* db.run(sql`PRAGMA foreign_keys = OFF`)
        yield* db.run(sql`INSERT INTO child VALUES ('c-2', 'missing-parent')`)
        yield* db.run(sql`PRAGMA foreign_keys = ON`)
        const verdict = yield* DataIntegrity.check(db)
        expect(verdict.ok).toBe(false)
        if (!verdict.ok) {
          expect(verdict.reason).toBe("foreign_key_violation")
          const rows = verdict.rows ?? []
          expect(rows.length).toBe(1)
          expect(String(rows[0]?.table)).toContain("child")
        }
      }),
    )
  })
})
