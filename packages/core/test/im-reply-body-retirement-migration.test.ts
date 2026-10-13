import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import { createReadStream } from "node:fs"
import os from "node:os"
import path from "node:path"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@deepagent-code/effect-drizzle-sqlite"
import { sql } from "drizzle-orm"
import { Effect, Exit } from "effect"
import { DatabaseMigration } from "../src/database/migration"
import { migrations } from "../src/database/migration.gen"
import { KernelDelivery } from "../src/im/kernel-delivery"
import { KernelDeliverySchema } from "../src/im/kernel-delivery.schema"
import { ReplyBodyRetirement } from "../src/im/reply-body-retirement"
import { ReplyBodyRetirementModel } from "../src/im/reply-body-retirement.model"
import { ReplyDeliveryID } from "../src/im/reply-delivery-id"

const boundary = migrations.findIndex((entry) => entry.id === "20261010035405_im_reply_body_retirement")
const selected = migrations.slice(0, boundary + 1)
const previous = selected.slice(0, -1)
const migration = selected[boundary]!
const makeDb = EffectDrizzleSqlite.makeWithDefaults()
type Db = Effect.Success<typeof makeDb>
type RawRow = { [field: string]: string | number | null }
type Spec = { stage: "unbound" | "local" | "kernel"; state?: "prepared" | "dispatched" | "acknowledged" | "unknown"; text?: string }
const digest = (value: string) => createHash("sha256").update(value, "utf8").digest("hex")
const hash = ReplyBodyRetirementModel.hash
const workspace = "原工作区🙂"
const groupID = "img_reply_original"
const source = { realm: "https://fixture.invalid/", appkey: "原应用🙂", orgID: 1, senderID: "原发送者🙂", credentialFingerprint: "a".repeat(64) }

const open = <A, E>(filename: string, body: (db: Db) => Effect.Effect<A, E>, intact = true) =>
  Effect.runPromise(Effect.gen(function* () {
    const db = yield* makeDb
    yield* db.run("PRAGMA foreign_keys=ON")
    expect(yield* db.get("PRAGMA foreign_keys")).toEqual({ foreign_keys: 1 })
    const result = yield* body(db)
    if (intact) expect(yield* db.all("PRAGMA foreign_key_check")).toEqual([])
    expect(yield* db.get("PRAGMA foreign_keys")).toEqual({ foreign_keys: 1 })
    expect(yield* db.get("PRAGMA defer_foreign_keys")).toEqual({ defer_foreign_keys: 0 })
    expect(yield* db.get("PRAGMA quick_check")).toEqual({ quick_check: "ok" })
    return result
  }).pipe(Effect.provide(SqliteClient.layer({ filename })), Effect.scoped))

const isolated = async (body: (filename: string) => Promise<void>) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dac-reply-body-migration-"))
  const filename = path.join(directory, "database.sqlite")
  try { await body(filename) }
  finally { await fs.rm(directory, { recursive: true }); expect(await Bun.file(filename).exists()).toBe(false) }
}

// No historical body is printed. Failure snapshots use lengths and digests;
// the quota specimen also compares the complete cold DB with bounded reads.
const snapshot = (db: Db, large = false) => Effect.gen(function* () {
  const schema = yield* db.all<{ type: string; name: string; tbl_name: string; sql: string | null }>(
    "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name")
  return {
    schema: schema.map((row) => ({ type: row.type, name: row.name, table: row.tbl_name, hash: digest(row.sql ?? "") })),
    data: yield* Effect.forEach(schema.filter((row) => row.type === "table"), (table) => Effect.gen(function* () {
      if (!/^[a-zA-Z0-9_]+$/.test(table.name)) return yield* Effect.die("Unexpected private fixture identifier")
      const rows = large && table.name === "im_reply_outbox"
        ? yield* db.all("SELECT id,session_id,group_id,agent_id,trigger_message_id,reply_message_id,delivery_message_id,reply_text,status,attempts,available_at,lease_owner,lease_expires_at,length(CAST(last_error AS BLOB)) error_bytes,time_created,time_updated,time_delivered FROM im_reply_outbox ORDER BY id")
        : yield* db.all(`SELECT * FROM "${table.name}"`)
      return { table: table.name, count: rows.length, hash: digest(JSON.stringify(rows.map((row) => digest(JSON.stringify(row))).sort())) }
    })),
  }
})

