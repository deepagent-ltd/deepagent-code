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
import { KernelDeliverySchema } from "../src/im/kernel-delivery.schema"
import { KernelMediaRetirementModel } from "../src/im/kernel-media-retirement.model"

const boundary = migrations.findIndex((migration) => migration.id === "20261010022200_im_kernel_media_body_retirement")
const selected = migrations.slice(0, boundary + 1)
const previous = selected.slice(0, -1)
const migration = selected[boundary]
const makeDb = EffectDrizzleSqlite.makeWithDefaults()
type Db = Effect.Success<typeof makeDb>
type RawRow = { [field: string]: string | number | null }
const digest = (value: string) => createHash("sha256").update(value, "utf8").digest("hex")
const hash = KernelMediaRetirementModel.hash
const source = { realm: "https://fixture.invalid/", appkey: "原应用🙂", orgID: null, senderID: "原发送者🙂", credentialFingerprint: "a".repeat(64) }
const workspace = "原工作区🙂"
const groupID = "img_media_original"

const open = <A, E>(filename: string, body: (db: Db) => Effect.Effect<A, E>) => Effect.runPromise(Effect.gen(function* () {
  const db = yield* makeDb
  yield* db.run("PRAGMA foreign_keys=ON")
  expect(yield* db.get("PRAGMA foreign_keys")).toEqual({ foreign_keys: 1 })
  const value = yield* body(db)
  expect(yield* db.all("PRAGMA foreign_key_check")).toEqual([])
  expect(yield* db.get("PRAGMA defer_foreign_keys")).toEqual({ defer_foreign_keys: 0 })
  expect(yield* db.get("PRAGMA quick_check")).toEqual({ quick_check: "ok" })
  return value
}).pipe(Effect.provide(SqliteClient.layer({ filename })), Effect.scoped))

const isolated = async (body: (filename: string) => Promise<void>) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dac-core-media-retirement-migration-"))
  const filename = path.join(directory, "database.sqlite")
  try { await body(filename) }
  finally {
    await fs.rm(directory, { recursive: true })
    expect(await Bun.file(filename).exists()).toBe(false)
  }
}

// Failures compare only digests/lengths: caption, descriptor and legacy reason
// fixtures never appear in assertion output. The one quota specimen is also
// compared as a complete cold SQLite file with bounded filesystem reads.
const snapshot = (db: Db, largeReason = false) => Effect.gen(function* () {
  const schema = yield* db.all<{ type: string; name: string; tbl_name: string; sql: string | null }>(
    "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name")
  return {
    schema: schema.map((entry) => ({ type: entry.type, name: entry.name, table: entry.tbl_name, hash: digest(entry.sql ?? "") })),
    data: yield* Effect.forEach(schema.filter((entry) => entry.type === "table"), (table) => Effect.gen(function* () {
      if (!/^[a-zA-Z0-9_]+$/.test(table.name)) return yield* Effect.die("Unexpected private fixture table identifier")
      if (largeReason && table.name === "im_kernel_delivery") {
        const rows = yield* db.all<RawRow>("SELECT message_id,binding,binding_hash,wire_id,state,dispatch_owner,kernel_message_id,created_at,dispatched_at,acknowledged_at,updated_at,length(CAST(reason AS BLOB)) AS reason_bytes FROM im_kernel_delivery ORDER BY message_id")
        return { table: table.name, count: rows.length, hash: digest(JSON.stringify(rows)) }
      }
      const rows = yield* db.all(`SELECT * FROM "${table.name}"`)
      return { table: table.name, count: rows.length, hash: digest(JSON.stringify(rows.map((row) => digest(JSON.stringify(row))).sort())) }
    })),
  }
})

