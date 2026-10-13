import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect, Exit, Layer, Scope } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "../src/database/database"
import { IMRepository, IMRepositoryLive, clientMessageID } from "../src/im/repository"
import { KernelDelivery } from "../src/im/kernel-delivery"
import { KernelReader } from "../src/im/kernel-reader"
import { KernelDeliverySchema } from "../src/im/kernel-delivery.schema"
import { KernelMediaRetirementModel } from "../src/im/kernel-media-retirement.model"

const source = { realm: "http://127.0.0.1:9/", appkey: "core-retirement", orgID: 1, senderID: "alice", credentialFingerprint: "a".repeat(64) }
const scopeKey = "b".repeat(64)
const caption = "RetirementCanary 中文🙂"
const proof = { conversationType: 1 as const, conversationID: "bob", orgID: 1, memberIDs: ["alice", "bob"] }
const run = <A, E>(filename: string, body: Effect.Effect<A, E, Database.Service | IMRepository | Scope.Scope>) =>
  Effect.runPromise(body.pipe(Effect.provide(Layer.provideMerge(IMRepositoryLive, Database.layerFromPath(filename))), Effect.scoped))
const isolated = async (body: (filename: string) => Promise<void>) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dac-core-media-body-runtime-"))
  const filename = path.join(directory, "database.sqlite")
  try { await body(filename) }
  finally { await fs.rm(directory, { recursive: true }); expect(await Bun.file(filename).exists()).toBe(false) }
}

/** Actual Core issuers/repository/SQLite transactions. The Engine's SDK port
 * supplies controlled opaque observations: this is not a native/provider or
 * network-SDK/24h wall-clock acceptance result. No attachment file is opened. */
const setup = Effect.gen(function* () {
  const db = (yield* Database.Service).db
  const repo = yield* IMRepository
  const active = { value: true }
  const observations = new WeakMap<object, { serverNow: number; scopeKey: string; version: 2; deadline: number }>()
  const reader = KernelReader.attach({ db, workspaceID: "ws", userID: "server", source, current: () => Effect.succeed(active.value),
    inspect: () => Effect.succeed({ name: "current peer" }), readCut: () => Effect.die("read-cut is out of scope"),
    retirementObservation: (handle) => { const value = observations.get(handle); observations.delete(handle); return value } })
  const authority = KernelDelivery.runtime(source)
  yield* Effect.addFinalizer(() => Effect.sync(() => { KernelReader.close(reader); KernelDelivery.close(authority) }))
  yield* KernelReader.bind(reader, scopeKey, 2)
  yield* KernelReader.ensureScope(reader)
  const group = yield* repo.createGroup({ workspaceID: "ws", type: "project", name: "Private media group", createdBy: "server" })
  yield* repo.bindKernelConversation({ groupID: group.id, kernelConvID: "k:1:bob" })
  const create = (requestID: string, groupID = group.id) => Effect.gen(function* () {
    const now = Date.now()
    const attachments = yield* Effect.forEach([0, 1], (index) => repo.createAttachment({ workspaceID: "ws", groupID, uploadedBy: "server",
      storagePath: `/private/never-opened/${requestID}/${index}`, filename: `${index} 私有附件名.txt`, mime: "text/plain", sizeBytes: index + 3,
      checksum: KernelDelivery.hash(["file", requestID, index]) }).pipe(Effect.map((local) => ({ local, remote: {
        attachmentID: KernelDelivery.hash(["object", requestID, index]), contentRef: KernelDelivery.hash(["object", requestID, index]),
        filename: local.filename, mime: "text/plain; charset=utf-8", sizeBytes: local.sizeBytes, sha256: local.checksum,
        createdAt: now - 1_000 + index, expiresAt: now - 1_000 + index + 86_400_000,
      } }))))
    const input = { clientRequestID: requestID, groupID, senderID: "server", senderType: "user" as const, type: "file" as const, content: caption,
      mentions: ["agent-a", "agent-b"], attachments: attachments.map((item) => ({ id: item.local.id, workspaceID: "ws" })),
      metadata: attachments.map((item) => ({ type: "attachment_ref" as const, batch: true as const, attachmentID: item.local.id })) }
    const capture: KernelDeliverySchema.MediaCreation = { messageID: clientMessageID("server", requestID), groupID,
      senderID: "server", content: caption, attachments }
    const message = yield* KernelDelivery.withMediaCreation(authority, capture, repo.createMessage(input))
    return { message, input, capture, expiresAt: attachments[0]!.remote.expiresAt }
  })
  const retire = (serverNow: number, purpose = KernelDelivery.retireSenderMedia()) => Effect.gen(function* () {
    const handle = {}
    observations.set(handle, { serverNow, scopeKey, version: 2, deadline: performance.now() + 1_000 })
    return yield* KernelDelivery.withSenderRetirement(reader, handle, purpose)
  })
  const claim = (messageID: string) => KernelDelivery.withVerification(authority, proof, repo.claimKernelDelivery(authority, messageID))
  const acknowledge = (messageID: string) => Effect.gen(function* () {
    const dispatch = yield* claim(messageID)
    if (!dispatch) return yield* Effect.die("Actual Core media dispatch was not admitted")
    expect(yield* repo.acknowledgeKernelDelivery(authority, dispatch, `kernel-${messageID}`)).toBe(true)
    return dispatch
  })
  return { db, repo, reader, authority, group, active, create, retire, claim, acknowledge }
})