// Previous official schema, legal historical admitted/settled storage only.
// No Session execution, provider, current Work/Native permission or service.
const seed = (db: Db, specs: readonly Spec[] = [
  { stage: "unbound" }, { stage: "local" }, { stage: "kernel", state: "prepared" },
  { stage: "kernel", state: "dispatched" }, { stage: "kernel", state: "unknown" },
  { stage: "kernel", state: "acknowledged" }, { stage: "unbound" },
]) => Effect.gen(function* () {
  yield* DatabaseMigration.applyOnly(db, previous)
  yield* db.run(sql`INSERT INTO im_groups(id,workspace_id,type,name,created_by,kernel_conv_id,created_at,updated_at)
    VALUES (${groupID},${workspace},'project',${"原群🙂"},'server','k:2:original-reply-group',10,10)`)
  yield* db.run("INSERT INTO project(id,worktree,sandboxes,time_created,time_updated) VALUES('reply-project','/private/reply-history','[]',10,10)")
  const ids: string[] = []
  for (const [index, spec] of specs.entries()) {
    const suffix = String(index).padStart(3, "0")
    const id = `imo_${suffix}`
    ids.push(id)
    const sessionID = `ses_im_original_${suffix}`
    const inputID = `msg_input_${suffix}`
    const finalID = `msg_final_${suffix}`
    const activityID = `activity_${suffix}`
    const sourceMessageID = `imsg_reply_source_${suffix}`
    const messageID = ReplyDeliveryID.fromOutbox(id)
    const text = spec.text ?? `原回复🙂 é <>& ${index}`
    const state = spec.state ?? "prepared"
    const status = state === "acknowledged" ? "delivered" : index === 1 ? "delivering" : index === 6 ? "dead" : "pending"
    yield* db.run(sql`INSERT INTO im_messages(id,group_id,sender_id,sender_type,type,content,created_at,updated_at)
      VALUES (${sourceMessageID},${groupID},'server','user','text',${"原接受源🙂"},10,10)`)
    yield* db.run(sql`INSERT INTO session(id,project_id,slug,directory,title,version,time_created,time_updated,v2_authority)
      VALUES (${sessionID},'reply-project',${suffix},'/private/reply-history','History','2',10,10,1)`)
    yield* db.run(sql`INSERT INTO session_input(id,session_id,prompt,delivery,admitted_seq,promoted_seq,time_created)
      VALUES (${inputID},${sessionID},'{}','steer',1,1,10)`)
    yield* db.run(sql`INSERT INTO session_activity(activity_id,session_id,ordinal,trigger_input_id,delivery,state,created_at,settled_at,final_message_id)
      VALUES (${activityID},${sessionID},1,${inputID},'steer','settled',10,11,${finalID})`)
    yield* db.run(sql`INSERT INTO session_activity_input(activity_id,input_id,ordinal,admitted_seq,role,promoted_at)
      VALUES (${activityID},${inputID},1,1,'trigger',10)`)
    yield* db.run(sql`INSERT INTO im_mention_intent(id,message_id,agent_name,directory,workspace_id,user_id,origin,session_id,input_id,status,created_at,updated_at)
      VALUES (${`imi_${suffix}`},${sourceMessageID},'auto','/private/reply-history',${workspace},'server','local',${sessionID},${inputID},'admitted',10,11)`)
    // Old delivering+NULL lease is legal and must not be normalized by DDL.
    yield* db.run(sql`INSERT INTO im_reply_outbox(id,session_id,group_id,agent_id,trigger_message_id,reply_message_id,delivery_message_id,reply_text,status,attempts,available_at,lease_owner,lease_expires_at,last_error,time_created,time_updated,time_delivered)
      VALUES (${id},${sessionID},${groupID},'auto',${inputID},${finalID},${messageID},${text},${status},${index},17,NULL,NULL,${index % 2 ? "原错误🙂 é 不得截断" : null},10,23,${status === "delivered" ? 22 : null})`)
    if (spec.stage === "unbound") continue
    const mentions = ["原代理🙂"]
    const metadata = { type: "agent_run", sessionID, status: "success" }
    const message = { id: messageID, group_id: groupID, sender_id: "auto", sender_type: "agent", type: "text", content: text,
      mentions, metadata, reply_to_id: null, client_request_id: `原请求🙂_${index}`, created_at: 10 }
    yield* db.run(sql`INSERT INTO im_messages(id,group_id,sender_id,sender_type,type,content,mentions,metadata,event_id,delivery_status,created_at,updated_at,kernel_msg_id,client_request_id)
      VALUES (${messageID},${groupID},'auto','agent','text',${text},${JSON.stringify(mentions, null, 1)},${JSON.stringify(metadata, null, 2)},
        ${`原事件🙂_${index}`},${index % 2 ? "pending" : null},10,23,${state === "acknowledged" ? `原核消息🙂_${index}` : null},${message.client_request_id})`)
    if (spec.stage === "local") continue
    const binding: KernelDeliverySchema.TextBinding = { version: 1, messageID, groupID, workspaceID: workspace, source,
      conversationType: 2, conversationID: "original-reply-group", messageHash: ReplyBodyRetirementModel.messageHash(message),
      wireID: `dac_${hash(["im-kernel-wire-v1", source, messageID])}`, textHash: hash(`[Agent·auto] ${text}`), createdAt: 10, expiresAt: 259200010 }
    yield* db.run(sql`INSERT INTO im_kernel_delivery(message_id,binding,binding_hash,wire_id,state,dispatch_owner,kernel_message_id,reason,created_at,dispatched_at,acknowledged_at,updated_at)
      VALUES (${messageID},${JSON.stringify(binding, null, 2)},${hash(binding)},${binding.wireID},${state},${state === "prepared" ? null : `原owner🙂_${index}`},
        ${state === "acknowledged" ? `原核消息🙂_${index}` : null},${state === "unknown" ? "原未知 不得改成成功🙂" : null},10,
        ${state === "prepared" ? null : 11},${state === "acknowledged" ? 12 : null},23)`)
  }
  return ids
})