// Real previous official SQLite schema, original v2 renderer and digests. These
// are legal historical storage specimens, not a runtime, upload or permission.
const seed = (db: Db, count = 4) => Effect.gen(function* () {
  yield* DatabaseMigration.applyOnly(db, previous)
  yield* db.run(sql`INSERT INTO im_groups(id,workspace_id,type,name,created_by,kernel_conv_id,created_at,updated_at)
    VALUES (${groupID},${workspace},'project',${"原群🙂"},'server','k:2:original-native-group',10,10)`)
  const ids: string[] = []
  for (let index = 0; index < count; index++) {
    const id = `imsg_media_${String(index).padStart(3, "0")}`
    ids.push(id)
    const state = (["prepared", "dispatched", "unknown", "acknowledged"] as const)[index % 4]!
    const content = `原正文🙂 <>& ${index}`
    const mentions = ["原代理🙂", "其他代理"]
    const metadata = [{ type: "attachment_ref", attachmentID: `local_${index}_0`, batch: true }, { type: "attachment_ref", attachmentID: `local_${index}_1`, batch: true }]
    const message = { id, group_id: groupID, sender_id: "server", sender_type: "user", type: "file", content,
      mentions, metadata, reply_to_id: null, created_at: 10, client_request_id: `原请求🙂_${index}` }
    const attachments = [0, 1].map((position) => ({ attachmentID: digest(`original-object-${index}-${position}`),
      contentRef: digest(`original-object-${index}-${position}`), filename: `原附件🙂_${position}.txt`, mime: "text/plain; charset=utf-8",
      sizeBytes: position, sha256: digest("x".repeat(position)), createdAt: 1 + position, expiresAt: 86400001 + position }))
    const localAttachments = attachments.map((remote, position) => ({ localAttachmentID: `local_${index}_${position}`,
      attachmentID: remote.attachmentID, identityHash: hash([`local_${index}_${position}`, workspace, null, groupID,
        "server", `/private/never-opened/${index}/${position}`, remote.filename, "text/plain", remote.sizeBytes, remote.sha256, 1 + position]) }))
    const wireContent = KernelMediaRetirementModel.mediaWire(content, attachments)
    const binding: KernelDeliverySchema.MediaBinding = { version: 2, messageID: id, groupID, workspaceID: workspace, source,
      conversationType: 2, conversationID: "original-native-group", messageHash: KernelMediaRetirementModel.messageHash(message),
      wireID: `dac_${hash(["im-kernel-wire-media-v2", source, id])}`, textHash: hash(content), createdAt: 10,
      expiresAt: 86400001, messageType: "dac:media.v1", wireContent, wireHash: digest(wireContent), attachments, localAttachments }
    yield* db.run(sql`INSERT INTO im_messages(id,group_id,sender_id,sender_type,type,content,mentions,metadata,created_at,updated_at,kernel_msg_id,client_request_id)
      VALUES (${id},${groupID},'server','user','file',${content},${JSON.stringify(mentions, null, 1)},${JSON.stringify(metadata, null, 2)},10,13,
        ${state === "acknowledged" ? `原核消息🙂_${index}` : null},${message.client_request_id})`)
    for (let position = 0; position < attachments.length; position++) {
      const remote = attachments[position]!
      yield* db.run(sql`INSERT INTO im_attachments(id,workspace_id,group_id,message_id,uploaded_by,storage_path,filename,mime,size_bytes,checksum,created_at)
        VALUES (${localAttachments[position]!.localAttachmentID},${workspace},${groupID},${id},'server',${`/private/never-opened/${index}/${position}`},
          ${remote.filename},'text/plain',${remote.sizeBytes},${remote.sha256},${remote.createdAt})`)
    }
    yield* db.run(sql`INSERT INTO im_kernel_delivery(message_id,binding,binding_hash,wire_id,state,dispatch_owner,kernel_message_id,reason,created_at,dispatched_at,acknowledged_at,updated_at)
      VALUES (${id},${JSON.stringify(binding, null, 2)},${hash(binding)},${binding.wireID},${state},${state === "prepared" ? null : `原owner_${index}`},
        ${state === "acknowledged" ? `原核消息🙂_${index}` : null},${state === "unknown" ? "原未知结果🙂 不允许转success" : null},10,
        ${state === "prepared" ? null : 11},${state === "acknowledged" ? 12 : null},13)`)
  }
  const textMessage = { id: "imsg_text_control", group_id: groupID, sender_id: "server", sender_type: "user", type: "text",
    content: "原文本🙂", mentions: null, metadata: null, reply_to_id: null, created_at: 10, client_request_id: null }
  const text = { version: 1, messageID: textMessage.id, groupID, workspaceID: workspace, source, conversationType: 2,
    conversationID: "original-native-group", messageHash: KernelMediaRetirementModel.messageHash(textMessage),
    wireID: `dac_${hash(["im-kernel-wire-v1", source, textMessage.id])}`, textHash: hash(textMessage.content), createdAt: 10, expiresAt: 86400010 }
  yield* db.run(sql`INSERT INTO im_messages(id,group_id,sender_id,sender_type,type,content,created_at,updated_at)
    VALUES ('imsg_text_control',${groupID},'server','user','text',${"原文本🙂"},10,10)`)
  yield* db.run(sql`INSERT INTO im_kernel_delivery(message_id,binding,binding_hash,wire_id,state,created_at,updated_at)
    VALUES ('imsg_text_control',${JSON.stringify(text)},${hash(text)},${text.wireID},'prepared',10,10)`)
  return { ids }
})

