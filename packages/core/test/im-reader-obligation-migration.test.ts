import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@deepagent-code/effect-drizzle-sqlite"
import { sql } from "drizzle-orm"
import { Effect, Exit } from "effect"
import { DatabaseMigration } from "../src/database/migration"
import { migrations } from "../src/database/migration.gen"
import { IMMentionIntentTable } from "../src/im/mention-intent.sql"

const boundary = migrations.findIndex((migration) => migration.id === "20261010013645_im_reader_obligation_retention")
const selected = migrations.slice(0, boundary + 1)
const previous = selected.slice(0, -1)
const migration = selected[boundary]
const makeDb = EffectDrizzleSqlite.makeWithDefaults()
type Db = Effect.Success<typeof makeDb>
const readerKey = "a".repeat(64)
const bindingKey = "b".repeat(64)
const projectionKey = "c".repeat(64)
const effectKey = "e".repeat(64)
const retiredEffectKey = "f".repeat(64)
const byteLimit = 268435456
const recordLimit = 100000
const digest = (value: string) => createHash("sha256").update(value, "utf8").digest("hex")

const open = <A, E>(filename: string, body: (db: Db) => Effect.Effect<A, E>) => Effect.runPromise(Effect.gen(function* () {
  const db = yield* makeDb
  yield* db.run("PRAGMA foreign_keys=ON")
  expect(yield* db.get("PRAGMA foreign_keys")).toEqual({ foreign_keys: 1 })
  const value = yield* body(db)
  expect(yield* db.all("PRAGMA foreign_key_check")).toEqual([])
  expect(yield* db.get("PRAGMA quick_check")).toEqual({ quick_check: "ok" })
  return value
}).pipe(Effect.provide(SqliteClient.layer({ filename })), Effect.scoped))

const isolated = async (body: (filename: string) => Promise<void>) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dac-im-reader-obligation-migration-"))
  const filename = path.join(directory, "database.sqlite")
  try { await body(filename) }
  finally {
    await fs.rm(directory, { recursive: true })
    expect(await Bun.file(filename).exists()).toBe(false)
  }
}

// Snapshot hashes prevent the generated 9 MiB error fixture entering failure output.
const snapshot = (db: Db) => Effect.gen(function* () {
  const schema = yield* db.all<{ type: string; name: string; tbl_name: string; sql: string | null }>(
    "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name")
  return {
    schema: schema.map((entry) => ({ type: entry.type, name: entry.name, table: entry.tbl_name, hash: digest(entry.sql ?? "") })),
    data: yield* Effect.forEach(schema.filter((entry) => entry.type === "table"), (table) => Effect.gen(function* () {
      if (!/^[a-zA-Z0-9_]+$/.test(table.name)) return yield* Effect.die("Unexpected private fixture table identifier")
      const rows = yield* db.all(`SELECT * FROM "${table.name}"`)
      return { table: table.name, count: rows.length, hash: digest(JSON.stringify(rows.map((row) => digest(JSON.stringify(row))).sort())) }
    })),
  }
})