// Oracle discovers the actual SQL columns rather than reusing production's
// field lists/accounting. JSON text is counted as stored BLOB bytes.
const rowBytes = (db: Db, table: string, key: string, value: string | number) => Effect.gen(function* () {
  const columns = yield* db.all<{ name: string; type: string }>(`PRAGMA table_info("${table}")`)
  const expression = columns.map((column) => /INT/i.test(column.type)
    ? `CASE WHEN "${column.name}" IS NULL THEN 0 ELSE 8 END`
    : `coalesce(length(CAST("${column.name}" AS BLOB)),0)`).join("+")
  return (yield* db.get<{ bytes: number }>(sql`SELECT ${sql.raw(expression)} bytes FROM ${sql.raw(`"${table}"`)} WHERE ${sql.raw(`"${key}"`)}=${value}`))?.bytes ?? 0
})
const audit = (db: Db) => Effect.gen(function* () {
  const bodies = yield* db.all<RawRow>("SELECT * FROM im_reply_body ORDER BY outbox_id")
  const meter = (yield* db.get<RawRow>("SELECT * FROM im_reply_body_meter"))!
  const singleton = yield* rowBytes(db, "im_reply_body_meter", "meter_id", 1)
  expect(singleton).toBe(76)
  let total = singleton
  let records = 1
  for (const body of bodies) {
    const count = 2 + Number(body.local_message_id !== null) + Number(body.receipt_message_id !== null)
    const bytes = (yield* rowBytes(db, "im_reply_body", "outbox_id", String(body.outbox_id))) +
      (yield* rowBytes(db, "im_reply_outbox", "id", String(body.outbox_id))) +
      (body.local_message_id === null ? 0 : yield* rowBytes(db, "im_messages", "id", String(body.local_message_id))) +
      (body.receipt_message_id === null ? 0 : yield* rowBytes(db, "im_kernel_delivery", "message_id", String(body.receipt_message_id)))
    expect(body.accounted_records).toBe(count)
    expect(body.accounted_bytes).toBe(bytes)
    total += bytes
    records += count
  }
  expect(meter.used_records).toBe(records)
  expect(meter.used_bytes).toBe(total)
  return { meter, bodies, records, bytes: total }
})
const failedPlan = [...previous, { ...migration, up: (tx: Parameters<DatabaseMigration.Migration["up"]>[0]) => Effect.gen(function* () {
  yield* migration.up(tx)
  return yield* tx.run("SELECT * FROM reply_owned_late_failure")
}) }]
const fileHash = async (filename: string) => {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(filename, { highWaterMark: 65536 })) hash.update(chunk)
  return hash.digest("hex")
}

