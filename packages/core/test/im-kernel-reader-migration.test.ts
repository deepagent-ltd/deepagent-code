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

const boundary = migrations.findIndex((item) => item.id === "20261007130332_im_kernel_reader")
const readerMigrations = migrations.slice(0, boundary + 1)
const cutBoundary = migrations.findIndex((item) => item.id === "20261007131555_im_reader_read_cut_lineage")
const cutMigrations = migrations.slice(0, cutBoundary + 1)
const makeDb = EffectDrizzleSqlite.makeWithDefaults()
type Db = Effect.Success<typeof makeDb>
const readerKey = "a".repeat(64)
const bindingKey = "b".repeat(64)
const projectionKey = "c".repeat(64)

const seedOrdinary = (db: Db) => Effect.gen(function* () {
  yield* db.run("INSERT INTO im_groups (id,workspace_id,type,name,created_by,created_at,updated_at) VALUES ('img_ordinary','workspace','project','Ordinary','alice',1,1)")
  yield* db.run("INSERT INTO im_members (group_id,member_id,member_type,role,joined_at) VALUES ('img_ordinary','alice','user','owner',1)")
  yield* db.run("INSERT INTO im_messages (id,group_id,sender_id,sender_type,type,content,created_at,updated_at) VALUES ('imsg_ordinary','img_ordinary','alice','user','text','original local body',1,1)")
})

const snapshot = (db: Db) => Effect.gen(function* () {
  const tables = yield* db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
  return {
    schema: yield* db.all<{ type: string; name: string; tbl_name: string; sql: string }>("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name"),
    rows: yield* Effect.forEach(tables, (table) => Effect.gen(function* () {
      if (!/^[a-zA-Z0-9_]+$/.test(table.name)) return yield* Effect.die("Unexpected fixture table identifier")
      return [table.name, (yield* db.all(`SELECT * FROM "${table.name}"`)).map((row) => JSON.stringify(row)).sort()] as const
    })),
  }
})

const seedReader = (db: Db) => Effect.gen(function* () {
  yield* db.run("INSERT INTO im_kernel_reader_meter VALUES (1,1,'11111111-1111-4111-8111-111111111111',1,2,4096,1,1)")
  yield* db.run(sql`INSERT INTO im_kernel_reader_scope
    (reader_key,meter_id,version,local_revision,created_at,updated_at,accounted_records,accounted_bytes,
     workspace_id,scope_key,binding,binding_hash,phase,completed_after,continuation,fixed_limit)
    VALUES (${readerKey},1,1,1,1,1,1,3072,'workspace',${"d".repeat(64)},${JSON.stringify({
      version: 1, instanceID: "11111111-1111-4111-8111-111111111111", workspaceID: "workspace",
      realm: "https://fixture.invalid", appkey: "fixture", orgID: "1", userID: "alice", scopeKey: "d".repeat(64),
    })},${"e".repeat(64)},'idle','0','{"version":1,"projections":[]}',32)`)
  yield* db.run(sql`INSERT INTO im_kernel_reader_projection
    (reader_key,binding_key,version,local_revision,created_at,updated_at,accounted_records,accounted_bytes,
     visibility,metadata,metadata_hash,newer_after,last_server_now,observed_at,history_complete,owned_group_bytes,
     conversation_type,target_id)
    VALUES (${readerKey},${bindingKey},1,1,1,1,1,3072,'pending','{"version":1}',${"f".repeat(64)},'0',1,1,0,0,1,'bob')`)
})

const seedLegacyCut = (db: Db) => Effect.gen(function* () {
  yield* seedReader(db)
  yield* db.run(sql`UPDATE im_kernel_reader_projection SET visibility='visible',projection_key=${projectionKey},
    server_revision='1',cursor='1',read_ordinal='0',admitted_ordinal='100',live_unread='100',stored_unread='100'`)
  yield* db.run(sql`INSERT INTO im_kernel_reader_read_intent
    (action_id,reader_key,binding_key,projection_key,phase,original_projection_revision,original_target_admitted,
     cut_revision,through_ordinal,request_hash,request,version,local_revision,created_at,updated_at,accounted_records,accounted_bytes,
     result,dispatched_at,settled_at,runtime_incarnation)
    VALUES ('user-action',${readerKey},${bindingKey},${projectionKey},'confirmed','1','100','1','32',
     ${"a".repeat(64)},'{"version":1,"throughOrdinal":"32"}',1,1,1,3,1,9216,
     '{"version":1,"readOrdinal":"32"}',2,3,'22222222-2222-4222-8222-222222222222')`)
  yield* db.run("UPDATE im_kernel_reader_meter SET used_records=4,used_bytes=16384")
})