const seed = (db: Db, large = false) => Effect.gen(function* () {
  yield* DatabaseMigration.applyOnly(db, previous)
  yield* db.run("INSERT INTO im_groups(id,workspace_id,type,name,created_by,created_at,updated_at) VALUES ('img_owned','workspace','project','Original group','receiver',10,10)")
  yield* db.run("INSERT INTO im_members(group_id,member_id,member_type,role,joined_at) VALUES ('img_owned','receiver','user','owner',10)")
  yield* db.run(sql`INSERT INTO im_messages(id,group_id,sender_id,sender_type,type,content,metadata,created_at,updated_at)
    VALUES ('imsg_owned','img_owned','sender','user','text',${"原消息🙂"},'{"type":"kernel_sync","liveEligible":false}',10,10)`)
  yield* db.run("INSERT INTO im_groups(id,workspace_id,type,name,created_by,created_at,updated_at) VALUES ('img_ordinary','workspace','project','Ordinary control','receiver',10,10)")
  yield* db.run("INSERT INTO im_messages(id,group_id,sender_id,sender_type,type,content,created_at,updated_at) VALUES ('imsg_ordinary','img_ordinary','receiver','user','text','ordinary body',10,10)")
  yield* db.run("INSERT INTO im_kernel_reader_meter VALUES (1,1,'11111111-1111-4111-8111-111111111111',1,8,16264,10,10)")
  yield* db.run(sql`INSERT INTO im_kernel_reader_scope
    (reader_key,meter_id,version,local_revision,created_at,updated_at,accounted_records,accounted_bytes,
    workspace_id,scope_key,binding,binding_hash,phase,completed_after,continuation,fixed_limit)
    VALUES (${readerKey},1,1,1,10,10,1,4096,'workspace',${"d".repeat(64)},${JSON.stringify({
      version: 1, instanceID: "11111111-1111-4111-8111-111111111111", workspaceID: "workspace",
      realm: "https://fixture.invalid", appkey: "fixture", orgID: "1", userID: "receiver", scopeKey: "d".repeat(64),
    })},${"9".repeat(64)},'idle','0','{"version":1,"projections":[]}',32)`)
  yield* db.run(sql`INSERT INTO im_kernel_reader_projection
    (reader_key,binding_key,projection_key,version,local_revision,created_at,updated_at,accounted_records,accounted_bytes,
    visibility,metadata,metadata_hash,newer_after,last_server_now,observed_at,history_complete,owned_group_bytes,
    conversation_type,target_id,server_revision,cursor,read_ordinal,admitted_ordinal,live_unread,stored_unread,local_group_id)
    VALUES (${readerKey},${bindingKey},${projectionKey},1,1,10,10,3,5000,'visible','{"version":1}',${"8".repeat(64)},
    '0',10,10,0,2500,2,'native-group','1','1','0','2','2','2','img_owned')`)
  yield* db.run(sql`INSERT INTO im_kernel_reader_message
    (reader_key,effect_key,binding_key,projection_key,message_id,sequence,delivery_cursor,sender_id,target_id,
    body_hash,immutable_hash,storage_state,metadata,message_time,expires_at,conversation_type,owns_message,body_bytes,
    version,local_revision,created_at,updated_at,accounted_records,accounted_bytes,local_message_id)
    VALUES (${readerKey},${effectKey},${bindingKey},${projectionKey},'native-original','1','1','sender','native-group',
    ${digest("原消息🙂")},${"7".repeat(64)},'present','{"version":1}',10,1000,2,1,${Buffer.byteLength("原消息🙂")},
    1,1,10,10,2,4096,'imsg_owned')`)
  yield* db.run(sql`INSERT INTO im_kernel_reader_message
    (reader_key,effect_key,binding_key,projection_key,message_id,sequence,delivery_cursor,sender_id,target_id,
    body_hash,immutable_hash,storage_state,metadata,message_time,expires_at,conversation_type,owns_message,body_bytes,
    version,local_revision,created_at,updated_at,accounted_records,accounted_bytes,local_message_id)
    VALUES (${readerKey},${retiredEffectKey},${bindingKey},${projectionKey},'native-retired','2','2','sender','native-group',
    ${"6".repeat(64)},${"5".repeat(64)},'expired','{"version":1}',10,1000,2,0,0,1,1,10,10,1,2048,NULL)`)
  const intents = [{
    id: "imi_原一🙂", message_id: "imsg_owned", agent_name: "建造🙂", directory: "/tmp/中文项目🙂", workspace_id: "workspace",
    user_id: "sender", origin: "kernel_live" as const, receiver_id: "接收🙂", conversation_type: 2, conversation_id: "native-group",
    resolved_agent: "构建代理🙂", session_id: "ses_历史🙂", input_id: "input_历史🙂", status: "admitted" as const,
    last_error: large ? "错".repeat(3 << 20) : "历史错误🙂", created_at: 10, updated_at: 11,
  }, {
    id: "imi_原二🙂", message_id: "imsg_owned", agent_name: "审查🙂", directory: "/tmp/审查🙂", workspace_id: "workspace",
    user_id: "sender", origin: "local" as const, receiver_id: null, conversation_type: null, conversation_id: null,
    resolved_agent: null, session_id: null, input_id: null, status: "pending" as const,
    last_error: "待完成🙂", created_at: 10, updated_at: 12,
  }]
  yield* db.insert(IMMentionIntentTable).values(intents).run()
  yield* db.insert(IMMentionIntentTable).values({ ...intents[1], id: "imi_ordinary", message_id: "imsg_ordinary", agent_name: "ordinary" }).run()
  const obligationBytes = intents.reduce((sum, intent) => sum + 1024 + Object.values(intent).reduce<number>((bytes, value) =>
    bytes + (typeof value === "string" ? Buffer.byteLength(value, "utf8") : typeof value === "number" ? 8 : 0), 0), 0)
  expect(yield* db.get("SELECT used_records FROM im_kernel_reader_meter")).toEqual({ used_records: 8 })
  expect(yield* db.all("PRAGMA foreign_key_check")).toEqual([])
  return { intentCount: intents.length, obligationBytes, ledgerCount: 2 }
})