const audit = (db: Database.Interface["db"]) => Effect.gen(function* () {
  const tables = ["im_kernel_media_meter", "im_kernel_media_body", "im_kernel_delivery", "im_messages"]
  const rows = yield* Effect.forEach(tables, (table) => db.all<{ [field: string]: string | number | null }>(sql.raw(`SELECT * FROM ${table}`)))
  // Independent raw-row inventory catches any missing production SQL column,
  // including nullable kernel IDs and actual Unicode JSON BLOB byte lengths.
  const bytes = rows.flat().reduce((sum, row) => sum + Object.values(row).reduce<number>((total, value) =>
    total + (value === null ? 0 : typeof value === "number" ? 8 : new TextEncoder().encode(value).byteLength), 0), 0)
  const meter = rows[0]![0]!
  expect(meter.used_bytes).toBe(bytes)
  expect(meter.used_records).toBe(1 + rows[1]!.length * 3)
  expect(yield* db.get("SELECT * FROM pragma_foreign_key_check LIMIT 1")).toBeUndefined()
  expect(yield* db.get("PRAGMA foreign_keys")).toEqual({ foreign_keys: 1 })
  expect(yield* db.get("PRAGMA quick_check")).toEqual({ quick_check: "ok" })
  return { rows, bytes, meter }
})

