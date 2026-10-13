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

const boundary = migrations.findIndex((item) => item.id === "20261007052936_goal_plan_rebase")
const rebaseMigrations = migrations.slice(0, boundary + 1)
const makeDb = EffectDrizzleSqlite.makeWithDefaults()
type Db = Effect.Success<typeof makeDb>
const hash = "b".repeat(64)
const raw = '{ "version": 2, "program": { "version": 2, "contract":"owned-goal-v2", "roles":[], "documents":[], "localEffectSlots":0, "nextStateBytes":0 }, "programHash":"' + hash + '", "parent":{}, "cursor":{}, "activations":[], "dispositions":[], "results":[], "localEffects":[], "documents":[], "nextState":null, "nextStateHash":null }'
const lineage = { version: 1, planRevision: 1, rebaseID: "edit_fixture", sourceReceiptHash: hash, planDocID: "doc:plan:fixture", planDocVersion: 1, planDocHash: hash, baselineDocsHash: hash }
const v3 = (changes = {}) => JSON.stringify({ ...JSON.parse(raw), version: 3, program: { ...JSON.parse(raw).program, version: 3, planLineage: { ...lineage, ...changes } } })

const seed = (db: Db) => Effect.gen(function* () {
  yield* db.run(sql`PRAGMA foreign_keys=ON`)
  yield* db.run(sql`INSERT INTO goal_control
    (goal_id,session_id,is_current,plan_doc_id,project_id,directory,driver_mode,initialization,initialization_hash,preparation,revision,requested_phase,next_seq,plan_version,created_at,updated_at)
    VALUES('rebase-goal','rebase-session',1,'rebase-plan','rebase-project','/fixture','event','{"version":1,"original":"中文\\n"}',${hash},'ready',0,'paused',0,0,1,1)`)
  yield* db.run(sql`INSERT INTO goal_tick_permit
    (permit_id,goal_id,tick_seq,control_revision,plan_version,owner_id,token,state,child_sessions,interrupt_state,created_at)
    VALUES('rebase-permit','rebase-goal',0,0,0,'rebase-owner','rebase-token','issued','[]','none',1)`)
  yield* db.run(sql`INSERT INTO goal_tick_checkpoint
    (permit_id,goal_id,tick_seq,version,revision,binding_hash,role_manifest_hash,parent_checked_through_seq,state,journal,journal_hash,logical_bytes,reserved_bytes,created_at,updated_at)
    VALUES('rebase-permit','rebase-goal',0,2,0,${hash},${hash},0,'prepared',${raw},${hash},${Buffer.byteLength(raw)},1048576,1,1)`)
  yield* db.run(sql`INSERT INTO goal_control_command
    (command_id,session_id,goal_id,request_id,request_hash,action,revision,receipt,wake_state,wake_key,tick_seq,plan_version,publish_attempts,created_at,updated_at)
    VALUES('rebase-old-command','rebase-session','rebase-goal','rebase-old-request',${hash},'pause',0,'{ "version": 1, "original": "中文" }','none','rebase-wake',0,0,0,1,1)`)
})

// Physical migration oracle only: these fixtures never authorize a Goal tick or plan mutation.
const existing = (db: Db) => Effect.all({
  goals: db.all(sql`SELECT goal_id,session_id,is_current,plan_doc_id,project_id,directory,workspace_id,driver_mode,initialization,initialization_hash,preparation,revision,requested_phase,observed_phase,next_seq,plan_version,recovery_reason,created_at,updated_at FROM goal_control`),
  permits: db.all(sql`SELECT * FROM goal_tick_permit`),
  checkpoints: db.all(sql`SELECT * FROM goal_tick_checkpoint`),
  commands: db.all(sql`SELECT * FROM goal_control_command`),
})
const snapshot = (db: Db) => Effect.all({
  rows: existing(db),
  schema: db.all(sql`SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name`),
  migrations: db.all(sql`SELECT * FROM migration ORDER BY id`),
  foreignKeys: db.all(sql`PRAGMA foreign_key_check`),
  integrity: db.all(sql`PRAGMA quick_check`),
})

