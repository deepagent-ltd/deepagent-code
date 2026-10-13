import { expect, test } from "bun:test"
import { Effect, Exit, Layer, Scope } from "effect"
import { sql } from "drizzle-orm"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createHash } from "node:crypto"
import { Database } from "../src/database/database"
import { IMRepository, IMRepositoryLive } from "../src/im/repository"
import { KernelReader } from "../src/im/kernel-reader"
import { KernelReaderSchema } from "../src/im/kernel-reader.schema"

const scopeKey = "a".repeat(64)
const projectionKey = "b".repeat(64)
const source = { realm: "http://127.0.0.1:9/", appkey: "isolated-v2-reader", orgID: 1, senderID: "alice", credentialFingerprint: "c".repeat(64) }
const fixture = (version: 1 | 2) => Effect.gen(function* () {
  const db = (yield* Database.Service).db
  const repo = yield* IMRepository
  const now = Date.now()
  const runtime = KernelReader.attach({ db, workspaceID: "workspace", userID: "server", source,
    current: () => Effect.succeed(true), inspect: () => Effect.succeed({ name: "verified peer" }),
    readCut: (request) => Effect.succeed({ ...request, throughOrdinal: "1", targetAdmittedOrdinal: "1", readOrdinal: "0", liveUnread: "1", storedUnread: "1", serverNow: Date.now(), complete: true }) })
  yield* Effect.addFinalizer(() => Effect.sync(() => KernelReader.close(runtime)))
  yield* KernelReader.bind(runtime, scopeKey, version)
  const stored = yield* KernelReader.ensureScope(runtime)
  yield* KernelReader.applyChanges(runtime, { version, scopeKey, after: "0", upper: "1", scanCursor: "1", scanProjectionKey: projectionKey, pageToken: "", windowComplete: true, caughtUp: true, serverNow: now,
    items: [{ visibility: "visible", projectionKey, revision: "1", cursor: "1", conversationType: 1, targetId: "bob", readOrdinal: "0", admittedOrdinal: "1", liveUnread: "1", storedUnread: "1", latestMessageId: "opaque-id", latestSequence: "1", latestMessageTime: now, nextExpiryAt: now + 86400000 }] })
  const groupID = (yield* KernelReader.projection(runtime, projectionKey))!.local_group_id!
  const message = { effectKey: "d".repeat(64), messageId: "opaque-id", sequence: "1", deliveryCursor: "1", messageTime: now, expiresAt: now + 86400000, senderId: "bob", targetId: "bob", conversationType: 1 as const, content: JSON.stringify({ content: "text" }), isSend: false, isRead: false }
  const page = { version, scopeKey, projectionKey, projectionRevision: "1", direction: "newer" as const, nextDeliveryCursor: "1", finished: true, serverNow: now, items: [message] }
  const cut: KernelReaderSchema.Cut = { version, scopeKey, projectionKey, projectionRevision: "1", throughOrdinal: "1", targetAdmittedOrdinal: "1", readOrdinal: "0", liveUnread: "1", storedUnread: "1", serverNow: now, complete: true }
  return { db, repo, runtime, now, stored, groupID, message, page, cut,
    output: <A, E>(effect: Effect.Effect<A, E>) => KernelReader.withOutput(runtime, { workspaceID: "workspace", userID: "server", groupIDs: [groupID] }, effect) }
})
function run<A, E>(filename: string, effect: Effect.Effect<A, E, Database.Service | IMRepository | Scope.Scope>) {
  return Effect.runPromise(effect.pipe(Effect.provide(Layer.provideMerge(IMRepositoryLive, Database.layerFromPath(filename))), Effect.scoped))
}
async function isolated<A>(body: (filename: string) => Promise<A>) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dac-reader-v2-"))
  try { return await body(path.join(directory, "reader.sqlite")) } finally { await fs.rm(directory, { recursive: true, force: true }) }
}
const attachments = (now: number) => [0, 1, 52428800].map((sizeBytes, index) => ({ attachmentID: String(index + 1).repeat(64), contentRef: String(index + 1).repeat(64), filename: `${index} 中文.bin`, mime: "application/octet-stream", sizeBytes,
  sha256: createHash("sha256").update(index === 0 ? "" : String(index)).digest("hex"), createdAt: now, expiresAt: now + 86400000 }))