const facts = (db: Db) => Effect.gen(function* () {
  return { ledgers: yield* db.all<Record<string, unknown>>("SELECT * FROM im_kernel_reader_message ORDER BY effect_key"),
    meter: yield* db.get<{ used_records: number; used_bytes: number; revision: number }>("SELECT used_records,used_bytes,revision FROM im_kernel_reader_meter") }
})
const failurePlan = [...previous, { ...migration,
  up: (tx: Parameters<DatabaseMigration.Migration["up"]>[0]) => Effect.gen(function* () {
    yield* migration.up(tx)
    return yield* tx.run("SELECT * FROM owned_obligation_late_failure")
  }),
}]

test("fresh official obligation migration keeps FK and installs retired custody constraints", () => isolated(async (filename) => {
  const first = await open(filename, (db) => Effect.gen(function* () {
    expect(boundary).toBeGreaterThan(0)
    yield* DatabaseMigration.applyOnly(db, selected)
    const columns = yield* db.all<{ name: string; notnull: number; dflt_value: string | null }>("PRAGMA table_info(im_kernel_reader_message)")
    expect(columns.filter((column) => column.name.startsWith("obligation_")).map((column) => ({ name: column.name, required: column.notnull, default: column.dflt_value })))
      .toEqual([{ name: "obligation_records", required: 1, default: "0" }, { name: "obligation_bytes", required: 1, default: "0" }])
    expect(yield* db.get("SELECT count(*) count FROM im_kernel_reader_meter")).toEqual({ count: 0 })
    expect(yield* db.all("SELECT name FROM sqlite_master WHERE name LIKE '__im_reader_obligation_%' OR name='__new_im_kernel_reader_message'")).toEqual([])
    return yield* snapshot(db)
  }))
  expect(await open(filename, (db) => Effect.gen(function* () {
    yield* DatabaseMigration.applyOnly(db, selected)
    return yield* snapshot(db)
  }))).toEqual(first)
}), 60000)

for (const large of [false, true]) test(`owned present UTF8 obligations ${large ? "with a legal 9 MiB old error" : "for multiple agents"} preserve data, full backfill and cold reapply`, () => isolated(async (filename) => {
  const result = await open(filename, (db) => Effect.gen(function* () {
    const expected = yield* seed(db, large)
    if (large) expect(expected.obligationBytes).toBeGreaterThan(9 << 20)
    yield* db.run("CREATE TABLE owned_obligation_delete_audit(effect_key TEXT NOT NULL)")
    yield* db.run("CREATE TRIGGER owned_obligation_delete_audit BEFORE DELETE ON im_kernel_reader_message BEGIN INSERT INTO owned_obligation_delete_audit VALUES(OLD.effect_key); END")
    yield* db.run("CREATE INDEX owned_obligation_metadata_guard ON im_kernel_reader_message(immutable_hash)")
    const before = yield* snapshot(db)
    const old = yield* facts(db)
    const guards = yield* db.all("SELECT type,name,sql FROM sqlite_master WHERE tbl_name='im_kernel_reader_message' AND type IN ('index','trigger') AND sql IS NOT NULL ORDER BY type,name")
    yield* DatabaseMigration.applyOnly(db, selected)
    const after = yield* snapshot(db)
    const actual = yield* facts(db)
    expect(actual.meter).toEqual({ used_records: old.meter!.used_records + expected.intentCount,
      used_bytes: old.meter!.used_bytes + 16 * expected.ledgerCount + expected.obligationBytes, revision: old.meter!.revision + 1 })
    expect(actual.ledgers).toHaveLength(2)
    for (const row of actual.ledgers) {
      const original = old.ledgers.find((original) => original.effect_key === row.effect_key)!
      expect(Object.fromEntries(Object.entries(row).filter(([key]) => !["obligation_records", "obligation_bytes", "accounted_records", "accounted_bytes"].includes(key))))
        .toEqual(Object.fromEntries(Object.entries(original).filter(([key]) => !["obligation_records", "obligation_bytes", "accounted_records", "accounted_bytes"].includes(key))))
      expect(row.obligation_records).toBe(row.effect_key === effectKey ? expected.intentCount : 0)
      expect(row.obligation_bytes).toBe(row.effect_key === effectKey ? expected.obligationBytes : 0)
      expect(row.accounted_records).toBe(Number(original.accounted_records) + Number(row.obligation_records))
      expect(row.accounted_bytes).toBe(Number(original.accounted_bytes) + 16 + Number(row.obligation_bytes))
    }
    expect(after.data.filter((table) => !["migration", "im_kernel_reader_message", "im_kernel_reader_meter"].includes(table.table)))
      .toEqual(before.data.filter((table) => !["migration", "im_kernel_reader_message", "im_kernel_reader_meter"].includes(table.table)))
    expect(yield* db.all("SELECT type,name,sql FROM sqlite_master WHERE tbl_name='im_kernel_reader_message' AND type IN ('index','trigger') AND sql IS NOT NULL ORDER BY type,name")).toEqual(guards)
    expect(yield* db.all("SELECT * FROM owned_obligation_delete_audit")).toEqual([])
    expect(Exit.isFailure(yield* Effect.exit(db.run("DELETE FROM im_messages WHERE id='imsg_owned'")))).toBe(true)
    expect(Exit.isFailure(yield* Effect.exit(db.run("DELETE FROM im_kernel_reader_projection")))).toBe(true)
    expect(Exit.isFailure(yield* Effect.exit(db.run("DELETE FROM im_kernel_reader_scope")))).toBe(true)
    return after
  }))
  expect(await open(filename, (db) => Effect.gen(function* () {
    yield* DatabaseMigration.applyOnly(db, selected)
    return yield* snapshot(db)
  }))).toEqual(result)
}), 60000)