test("fresh official reply migration and cold reapply preserve singleton76 and FK-on custody", () => isolated(async (filename) => {
  const first = await open(filename, (db) => Effect.gen(function* () {
    expect(boundary).toBeGreaterThan(0)
    yield* DatabaseMigration.applyOnly(db, selected)
    expect((yield* audit(db)).records).toBe(1)
    expect((yield* db.all("PRAGMA foreign_key_list(im_reply_body)")).length).toBe(5)
    return yield* snapshot(db)
  }))
  expect(await open(filename, (db) => Effect.gen(function* () { yield* DatabaseMigration.applyOnly(db, selected); return yield* snapshot(db) }))).toEqual(first)
}), 60000)

test("previous staged2/3/4 Unicode copies preserve every original raw field and honest independent meter", () => isolated(async (filename) => {
  const first = await open(filename, (db) => Effect.gen(function* () {
    const ids = yield* seed(db)
    const old = yield* db.all<RawRow>("SELECT * FROM im_reply_outbox ORDER BY id")
    const before = yield* snapshot(db)
    yield* DatabaseMigration.applyOnly(db, selected)
    const current = yield* db.all<RawRow>("SELECT * FROM im_reply_outbox ORDER BY id")
    expect(digest(JSON.stringify(current.map((row) => { expect(row.body_state).toBe("live"); return Object.fromEntries(Object.entries(row).filter(([key]) => key !== "body_state")) })))).toBe(digest(JSON.stringify(old)))
    const totals = yield* audit(db)
    expect(totals.bodies.map((row) => row.accounted_records)).toEqual([2, 3, 4, 4, 4, 4, 2])
    expect(totals.records).toBe(24)
    expect(totals.bodies.map((row) => row.origin_kind)).toEqual(ids.map(() => "mention"))
    const after = yield* snapshot(db)
    expect(after.data.filter((row) => !["migration", "im_reply_outbox", "im_reply_body", "im_reply_body_meter"].includes(row.table)))
      .toEqual(before.data.filter((row) => !["migration", "im_reply_outbox"].includes(row.table)))
    expect(current[1]!.status).toBe("delivering")
    expect(current[1]!.lease_owner).toBeNull()
    expect(current[1]!.lease_expires_at).toBeNull()
    return after
  }))
  expect(await open(filename, (db) => Effect.gen(function* () { yield* DatabaseMigration.applyOnly(db, selected); yield* audit(db); return yield* snapshot(db) }))).toEqual(first)
}), 60000)

test("old missing-group original closure stays sealed legacy and cannot adopt a later same-ID group", () => isolated(async (filename) => {
  const id = await open(filename, (db) => Effect.gen(function* () {
    const ids = yield* seed(db, [{ stage: "unbound" }])
    yield* db.run(sql`DELETE FROM im_groups WHERE id=${groupID}`)
    const before = yield* db.all<RawRow>("SELECT * FROM im_reply_outbox")
    yield* DatabaseMigration.applyOnly(db, selected)
    const body = yield* ReplyBodyRetirement.read(db, ids[0]!)
    expect(body.record.origin.kind).toBe("legacy_unbound")
    expect(body.record.custody).toBe("legacy_unbound")
    expect(body.body.accounted_records).toBe(2)
    expect(body.body.group_ref).toBeNull()
    expect(digest(JSON.stringify(Object.fromEntries(Object.entries(body.rawOutbox).filter(([key]) => key !== "body_state"))))).toBe(digest(JSON.stringify(before[0])))
    yield* audit(db)
    return ids[0]!
  }))
  await open(filename, (db) => Effect.gen(function* () {
    yield* db.run(sql`INSERT INTO im_groups(id,workspace_id,type,name,created_by,created_at,updated_at) VALUES(${groupID},'foreign','project','Later group','foreign',30,30)`)
    expect(Exit.isFailure(yield* Effect.exit(ReplyBodyRetirement.preflight(db, ReplyDeliveryID.fromOutbox(id))))).toBe(true)
    expect(yield* db.get("SELECT origin_kind,custody_state,group_ref,accounted_records FROM im_reply_body"))
      .toEqual({ origin_kind: "legacy_unbound", custody_state: "legacy_unbound", group_ref: null, accounted_records: 2 })
    expect(Exit.isFailure(yield* Effect.exit(db.run(sql`UPDATE im_reply_body SET group_ref=${groupID} WHERE outbox_id=${id}`)))).toBe(true)
  }))
}), 60000)

