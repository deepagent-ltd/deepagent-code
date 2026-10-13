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

const boundary = migrations.findIndex((item) => item.id === "20261007015406_goal_tick_program_v2")
// This oracle preserves the historical 216 to 217 boundary as later migrations are appended.
const programMigrations = migrations.slice(0, boundary + 1)
const makeDb = EffectDrizzleSqlite.makeWithDefaults()
type Db = Effect.Success<typeof makeDb>
const hash = "f".repeat(64)
const oldJournal = '{ "version": 1, "fixture": "中文\\n原始" }'
// SQL fixtures prove physical preservation/shape, never actual Goal eligibility or execution.
const journal = () => JSON.stringify({ version: 2, program: { version: 2, contract: "owned-goal-v2", roles: [], documents: [], localEffectSlots: 0, nextStateBytes: 0 }, programHash: hash, parent: {}, cursor: {}, activations: [], dispositions: [], results: [], localEffects: [], documents: [], nextState: null, nextStateHash: null })

const seed = (db: Db) => Effect.gen(function* () {
  yield* db.run(sql`PRAGMA foreign_keys=ON`)
  yield* db.run(sql`INSERT INTO goal_control
    (goal_id,session_id,is_current,plan_doc_id,project_id,directory,driver_mode,initialization,initialization_hash,preparation,revision,requested_phase,next_seq,plan_version,created_at,updated_at)
    VALUES('program-goal','program-parent',1,'program-plan','program-project','/fixture','event','{"version":1}',${hash},'ready',0,'running',0,0,1,1)`)
  yield* db.run(sql`INSERT INTO goal_tick_permit
    (permit_id,goal_id,tick_seq,control_revision,plan_version,owner_id,token,state,child_sessions,interrupt_state,created_at)
    VALUES('program-permit','program-goal',0,0,0,'program-owner','program-token','issued','[]','none',1)`)
  yield* db.run(sql`INSERT INTO goal_tick_checkpoint
    (permit_id,goal_id,tick_seq,version,revision,binding_hash,role_manifest_hash,parent_checked_through_seq,state,journal,journal_hash,logical_bytes,reserved_bytes,created_at,updated_at)
    VALUES('program-permit','program-goal',0,1,3,${hash},${hash},0,'mirror_pending',${oldJournal},${hash},${Buffer.byteLength(oldJournal)},1048576,1,2)`)
})

const snapshot = (db: Db) => Effect.all({
  rows: db.all(sql`SELECT * FROM goal_tick_checkpoint ORDER BY permit_id`),
  goals: db.all(sql`SELECT * FROM goal_control ORDER BY goal_id`),
  permits: db.all(sql`SELECT * FROM goal_tick_permit ORDER BY permit_id`),
  schema: db.all(sql`SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name`),
  migrations: db.all(sql`SELECT * FROM migration ORDER BY id`),
  foreignKeys: db.all(sql`PRAGMA foreign_key_check`),
  integrity: db.all(sql`PRAGMA quick_check`),
})