for (const failure of ["backfill", "late"] as const) test(`${failure} failure rolls back complete old obligation schema/data/journal`, () => isolated(async (filename) => {
  const original = await open(filename, (db) => Effect.gen(function* () {
    yield* seed(db)
    if (failure === "backfill") yield* db.run("CREATE TRIGGER owned_obligation_backfill_failure BEFORE UPDATE ON im_kernel_reader_meter BEGIN SELECT RAISE(ABORT,'owned backfill failure'); END")
    const before = yield* snapshot(db)
    expect(Exit.isFailure(yield* Effect.exit(DatabaseMigration.applyOnly(db, failure === "late" ? failurePlan : selected)))).toBe(true)
    expect(yield* snapshot(db)).toEqual(before)
    return before
  }))
  expect(await open(filename, snapshot)).toEqual(original)
}), 60000)

for (const limit of ["records", "bytes"] as const) test(`overquota ${limit} rejects old owned obligations without modifying data`, () => isolated(async (filename) => {
  const original = await open(filename, (db) => Effect.gen(function* () {
    yield* seed(db)
    yield* db.run(limit === "records" ? "UPDATE im_kernel_reader_meter SET used_records=100000" : "UPDATE im_kernel_reader_meter SET used_bytes=268435456")
    const before = yield* snapshot(db)
    expect(Exit.isFailure(yield* Effect.exit(DatabaseMigration.applyOnly(db, selected)))).toBe(true)
    expect(yield* snapshot(db)).toEqual(before)
    return before
  }))
  expect(await open(filename, snapshot)).toEqual(original)
}), 60000)

test("exact record and byte quota boundaries admit complete obligation backfill", () => isolated(async (filename) => {
  await open(filename, (db) => Effect.gen(function* () {
    const expected = yield* seed(db)
    yield* db.run(sql`UPDATE im_kernel_reader_meter SET used_records=${recordLimit - expected.intentCount},
      used_bytes=${byteLimit - 16 * expected.ledgerCount - expected.obligationBytes}`)
    yield* DatabaseMigration.applyOnly(db, selected)
    expect(yield* db.get("SELECT used_records,used_bytes FROM im_kernel_reader_meter")).toEqual({ used_records: recordLimit, used_bytes: byteLimit })
  }))
}), 60000)

for (const action of ["CASCADE", "SET NULL", "SET DEFAULT"] as const) test(`unsafe incoming ${action} FK refuses before DDL and preserves original child/parent`, () => isolated(async (filename) => {
  const original = await open(filename, (db) => Effect.gen(function* () {
    yield* seed(db)
    yield* db.run(`CREATE TABLE owned_obligation_incoming_child(id INTEGER PRIMARY KEY,reader_key TEXT DEFAULT NULL,
      effect_key TEXT DEFAULT NULL, FOREIGN KEY(reader_key,effect_key) REFERENCES im_kernel_reader_message(reader_key,effect_key) ON DELETE ${action})`)
    yield* db.run(sql`INSERT INTO owned_obligation_incoming_child(id,reader_key,effect_key) VALUES(1,${readerKey},${effectKey})`)
    const before = yield* snapshot(db)
    expect(Exit.isFailure(yield* Effect.exit(DatabaseMigration.applyOnly(db, selected)))).toBe(true)
    expect(yield* snapshot(db)).toEqual(before)
    expect(yield* db.get("SELECT count(*) count FROM owned_obligation_incoming_child")).toEqual({ count: 1 })
    expect(yield* db.get("SELECT count(*) count FROM im_kernel_reader_message")).toEqual({ count: 2 })
    return before
  }))
  expect(await open(filename, snapshot)).toEqual(original)
}), 60000)
