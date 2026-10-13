import { expect, test } from "bun:test"
import { Effect, Exit, Layer, Scope } from "effect"
import { sql } from "drizzle-orm"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createHash } from "node:crypto"
import { Database } from "../src/database/database"
import { IMRepository, IMRepositoryLive, clientMessageID } from "../src/im/repository"
import { KernelDelivery } from "../src/im/kernel-delivery"
import { KernelDeliverySchema } from "../src/im/kernel-delivery.schema"
import { KernelReader } from "../src/im/kernel-reader"

const source = { realm: "http://127.0.0.1:9/", appkey: "media-store-fixture", orgID: 1, senderID: "alice", credentialFingerprint: "a".repeat(64) }
const scopeKey = "b".repeat(64)
const projectionKey = "c".repeat(64)
const proof = { conversationType: 1 as const, conversationID: "bob", orgID: 1, memberIDs: ["alice", "bob"] }
function run<A, E>(filename: string, effect: Effect.Effect<A, E, Database.Service | IMRepository | Scope.Scope>) {
  return Effect.runPromise(effect.pipe(Effect.provide(Layer.provideMerge(IMRepositoryLive, Database.layerFromPath(filename))), Effect.scoped))
}
async function isolated<A>(body: (filename: string) => Promise<A>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dac-media-receipt-"))
  try { return await body(path.join(dir, "store.sqlite")) } finally { await fs.rm(dir, { recursive: true, force: true }) }
}
const setup = Effect.gen(function* () {
  const db = (yield* Database.Service).db
  const repo = yield* IMRepository
  const authority = KernelDelivery.runtime(source)
  yield* Effect.addFinalizer(() => Effect.sync(() => KernelDelivery.close(authority)))
  const reader = KernelReader.attach({ db, source, workspaceID: "ws", userID: "server", current: () => Effect.succeed(true), inspect: () => Effect.succeed({ name: "verified peer" }), readCut: (request) => Effect.succeed({ ...request, throughOrdinal: "1", targetAdmittedOrdinal: "1", readOrdinal: "0", liveUnread: "1", storedUnread: "1", serverNow: Date.now(), complete: true }) })
  yield* Effect.addFinalizer(() => Effect.sync(() => KernelReader.close(reader)))
  yield* KernelReader.bind(reader, scopeKey, 2)
  yield* KernelReader.ensureScope(reader)
  const now = Date.now()
  yield* KernelReader.applyChanges(reader, { version: 2, scopeKey, after: "0", upper: "1", scanCursor: "1", scanProjectionKey: projectionKey, pageToken: "", windowComplete: true, caughtUp: true, serverNow: now,
    items: [{ visibility: "visible", projectionKey, revision: "1", cursor: "1", conversationType: 1, targetId: "bob", readOrdinal: "0", admittedOrdinal: "1", liveUnread: "1", storedUnread: "1", latestMessageId: "remote-message", latestSequence: "1", latestMessageTime: now, nextExpiryAt: now + 86400000 }] })
  const groupID = (yield* KernelReader.projection(reader, projectionKey))!.local_group_id!
  const attachments = yield* Effect.forEach([0, 1, 3], (sizeBytes, index) => repo.createAttachment({ workspaceID: "ws", groupID, uploadedBy: "server", storagePath: `/private/fixture-only/${index}`, filename: `${index} 中文.txt`, mime: "text/plain", sizeBytes, checksum: createHash("sha256").update("a".repeat(sizeBytes)).digest("hex") }).pipe(Effect.map((local) => ({ local, remote: { attachmentID: String(index + 1).repeat(64), contentRef: String(index + 1).repeat(64), filename: local.filename, mime: "text/plain; charset=utf-8", sizeBytes, sha256: local.checksum, createdAt: now - 1000, expiresAt: now - 1000 + 86400000 } }))))
  const input = { groupID, attachments: attachments.map((item) => ({ id: item.local.id, workspaceID: "ws" })), clientRequestID: "media-original", senderID: "server", senderType: "user" as const, type: "file" as const, content: "三附件 <>& 中文", metadata: attachments.map((item) => ({ type: "attachment_ref" as const, attachmentID: item.local.id, batch: true as const })) }
  const capture: KernelDeliverySchema.MediaCreation = { messageID: clientMessageID(input.senderID, input.clientRequestID), groupID, senderID: input.senderID, content: input.content, attachments }
  const create = () => KernelDelivery.withMediaCreation(authority, capture, repo.createMessage(input))
  const claim = (messageID: string) => KernelDelivery.withVerification(authority, proof, repo.claimKernelDelivery(authority, messageID))
  return { db, repo, authority, reader, groupID, now, input, capture, attachments, create, claim }
})