test("actual canonical caption, wireContent and descriptor copy retire together; raw ACK facts/identity and FTS survive correctly", () => isolated((filename) => run(filename, Effect.gen(function* () {
  const s = yield* setup
  const media = yield* s.create("ack-retire")
  yield* s.acknowledge(media.message.id)
  const before = yield* audit(s.db)
  const raw = yield* s.db.get<{ [field: string]: string | number | null }>(sql`SELECT * FROM im_kernel_delivery WHERE message_id=${media.message.id}`)
  expect((yield* s.db.get<{ count: number }>(sql`SELECT count(*) count FROM im_messages_fts WHERE content MATCH 'RetirementCanary'`))?.count).toBe(1)
  expect(yield* s.retire(media.expiresAt - 1)).toEqual([])
  expect(yield* s.retire(media.expiresAt)).toEqual([s.group.id])
  const after = yield* audit(s.db)
  expect(after.bytes).toBeLessThan(before.bytes)
  const receipt = yield* s.db.get<{ [field: string]: string | number | null }>(sql`SELECT * FROM im_kernel_delivery WHERE message_id=${media.message.id}`)
  expect(receipt?.binding).toBeNull()
  expect(receipt?.body_state).toBe("retired")
  expect(Object.fromEntries(Object.entries(receipt!).filter(([key]) => !["binding", "body_state"].includes(key))))
    .toEqual(Object.fromEntries(Object.entries(raw!).filter(([key]) => !["binding", "body_state"].includes(key))))
  expect(yield* s.db.get(sql`SELECT content,deleted_at FROM im_messages WHERE id=${media.message.id}`)).toEqual({ content: "", deleted_at: media.expiresAt })
  expect((yield* s.db.get<{ count: number }>(sql`SELECT count(*) count FROM im_messages_fts WHERE content MATCH 'RetirementCanary'`))?.count).toBe(0)
  const history = yield* KernelDelivery.history(s.db, media.message.id)
  expect(history.kind).toBe("retired")
  expect(JSON.stringify(history)).not.toContain(caption)
  expect(JSON.stringify(history)).not.toContain("私有附件名")
  const retiredError = yield* KernelDelivery.read(s.db, media.message.id).pipe(Effect.flip)
  expect(retiredError instanceof KernelDeliverySchema.Error && retiredError.code).toBe("KERNEL_DELIVERY_RETIRED")
  expect((yield* s.repo.kernelDeliveryStatus(media.message.id, s.authority)).state).toBe("acknowledged")
  expect((yield* s.repo.kernelDeliveryStatuses([media.message.id], s.authority))[media.message.id]).toEqual({ state: "acknowledged" })
  expect((yield* s.repo.createMessage(media.input).pipe(Effect.flip)).code).toBe("message_identity_conflict")
  expect(Exit.isFailure(yield* Effect.exit(s.repo.setMessageKernelMsgID({ messageID: media.message.id, kernelMsgID: "new-kernel" })))).toBe(true)
  expect(yield* s.repo.listPendingKernelMessages({ runtime: s.authority, limit: 32 })).toEqual([])
  expect(yield* s.retire(media.expiresAt + 1_000)).toEqual([])
  expect((yield* audit(s.db)).rows).toEqual(after.rows)
}))))

test("prepared/dispatched/unknown body and quota obligations remain unchanged at expiry", () => isolated((filename) => run(filename, Effect.gen(function* () {
  const s = yield* setup
  const prepared = yield* s.create("prepared")
  const dispatched = yield* s.create("dispatched")
  const unknown = yield* s.create("unknown")
  yield* s.claim(dispatched.message.id)
  const uncertain = yield* s.claim(unknown.message.id)
  yield* s.repo.uncertainKernelDelivery(s.authority, uncertain!)
  const before = yield* audit(s.db)
  expect(yield* s.retire(Math.max(prepared.expiresAt, dispatched.expiresAt, unknown.expiresAt))).toEqual([])
  expect((yield* audit(s.db)).rows).toEqual(before.rows)
  expect((yield* KernelDelivery.read(s.db, prepared.message.id))?.state).toBe("prepared")
  expect((yield* KernelDelivery.read(s.db, dispatched.message.id))?.state).toBe("dispatched")
  expect((yield* KernelDelivery.read(s.db, unknown.message.id))?.state).toBe("unknown")
}))))

test("copied metadata clock and closed current owner cannot mint media retirement", () => isolated((filename) => run(filename, Effect.gen(function* () {
  const s = yield* setup
  const media = yield* s.create("clock-owner")
  yield* s.acknowledge(media.message.id)
  const before = yield* audit(s.db)
  const forged = { serverNow: media.expiresAt, scopeKey, version: 2, deadline: performance.now() + 1_000 }
  expect(Exit.isFailure(yield* Effect.exit(KernelDelivery.withSenderRetirement(s.reader, forged, KernelDelivery.retireSenderMedia())))).toBe(true)
  expect(yield* KernelDelivery.cleanupSender(s.reader, media.expiresAt)).toEqual([])
  s.active.value = false
  expect(Exit.isFailure(yield* Effect.exit(s.retire(media.expiresAt)))).toBe(true)
  s.active.value = true
  expect((yield* audit(s.db)).rows).toEqual(before.rows)
}))))