test("same file 216 to 217 preserves v1 raw bytes, hashes, references and reopen idempotency", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dac-goal-program-migration-"))
  const filename = path.join(directory, "database.sqlite")
  const run = (first: boolean) => Effect.runPromise(Effect.gen(function* () {
    const db = yield* makeDb
    if (first) {
      yield* DatabaseMigration.applyOnly(db, migrations.slice(0, boundary))
      yield* seed(db)
      const original = yield* db.all(sql`SELECT * FROM goal_tick_checkpoint`)
      yield* DatabaseMigration.applyOnly(db, programMigrations)
      expect(yield* db.all(sql`SELECT * FROM goal_tick_checkpoint`)).toEqual(original)
      expect(yield* db.get(sql`PRAGMA foreign_keys`)).toEqual({ foreign_keys: 1 })
    }
    yield* DatabaseMigration.applyOnly(db, programMigrations)
    return yield* snapshot(db)
  }).pipe(Effect.provide(SqliteClient.layer({ filename })), Effect.scoped))
  try {
    const first = await run(true)
    const before = await fs.stat(filename)
    const reopened = await run(false)
    const after = await fs.stat(filename)
    expect(reopened).toEqual(first)
    expect(reopened.migrations).toHaveLength(217)
    expect(reopened.rows[0]).toMatchObject({ journal: oldJournal, journal_hash: hash, version: 1, revision: 3, state: "mirror_pending" })
    expect(reopened.foreignKeys).toEqual([])
    expect(reopened.integrity).toEqual([{ quick_check: "ok" }])
    expect([after.dev, after.ino]).toEqual([before.dev, before.ino])
    if (process.env.DAC_GOAL_PROGRAM_MIGRATION_EVIDENCE)
      await Bun.write(path.join(process.env.DAC_GOAL_PROGRAM_MIGRATION_EVIDENCE, "file-reopen.json"), JSON.stringify({ device: after.dev, inode: after.ino, first, reopened }, null, 2))
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})

test("v2 physical gate rejects missing/null/mismatched shape while v1 remains byte compatible", () => Effect.runPromise(Effect.gen(function* () {
  const db = yield* makeDb
  yield* DatabaseMigration.applyOnly(db, programMigrations)
  yield* seed(db)
  const initial = JSON.parse(journal()) as Record<string, unknown>
  const wrong = ["{}", "[]", "null", "bad", ...Object.keys(initial).map((key) => JSON.stringify(Object.fromEntries(Object.entries(initial).filter(([name]) => name !== key)))), ...Object.keys(initial).filter((key) => !["nextState", "nextStateHash"].includes(key)).map((key) => JSON.stringify({ ...initial, [key]: null })), JSON.stringify({ ...initial, program: { version: 2, contract: "owned-goal-v1" } }), JSON.stringify({ ...initial, version: 2.0, program: { version: 1 } })]
  for (const value of wrong) {
    const update = yield* db.run(sql`UPDATE goal_tick_checkpoint SET version=2,journal=${value},logical_bytes=${Buffer.byteLength(value)} WHERE permit_id='program-permit'`).pipe(Effect.exit)
    expect({ value, rejected: Exit.isFailure(update) }).toEqual({ value, rejected: true })
    expect(yield* db.get(sql`SELECT version,journal FROM goal_tick_checkpoint`)).toEqual({ version: 1, journal: oldJournal })
  }
  const value = journal()
  yield* db.run(sql`UPDATE goal_tick_checkpoint SET version=2,journal=${value},logical_bytes=${Buffer.byteLength(value)} WHERE permit_id='program-permit'`)
  expect(yield* db.get(sql`SELECT version,journal FROM goal_tick_checkpoint`)).toEqual({ version: 2, journal: value })
  expect(Exit.isFailure(yield* db.run(sql`UPDATE goal_tick_checkpoint SET version=3`).pipe(Effect.exit))).toBe(true)
}).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" })), Effect.scoped)))

test("late successor failure restores original table, data, indexes, FKs and migration journal", () => Effect.runPromise(Effect.gen(function* () {
  const db = yield* makeDb
  yield* DatabaseMigration.applyOnly(db, migrations.slice(0, boundary))
  yield* seed(db)
  const before = yield* snapshot(db)
  const successor = migrations[boundary]
  const failing = { ...successor, up: (tx: Parameters<DatabaseMigration.Migration["up"]>[0]) => successor.up(tx).pipe(Effect.andThen(tx.run("CREATE INDEX goal_tick_checkpoint_state_idx ON goal_tick_checkpoint(state)"))) }
  expect(Exit.isFailure(yield* DatabaseMigration.applyOnly(db, [...migrations.slice(0, boundary), failing]).pipe(Effect.exit))).toBe(true)
  expect(yield* snapshot(db)).toEqual(before)
  expect(yield* db.get(sql`PRAGMA foreign_keys`)).toEqual({ foreign_keys: 1 })
}).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" })), Effect.scoped)))