test("219 to 220 same-file preserves raw v2 journals and command receipts with FK-safe reapply", async () => {
  expect(boundary).toBe(219)
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dac-rebase-migration-"))
  const filename = path.join(root, "database.sqlite")
  const before = await Effect.runPromise(Effect.gen(function* () {
    const db = yield* makeDb
    yield* DatabaseMigration.applyOnly(db, rebaseMigrations.slice(0, -1))
    yield* seed(db)
    return yield* existing(db)
  }).pipe(Effect.provide(SqliteClient.layer({ filename })), Effect.scoped))
  const identity = await fs.stat(filename)
  const first = await Effect.runPromise(Effect.gen(function* () {
    const db = yield* makeDb
    yield* db.run(sql`PRAGMA foreign_keys=ON`)
    yield* DatabaseMigration.applyOnly(db, rebaseMigrations)
    expect(yield* existing(db)).toEqual(before)
    expect(yield* db.get(sql`SELECT plan_revision,plan_rebase_id,pending_rebase_id FROM goal_control`)).toEqual({ plan_revision: 0, plan_rebase_id: null, pending_rebase_id: null })
    return yield* snapshot(db)
  }).pipe(Effect.provide(SqliteClient.layer({ filename })), Effect.scoped))
  const reopened = await Effect.runPromise(Effect.gen(function* () {
    const db = yield* makeDb
    yield* db.run(sql`PRAGMA foreign_keys=ON`)
    yield* DatabaseMigration.applyOnly(db, rebaseMigrations)
    return yield* snapshot(db)
  }).pipe(Effect.provide(SqliteClient.layer({ filename })), Effect.scoped))
  expect(reopened).toEqual(first)
  expect(first.foreignKeys).toEqual([])
  expect(first.integrity).toEqual([{ quick_check: "ok" }])
  const after = await fs.stat(filename)
  expect({ dev: after.dev, ino: after.ino }).toEqual({ dev: identity.dev, ino: identity.ino })
  await fs.rm(root, { recursive: true })
})

