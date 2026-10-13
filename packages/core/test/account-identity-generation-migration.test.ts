import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@deepagent-code/effect-drizzle-sqlite"
import { Effect, Exit } from "effect"
import { sql } from "drizzle-orm"
import { DatabaseMigration } from "../src/database/migration"
import { migrations } from "../src/database/migration.gen"

const boundary = migrations.findIndex((item) => item.id === "20261007064020_account_identity_generation")
const accountMigrations = migrations.slice(0, boundary + 1)
const makeDb = EffectDrizzleSqlite.makeWithDefaults()
type Db = Effect.Success<typeof makeDb>

const seed = (db: Db) => Effect.gen(function* () {
  yield* db.run(sql`INSERT INTO account
    (id,email,url,access_token,refresh_token,token_expiry,time_created,time_updated)
    VALUES ('account-migration','fixture@example.invalid','https://fixture.example.invalid','fixture-access','fixture-refresh',42,1,2)`)
  yield* db.run(sql`INSERT INTO account_state (id,active_account_id,active_org_id)
    VALUES (1,'account-migration','fixture-org')`)
  yield* db.run(sql`CREATE TABLE account_migration_reference (
    id TEXT PRIMARY KEY, account_id TEXT REFERENCES account(id) ON DELETE SET NULL)`)
  yield* db.run(sql`INSERT INTO account_migration_reference VALUES ('reference','account-migration')`)
})

const oldRows = (db: Db) => Effect.all({
  account: db.all(sql`SELECT id,email,url,access_token,refresh_token,token_expiry,time_created,time_updated FROM account ORDER BY id`),
  state: db.all(sql`SELECT id,active_account_id,active_org_id FROM account_state ORDER BY id`),
  references: db.all(sql`SELECT * FROM account_migration_reference ORDER BY id`),
})

const snapshot = (db: Db) => Effect.all({
  schema: db.all(sql`SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name`),
  migrations: db.all(sql`SELECT * FROM migration ORDER BY id`),
  rows: oldRows(db),
})

test("populated 220 to 221 preserves active account and SET NULL references across reopen and reapply", async () => {
  expect(boundary).toBe(220)
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dac-account-identity-migration-"))
  const filename = path.join(directory, "database.sqlite")
  try {
    const before = await Effect.runPromise(Effect.gen(function* () {
      const db = yield* makeDb
      yield* db.run(sql`PRAGMA foreign_keys=ON`)
      yield* DatabaseMigration.applyOnly(db, accountMigrations.slice(0, -1))
      yield* seed(db)
      return yield* oldRows(db)
    }).pipe(Effect.provide(SqliteClient.layer({ filename })), Effect.scoped))
    const identity = await fs.stat(filename)
    const first = await Effect.runPromise(Effect.gen(function* () {
      const db = yield* makeDb
      yield* db.run(sql`PRAGMA foreign_keys=ON`)
      yield* DatabaseMigration.applyOnly(db, accountMigrations)
      expect(yield* oldRows(db)).toEqual(before)
      expect(yield* db.all(sql`SELECT identity_generation FROM account`)).toEqual([{ identity_generation: null }])
      expect(yield* db.all(sql`SELECT selection_revision FROM account_state`)).toEqual([{ selection_revision: 0 }])
      expect(yield* db.all(sql`PRAGMA foreign_keys`)).toEqual([{ foreign_keys: 1 }])
      expect(yield* db.all(sql`PRAGMA foreign_key_check`)).toEqual([])
      expect(yield* db.all(sql`PRAGMA quick_check`)).toEqual([{ quick_check: "ok" }])
      return yield* snapshot(db)
    }).pipe(Effect.provide(SqliteClient.layer({ filename })), Effect.scoped))
    const reopened = await Effect.runPromise(Effect.gen(function* () {
      const db = yield* makeDb
      yield* db.run(sql`PRAGMA foreign_keys=ON`)
      yield* DatabaseMigration.applyOnly(db, accountMigrations)
      return yield* snapshot(db)
    }).pipe(Effect.provide(SqliteClient.layer({ filename })), Effect.scoped))
    expect(reopened).toEqual(first)
    const after = await fs.stat(filename)
    expect({ dev: after.dev, ino: after.ino }).toEqual({ dev: identity.dev, ino: identity.ino })
  } finally {
    await fs.rm(directory, { recursive: true })
  }
})

test("physical generation and selection revision constraints reject malformed values without losing legacy rows", async () => {
  await Effect.runPromise(Effect.gen(function* () {
    const db = yield* makeDb
    yield* db.run(sql`PRAGMA foreign_keys=ON`)
    yield* DatabaseMigration.applyOnly(db, accountMigrations)
    yield* seed(db)
    const before = yield* oldRows(db)
    for (const value of ["", "a".repeat(63), "A".repeat(64), "中".repeat(64), new Uint8Array(64)]) {
      expect(Exit.isFailure(yield* Effect.exit(db.run(sql`UPDATE account SET identity_generation=${value}`)))).toBe(true)
    }
    for (const value of [null, -1, 0.5, 9007199254740992, "bad", new Uint8Array([1])]) {
      expect(Exit.isFailure(yield* Effect.exit(db.run(sql`UPDATE account_state SET selection_revision=${value}`)))).toBe(true)
    }
    yield* db.run(sql`UPDATE account SET identity_generation=${"a".repeat(64)}`)
    yield* db.run(sql`UPDATE account_state SET selection_revision=9007199254740991`)
    expect(yield* db.all(sql`SELECT identity_generation FROM account`)).toEqual([{ identity_generation: "a".repeat(64) }])
    expect(yield* db.all(sql`SELECT selection_revision FROM account_state`)).toEqual([{ selection_revision: 9007199254740991 }])
    yield* db.run(sql`UPDATE account SET identity_generation=NULL`)
    expect(yield* oldRows(db)).toEqual(before)
    expect(yield* db.all(sql`PRAGMA foreign_key_check`)).toEqual([])
  }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" })), Effect.scoped))
})

test("failure after the actual forward DDL rolls back both new columns and its journal row", async () => {
  await Effect.runPromise(Effect.gen(function* () {
    const db = yield* makeDb
    yield* db.run(sql`PRAGMA foreign_keys=ON`)
    yield* DatabaseMigration.applyOnly(db, accountMigrations.slice(0, -1))
    yield* seed(db)
    const before = yield* snapshot(db)
    const result = yield* Effect.exit(DatabaseMigration.applyOnly(db, [
      ...accountMigrations.slice(0, -1),
      { ...accountMigrations[boundary], up: (tx) => Effect.gen(function* () {
        yield* accountMigrations[boundary].up(tx)
        expect(yield* tx.all(sql`SELECT identity_generation FROM account`)).toEqual([{ identity_generation: null }])
        expect(yield* tx.all(sql`SELECT selection_revision FROM account_state`)).toEqual([{ selection_revision: 0 }])
        return yield* tx.run("SELECT * FROM account_table_does_not_exist")
      }) },
    ]))
    expect(Exit.isFailure(result)).toBe(true)
    expect(yield* snapshot(db)).toEqual(before)
    expect(yield* db.all(sql`PRAGMA foreign_keys`)).toEqual([{ foreign_keys: 1 }])
  }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" })), Effect.scoped))
})