const rawBytes = (row: RawRow) => Object.values(row).reduce<number>((total, value) => total +
  (value === null ? 0 : typeof value === "number" ? 8 : Buffer.byteLength(value, "utf8")), 0)
const audit = (db: Db, ids: string[]) => Effect.gen(function* () {
  const meter = (yield* db.all<RawRow>("SELECT * FROM im_kernel_media_meter"))[0]!
  const bodies = yield* db.all<RawRow>("SELECT * FROM im_kernel_media_body ORDER BY message_id")
  expect(bodies.map((row) => row.message_id)).toEqual(ids)
  let total = rawBytes(meter)
  for (const body of bodies) {
    const receipt = yield* db.get<RawRow>(sql`SELECT * FROM im_kernel_delivery WHERE message_id=${body.message_id}`)
    const message = yield* db.get<RawRow>(sql`SELECT * FROM im_messages WHERE id=${body.message_id}`)
    if (!receipt || !message) return yield* Effect.die("Original custody disappeared")
    const counted = rawBytes(body) + rawBytes(receipt) + rawBytes(message)
    expect(body.accounted_records).toBe(3)
    expect(body.accounted_bytes).toBe(counted)
    total += counted
  }
  expect(rawBytes(meter)).toBe(76)
  expect(meter.used_records).toBe(1 + 3 * ids.length)
  expect(meter.used_bytes).toBe(total)
  return { bodies, meter, total }
})

const failurePlan = [...previous, { ...migration,
  up: (tx: Parameters<DatabaseMigration.Migration["up"]>[0]) => Effect.gen(function* () {
    yield* migration.up(tx)
    return yield* tx.run("SELECT * FROM media_owned_late_failure")
  }),
}]

const fileHash = async (filename: string) => {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(filename, { highWaterMark: 65536 })) hash.update(chunk)
  return hash.digest("hex")
}

test("fresh official media body migration installs independent meter/custody FK and cold reapply is exact", () => isolated(async (filename) => {
  const first = await open(filename, (db) => Effect.gen(function* () {
    expect(boundary).toBeGreaterThan(0)
    yield* DatabaseMigration.applyOnly(db, selected)
    expect(yield* db.get("SELECT version,revision,used_records,used_bytes FROM im_kernel_media_meter")).toEqual({ version: 1, revision: 1, used_records: 1, used_bytes: 76 })
    expect(yield* db.all("SELECT * FROM im_kernel_media_body")).toEqual([])
    expect((yield* db.all("PRAGMA foreign_key_list(im_kernel_media_body)")).length).toBe(4)
    expect(yield* db.all("SELECT name FROM sqlite_master WHERE name='__new_im_kernel_delivery'")).toEqual([])
    return yield* snapshot(db)
  }))
  expect(await open(filename, (db) => Effect.gen(function* () { yield* DatabaseMigration.applyOnly(db, selected); return yield* snapshot(db) }))).toEqual(first)
}), 60000)