test("late actual SQL membership loss rolls back caption, raw binding, summary and meter together", () => isolated((filename) => run(filename, Effect.gen(function* () {
  const s = yield* setup
  const media = yield* s.create("late-member")
  yield* s.acknowledge(media.message.id)
  const before = yield* audit(s.db)
  yield* s.db.run("CREATE TRIGGER media_late_member AFTER UPDATE OF content ON im_messages WHEN NEW.type='file' AND NEW.content='' BEGIN DELETE FROM im_members WHERE group_id=NEW.group_id AND member_id='server'; END")
  expect(Exit.isFailure(yield* Effect.exit(s.retire(media.expiresAt)))).toBe(true)
  expect((yield* audit(s.db)).rows).toEqual(before.rows)
  expect((yield* s.db.get<{ count: number }>(sql`SELECT count(*) count FROM im_members WHERE group_id=${s.group.id} AND member_id='server'`))?.count).toBe(1)
}))))

test("late actual SQL scope binding loss rolls back every body and its budget", () => isolated((filename) => run(filename, Effect.gen(function* () {
  const s = yield* setup
  const media = yield* s.create("late-scope")
  yield* s.acknowledge(media.message.id)
  const before = yield* audit(s.db)
  const scope = yield* KernelReader.scope(s.reader)
  yield* s.db.run(sql.raw(`CREATE TRIGGER media_late_scope AFTER UPDATE OF record ON im_kernel_media_body BEGIN UPDATE im_kernel_reader_scope SET binding_hash='${"f".repeat(64)}'; END`))
  expect(Exit.isFailure(yield* Effect.exit(s.retire(media.expiresAt)))).toBe(true)
  expect((yield* audit(s.db)).rows).toEqual(before.rows)
  expect((yield* KernelReader.scope(s.reader))?.binding_hash).toBe(scope?.binding_hash)
}))))

test("quota failures in new creation and late raw dispatch preserve all old Message/attachment/receipt facts", () => isolated((filename) => run(filename, Effect.gen(function* () {
  const s = yield* setup
  yield* s.db.run("UPDATE im_kernel_media_meter SET used_records=99999 WHERE meter_id=1")
  expect(Exit.isFailure(yield* Effect.exit(s.create("capacity-denial")))).toBe(true)
  expect(yield* s.db.get("SELECT count(*) count FROM im_messages")).toEqual({ count: 0 })
  expect(yield* s.db.get("SELECT count(*) count FROM im_kernel_delivery")).toEqual({ count: 0 })
  expect(yield* s.db.get("SELECT count(*) count FROM im_attachments WHERE message_id IS NOT NULL")).toEqual({ count: 0 })
  yield* s.db.run("UPDATE im_kernel_media_meter SET used_records=1 WHERE meter_id=1")
  const media = yield* s.create("dispatch-denial")
  const before = yield* audit(s.db)
  yield* s.db.run(sql`UPDATE im_kernel_media_meter SET used_bytes=${KernelMediaRetirementModel.BYTE_LIMIT} WHERE meter_id=1`)
  const full = yield* s.db.get("SELECT * FROM im_kernel_media_meter")
  expect(Exit.isFailure(yield* Effect.exit(s.claim(media.message.id)))).toBe(true)
  expect(yield* s.db.get("SELECT * FROM im_kernel_media_meter")).toEqual(full)
  expect((yield* KernelDelivery.read(s.db, media.message.id))?.state).toBe("prepared")
  expect(yield* s.db.get(sql`SELECT dispatch_owner,dispatched_at FROM im_kernel_delivery WHERE message_id=${media.message.id}`)).toEqual({ dispatch_owner: null, dispatched_at: null })
  yield* s.db.run(sql`UPDATE im_kernel_media_meter SET used_bytes=${before.bytes} WHERE meter_id=1`)
  expect((yield* audit(s.db)).rows).toEqual(before.rows)
}))))