test("physical rebase journal refuses missing minimum fields, NULL identity and capacity overflow", () => Effect.runPromise(Effect.gen(function* () {
  const db = yield* makeDb
  yield* DatabaseMigration.applyOnly(db, rebaseMigrations)
  yield* seed(db)
  const record = { edit_id: "edit_fixture", goal_id: "rebase-goal", session_id: "rebase-session", version: 1, revision: 0, state: "ready", source_plan_revision: 0, target_plan_revision: 1, source_control_revision: 0, expected_control_revision: 0, source_receipt_hash: hash, journal: '{"version":1,"documents":[],"commands":[{}]}', journal_hash: hash, logical_bytes: 0, reserved_bytes: 1048576, created_at: 1, updated_at: 1 }
  for (const changes of [
    { edit_id: null }, { edit_id: "edit/invalid" }, { goal_id: "中".repeat(171) },
    { journal: '{"version":1,"documents":[]}' }, { journal: '{"version":1,"commands":[{}]}' },
    { journal: '{"version":null,"documents":[],"commands":[{}]}' },
    { journal: '{"version":1,"documents":[],"commands":[]}' },
    { journal: JSON.stringify({ version: 1, documents: [], commands: Array(33).fill({}) }) },
    { journal: "{" }, { journal: JSON.stringify({ version: 1, documents: [], commands: [{}], overflow: "中".repeat(349526) }) },
    { target_plan_revision: 2 }, { expected_control_revision: -1 }, { created_at: -1 },
    { updated_at: 0 }, { journal_hash: "B".repeat(64) }, { reserved_bytes: 0 },
  ]) {
    const row = { ...record, ...changes }
    row.logical_bytes = Buffer.byteLength(row.journal)
    expect(Exit.isFailure(yield* db.run(sql`INSERT INTO goal_plan_rebase
      (${sql.join(Object.keys(row).map((key) => sql.identifier(key)), sql`,`)})
      VALUES(${sql.join(Object.values(row).map((value) => sql`${value}`), sql`,`)})`).pipe(Effect.exit))).toBe(true)
  }
  record.logical_bytes = Buffer.byteLength(record.journal)
  yield* db.run(sql`INSERT INTO goal_plan_rebase
    (${sql.join(Object.keys(record).map((key) => sql.identifier(key)), sql`,`)})
    VALUES(${sql.join(Object.values(record).map((value) => sql`${value}`), sql`,`)})`)
  expect(yield* db.get(sql`SELECT COUNT(*) AS count FROM goal_plan_rebase`)).toEqual({ count: 1 })
}).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" })), Effect.scoped)))

test("v3 checkpoint requires typed bounded lineage and old v2 raw journal remains unchanged", () => Effect.runPromise(Effect.gen(function* () {
  const db = yield* makeDb
  yield* DatabaseMigration.applyOnly(db, rebaseMigrations)
  yield* seed(db)
  expect(yield* db.get(sql`SELECT journal FROM goal_tick_checkpoint`)).toEqual({ journal: raw })
  for (const value of [
    JSON.stringify({ ...JSON.parse(raw), version: 3, program: { ...JSON.parse(raw).program, version: 3 } }),
    v3({ version: null }), v3({ planRevision: -1 }), v3({ rebaseID: "../bad" }),
    v3({ sourceReceiptHash: "B".repeat(64) }), v3({ planDocVersion: 0 }),
    v3({ baselineDocsHash: null }), v3({ planDocID: "中".repeat(43) }),
  ]) {
    expect(Exit.isFailure(yield* db.run(sql`UPDATE goal_tick_checkpoint SET version=3,journal=${value},logical_bytes=${Buffer.byteLength(value)}`).pipe(Effect.exit))).toBe(true)
    expect(yield* db.get(sql`SELECT version,journal FROM goal_tick_checkpoint`)).toEqual({ version: 2, journal: raw })
  }
  yield* db.run(sql`UPDATE goal_tick_checkpoint SET version=3,journal=${v3()},logical_bytes=${Buffer.byteLength(v3())}`)
  expect(yield* db.get(sql`SELECT version FROM goal_tick_checkpoint`)).toEqual({ version: 3 })
}).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" })), Effect.scoped)))

test("late rebase DDL failure rolls back schema, FKs and all raw business rows", () => Effect.runPromise(Effect.gen(function* () {
  const db = yield* makeDb
  yield* DatabaseMigration.applyOnly(db, rebaseMigrations.slice(0, -1))
  yield* seed(db)
  const before = yield* snapshot(db)
  const successor = rebaseMigrations[boundary]!
  const failing = { ...successor, up: (tx: Parameters<DatabaseMigration.Migration["up"]>[0]) => successor.up(tx).pipe(Effect.andThen(tx.run("CREATE INDEX goal_plan_rebase_active_idx ON goal_plan_rebase(goal_id)"))) }
  expect(Exit.isFailure(yield* DatabaseMigration.applyOnly(db, [...rebaseMigrations.slice(0, -1), failing]).pipe(Effect.exit))).toBe(true)
  expect(yield* snapshot(db)).toEqual(before)
  expect(yield* db.get(sql`PRAGMA foreign_keys`)).toEqual({ foreign_keys: 1 })
  expect(yield* db.get(sql`PRAGMA defer_foreign_keys`)).toEqual({ defer_foreign_keys: 0 })
}).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" })), Effect.scoped)))

test("unsafe incoming cascade refuses before DDL and preserves the referenced Goal", () => Effect.runPromise(Effect.gen(function* () {
  const db = yield* makeDb
  yield* DatabaseMigration.applyOnly(db, rebaseMigrations.slice(0, -1))
  yield* seed(db)
  yield* db.run(sql`CREATE TABLE custom_goal_reference (id TEXT PRIMARY KEY, goal_id TEXT REFERENCES goal_control(goal_id) ON DELETE CASCADE)`)
  yield* db.run(sql`INSERT INTO custom_goal_reference VALUES('custom','rebase-goal')`)
  const before = yield* snapshot(db)
  expect(Exit.isFailure(yield* DatabaseMigration.applyOnly(db, rebaseMigrations).pipe(Effect.exit))).toBe(true)
  expect(yield* snapshot(db)).toEqual(before)
  expect(yield* db.get(sql`SELECT * FROM custom_goal_reference`)).toEqual({ id: "custom", goal_id: "rebase-goal" })
  expect(yield* db.get(sql`PRAGMA foreign_keys`)).toEqual({ foreign_keys: 1 })
  expect(yield* db.get(sql`PRAGMA defer_foreign_keys`)).toEqual({ defer_foreign_keys: 0 })
}).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" })), Effect.scoped)))

test("post-DDL foreign key corruption refuses and restores every original schema/data row", () => Effect.runPromise(Effect.gen(function* () {
  const db = yield* makeDb
  yield* DatabaseMigration.applyOnly(db, rebaseMigrations.slice(0, -1))
  yield* seed(db)
  const before = yield* snapshot(db)
  const successor = rebaseMigrations[boundary]!
  const corrupt = { ...successor, up: (tx: Parameters<DatabaseMigration.Migration["up"]>[0]) => successor.up(tx).pipe(Effect.andThen(tx.run("UPDATE goal_tick_permit SET goal_id='missing-parent' WHERE permit_id='rebase-permit'"))) }
  expect(Exit.isFailure(yield* DatabaseMigration.applyOnly(db, [...rebaseMigrations.slice(0, -1), corrupt]).pipe(Effect.exit))).toBe(true)
  expect(yield* snapshot(db)).toEqual(before)
  expect(yield* db.get(sql`PRAGMA foreign_keys`)).toEqual({ foreign_keys: 1 })
  expect(yield* db.get(sql`PRAGMA defer_foreign_keys`)).toEqual({ defer_foreign_keys: 0 })
}).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" })), Effect.scoped)))