test("one legal9MiB UTF8 error and unbound oversized body backfill fully without a fake wire limit", () => isolated(async (filename) => {
  await open(filename, (db) => Effect.gen(function* () {
    const ids = yield* seed(db, [{ stage: "unbound", text: "x".repeat(70_000) }])
    const error = "中文🙂".repeat(943718)
    yield* db.run(sql`UPDATE im_reply_outbox SET last_error=${error} WHERE id=${ids[0]}`)
    const before = yield* snapshot(db)
    const bytes = (yield* db.get<{ bytes: number }>("SELECT length(CAST(last_error AS BLOB)) bytes FROM im_reply_outbox"))!.bytes
    expect(bytes).toBe(Buffer.byteLength(error))
    expect(bytes).toBeGreaterThan(9 * 1024 * 1024 - 10)
    yield* DatabaseMigration.applyOnly(db, selected)
    const body = yield* ReplyBodyRetirement.read(db, ids[0]!)
    expect(body.body.accounted_records).toBe(2)
    expect(body.record.origin.replyBytes).toBe(70_000)
    expect(body.record.transport).toBeNull()
    expect(digest(String(body.rawOutbox.last_error))).toBe(digest(error))
    yield* audit(db)
    expect((yield* snapshot(db)).data.filter((row) => !["migration", "im_reply_outbox", "im_reply_body", "im_reply_body_meter"].includes(row.table)))
      .toEqual(before.data.filter((row) => !["migration", "im_reply_outbox"].includes(row.table)))
  }))
}), 60000)

test("ADD COLUMN preserves same-name schema guards and all incoming FK actions while custody rejects real parent delete", () => isolated(async (filename) => {
  await open(filename, (db) => Effect.gen(function* () {
    const ids = yield* seed(db, [{ stage: "unbound" }])
    yield* db.run("CREATE TABLE reply_owned_guard(outbox_id TEXT NOT NULL)")
    yield* db.run("CREATE TRIGGER reply_owned_guard BEFORE DELETE ON im_reply_outbox BEGIN INSERT INTO reply_owned_guard VALUES(OLD.id); END")
    yield* db.run("CREATE INDEX reply_owned_identity_guard ON im_reply_outbox(agent_id,reply_message_id)")
    for (const [index, action] of ["NO ACTION", "RESTRICT", "CASCADE", "SET NULL", "SET DEFAULT"].entries()) {
      yield* db.run(`CREATE TABLE reply_owned_child_${index}(id INTEGER PRIMARY KEY,outbox_id TEXT DEFAULT '${ids[0]}' REFERENCES im_reply_outbox(id) ON DELETE ${action} ON UPDATE ${action})`)
      yield* db.run(sql`INSERT INTO ${sql.raw(`reply_owned_child_${index}`)} VALUES(1,${ids[0]})`)
    }
    const before = yield* snapshot(db)
    yield* DatabaseMigration.applyOnly(db, selected)
    const after = yield* snapshot(db)
    for (const original of before.schema.filter((row) => row.table === "im_reply_outbox" && row.type !== "table" || row.name.startsWith("reply_owned"))) {
      expect(after.schema.find((row) => row.type === original.type && row.name === original.name)).toEqual(original)
    }
    expect(after.schema.some((row) => row.type === "index" && row.name === "im_reply_outbox_session_reply_idx" && row.table === "im_reply_outbox")).toBe(true)
    expect(after.data.filter((row) => row.table.startsWith("reply_owned"))).toEqual(before.data.filter((row) => row.table.startsWith("reply_owned")))
    expect(Exit.isFailure(yield* Effect.exit(db.run(sql`DELETE FROM im_reply_outbox WHERE id=${ids[0]}`)))).toBe(true)
    expect(Exit.isFailure(yield* Effect.exit(db.run(sql`UPDATE im_reply_outbox SET id='foreign' WHERE id=${ids[0]}`)))).toBe(true)
    expect((yield* snapshot(db)).data.filter((row) => row.table.startsWith("reply_owned"))).toEqual(before.data.filter((row) => row.table.startsWith("reply_owned")))
    yield* audit(db)
  }))
}), 60000)