test("v2 three media descriptors including zero bytes project without rewriting wire content or minting local attachment paths", () => isolated((filename) => run(filename, Effect.gen(function* () {
  const s = yield* fixture(2)
  const media = { ...s.message, messageType: "dac:media.v1" as const, content: JSON.stringify({ v: 1, content: "三附件", attachments: attachments(s.now) }) }
  yield* KernelReader.applyMessages(s.runtime, { ...s.page, items: [media] })
  const before = yield* s.db.all(sql`SELECT * FROM im_kernel_reader_message`)
  const messages = yield* s.output(s.repo.listMessages({ groupID: s.groupID, limit: 32 }))
  expect(messages.messages[0]?.content).toBe("三附件")
  expect(messages.messages[0]?.remoteAttachments).toEqual(attachments(s.now).map((item) => ({ profile: "kernel_media", ...item })))
  expect((yield* s.db.get<{ content: string }>(sql`SELECT content FROM im_messages`))?.content).toBe(media.content)
  expect((yield* s.db.get<{ body_hash: string }>(sql`SELECT body_hash FROM im_kernel_reader_message`))?.body_hash).toBe(createHash("sha256").update(media.content).digest("hex"))
  expect((yield* s.db.get<{ count: number }>(sql`SELECT count(*) count FROM im_attachments`))?.count).toBe(0)
  yield* KernelReader.applyMessages(s.runtime, { ...s.page, items: [{ ...media, isRead: true }] })
  expect(yield* s.db.all(sql`SELECT * FROM im_kernel_reader_message`)).toEqual(before)
  yield* s.db.run(sql`UPDATE im_kernel_reader_message SET metadata=json_set(metadata, '$.isSend', json('true'))`)
  expect(Exit.isFailure(yield* Effect.exit(s.output(s.repo.listMessages({ groupID: s.groupID, limit: 32 }))))).toBe(true)
}))))

test("v1 rejects media and extra type before any message storage, v2 rejects missing type and malformed envelopes", () => isolated((filename) => run(filename, Effect.gen(function* () {
  const old = yield* fixture(1)
  const media = { ...old.message, content: JSON.stringify({ v: 1, content: "", attachments: attachments(old.now) }) }
  expect(Exit.isFailure(yield* Effect.exit(KernelReader.applyMessages(old.runtime, { ...old.page, items: [media] })))).toBe(true)
  expect(Exit.isFailure(yield* Effect.exit(KernelReader.applyMessages(old.runtime, { ...old.page, items: [{ ...old.message, messageType: "jg:text" }] })))).toBe(true)
  const fresh = yield* fixture(2)
  expect(Exit.isFailure(yield* Effect.exit(KernelReader.applyMessages(fresh.runtime, fresh.page)))).toBe(true)
  for (const content of [
    '{"v":1,"content":"","content":"duplicate","attachments":[]}',
    JSON.stringify({ v: 1, content: "", attachments: attachments(fresh.now).map((item, index) => index === 0 ? { ...item, contentRef: "/tmp/untrusted" } : item) }),
    JSON.stringify({ v: 1, content: "", attachments: [attachments(fresh.now)[0], attachments(fresh.now)[0]] }),
    JSON.stringify({ v: 1, content: "", attachments: attachments(fresh.now).map((item) => ({ ...item, expiresAt: item.expiresAt + 1 })) }),
  ]) expect(Exit.isFailure(yield* Effect.exit(KernelReader.applyMessages(fresh.runtime, { ...fresh.page, items: [{ ...fresh.message, messageType: "dac:media.v1", content }] })))).toBe(true)
  expect((yield* fresh.db.get<{ count: number }>(sql`SELECT count(*) count FROM im_messages`))?.count).toBe(0)
}))))