test("media receipt atomically binds three original local/remote identities and exact retry preserves canonical wire and legacy text bytes", () => isolated((filename) => run(filename, Effect.gen(function* () {
  const s = yield* setup
  const message = yield* s.create()
  const raw = yield* s.db.get<{ binding: string; binding_hash: string }>(sql`SELECT binding,binding_hash FROM im_kernel_delivery WHERE message_id=${message.id}`)
  const receipt = yield* KernelDelivery.read(s.db, message.id)
  if (receipt?.binding.version !== 2) throw new Error("fixture expected durable media binding")
  expect(receipt.binding.messageType).toBe("dac:media.v1")
  expect(receipt.binding.expiresAt).toBe(s.attachments[0]!.remote.expiresAt)
  expect(receipt.binding.wireContent).toBe(JSON.stringify({ v: 1, content: s.input.content, attachments: s.attachments.map((item) => item.remote) }))
  expect(receipt.binding.wireHash).toBe(createHash("sha256").update(receipt.binding.wireContent).digest("hex"))
  expect(raw?.binding.includes("fixture-only")).toBe(false)
  expect((yield* s.db.all<{ message_id: string }>(sql`SELECT message_id FROM im_attachments`)).every((item) => item.message_id === message.id)).toBe(true)
  expect((yield* s.create()).replayed).toBe(true)
  expect(Exit.isFailure(yield* Effect.exit(KernelDelivery.withMediaCreation(s.authority, { ...s.capture, attachments: [...s.capture.attachments].reverse() }, s.repo.createMessage({ ...s.input, attachments: [...s.input.attachments].reverse(), metadata: [...s.input.metadata].reverse() }))))).toBe(true)
  expect(yield* s.db.get(sql`SELECT binding,binding_hash FROM im_kernel_delivery WHERE message_id=${message.id}`)).toEqual(raw)
  expect(Exit.isFailure(yield* Effect.exit(KernelDelivery.withMediaCreation(s.authority, { ...s.capture, attachments: s.capture.attachments.map((item) => ({ ...item, remote: { ...item.remote, createdAt: item.remote.createdAt + 1, expiresAt: item.remote.expiresAt + 1 } })) }, s.repo.createMessage(s.input))))).toBe(true)
  const text = yield* KernelDelivery.withCreation(s.authority, s.groupID, s.repo.createMessage({ groupID: s.groupID, clientRequestID: "old-text", senderID: "server", senderType: "user", type: "text", content: "old", createdAt: s.now }))
  const textReceipt = yield* KernelDelivery.read(s.db, text.id)
  expect(textReceipt?.binding).toEqual({ version: 1, messageID: text.id, groupID: s.groupID, workspaceID: "ws", source, conversationType: 1, conversationID: "bob", messageHash: textReceipt!.binding.messageHash, wireID: `dac_${KernelDelivery.hash(["im-kernel-wire-v1", source, text.id])}`, textHash: KernelDelivery.hash("old"), createdAt: s.now, expiresAt: s.now + KernelDelivery.TTL })
  expect((yield* s.db.get<{ binding: string }>(sql`SELECT binding FROM im_kernel_delivery WHERE message_id=${text.id}`))?.binding).toBe(JSON.stringify(textReceipt!.binding))
}))))

test("media authority, local identity, and receipt failure all roll back message and attachment binding", () => isolated((filename) => run(filename, Effect.gen(function* () {
  const s = yield* setup
  expect(Exit.isFailure(yield* Effect.exit(KernelDelivery.withCreation(s.authority, s.groupID, s.repo.createMessage(s.input))))).toBe(true)
  expect(Exit.isFailure(yield* Effect.exit(KernelDelivery.withMediaCreation({ ...s.authority }, s.capture, s.repo.createMessage(s.input))))).toBe(true)
  expect(Exit.isFailure(yield* Effect.exit(KernelDelivery.withMediaCreation(s.authority, { ...s.capture, content: "other body" }, s.repo.createMessage(s.input))))).toBe(true)
  yield* s.db.run("CREATE TRIGGER media_receipt_failure BEFORE INSERT ON im_kernel_delivery BEGIN SELECT RAISE(ABORT,'controlled receipt failure'); END")
  expect(Exit.isFailure(yield* Effect.exit(s.create()))).toBe(true)
  expect(yield* s.db.get(sql`SELECT count(*) total FROM im_messages`)).toEqual({ total: 0 })
  expect(yield* s.db.get(sql`SELECT count(*) total FROM im_attachments WHERE message_id IS NOT NULL`)).toEqual({ total: 0 })
  yield* s.db.run("DROP TRIGGER media_receipt_failure")
  yield* s.db.run(sql`UPDATE im_attachments SET storage_path='/private/changed' WHERE id=${s.attachments[0]!.local.id}`)
  expect(Exit.isFailure(yield* Effect.exit(s.create()))).toBe(true)
  expect(yield* s.db.get(sql`SELECT count(*) total FROM im_kernel_delivery`)).toEqual({ total: 0 })
}))))