test("outer deferON refuses before DDL and does not clear the caller's pending constraint policy", () => isolated(async (filename) => {
  const before = await open(filename, (db) => Effect.gen(function* () {
    yield* seed(db, [{ stage: "unbound" }])
    const before = yield* snapshot(db)
    yield* db.transaction((tx) => Effect.gen(function* () {
      yield* tx.run("PRAGMA defer_foreign_keys=ON")
      expect(Exit.isFailure(yield* Effect.exit(migration.up(tx)))).toBe(true)
      expect(yield* tx.get("PRAGMA defer_foreign_keys")).toEqual({ defer_foreign_keys: 1 })
      expect(yield* tx.all("SELECT name FROM sqlite_master WHERE name LIKE 'im_reply_body%'")).toEqual([])
      yield* tx.run("PRAGMA defer_foreign_keys=OFF")
    }))
    expect(yield* snapshot(db)).toEqual(before)
    return before
  }))
  expect(await open(filename, (db) => snapshot(db))).toEqual(before)
}), 60000)

test("existing genuine FK corruption refuses before any new body state and preserves the cold old DB", () => isolated(async (filename) => {
  const before = await open(filename, (db) => Effect.gen(function* () {
    yield* seed(db, [{ stage: "unbound" }])
    yield* db.run("CREATE TABLE reply_owned_corrupt(id INTEGER PRIMARY KEY,outbox_id TEXT REFERENCES im_reply_outbox(id))")
    // Historical corruption is constructed only in this private fixture; the
    // migration itself must run FK-on and refuse, never repair/delete history.
    yield* db.run("PRAGMA foreign_keys=OFF")
    yield* db.run("INSERT INTO reply_owned_corrupt VALUES(1,'missing-old-parent')")
    yield* db.run("PRAGMA foreign_keys=ON")
    expect((yield* db.all("PRAGMA foreign_key_check")).length).toBe(1)
    const before = yield* snapshot(db)
    expect(Exit.isFailure(yield* Effect.exit(DatabaseMigration.applyOnly(db, selected)))).toBe(true)
    expect(yield* snapshot(db)).toEqual(before)
    return before
  }), false)
  expect(await open(filename, (db) => snapshot(db), false)).toEqual(before)
}), 60000)

for (const late of ["last-backfill", "after-up", "missing-message"] as const) test(`whole official reply TX rolls back ${late} failure including old data and journal`, () => isolated(async (filename) => {
  const before = await open(filename, (db) => Effect.gen(function* () {
    const ids = yield* seed(db, Array.from({ length: late === "last-backfill" ? 33 : 1 }, () => ({ stage: "kernel" as const })))
    if (late === "last-backfill") yield* db.run(sql`UPDATE im_kernel_delivery SET binding_hash=${"0".repeat(64)} WHERE message_id=${ReplyDeliveryID.fromOutbox(ids[32]!)}`)
    if (late === "missing-message") yield* db.run(sql`DELETE FROM im_messages WHERE id=${ReplyDeliveryID.fromOutbox(ids[0]!)}`)
    const before = yield* snapshot(db)
    expect(Exit.isFailure(yield* Effect.exit(DatabaseMigration.applyOnly(db, late === "after-up" ? failedPlan : selected)))).toBe(true)
    expect(yield* snapshot(db)).toEqual(before)
    return before
  }))
  expect(await open(filename, (db) => snapshot(db))).toEqual(before)
}), 60000)

test("full256MiB legacy error budget refuses without changing unknown obligations or any original cold bytes", () => isolated(async (filename) => {
  const before = await open(filename, (db) => Effect.gen(function* () {
    const ids = yield* seed(db, [{ stage: "kernel", state: "unknown" }])
    yield* db.run(sql`UPDATE im_reply_outbox SET last_error=printf('%*s',268435456,'') WHERE id=${ids[0]}`)
    expect(yield* db.get("SELECT length(CAST(last_error AS BLOB)) bytes FROM im_reply_outbox")).toEqual({ bytes: 268435456 })
    return yield* snapshot(db, true)
  }))
  const originalHash = await fileHash(filename)
  await open(filename, (db) => Effect.gen(function* () {
    expect(Exit.isFailure(yield* Effect.exit(DatabaseMigration.applyOnly(db, selected)))).toBe(true)
    expect(yield* snapshot(db, true)).toEqual(before)
  }))
  expect(await fileHash(filename)).toBe(originalHash)
  expect(await open(filename, (db) => snapshot(db, true))).toEqual(before)
  expect(await fileHash(filename)).toBe(originalHash)
}), 60000)