const seedUnknownCut = (db: Db) => Effect.gen(function* () {
  yield* DatabaseMigration.applyOnly(db, readerMigrations)
  yield* seedLegacyCut(db)
  yield* DatabaseMigration.applyOnly(db, cutMigrations)
  yield* db.run(sql`INSERT INTO im_kernel_reader_read_intent
    (action_id,original_action_id,cut_index,parent_action_id,reader_key,binding_key,projection_key,phase,
     original_projection_revision,original_target_admitted,cut_revision,through_ordinal,request_hash,request,
     version,local_revision,created_at,updated_at,accounted_records,accounted_bytes)
    VALUES ('unknown-cut','user-action',1,'user-action',${readerKey},${bindingKey},${projectionKey},
     'prepared','1','100','2','64',${"b".repeat(64)},'{"version":1}',1,1,4,4,1,9500)`)
  yield* db.run("UPDATE im_kernel_reader_read_intent SET phase='dispatched',dispatched_at=5,updated_at=5,runtime_incarnation='33333333-3333-4333-8333-333333333333' WHERE action_id='unknown-cut'")
  yield* db.run("UPDATE im_kernel_reader_read_intent SET phase='unknown',updated_at=6 WHERE action_id='unknown-cut'")
  yield* db.run("UPDATE im_kernel_reader_meter SET used_records=5,used_bytes=25903")
})

test("reader-v2 forward preserves old self-referenced cuts and audit guards with transactional rollback and cold reapply", async () => {
  const boundary = migrations.findIndex((item) => item.id === "20261007221842_im_reader_media_v2")
  expect(boundary).toBe(232)
  const selected = migrations.slice(0, boundary + 1)
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dac-reader-v2-migration-"))
  const filename = path.join(directory, "database.sqlite")
  try {
    const upgraded = await Effect.runPromise(Effect.gen(function* () {
      const db = yield* makeDb
      yield* db.run("PRAGMA foreign_keys=ON")
      yield* seedUnknownCut(db)
      yield* DatabaseMigration.applyOnly(db, selected.slice(0, -1))
      yield* db.run("CREATE TABLE owned_reader_delete_audit (action_id TEXT NOT NULL)")
      yield* db.run("CREATE TRIGGER owned_reader_delete_audit BEFORE DELETE ON im_kernel_reader_read_intent BEGIN INSERT INTO owned_reader_delete_audit VALUES (OLD.action_id); END")
      yield* db.run("CREATE INDEX owned_reader_request_hash ON im_kernel_reader_read_intent(request_hash)")
      const before = yield* snapshot(db)
      const rows = yield* db.all("SELECT * FROM im_kernel_reader_read_intent ORDER BY action_id")
      const meter = yield* db.all("SELECT * FROM im_kernel_reader_meter")
      const guards = yield* db.all("SELECT type,name,sql FROM sqlite_master WHERE tbl_name='im_kernel_reader_read_intent' AND type IN ('index','trigger') AND sql IS NOT NULL ORDER BY type,name")
      const failed: DatabaseMigration.Migration[] = [...selected.slice(0, -1), {
        ...selected[boundary],
        up: (tx) => Effect.gen(function* () {
          yield* selected[boundary].up(tx)
          return yield* tx.run("SELECT * FROM reader_v2_late_failure")
        }),
      }]
      expect(Exit.isFailure(yield* Effect.exit(DatabaseMigration.applyOnly(db, failed)))).toBe(true)
      expect(yield* snapshot(db)).toEqual(before)
      yield* DatabaseMigration.applyOnly(db, selected)
      expect(yield* db.all("SELECT * FROM im_kernel_reader_read_intent ORDER BY action_id")).toEqual(rows)
      expect(yield* db.all("SELECT * FROM im_kernel_reader_meter")).toEqual(meter)
      expect(yield* db.all("SELECT type,name,sql FROM sqlite_master WHERE tbl_name='im_kernel_reader_read_intent' AND type IN ('index','trigger') AND sql IS NOT NULL ORDER BY type,name")).toEqual(guards)
      expect(yield* db.all("SELECT * FROM owned_reader_delete_audit")).toEqual([])
      expect(yield* db.all("PRAGMA foreign_keys")).toEqual([{ foreign_keys: 1 }])
      expect(yield* db.all("PRAGMA foreign_key_check")).toEqual([])
      const insert = (action: string, version: unknown) => db.run(sql`INSERT INTO im_kernel_reader_read_intent
        (action_id,original_action_id,cut_index,parent_action_id,reader_key,binding_key,projection_key,phase,
         original_projection_revision,original_target_admitted,cut_revision,through_ordinal,request_hash,request,
         version,local_revision,created_at,updated_at,accounted_records,accounted_bytes)
        VALUES (${action},${action},0,NULL,${readerKey},${bindingKey},${projectionKey},'prepared',
         '3','101','3','101',${"c".repeat(64)},${JSON.stringify({ version })},1,1,10,10,1,9216)`)
      for (const version of [0, 3, "2", null])
        expect(Exit.isFailure(yield* Effect.exit(insert("invalid-v2", version)))).toBe(true)
      yield* insert("v2-root", 2)
      yield* db.run("UPDATE im_kernel_reader_read_intent SET phase='dispatched',dispatched_at=11,updated_at=11,runtime_incarnation='44444444-4444-4444-8444-444444444444' WHERE action_id='v2-root'")
      expect(Exit.isFailure(yield* Effect.exit(db.run("UPDATE im_kernel_reader_read_intent SET phase='confirmed',result='{\"version\":3}',settled_at=12,updated_at=12 WHERE action_id='v2-root'")))).toBe(true)
      yield* db.run("UPDATE im_kernel_reader_read_intent SET phase='confirmed',result='{\"version\":2}',settled_at=12,updated_at=12 WHERE action_id='v2-root'")
      expect(yield* db.get("SELECT version,request,result FROM im_kernel_reader_read_intent WHERE action_id='v2-root'"))
        .toEqual({ version: 1, request: '{"version":2}', result: '{"version":2}' })
      expect(Exit.isFailure(yield* Effect.exit(db.run("UPDATE im_kernel_reader_read_intent SET request='{\"version\":2}' WHERE action_id='unknown-cut'")))).toBe(true)
      expect(yield* db.get("PRAGMA quick_check")).toEqual({ quick_check: "ok" })
      return yield* snapshot(db)
    }).pipe(Effect.provide(SqliteClient.layer({ filename })), Effect.scoped))
    const reopened = await Effect.runPromise(Effect.gen(function* () {
      const db = yield* makeDb
      yield* db.run("PRAGMA foreign_keys=ON")
      yield* DatabaseMigration.applyOnly(db, selected)
      expect(yield* db.all("PRAGMA foreign_key_check")).toEqual([])
      return yield* snapshot(db)
    }).pipe(Effect.provide(SqliteClient.layer({ filename })), Effect.scoped))
    expect(reopened).toEqual(upgraded)
  } finally {
    await fs.rm(directory, { recursive: true })
  }
}, 60000)