test("old ordered Unicode v2 receipts preserve every raw fact/schema guard while fully charging copies and cold reapply", () => isolated(async (filename) => {
  const original = await open(filename, (db) => Effect.gen(function* () {
    const seeded = yield* seed(db)
    yield* db.run("CREATE TABLE media_owned_guard(message_id TEXT NOT NULL)")
    yield* db.run("CREATE TRIGGER media_owned_guard BEFORE DELETE ON im_kernel_delivery BEGIN INSERT INTO media_owned_guard VALUES(OLD.message_id); END")
    yield* db.run("CREATE INDEX media_owned_identity_guard ON im_kernel_delivery(binding_hash)")
    const before = yield* snapshot(db)
    const old = yield* db.all<RawRow>("SELECT * FROM im_kernel_delivery ORDER BY message_id")
    const guards = yield* db.all("SELECT type,name,sql FROM sqlite_master WHERE tbl_name='im_kernel_delivery' AND type IN ('index','trigger') AND sql IS NOT NULL ORDER BY type,name")
    yield* DatabaseMigration.applyOnly(db, selected)
    const result = yield* audit(db, seeded.ids)
    expect(result.meter.revision).toBe(1 + seeded.ids.length)
    const after = yield* snapshot(db)
    expect((yield* db.all<RawRow>("SELECT * FROM im_kernel_delivery ORDER BY message_id")).map((row) => {
      expect(row.body_state).toBe("live")
      return Object.fromEntries(Object.entries(row).filter(([key]) => key !== "body_state"))
    })).toEqual(old)
    expect(after.data.filter((table) => !["migration", "im_kernel_delivery", "im_kernel_media_meter", "im_kernel_media_body"].includes(table.table)))
      .toEqual(before.data.filter((table) => !["migration", "im_kernel_delivery"].includes(table.table)))
    expect(yield* db.all("SELECT type,name,sql FROM sqlite_master WHERE tbl_name='im_kernel_delivery' AND type IN ('index','trigger') AND sql IS NOT NULL ORDER BY type,name")).toEqual(guards)
    expect(yield* db.all("SELECT * FROM media_owned_guard")).toEqual([])
    const record = JSON.parse(String(result.bodies[2]!.record))
    expect(record.identity.source.orgID).toBeNull()
    expect(record.bodyState).toBe("live")
    expect(record.identity.originalBindingBytes).toBe(Buffer.byteLength(String(old[2]!.binding), "utf8"))
    expect(record.identity.originalCaptionBytes).toBe(Buffer.byteLength("原正文🙂 <>& 2", "utf8"))
    expect(record.identity.manifest.map((item: { localAttachmentID: string }) => item.localAttachmentID)).toEqual(["local_2_0", "local_2_1"])
    expect(record.identity.remoteManifestHash).toBe(hash(JSON.parse(String(old[2]!.binding)).attachments))
    expect(record.transportHash).toBe(KernelMediaRetirementModel.transportHash({ state: "unknown", dispatchOwner: "原owner_2", kernelMessageID: null,
      reason: "原未知结果🙂 不允许转success", createdAt: 10, dispatchedAt: 11, acknowledgedAt: null, updatedAt: 13 }))
    expect(String(result.bodies[2]!.record)).not.toContain("原正文")
    expect(String(result.bodies[2]!.record)).not.toContain("原附件")
    expect(Exit.isFailure(yield* Effect.exit(db.run(sql`DELETE FROM im_messages WHERE id=${seeded.ids[0]}`)))).toBe(true)
    expect(Exit.isFailure(yield* Effect.exit(db.run(sql`DELETE FROM im_groups WHERE id=${groupID}`)))).toBe(true)
    expect(Exit.isFailure(yield* Effect.exit(db.run("DELETE FROM im_kernel_media_meter")))).toBe(true)
    return after
  }))
  expect(await open(filename, (db) => Effect.gen(function* () { yield* DatabaseMigration.applyOnly(db, selected); return yield* snapshot(db) }))).toEqual(original)
}), 60000)

for (const action of ["NO ACTION", "RESTRICT"] as const) test(`safe incoming ${action} FK preserves old receipt child without delete side effects`, () => isolated(async (filename) => {
  const original = await open(filename, (db) => Effect.gen(function* () {
    const seeded = yield* seed(db)
    yield* db.run(`CREATE TABLE media_owned_child(id INTEGER PRIMARY KEY,message_id TEXT NOT NULL REFERENCES im_kernel_delivery(message_id) ON DELETE ${action})`)
    yield* db.run(sql`INSERT INTO media_owned_child VALUES(1,${seeded.ids[2]})`)
    yield* DatabaseMigration.applyOnly(db, selected)
    expect(yield* db.get("SELECT count(*) total FROM media_owned_child")).toEqual({ total: 1 })
    yield* audit(db, seeded.ids)
    return yield* snapshot(db)
  }))
  expect(await open(filename, (db) => Effect.gen(function* () { yield* DatabaseMigration.applyOnly(db, selected); return yield* snapshot(db) }))).toEqual(original)
}), 60000)