test("media dispatch consumes one verified CAS; unknown survives cold reopening without a new dispatch or binding", () => isolated(async (filename) => {
  const original = await run(filename, Effect.gen(function* () {
    const s = yield* setup
    const message = yield* s.create()
    expect(yield* s.repo.claimKernelDelivery(s.authority, message.id)).toBeUndefined()
    const dispatches = yield* Effect.all([s.claim(message.id), s.claim(message.id)], { concurrency: 2 })
    const dispatch = dispatches.find((item) => item !== undefined)!
    expect(dispatches.filter(Boolean)).toHaveLength(1)
    expect(dispatch.binding.version).toBe(2)
    yield* s.repo.uncertainKernelDelivery(s.authority, dispatch)
    return { id: message.id, capture: s.capture, input: s.input, row: yield* s.db.get(sql`SELECT * FROM im_kernel_delivery WHERE message_id=${message.id}`) }
  }))
  await run(filename, Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const repo = yield* IMRepository
    const authority = KernelDelivery.runtime(source)
    yield* Effect.addFinalizer(() => Effect.sync(() => KernelDelivery.close(authority)))
    expect((yield* KernelDelivery.withMediaCreation(authority, original.capture, repo.createMessage(original.input))).replayed).toBe(true)
    expect(yield* KernelDelivery.withVerification(authority, proof, repo.claimKernelDelivery(authority, original.id))).toBeUndefined()
    expect(yield* repo.listPendingKernelMessages({ runtime: authority, limit: 32 })).toHaveLength(0)
    expect((yield* repo.kernelDeliveryStatus(original.id, authority)).state).toBe("unknown")
    expect(yield* db.get(sql`SELECT * FROM im_kernel_delivery WHERE message_id=${original.id}`)).toEqual(original.row)
  }))
}))

test("v2 sender reader reconciles only the actual media receipt and rejects text-receipt or messageType substitution", () => isolated((filename) => run(filename, Effect.gen(function* () {
  const s = yield* setup
  const message = yield* s.create()
  const dispatch = yield* s.claim(message.id)
  if (dispatch?.binding.version !== 2) throw new Error("fixture expected dispatched media")
  expect(yield* s.repo.acknowledgeKernelDelivery(s.authority, dispatch, "media-ack")).toBe(true)
  const item = { effectKey: "d".repeat(64), messageId: "media-ack", sequence: "1", deliveryCursor: "1", messageTime: s.now, expiresAt: dispatch.binding.expiresAt, senderId: "alice", targetId: "bob", conversationType: 1 as const, content: dispatch.binding.wireContent, isSend: true, isRead: false, messageType: "dac:media.v1" as const }
  const page = { version: 2 as const, scopeKey, projectionKey, projectionRevision: "1", direction: "newer" as const, nextDeliveryCursor: "1", finished: true, serverNow: Date.now(), items: [item] }
  yield* KernelReader.applyMessages(s.reader, page)
  expect(yield* s.db.get(sql`SELECT owns_message,local_message_id FROM im_kernel_reader_message`)).toEqual({ owns_message: 0, local_message_id: message.id })
  const listed = yield* KernelReader.withOutput(s.reader, { workspaceID: "ws", userID: "server", groupIDs: [s.groupID] }, s.repo.listMessages({ groupID: s.groupID, limit: 32 }))
  expect(listed.messages[0]?.content).toBe(s.input.content)
  expect(listed.messages[0]?.remoteAttachments).toHaveLength(3)
  expect(listed.messages[0]?.remoteAttachments?.[0]?.sizeBytes).toBe(0)
  expect(Exit.isFailure(yield* Effect.exit(KernelReader.applyMessages(s.reader, { ...page, items: [{ ...item, messageType: "jg:text" }] })))).toBe(true)
  const text = yield* KernelDelivery.withCreation(s.authority, s.groupID, s.repo.createMessage({ groupID: s.groupID, clientRequestID: "text-receipt", senderID: "server", senderType: "user", type: "text", content: s.input.content }))
  const textDispatch = yield* s.claim(text.id)
  yield* s.repo.acknowledgeKernelDelivery(s.authority, textDispatch!, "text-ack")
  expect(Exit.isFailure(yield* Effect.exit(KernelReader.applyMessages(s.reader, { ...page, items: [{ ...item, effectKey: "e".repeat(64), messageId: "text-ack", sequence: "2", deliveryCursor: "2" }] })))).toBe(true)
  expect(yield* s.db.get(sql`SELECT count(*) total FROM im_kernel_reader_message`)).toEqual({ total: 1 })
}))))