test("migrated ACK retires copies once and cold original history preserves facts without a live body or new intent", () => isolated(async (filename) => {
  const original = await open(filename, (db) => Effect.gen(function* () {
    const ids = yield* seed(db, [{ stage: "kernel", state: "acknowledged" }])
    yield* DatabaseMigration.applyOnly(db, selected)
    const before = yield* ReplyBodyRetirement.read(db, ids[0]!)
    expect(yield* db.transaction((tx) => ReplyBodyRetirement.retire(tx, ids[0]!, 259200010), { behavior: "immediate" })).toBe(true)
    const after = yield* ReplyBodyRetirement.read(db, ids[0]!)
    expect(after.record.origin).toEqual(before.record.origin)
    expect(after.record.transport).toEqual(before.record.transport)
    expect(after.outbox.status).toBe(before.outbox.status)
    expect(digest(JSON.stringify(Object.fromEntries(Object.entries(after.rawOutbox).filter(([key]) => !["reply_text", "body_state"].includes(key))))))
      .toBe(digest(JSON.stringify(Object.fromEntries(Object.entries(before.rawOutbox).filter(([key]) => !["reply_text", "body_state"].includes(key))))))
    expect(digest(JSON.stringify(Object.fromEntries(Object.entries(after.rawReceipt!).filter(([key]) => !["binding", "body_state"].includes(key))))))
      .toBe(digest(JSON.stringify(Object.fromEntries(Object.entries(before.rawReceipt!).filter(([key]) => !["binding", "body_state"].includes(key))))))
    expect(after.rawOutbox.reply_text).toBe("")
    expect(after.message?.content).toBe("")
    expect(after.receipt?.binding).toBeNull()
    yield* audit(db)
    return { id: ids[0]!, messageID: ReplyDeliveryID.fromOutbox(ids[0]!), snapshot: yield* snapshot(db) }
  }))
  await open(filename, (db) => Effect.gen(function* () {
    yield* DatabaseMigration.applyOnly(db, selected)
    expect((yield* KernelDelivery.history(db, original.messageID)).kind).toBe("reply_retired")
    expect(Exit.isFailure(yield* Effect.exit(KernelDelivery.read(db, original.messageID)))).toBe(true)
    expect(yield* ReplyBodyRetirement.exactCollected(db, { id: original.id, sessionID: "ses_im_original_000", replyMessageID: "msg_final_000" })).toBe(true)
    expect(yield* db.transaction((tx) => ReplyBodyRetirement.retire(tx, original.id, 259200010))).toBe(false)
    expect(yield* snapshot(db)).toEqual(original.snapshot)
    yield* audit(db)
  }))
}), 60000)

test("original text-v1 wire exactly65536B migrates without expanding its original identity", () => isolated(async (filename) => {
  await open(filename, (db) => Effect.gen(function* () {
    const text = "x".repeat(65536 - Buffer.byteLength(JSON.stringify({ content: "[Agent·auto] " })))
    expect(Buffer.byteLength(JSON.stringify({ content: `[Agent·auto] ${text}` }))).toBe(65536)
    const ids = yield* seed(db, [{ stage: "kernel", state: "acknowledged", text }])
    yield* DatabaseMigration.applyOnly(db, selected)
    expect((yield* ReplyBodyRetirement.read(db, ids[0]!)).record.transport?.wireBytes).toBe(65536)
    yield* audit(db)
  }))
}), 60000)

for (const invalid of ["over-limit", "invalid-unicode"] as const) test(`illegal old ACK ${invalid} refuses and preserves every original row`, () => isolated(async (filename) => {
  const before = await open(filename, (db) => Effect.gen(function* () {
    const text = invalid === "over-limit" ? "x".repeat(65537 - Buffer.byteLength(JSON.stringify({ content: "[Agent·auto] " }))) : "\ud800"
    yield* seed(db, [{ stage: "kernel", state: "acknowledged", text }])
    const before = yield* snapshot(db)
    expect(Exit.isFailure(yield* Effect.exit(DatabaseMigration.applyOnly(db, selected)))).toBe(true)
    expect(yield* snapshot(db)).toEqual(before)
    return before
  }))
  expect(await open(filename, (db) => snapshot(db))).toEqual(before)
}), 60000)