test("new-action forward keeps the original unknown byte-for-byte, rolls back late DDL, and cold reapply is unchanged", async () => {
  const boundary = migrations.findIndex((item) => item.id === "20261007175745_im_reader_new_action")
  expect(boundary).toBe(228)
  const selected = migrations.slice(0, boundary + 1)
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dac-reader-new-action-migration-"))
  const filename = path.join(directory, "database.sqlite")
  try {
    const upgraded = await Effect.runPromise(Effect.gen(function* () {
      const db = yield* makeDb
      yield* db.run("PRAGMA foreign_keys=ON")
      yield* seedUnknownCut(db)
      yield* DatabaseMigration.applyOnly(db, selected.slice(0, -1))
      const before = yield* snapshot(db)
      const failed: DatabaseMigration.Migration[] = [...selected.slice(0, -1), {
        ...selected[boundary],
        up: (tx) => Effect.gen(function* () {
          yield* selected[boundary].up(tx)
          return yield* tx.run("SELECT * FROM new_action_late_failure")
        }),
      }]
      expect(Exit.isFailure(yield* Effect.exit(DatabaseMigration.applyOnly(db, failed)))).toBe(true)
      expect(yield* snapshot(db)).toEqual(before)
      const rows = yield* db.all("SELECT * FROM im_kernel_reader_read_intent ORDER BY action_id")
      const meter = yield* db.get("SELECT * FROM im_kernel_reader_meter")
      yield* DatabaseMigration.applyOnly(db, selected)
      expect(yield* db.all("SELECT * FROM im_kernel_reader_read_intent ORDER BY action_id")).toEqual(rows)
      expect(yield* db.get("SELECT * FROM im_kernel_reader_meter")).toEqual(meter)
      expect(yield* db.all("PRAGMA foreign_key_check")).toEqual([])
      expect(yield* db.all("PRAGMA foreign_keys")).toEqual([{ foreign_keys: 1 }])
      expect(yield* db.get("SELECT name FROM sqlite_master WHERE name='im_kernel_reader_read_intent_pending_idx'")).toBeUndefined()
      expect(yield* db.all("SELECT name FROM sqlite_master WHERE name IN ('im_reader_action_capacity_insert','im_reader_action_capacity_update') ORDER BY name"))
        .toEqual([{ name: "im_reader_action_capacity_insert" }, { name: "im_reader_action_capacity_update" }])
      return yield* snapshot(db)
    }).pipe(Effect.provide(SqliteClient.layer({ filename })), Effect.scoped))
    const reopened = await Effect.runPromise(Effect.gen(function* () {
      const db = yield* makeDb
      yield* db.run("PRAGMA foreign_keys=ON")
      yield* DatabaseMigration.applyOnly(db, selected)
      return yield* snapshot(db)
    }).pipe(Effect.provide(SqliteClient.layer({ filename })), Effect.scoped))
    expect(reopened).toEqual(upgraded)
  } finally {
    await fs.rm(directory, { recursive: true })
  }
})