test("custody FK restrict keeps groups/messages/receipts from cascading the actual ledger away", () => isolated((filename) => run(filename, Effect.gen(function* () {
  const s = yield* setup
  const media = yield* s.create("restrict")
  yield* s.acknowledge(media.message.id)
  yield* s.retire(media.expiresAt)
  const before = yield* audit(s.db)
  for (const statement of [sql`DELETE FROM im_groups WHERE id=${s.group.id}`, sql`DELETE FROM im_messages WHERE id=${media.message.id}`,
    sql`DELETE FROM im_kernel_delivery WHERE message_id=${media.message.id}`, sql`DELETE FROM im_kernel_media_meter WHERE meter_id=1`])
    expect(Exit.isFailure(yield* Effect.exit(s.db.run(statement)))).toBe(true)
  expect((yield* audit(s.db)).rows).toEqual(before.rows)
}))))

test("file DB cold reopening and exact migration reapply keep original retired identity and reject live re-upload retry", () => isolated(async (filename) => {
  const original = await run(filename, Effect.gen(function* () {
    const s = yield* setup
    const media = yield* s.create("cold")
    yield* s.acknowledge(media.message.id)
    yield* s.retire(media.expiresAt)
    return { id: media.message.id, input: media.input, rows: (yield* audit(s.db)).rows,
      history: yield* KernelDelivery.history(s.db, media.message.id) }
  }))
  await run(filename, Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const repo = yield* IMRepository
    expect((yield* audit(db)).rows).toEqual(original.rows)
    expect(yield* KernelDelivery.history(db, original.id)).toEqual(original.history)
    const retiredError = yield* KernelDelivery.read(db, original.id).pipe(Effect.flip)
    expect(retiredError instanceof KernelDeliverySchema.Error && retiredError.code).toBe("KERNEL_DELIVERY_RETIRED")
    expect((yield* repo.createMessage(original.input).pipe(Effect.flip)).code).toBe("message_identity_conflict")
    expect((yield* audit(db)).rows).toEqual(original.rows)
    expect((yield* db.get<{ count: number }>("SELECT count(*) count FROM session_input"))?.count).toBe(0)
  }))
}))