test("v1 persisted bytes and unknown read survive fresh v2 scope and cold reopening; old callback cannot change protocols", () => isolated(async (filename) => {
  const before = await run(filename, Effect.gen(function* () {
    const s = yield* fixture(1)
    yield* KernelReader.applyMessages(s.runtime, s.page)
    const action = yield* KernelReader.prepareRead(s.runtime, { actionID: "original", groupID: s.groupID, cut: s.cut })
    yield* KernelReader.dispatchRead(s.runtime, action!.action_id)
    yield* KernelReader.settleRead(s.runtime, action!.action_id)
    expect(JSON.parse(s.stored.binding).readerVersion).toBeUndefined()
    expect(Exit.isFailure(yield* Effect.exit(KernelReader.bind(s.runtime, scopeKey, 2)))).toBe(true)
    expect(KernelReader.active(s.runtime)).toBe(false)
    return { key: s.stored.reader_key, scope: yield* s.db.all(sql`SELECT * FROM im_kernel_reader_scope`), message: yield* s.db.all(sql`SELECT * FROM im_kernel_reader_message`), intent: yield* s.db.all(sql`SELECT * FROM im_kernel_reader_read_intent`) }
  }))
  await run(filename, Effect.gen(function* () {
    const s = yield* fixture(2)
    expect(s.stored.reader_key).not.toBe(before.key)
    expect(JSON.parse(s.stored.binding)).toMatchObject({ version: 1, readerVersion: 2 })
    expect(yield* s.db.all(sql`SELECT * FROM im_kernel_reader_scope WHERE reader_key=${before.key}`)).toEqual(before.scope)
    expect(yield* s.db.all(sql`SELECT * FROM im_kernel_reader_message WHERE reader_key=${before.key}`)).toEqual(before.message)
    expect(yield* s.db.all(sql`SELECT * FROM im_kernel_reader_read_intent WHERE reader_key=${before.key}`)).toEqual(before.intent)
    expect(Exit.isFailure(yield* Effect.exit(KernelReader.applyMessages(s.runtime, { ...s.page, version: 1 })))).toBe(true)
    expect(Exit.isFailure(yield* Effect.exit(KernelReader.prepareRead(s.runtime, { actionID: "wrong-version", groupID: s.groupID, cut: { ...s.cut, version: 1 } })))).toBe(true)
  }))
}))

test("v2 read intent freezes actual cut version and rejects a late v1 result without rewriting request", () => isolated((filename) => run(filename, Effect.gen(function* () {
  const s = yield* fixture(2)
  const action = yield* KernelReader.prepareRead(s.runtime, { actionID: "v2-action", groupID: s.groupID, cut: s.cut })
  expect(action).toBeDefined()
  expect(yield* KernelReader.prepareRead(s.runtime, { actionID: "v2-action", groupID: s.groupID, cut: s.cut })).toEqual(action)
  expect(KernelReaderSchema.decode(KernelReaderSchema.Request, action!.request, 4096).version).toBe(2)
  yield* KernelReader.dispatchRead(s.runtime, action!.action_id)
  expect(Exit.isFailure(yield* Effect.exit(KernelReader.settleRead(s.runtime, action!.action_id, { ...s.cut, version: 1, readOrdinal: "1" })))).toBe(true)
  expect((yield* KernelReader.readIntent(s.runtime, action!.action_id))?.request).toBe(action!.request)
  yield* KernelReader.settleRead(s.runtime, action!.action_id, { ...s.cut, readOrdinal: "1" })
  const final = yield* KernelReader.readIntent(s.runtime, action!.action_id)
  expect(final?.phase).toBe("confirmed")
  expect(KernelReaderSchema.decode(KernelReaderSchema.Cut, final!.result!, 4096).version).toBe(2)
  expect(Exit.isFailure(yield* Effect.exit(s.db.run(sql`UPDATE im_kernel_reader_read_intent SET request_hash=${"f".repeat(64)} WHERE action_id='v2-action'`)))).toBe(true)
  expect((yield* KernelReader.readIntent(s.runtime, "v2-action"))?.request_hash).toBe(action!.request_hash)
}))))