test("new-action SQL reserves one unknown slot, enforces a greater target and one in-flight cut", async () => {
  const boundary = migrations.findIndex((item) => item.id === "20261007175745_im_reader_new_action")
  await Effect.runPromise(Effect.gen(function* () {
    const db = yield* makeDb
    yield* db.run("PRAGMA foreign_keys=ON")
    yield* seedUnknownCut(db)
    yield* DatabaseMigration.applyOnly(db, migrations.slice(0, boundary + 1))
    const insert = (id: string, target: string) => db.run(sql`INSERT INTO im_kernel_reader_read_intent
      (action_id,original_action_id,cut_index,parent_action_id,reader_key,binding_key,projection_key,phase,
       original_projection_revision,original_target_admitted,cut_revision,through_ordinal,request_hash,request,
       version,local_revision,created_at,updated_at,accounted_records,accounted_bytes)
      VALUES (${id},${id},0,NULL,${readerKey},${bindingKey},${projectionKey},'prepared',
       '3',${target},'3',${target},${"c".repeat(64)},'{"version":1}',1,1,10,10,1,9500)`)
    const original = yield* db.get("SELECT * FROM im_kernel_reader_read_intent WHERE action_id='unknown-cut'")
    for (const target of ["99", "100"]) expect(Exit.isFailure(yield* Effect.exit(insert(`bad-${target}`, target)))).toBe(true)
    for (const ordinal of [101, 102, 103, 104, 105, 106, 107]) {
      const id = `new-${ordinal}`
      yield* insert(id, String(ordinal))
      expect(Exit.isFailure(yield* Effect.exit(insert(`parallel-${ordinal}`, String(ordinal + 1))))).toBe(true)
      yield* db.run(sql`UPDATE im_kernel_reader_read_intent SET phase='dispatched',dispatched_at=11,updated_at=11,runtime_incarnation='33333333-3333-4333-8333-333333333333' WHERE action_id=${id}`)
      yield* db.run(sql`UPDATE im_kernel_reader_read_intent SET phase='unknown',updated_at=12 WHERE action_id=${id}`)
    }
    expect(yield* db.get("SELECT COUNT(*) AS count FROM im_kernel_reader_read_intent WHERE phase='unknown'")).toEqual({ count: 8 })
    expect(Exit.isFailure(yield* Effect.exit(insert("ninth", "108")))).toBe(true)
    expect(yield* db.get("SELECT * FROM im_kernel_reader_read_intent WHERE action_id='unknown-cut'")).toEqual(original)
    yield* db.run("UPDATE im_kernel_reader_read_intent SET phase='confirmed',result='{\"version\":1,\"readOrdinal\":\"64\"}',settled_at=13,updated_at=13 WHERE action_id='unknown-cut'")
    yield* insert("after-known", "108")
    expect(yield* db.get("SELECT COUNT(*) AS count FROM im_kernel_reader_read_intent WHERE phase IN ('prepared','dispatched','unknown')")).toEqual({ count: 8 })
    const plan = yield* db.all<{ detail: string }>(sql`EXPLAIN QUERY PLAN SELECT action_id FROM im_kernel_reader_read_intent
      WHERE reader_key=${readerKey} AND binding_key=${bindingKey} AND projection_key=${projectionKey} AND cut_index=0
      ORDER BY created_at DESC,action_id DESC LIMIT 1`)
    expect(plan.some((row) => row.detail.includes("im_kernel_reader_read_intent_root_idx"))).toBe(true)
    expect(plan.some((row) => row.detail.includes("TEMP B-TREE"))).toBe(false)
    expect(yield* db.all("PRAGMA foreign_key_check")).toEqual([])
  }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" })), Effect.scoped))
})

test("read-cut forward preserves original request/result bytes, adds exact accounting, and cold reapply does not charge twice", async () => {
  expect(cutBoundary).toBe(222)
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dac-read-cut-migration-"))
  const filename = path.join(directory, "database.sqlite")
  try {
    const before = await Effect.runPromise(Effect.gen(function* () {
      const db = yield* makeDb
      yield* db.run("PRAGMA foreign_keys=ON")
      yield* DatabaseMigration.applyOnly(db, readerMigrations)
      yield* seedLegacyCut(db)
      return yield* db.get("SELECT request,result,request_hash,through_ordinal FROM im_kernel_reader_read_intent")
    }).pipe(Effect.provide(SqliteClient.layer({ filename })), Effect.scoped))
    const upgraded = await Effect.runPromise(Effect.gen(function* () {
      const db = yield* makeDb
      yield* db.run("PRAGMA foreign_keys=ON")
      yield* DatabaseMigration.applyOnly(db, cutMigrations)
      expect(yield* db.get("SELECT request,result,request_hash,through_ordinal FROM im_kernel_reader_read_intent")).toEqual(before)
      expect(yield* db.get("SELECT original_action_id,cut_index,parent_action_id,accounted_bytes FROM im_kernel_reader_read_intent"))
        .toEqual({ original_action_id: "user-action", cut_index: 0, parent_action_id: null, accounted_bytes: 9235 })
      expect(yield* db.get("SELECT used_records,used_bytes,revision FROM im_kernel_reader_meter"))
        .toEqual({ used_records: 4, used_bytes: 16403, revision: 2 })
      expect(yield* db.all("PRAGMA foreign_keys")).toEqual([{ foreign_keys: 1 }])
      expect(yield* db.all("PRAGMA foreign_key_check")).toEqual([])
      return yield* snapshot(db)
    }).pipe(Effect.provide(SqliteClient.layer({ filename })), Effect.scoped))
    const reopened = await Effect.runPromise(Effect.gen(function* () {
      const db = yield* makeDb
      yield* db.run("PRAGMA foreign_keys=ON")
      yield* DatabaseMigration.applyOnly(db, cutMigrations)
      return yield* snapshot(db)
    }).pipe(Effect.provide(SqliteClient.layer({ filename })), Effect.scoped))
    expect(reopened).toEqual(upgraded)
  } finally {
    await fs.rm(directory, { recursive: true })
  }
})

test("cut continuation requires the same root, confirmed predecessor and immutable original request/result", async () => {
  await Effect.runPromise(Effect.gen(function* () {
    const db = yield* makeDb
    yield* db.run("PRAGMA foreign_keys=ON")
    yield* DatabaseMigration.applyOnly(db, readerMigrations)
    yield* seedLegacyCut(db)
    yield* DatabaseMigration.applyOnly(db, cutMigrations)
    const before = yield* snapshot(db)
    for (const statement of [
      "UPDATE im_kernel_reader_read_intent SET original_target_admitted='101'",
      "UPDATE im_kernel_reader_read_intent SET request='{\"version\":1,\"throughOrdinal\":\"33\"}'",
      "UPDATE im_kernel_reader_read_intent SET result='{\"version\":1,\"readOrdinal\":\"100\"}'",
      "UPDATE im_kernel_reader_read_intent SET phase='cancelled'",
      "UPDATE im_kernel_reader_read_intent SET cut_index=1",
    ]) expect(Exit.isFailure(yield* Effect.exit(db.run(statement)))).toBe(true)
    expect(yield* snapshot(db)).toEqual(before)
    const insert = (index: number, target = "100") => db.run(sql`INSERT INTO im_kernel_reader_read_intent
      (action_id,original_action_id,cut_index,parent_action_id,reader_key,binding_key,projection_key,phase,
       original_projection_revision,original_target_admitted,cut_revision,through_ordinal,request_hash,request,
       version,local_revision,created_at,updated_at,accounted_records,accounted_bytes)
      VALUES (${`user-cut-${index}`},'user-action',${index},'user-action',${readerKey},${bindingKey},${projectionKey},
       'prepared','1',${target},'2','64',${"b".repeat(64)},'{"version":1}',1,1,4,4,1,9500)`)
    expect(Exit.isFailure(yield* Effect.exit(insert(2)))).toBe(true)
    expect(Exit.isFailure(yield* Effect.exit(insert(1, "101")))).toBe(true)
    expect(Exit.isFailure(yield* Effect.exit(insert(32)))).toBe(true)
    yield* insert(1)
    expect(Exit.isFailure(yield* Effect.exit(insert(1)))).toBe(true)
    yield* db.run("UPDATE im_kernel_reader_read_intent SET phase='dispatched',dispatched_at=5,updated_at=5,runtime_incarnation='33333333-3333-4333-8333-333333333333' WHERE action_id='user-cut-1'")
    yield* db.run("UPDATE im_kernel_reader_read_intent SET phase='unknown',updated_at=6 WHERE action_id='user-cut-1'")
    expect(Exit.isFailure(yield* Effect.exit(insert(2)))).toBe(true)
    expect(Exit.isFailure(yield* Effect.exit(db.run("UPDATE im_kernel_reader_read_intent SET phase='cancelled',settled_at=6 WHERE action_id='user-cut-1'")))).toBe(true)
    yield* db.run("UPDATE im_kernel_reader_read_intent SET phase='confirmed',result='{\"version\":1,\"readOrdinal\":\"64\"}',settled_at=7,updated_at=7 WHERE action_id='user-cut-1'")
    yield* insert(2)
    expect(yield* db.all("SELECT action_id,cut_index FROM im_kernel_reader_read_intent ORDER BY cut_index"))
      .toEqual([{ action_id: "user-action", cut_index: 0 }, { action_id: "user-cut-1", cut_index: 1 }, { action_id: "user-cut-2", cut_index: 2 }])
    expect(yield* db.all("PRAGMA foreign_key_check")).toEqual([])
  }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" })), Effect.scoped))
})

test("full meter or late DDL failure leaves populated legacy cuts and schema unchanged", async () => {
  for (const full of [true, false]) await Effect.runPromise(Effect.gen(function* () {
    const db = yield* makeDb
    yield* db.run("PRAGMA foreign_keys=ON")
    yield* DatabaseMigration.applyOnly(db, readerMigrations)
    yield* seedLegacyCut(db)
    if (full) yield* db.run("UPDATE im_kernel_reader_meter SET used_bytes=268435456")
    const before = yield* snapshot(db)
    const selected: DatabaseMigration.Migration[] = full ? cutMigrations : [
      ...cutMigrations.slice(0, -1),
      { ...cutMigrations[cutBoundary], up: (tx) => Effect.gen(function* () {
        yield* cutMigrations[cutBoundary].up(tx)
        return yield* tx.run("SELECT * FROM late_cut_migration_failure")
      }) },
    ]
    expect(Exit.isFailure(yield* Effect.exit(DatabaseMigration.applyOnly(db, selected)))).toBe(true)
    expect(yield* snapshot(db)).toEqual(before)
    expect(yield* db.all("PRAGMA foreign_keys")).toEqual([{ foreign_keys: 1 }])
  }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" })), Effect.scoped))
})

test("populated 221 upgrade adds empty reader tables, preserves every old table, and cold reapply is unchanged", async () => {
  expect(boundary).toBe(221)
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dac-reader-migration-"))
  const filename = path.join(directory, "database.sqlite")
  try {
    const before = await Effect.runPromise(Effect.gen(function* () {
      const db = yield* makeDb
      yield* db.run("PRAGMA foreign_keys=ON")
      yield* DatabaseMigration.applyOnly(db, readerMigrations.slice(0, -1))
      yield* seedOrdinary(db)
      return yield* snapshot(db)
    }).pipe(Effect.provide(SqliteClient.layer({ filename })), Effect.scoped))
    const identity = await fs.stat(filename)
    const first = await Effect.runPromise(Effect.gen(function* () {
      const db = yield* makeDb
      yield* db.run("PRAGMA foreign_keys=ON")
      yield* DatabaseMigration.applyOnly(db, readerMigrations)
      const after = yield* snapshot(db)
      expect(after.rows.filter(([name]) => name !== "migration" && !name.startsWith("im_kernel_reader_")))
        .toEqual(before.rows.filter(([name]) => name !== "migration"))
      expect(after.rows.filter(([name]) => name.startsWith("im_kernel_reader_"))).toHaveLength(5)
      expect(after.rows.filter(([name]) => name.startsWith("im_kernel_reader_")).every(([, rows]) => rows.length === 0)).toBe(true)
      expect(yield* db.all("PRAGMA foreign_key_check")).toEqual([])
      expect(yield* db.all("PRAGMA quick_check")).toEqual([{ quick_check: "ok" }])
      return after
    }).pipe(Effect.provide(SqliteClient.layer({ filename })), Effect.scoped))
    const reopened = await Effect.runPromise(Effect.gen(function* () {
      const db = yield* makeDb
      yield* db.run("PRAGMA foreign_keys=ON")
      yield* DatabaseMigration.applyOnly(db, readerMigrations)
      return yield* snapshot(db)
    }).pipe(Effect.provide(SqliteClient.layer({ filename })), Effect.scoped))
    expect(reopened).toEqual(first)
    const after = await fs.stat(filename)
    expect({ dev: after.dev, ino: after.ino }).toEqual({ dev: identity.dev, ino: identity.ino })
  } finally {
    await fs.rm(directory, { recursive: true })
  }
})

test("physical reader constraints preserve exact int64s and reject malformed identity, JSON, quota, pending children and cuts", async () => {
  await Effect.runPromise(Effect.gen(function* () {
    const db = yield* makeDb
    yield* db.run("PRAGMA foreign_keys=ON")
    yield* DatabaseMigration.applyOnly(db, readerMigrations)
    yield* seedOrdinary(db)
    yield* seedReader(db)
    const before = yield* snapshot(db)
    const denied = [
      "UPDATE im_kernel_reader_meter SET id=2",
      "UPDATE im_kernel_reader_meter SET used_records=100001",
      "UPDATE im_kernel_reader_meter SET used_bytes=268435457",
      "UPDATE im_kernel_reader_meter SET revision=1.5",
      "UPDATE im_kernel_reader_meter SET instance_id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa-extra'",
      "UPDATE im_kernel_reader_scope SET binding='{}'",
      "UPDATE im_kernel_reader_scope SET binding='{\"version\":null}'",
      "UPDATE im_kernel_reader_scope SET continuation='{\"version\":1}'",
      "UPDATE im_kernel_reader_scope SET completed_after='01'",
      "UPDATE im_kernel_reader_scope SET completed_after='9223372036854775808'",
      "UPDATE im_kernel_reader_projection SET binding_key='bad'",
      "UPDATE im_kernel_reader_projection SET metadata_hash='bad'",
      "UPDATE im_kernel_reader_projection SET server_revision='bad'",
      "UPDATE im_kernel_reader_projection SET newer_after='01'",
      "UPDATE im_kernel_reader_projection SET projection_key='bad'",
      "UPDATE im_kernel_reader_projection SET cursor='1'",
      "UPDATE im_kernel_reader_projection SET visibility='visible'",
      "UPDATE im_kernel_reader_projection SET metadata='not json'",
    ]
    for (const statement of denied) expect(Exit.isFailure(yield* Effect.exit(db.run(statement)))).toBe(true)
    expect(yield* snapshot(db)).toEqual(before)
    expect(Exit.isFailure(yield* Effect.exit(db.run(sql`INSERT INTO im_kernel_reader_read_intent
      (action_id,reader_key,binding_key,projection_key,phase,original_projection_revision,original_target_admitted,
       cut_revision,through_ordinal,request_hash,request,version,local_revision,created_at,updated_at,accounted_records,accounted_bytes)
      VALUES ('read-action',${readerKey},${bindingKey},${projectionKey},'prepared','1','1','1','1',${"a".repeat(64)},'{"version":1}',1,1,1,1,1,9216)`)))).toBe(true)
    expect(Exit.isFailure(yield* Effect.exit(db.run(sql`INSERT INTO im_kernel_reader_message
      (reader_key,effect_key,binding_key,projection_key,message_id,sequence,delivery_cursor,sender_id,target_id,
       body_hash,immutable_hash,storage_state,metadata,message_time,expires_at,conversation_type,owns_message,body_bytes,
       version,local_revision,created_at,updated_at,accounted_records,accounted_bytes,local_message_id)
      VALUES (${readerKey},${"9".repeat(64)},${bindingKey},${projectionKey},'message','1','1','alice','bob',
       ${"a".repeat(64)},${"b".repeat(64)},'present','{"version":1}',1,2,1,0,19,1,1,1,1,1,3072,'imsg_ordinary')`)))).toBe(true)
    yield* db.run(sql`UPDATE im_kernel_reader_projection SET visibility='visible',projection_key=${projectionKey},
      server_revision='9007199254740993',cursor='9223372036854775807',read_ordinal='0',
      admitted_ordinal='9223372036854775807',live_unread='9007199254740993',stored_unread='9007199254740993'`)
    expect(yield* db.get("SELECT server_revision,cursor,live_unread FROM im_kernel_reader_projection")).toEqual({
      server_revision: "9007199254740993", cursor: "9223372036854775807", live_unread: "9007199254740993",
    })
    const visible = yield* snapshot(db)
    for (const statement of [
      "UPDATE im_kernel_reader_projection SET read_ordinal='9223372036854775808'",
      "UPDATE im_kernel_reader_projection SET live_unread='9223372036854775807'",
      "UPDATE im_kernel_reader_projection SET server_revision='0'",
      "UPDATE im_kernel_reader_projection SET stored_unread='01'",
    ]) expect(Exit.isFailure(yield* Effect.exit(db.run(statement)))).toBe(true)
    yield* db.run(sql`INSERT INTO im_kernel_reader_read_intent
      (action_id,reader_key,binding_key,projection_key,phase,original_projection_revision,original_target_admitted,
       cut_revision,through_ordinal,request_hash,request,version,local_revision,created_at,updated_at,accounted_records,accounted_bytes)
      VALUES ('read-action',${readerKey},${bindingKey},${projectionKey},'prepared','9007199254740993',
       '9223372036854775807','9007199254740993','9223372036854775807',${"a".repeat(64)},'{"version":1}',1,1,1,1,1,9216)`)
    expect(Exit.isFailure(yield* Effect.exit(db.run("UPDATE im_kernel_reader_read_intent SET phase='dispatched'")))).toBe(true)
    expect(Exit.isFailure(yield* Effect.exit(db.run("DELETE FROM im_kernel_reader_projection")))).toBe(true)
    expect(Exit.isFailure(yield* Effect.exit(db.run("DELETE FROM im_kernel_reader_scope")))).toBe(true)
    expect(Exit.isFailure(yield* Effect.exit(db.run("DELETE FROM im_kernel_reader_meter")))).toBe(true)
    expect((yield* snapshot(db)).rows.find(([name]) => name === "im_kernel_reader_projection"))
      .toEqual(visible.rows.find(([name]) => name === "im_kernel_reader_projection"))
    expect(yield* db.all("PRAGMA foreign_key_check")).toEqual([])
  }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" })), Effect.scoped))
})

test("a failure after real reader DDL rolls back schema, all old rows and migration journal", async () => {
  await Effect.runPromise(Effect.gen(function* () {
    const db = yield* makeDb
    yield* db.run("PRAGMA foreign_keys=ON")
    yield* DatabaseMigration.applyOnly(db, readerMigrations.slice(0, -1))
    yield* seedOrdinary(db)
    const before = yield* snapshot(db)
    const result = yield* Effect.exit(DatabaseMigration.applyOnly(db, [
      ...readerMigrations.slice(0, -1),
      { ...readerMigrations[boundary], up: (tx) => Effect.gen(function* () {
        yield* readerMigrations[boundary].up(tx)
        yield* tx.run("SELECT * FROM reader_migration_failure")
      }) },
    ]))
    expect(Exit.isFailure(result)).toBe(true)
    expect(yield* snapshot(db)).toEqual(before)
  }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" })), Effect.scoped))
})

test("read-action lookup upgrade preserves cut receipts and uses a bounded reverse index scan", async () => {
  await Effect.runPromise(Effect.gen(function* () {
    const db = yield* makeDb
    yield* db.run("PRAGMA foreign_keys=ON")
    yield* DatabaseMigration.applyOnly(db, readerMigrations)
    yield* seedLegacyCut(db)
    yield* DatabaseMigration.applyOnly(db, cutMigrations)
    const lookup = migrations.findIndex((item) => item.id === "20261007143308_im_reader_action_lookup")
    expect(lookup).toBeGreaterThan(cutBoundary)
    yield* DatabaseMigration.applyOnly(db, migrations.slice(0, lookup))
    const before = yield* snapshot(db)
    yield* DatabaseMigration.applyOnly(db, migrations.slice(0, lookup + 1))
    const upgraded = yield* snapshot(db)
    expect(upgraded.rows.filter((row) => row[0] !== "migration")).toEqual(before.rows.filter((row) => row[0] !== "migration"))
    expect(upgraded.schema.filter((row) => row.name !== "im_kernel_reader_read_intent_lookup_idx")).toEqual(before.schema)
    const plan = yield* db.all<{ detail: string }>(sql`EXPLAIN QUERY PLAN SELECT action_id,phase,cut_index
      FROM im_kernel_reader_read_intent WHERE reader_key=${readerKey} AND binding_key=${bindingKey}
      AND projection_key=${projectionKey} ORDER BY created_at DESC,cut_index DESC,action_id DESC LIMIT 1`)
    expect(plan.some((row) => row.detail.includes("im_kernel_reader_read_intent_lookup_idx"))).toBe(true)
    expect(plan.some((row) => row.detail.includes("TEMP B-TREE"))).toBe(false)
    yield* DatabaseMigration.applyOnly(db, migrations.slice(0, lookup + 1))
    expect(yield* snapshot(db)).toEqual(upgraded)
    expect(yield* db.all("PRAGMA foreign_key_check")).toEqual([])
  }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" })), Effect.scoped))
})

test("group-page index upgrade preserves receipts, supports stable keysets and rolls back atomically", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dac-group-page-migration-"))
  const filename = path.join(directory, "database.sqlite")
  const pageBoundary = migrations.findIndex((item) => item.id === "20261007152539_im_group_page_index")
  expect(pageBoundary).toBeGreaterThan(cutBoundary)
  try {
    const upgraded = await Effect.runPromise(Effect.gen(function* () {
      const db = yield* makeDb
      yield* db.run("PRAGMA foreign_keys=ON")
      yield* DatabaseMigration.applyOnly(db, readerMigrations)
      yield* seedLegacyCut(db)
      yield* seedOrdinary(db)
      yield* DatabaseMigration.applyOnly(db, migrations.slice(0, pageBoundary))
      yield* Effect.forEach(Array.from({ length: 65 }, (_, index) => `img_page_${String(index).padStart(2, "0")}`), (id) => Effect.gen(function* () {
        yield* db.run(sql`INSERT INTO im_groups (id,workspace_id,type,name,created_by,created_at,updated_at) VALUES (${id},'workspace','project',${id},'alice',1,1)`)
        yield* db.run(sql`INSERT INTO im_members (group_id,member_id,member_type,role,joined_at) VALUES (${id},'alice','user','owner',1)`)
      }))
      const before = yield* snapshot(db)
      const failed = yield* Effect.exit(DatabaseMigration.applyOnly(db, [
        ...migrations.slice(0, pageBoundary),
        { ...migrations[pageBoundary], up: (tx) => Effect.gen(function* () {
          yield* migrations[pageBoundary].up(tx)
          yield* tx.run("SELECT * FROM late_group_page_index_failure")
        }) },
      ]))
      expect(Exit.isFailure(failed)).toBe(true)
      expect(yield* snapshot(db)).toEqual(before)
      yield* DatabaseMigration.applyOnly(db, migrations.slice(0, pageBoundary + 1))
      const after = yield* snapshot(db)
      expect(after.rows.filter((row) => row[0] !== "migration")).toEqual(before.rows.filter((row) => row[0] !== "migration"))
      expect(after.schema.filter((row) => row.name !== "im_groups_page_idx")).toEqual(before.schema)
      const plan = yield* db.all<{ detail: string }>(sql`EXPLAIN QUERY PLAN SELECT g.id,g.created_at FROM im_groups g
        WHERE g.workspace_id='workspace' AND g.deleted_at IS NULL AND (g.created_at,g.id) <= (1,'img_page_64')
        AND EXISTS(SELECT 1 FROM im_members m WHERE m.group_id=g.id AND m.member_id='alice' AND m.member_type='user')
        ORDER BY g.created_at DESC,g.id DESC LIMIT 33`)
      expect(plan.some((row) => row.detail.includes("im_groups_page_idx"))).toBe(true)
      expect(plan.some((row) => row.detail.includes("TEMP B-TREE"))).toBe(false)
      const first = yield* db.all<{ id: string; created_at: number }>(sql`SELECT id,created_at FROM im_groups WHERE workspace_id='workspace' AND deleted_at IS NULL AND (created_at,id) <= (1,'img_page_64') ORDER BY created_at DESC,id DESC LIMIT 32`)
      const last = first.at(-1)!
      const second = yield* db.all<{ id: string; created_at: number }>(sql`SELECT id,created_at FROM im_groups WHERE workspace_id='workspace' AND deleted_at IS NULL AND (created_at,id) < (${last.created_at},${last.id}) ORDER BY created_at DESC,id DESC LIMIT 32`)
      const tail = second.at(-1)!
      const third = yield* db.all<{ id: string; created_at: number }>(sql`SELECT id,created_at FROM im_groups WHERE workspace_id='workspace' AND deleted_at IS NULL AND (created_at,id) < (${tail.created_at},${tail.id}) ORDER BY created_at DESC,id DESC LIMIT 32`)
      expect([first.length, second.length, third.length]).toEqual([32, 32, 2])
      expect(new Set([...first, ...second, ...third].map((row) => row.id)).size).toBe(66)
      expect(yield* db.all("PRAGMA foreign_key_check")).toEqual([])
      return after
    }).pipe(Effect.provide(SqliteClient.layer({ filename })), Effect.scoped))
    await Effect.runPromise(Effect.gen(function* () {
      const db = yield* makeDb
      yield* db.run("PRAGMA foreign_keys=ON")
      yield* DatabaseMigration.applyOnly(db, migrations.slice(0, pageBoundary + 1))
      expect(yield* snapshot(db)).toEqual(upgraded)
    }).pipe(Effect.provide(SqliteClient.layer({ filename })), Effect.scoped))
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})