test("old non-owned sender ledger and cold exact expired echo stay body-free without a new mirror or custody charge", () => isolated(async (filename) => {
  const original = await run(filename, Effect.gen(function* () {
    const s = yield* setup
    const now = Date.now()
    const projectionKey = "c".repeat(64)
    yield* KernelReader.applyChanges(s.reader, { version: 2, scopeKey, after: "0", upper: "1", scanCursor: "1", scanProjectionKey: projectionKey,
      pageToken: "", windowComplete: true, caughtUp: true, serverNow: now, items: [{ visibility: "visible", projectionKey,
        revision: "1", cursor: "1", conversationType: 1, targetId: "bob", readOrdinal: "0", admittedOrdinal: "1", liveUnread: "1",
        storedUnread: "1", latestMessageId: "original", latestSequence: "1", latestMessageTime: now, nextExpiryAt: now + 86_400_000 }] })
    const groupID = (yield* KernelReader.projection(s.reader, projectionKey))!.local_group_id!
    const media = yield* s.create("old-ledger-echo", groupID)
    const dispatch = yield* s.acknowledge(media.message.id)
    if (dispatch.binding.version !== 2) return yield* Effect.die("Actual v2 receipt expected")
    const item = { effectKey: "d".repeat(64), messageId: `kernel-${media.message.id}`, sequence: "1", deliveryCursor: "1", messageTime: media.message.createdAt,
      expiresAt: dispatch.binding.expiresAt, senderId: "alice", targetId: "bob", conversationType: 1 as const, content: dispatch.binding.wireContent,
      isSend: true, isRead: false, messageType: "dac:media.v1" as const }
    const page = { version: 2 as const, scopeKey, projectionKey, projectionRevision: "1", direction: "newer" as const, nextDeliveryCursor: "1",
      finished: true, serverNow: now, items: [item] }
    yield* KernelReader.applyMessages(s.reader, page)
    const ledger = yield* s.db.get(sql`SELECT * FROM im_kernel_reader_message WHERE effect_key=${item.effectKey}`)
    expect(ledger).toMatchObject({ owns_message: 0, local_message_id: media.message.id, storage_state: "present" })
    yield* s.retire(media.expiresAt)
    const after = yield* audit(s.db)
    const meter = yield* s.db.get(sql`SELECT used_records,used_bytes FROM im_kernel_reader_meter`)
    const expired = { ...page, serverNow: media.expiresAt }
    expect(yield* KernelReader.applyMessages(s.reader, expired)).toEqual([])
    expect(yield* s.db.get(sql`SELECT * FROM im_kernel_reader_message WHERE effect_key=${item.effectKey}`)).toEqual(ledger)
    expect((yield* audit(s.db)).rows).toEqual(after.rows)
    expect(yield* s.db.get(sql`SELECT used_records,used_bytes FROM im_kernel_reader_meter`)).toEqual(meter)
    expect(Exit.isFailure(yield* Effect.exit(KernelReader.applyMessages(s.reader, { ...expired, items: [{ ...item, content: item.content + " " }] })))).toBe(true)
    expect((yield* audit(s.db)).rows).toEqual(after.rows)
    return { page: expired, ledger, meter, rows: after.rows }
  }))
  await run(filename, Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const reader = KernelReader.attach({ db, workspaceID: "ws", userID: "server", source, current: () => Effect.succeed(true),
      inspect: () => Effect.succeed({ name: "current peer" }), readCut: () => Effect.die("No read-cut execution in historical echo") })
    yield* Effect.addFinalizer(() => Effect.sync(() => KernelReader.close(reader)))
    yield* KernelReader.bind(reader, scopeKey, 2)
    expect(yield* KernelReader.applyMessages(reader, original.page)).toEqual([])
    expect(yield* db.get(sql`SELECT * FROM im_kernel_reader_message WHERE effect_key=${original.page.items[0]!.effectKey}`)).toEqual(original.ledger)
    expect(yield* db.get(sql`SELECT used_records,used_bytes FROM im_kernel_reader_meter`)).toEqual(original.meter)
    expect((yield* audit(db)).rows).toEqual(original.rows)
  }))
}))

test("actual successful commit with a lost return reconciles read-only and cold body identity never resurrects", () => isolated(async (filename) => {
  const original = await run(filename, Effect.gen(function* () {
    const s = yield* setup
    const media = yield* s.create("commit-return-loss")
    yield* s.acknowledge(media.message.id)
    const originalTransaction = s.db.transaction.bind(s.db)
    const lost = { once: true, calls: 0 }
    // Inject only after the actual file-backed transaction has committed.
    s.db.transaction = ((...args: Parameters<typeof s.db.transaction>) => originalTransaction(...args).pipe(Effect.flatMap((value) => {
      lost.calls++
      if (!lost.once) return Effect.succeed(value)
      lost.once = false
      return Effect.fail(new KernelDeliverySchema.Error({ code: "KERNEL_DELIVERY_UNAVAILABLE", message: "Controlled successful commit return loss" }))
    }))) as typeof s.db.transaction
    yield* Effect.addFinalizer(() => Effect.sync(() => { s.db.transaction = originalTransaction }))
    expect(yield* s.retire(media.expiresAt)).toEqual([s.group.id])
    expect(lost.calls).toBe(2)
    const after = yield* audit(s.db)
    expect(yield* s.retire(media.expiresAt)).toEqual([])
    expect((yield* audit(s.db)).rows).toEqual(after.rows)
    return { id: media.message.id, rows: after.rows, history: yield* KernelDelivery.history(s.db, media.message.id) }
  }))
  await run(filename, Effect.gen(function* () {
    const db = (yield* Database.Service).db
    expect((yield* audit(db)).rows).toEqual(original.rows)
    expect(yield* KernelDelivery.history(db, original.id)).toEqual(original.history)
    expect(yield* db.get(sql`SELECT content,deleted_at FROM im_messages WHERE id=${original.id}`)).toMatchObject({ content: "" })
  }))
}))