for (const action of ["CASCADE", "SET NULL", "SET DEFAULT"] as const) test(`unsafe incoming ${action} FK refuses before DDL with original child/parent/journal intact`, () => isolated(async (filename) => {
  const original = await open(filename, (db) => Effect.gen(function* () {
    const seeded = yield* seed(db)
    yield* db.run(`CREATE TABLE media_owned_child(id INTEGER PRIMARY KEY,message_id TEXT DEFAULT NULL REFERENCES im_kernel_delivery(message_id) ON DELETE ${action})`)
    yield* db.run(sql`INSERT INTO media_owned_child VALUES(1,${seeded.ids[2]})`)
    const before = yield* snapshot(db)
    expect(Exit.isFailure(yield* Effect.exit(DatabaseMigration.applyOnly(db, selected)))).toBe(true)
    expect(yield* snapshot(db)).toEqual(before)
    expect(yield* db.get("SELECT count(*) total FROM media_owned_child")).toEqual({ total: 1 })
    return before
  }))
  expect(await open(filename, (db) => snapshot(db))).toEqual(original)
}), 60000)

test("pre-existing outer deferred transaction is refused without clearing caller-owned pragma or modifying old data", () => isolated(async (filename) => {
  const original = await open(filename, (db) => Effect.gen(function* () {
    yield* seed(db)
    const before = yield* snapshot(db)
    yield* db.transaction((tx) => Effect.gen(function* () {
      yield* tx.run("PRAGMA defer_foreign_keys=ON")
      expect(Exit.isFailure(yield* Effect.exit(migration.up(tx)))).toBe(true)
      expect(yield* tx.get("PRAGMA defer_foreign_keys")).toEqual({ defer_foreign_keys: 1 })
      expect(yield* tx.all("SELECT name FROM sqlite_master WHERE name='im_kernel_media_body'")).toEqual([])
      yield* tx.run("PRAGMA defer_foreign_keys=OFF")
    }))
    expect(yield* snapshot(db)).toEqual(before)
    return before
  }))
  expect(await open(filename, (db) => snapshot(db))).toEqual(original)
}), 60000)

for (const failure of ["backfill", "late", "missing custody"] as const) test(`${failure} failure rolls back original media schema/body/identity/journal and cold state`, () => isolated(async (filename) => {
  const original = await open(filename, (db) => Effect.gen(function* () {
    const seeded = yield* seed(db, failure === "backfill" ? 33 : 4)
    if (failure === "backfill") yield* db.run(sql`UPDATE im_kernel_delivery SET binding_hash=${"f".repeat(64)} WHERE message_id=${seeded.ids[32]}`)
    if (failure === "missing custody") yield* db.run(sql`DELETE FROM im_messages WHERE id=${seeded.ids[2]}`)
    const before = yield* snapshot(db)
    expect(Exit.isFailure(yield* Effect.exit(DatabaseMigration.applyOnly(db, failure === "late" ? failurePlan : selected)))).toBe(true)
    expect(yield* snapshot(db)).toEqual(before)
    return before
  }))
  expect(await open(filename, (db) => snapshot(db))).toEqual(original)
}), 60000)

test("legal old unknown reason above the full-copy byte quota rejects and preserves exact bytes in cold storage", () => isolated(async (filename) => {
  const original = await open(filename, (db) => Effect.gen(function* () {
    const seeded = yield* seed(db)
    // Previous SQL and Transport permit an unbounded legacy reason; only SQLite
    // creates this one large value. No string is printed or held by the fixture.
    yield* db.run(sql`UPDATE im_kernel_delivery SET reason=printf('%*s',${KernelMediaRetirementModel.BYTE_LIMIT},'') WHERE message_id=${seeded.ids[2]}`)
    expect(yield* db.get(sql`SELECT length(CAST(reason AS BLOB)) bytes FROM im_kernel_delivery WHERE message_id=${seeded.ids[2]}`))
      .toEqual({ bytes: 268435456 })
    return yield* snapshot(db, true)
  }))
  const coldHash = await fileHash(filename)
  await open(filename, (db) => Effect.gen(function* () {
    expect(Exit.isFailure(yield* Effect.exit(DatabaseMigration.applyOnly(db, selected)))).toBe(true)
    expect(yield* snapshot(db, true)).toEqual(original)
  }))
  expect(await fileHash(filename)).toBe(coldHash)
  expect(await open(filename, (db) => snapshot(db, true))).toEqual(original)
  expect(await fileHash(filename)).toBe(coldHash)
}), 60000)
