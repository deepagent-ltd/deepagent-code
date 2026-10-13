import { expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { sql } from "drizzle-orm"
import { createHash } from "node:crypto"
import { IMKernelReaderMessageTable } from "../src/im/kernel-reader.sql"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "../src/database/database"
import { KernelReader } from "../src/im/kernel-reader"
import { KernelReaderSchema } from "../src/im/kernel-reader.schema"

const source = { realm: "http://127.0.0.1:9/", appkey: "first-seen", orgID: 1, senderID: "receiver", credentialFingerprint: "c".repeat(64) }
const scopeKey = "a".repeat(64)
const projectionKey = "b".repeat(64)
const fixture = (verifier = true, receiverID = "receiver") => Effect.gen(function* () {
  const db = (yield* Database.Service).db
  const bindingSource = { ...source, senderID: receiverID }
  const now = Date.now()
  const handle = Object.freeze({})
  const state = { active: true, native: true, deadline: performance.now() + 1000 }
  const message = { effectKey: "d".repeat(64), messageId: "native-message", sequence: "9007199254740993", deliveryCursor: "1", messageTime: now, expiresAt: now + 2 * 86_400_000, senderId: "sender", targetId: "sender", conversationType: 1 as const, content: '{"content":"source classification 中文"}', isSend: false, isRead: false }
  const observation = { scopeKey, projectionKey, projectionRevision: "1", sourceHash: KernelReader.hash(bindingSource), receiverID, transportGeneration: 1, receivedAt: now, messageID: message.messageId, sequence: message.sequence, messageTime: now, senderID: message.senderId, conversationType: 1 as const, conversationID: message.targetId, wireContent: message.content }
  // Controlled Core boundary fixture. Actual original SDK provenance is tested
  // separately through the production Host/WS/native-query chain.
  const runtime = KernelReader.attach({ db, workspaceID: "first-seen-workspace", userID: "server", source: bindingSource, current: () => Effect.sync(() => state.active), inspect: () => Effect.succeed({ name: "Sender" }), readCut: () => Effect.fail(KernelReaderSchema.failure("reader_unavailable", "unused")), ...(verifier ? { liveObservation: (candidate: object) => candidate === handle && state.native && performance.now() < state.deadline ? observation : undefined } : {}) })
  yield* Effect.addFinalizer(() => Effect.sync(() => KernelReader.close(runtime)))
  yield* KernelReader.bind(runtime, scopeKey)
  yield* KernelReader.ensureScope(runtime)
  yield* KernelReader.applyChanges(runtime, { version: 1, scopeKey, after: "0", upper: "1", scanCursor: "1", scanProjectionKey: projectionKey, pageToken: "", windowComplete: true, caughtUp: true, serverNow: now, items: [{ visibility: "visible", projectionKey, revision: "1", cursor: "1", conversationType: 1, targetId: "sender", readOrdinal: "0", admittedOrdinal: "1", liveUnread: "1", storedUnread: "1", latestMessageId: message.messageId, latestSequence: message.sequence, latestMessageTime: now, nextExpiryAt: message.expiresAt }] })
  const page = { version: 1 as const, scopeKey, projectionKey, projectionRevision: "1", direction: "newer" as const, nextDeliveryCursor: "1", finished: true, serverNow: now, items: [message] }
  const row = () => db.get<{ metadata: string; immutable_hash: string; accounted_bytes: number }>(sql`SELECT metadata,immutable_hash,accounted_bytes FROM im_kernel_reader_message`)
  const census = () => db.get<{ records: number; bytes: number; messages: number }>(sql`SELECT used_records AS records, used_bytes AS bytes, (SELECT count(*) FROM im_messages) AS messages FROM im_kernel_reader_meter`)
  return { db, runtime, handle, state, message, observation, page, row, census }
})
async function isolated<A, E>(body: Effect.Effect<A, E, Database.Service | import("effect").Scope.Scope>) {
  const directory = await mkdtemp(join(tmpdir(), "dac-reader-first-seen-"))
  try { return await Effect.runPromise(body.pipe(Effect.provide(Database.layerFromPath(join(directory, "reader.sqlite"))), Effect.scoped)) }
  finally { await rm(directory, { recursive: true, force: true }) }
}
const metadata = (value: { metadata: string } | undefined) => KernelReaderSchema.decode(KernelReaderSchema.MessageMetadata, value!.metadata, 2048)

test("first commit fixes live provenance, 24h expiry and original bytes across replay, cold owner and cleanup", () => isolated(Effect.gen(function* () {
  const s = yield* fixture()
  yield* KernelReader.applyMessages(s.runtime, s.page, undefined, s.handle)
  const first = yield* s.row()
  expect(metadata(first).firstSeen).toEqual({ version: 1, origin: "kernel_live", receiverID: "receiver", transportGeneration: 1, receivedAt: s.observation.receivedAt, sourceExpiresAt: s.observation.receivedAt + 86_400_000, observationHash: KernelReader.hash(["deepagent.im.reader.live-observation.v1", s.observation]), sourceHash: KernelReader.hash(source) })
  expect(metadata(first).isRead).toBe(false)
  s.state.native = false
  yield* KernelReader.applyMessages(s.runtime, { ...s.page, items: [{ ...s.message, isRead: true }] })
  expect(yield* s.row()).toEqual(first)
  yield* KernelReader.cleanup(s.runtime, s.message.expiresAt + 1)
  expect(yield* s.row()).toEqual({ ...first!, accounted_bytes: (yield* s.row())!.accounted_bytes })
  yield* KernelReader.applyMessages(s.runtime, { ...s.page, serverNow: s.message.expiresAt + 1 }, undefined, s.handle)
  expect((yield* s.row())!.metadata).toBe(first!.metadata)
  expect(yield* s.db.get(sql`SELECT count(*) AS n FROM session`)).toEqual({ n: 0 })
  expect(yield* s.db.get(sql`SELECT count(*) AS n FROM session_input`)).toEqual({ n: 0 })
})))

test("history first never gains live eligibility and absent legacy metadata stays byte exact", () => isolated(Effect.gen(function* () {
  const s = yield* fixture()
  yield* KernelReader.applyMessages(s.runtime, s.page)
  const first = yield* s.row()
  expect(metadata(first).firstSeen).toEqual({ version: 1, origin: "history" })
  yield* KernelReader.applyMessages(s.runtime, s.page, undefined, s.handle)
  expect(yield* s.row()).toEqual(first)
  // The optional schema decodes old retained rows as history without rewriting
  // bytes or using their absence to mint a new observation.
  const legacy = '{"version":1,"isSend":false,"isRead":false}'
  expect(KernelReaderSchema.decode(KernelReaderSchema.MessageMetadata, legacy, 2048).firstSeen).toBeUndefined()
  expect(KernelReaderSchema.encode(KernelReaderSchema.MessageMetadata, Schema.decodeUnknownSync(KernelReaderSchema.MessageMetadata)({ version: 1, isSend: false, isRead: false }), 2048)).toBe(legacy)
})))

for (const scenario of ["no-verifier", "copy", "native-expired", "wrong-source", "wrong-tuple", "reference-body", "sent"] as const) test(`fresh ${scenario} stays history`, () => isolated(Effect.gen(function* () {
  const s = yield* fixture(scenario !== "no-verifier")
  if (scenario === "native-expired") s.state.deadline = 0
  if (scenario === "wrong-source") s.observation.sourceHash = "f".repeat(64)
  if (scenario === "wrong-tuple") s.observation.sequence = "2"
  if (scenario === "reference-body") s.observation.wireContent = '{"content":"different raw bytes"}'
  yield* KernelReader.applyMessages(s.runtime, scenario === "sent" ? { ...s.page, items: [{ ...s.message, isSend: true }] } : s.page, undefined, scenario === "copy" ? { ...s.handle } : s.handle)
  expect(metadata(yield* s.row()).firstSeen).toEqual({ version: 1, origin: "history" })
})))

test("late actual SQLite rollback preserves budget and permits exact origin retry only within the original witness", () => isolated(Effect.gen(function* () {
  const s = yield* fixture()
  const before = yield* s.census()
  yield* s.db.run(sql`CREATE TEMP TRIGGER first_seen_late_abort BEFORE INSERT ON im_kernel_reader_message BEGIN SELECT RAISE(ABORT,'first-seen-late-failure'); END`)
  expect((yield* KernelReader.applyMessages(s.runtime, s.page, undefined, s.handle).pipe(Effect.exit))._tag).toBe("Failure")
  expect(yield* s.census()).toEqual(before)
  expect(yield* s.row()).toBeUndefined()
  yield* s.db.run(sql`DROP TRIGGER first_seen_late_abort`)
  yield* KernelReader.applyMessages(s.runtime, s.page, undefined, s.handle)
  expect(metadata(yield* s.row()).firstSeen?.origin).toBe("kernel_live")
})))

test("late rollback followed by expiry admits only immutable history and does not renew the original witness", () => isolated(Effect.gen(function* () {
  const s = yield* fixture()
  const before = yield* s.census()
  yield* s.db.run(sql`CREATE TEMP TRIGGER first_seen_expired_abort BEFORE INSERT ON im_kernel_reader_message BEGIN SELECT RAISE(ABORT,'first-seen-expiry'); END`)
  expect((yield* KernelReader.applyMessages(s.runtime, s.page, undefined, s.handle).pipe(Effect.exit))._tag).toBe("Failure")
  expect(yield* s.census()).toEqual(before)
  s.state.deadline = 0
  yield* s.db.run(sql`DROP TRIGGER first_seen_expired_abort`)
  yield* KernelReader.applyMessages(s.runtime, s.page, undefined, s.handle)
  expect(metadata(yield* s.row()).firstSeen).toEqual({ version: 1, origin: "history" })
})))

test("combined UTF8 metadata capacity is typed and atomic before body, receipt or meter writes", () => isolated(Effect.gen(function* () {
  const s = yield* fixture(true, "r".repeat(2048))
  const before = yield* s.census()
  expect(yield* KernelReader.applyMessages(s.runtime, s.page, undefined, s.handle).pipe(Effect.flip)).toMatchObject({ code: "reader_capacity" })
  expect(yield* s.census()).toEqual(before)
  expect(yield* s.row()).toBeUndefined()
})))

test("another engine cannot turn the same original object's retained tuple into live provenance", () => isolated(Effect.gen(function* () {
  const s = yield* fixture()
  const foreign = KernelReader.attach({ db: s.db, workspaceID: "foreign-workspace", userID: "server", source, current: () => Effect.succeed(true), inspect: () => Effect.succeed({ name: "Sender" }), readCut: () => Effect.fail(KernelReaderSchema.failure("reader_unavailable", "unused")) })
  yield* Effect.addFinalizer(() => Effect.sync(() => KernelReader.close(foreign)))
  yield* KernelReader.bind(foreign, scopeKey)
  yield* KernelReader.ensureScope(foreign)
  yield* KernelReader.applyChanges(foreign, { version: 1, scopeKey, after: "0", upper: "1", scanCursor: "1", scanProjectionKey: projectionKey, pageToken: "", windowComplete: true, caughtUp: true, serverNow: s.message.messageTime, items: [{ visibility: "visible", projectionKey, revision: "1", cursor: "1", conversationType: 1, targetId: "sender", readOrdinal: "0", admittedOrdinal: "1", liveUnread: "1", storedUnread: "1", latestMessageId: s.message.messageId, latestSequence: s.message.sequence, latestMessageTime: s.message.messageTime, nextExpiryAt: s.message.expiresAt }] })
  yield* KernelReader.applyMessages(foreign, s.page, undefined, s.handle)
  expect(metadata(yield* s.row()).firstSeen).toEqual({ version: 1, origin: "history" })
})))

test("cold file DB retains original provenance bytes without recreating the SDK handle or current permission", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dac-reader-first-seen-cold-"))
  const filename = join(directory, "reader.sqlite")
  try {
    const first = await Effect.runPromise(Effect.gen(function* () {
      const s = yield* fixture()
      yield* KernelReader.applyMessages(s.runtime, s.page, undefined, s.handle)
      return { row: (yield* s.row())!, page: s.page, handle: s.handle }
    }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped))
    await Effect.runPromise(Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const rotatedSource = { ...source, credentialFingerprint: "e".repeat(64) }
      const runtime = KernelReader.attach({ db, workspaceID: "first-seen-workspace", userID: "server", source: rotatedSource, current: () => Effect.succeed(true), inspect: () => Effect.succeed({ name: "Sender" }), readCut: () => Effect.fail(KernelReaderSchema.failure("reader_unavailable", "unused")) })
      yield* Effect.addFinalizer(() => Effect.sync(() => KernelReader.close(runtime)))
      yield* KernelReader.bind(runtime, scopeKey)
      yield* KernelReader.ensureScope(runtime)
      yield* KernelReader.applyMessages(runtime, first.page, undefined, first.handle)
      expect(yield* db.get(sql`SELECT metadata,immutable_hash,accounted_bytes FROM im_kernel_reader_message`)).toEqual(first.row)
      const retained = metadata(first.row).firstSeen
      expect(retained?.origin === "kernel_live" && retained.sourceHash).toBe(KernelReader.hash(source))
      expect(retained?.origin === "kernel_live" && retained.sourceHash).not.toBe(KernelReader.hash(rotatedSource))
      expect(yield* db.get(sql`SELECT count(*) AS n FROM session_input`)).toEqual({ n: 0 })
    }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped))
  } finally { await rm(directory, { recursive: true, force: true }) }
})

for (const legacyOrigin of ["absent", "live-no-source"] as const) test(`actual retained v1 ${legacyOrigin} row stays byte exact when a current scoped callback matches`, () => isolated(Effect.gen(function* () {
  const s = yield* fixture()
  const stored = (yield* KernelReader.scope(s.runtime))!
  const projection = (yield* KernelReader.projection(s.runtime, projectionKey))!
  // A schema-valid historical seed, with the original v1 bytes and hash. This
  // fixture creates no live observation or execution authority.
  const legacy = legacyOrigin === "absent" ? '{"version":1,"isSend":false,"isRead":false}' : JSON.stringify({ version: 1, isSend: false, isRead: false, firstSeen: { version: 1, origin: "kernel_live", receiverID: "receiver", transportGeneration: 1, receivedAt: s.observation.receivedAt, sourceExpiresAt: s.observation.receivedAt + 86_400_000, observationHash: KernelReader.hash(["deepagent.im.reader.live-observation.v1", s.observation]) } })
  const immutable = { reader_key: stored.reader_key, effect_key: s.message.effectKey, binding_key: projection.binding_key, projection_key: projectionKey, message_id: s.message.messageId, sequence: s.message.sequence, delivery_cursor: s.message.deliveryCursor, message_time: s.message.messageTime, expires_at: s.message.expiresAt, sender_id: s.message.senderId, target_id: s.message.targetId, conversation_type: s.message.conversationType, body_hash: createHash("sha256").update(s.message.content, "utf8").digest("hex"), metadata: legacy }
  const row = { ...immutable, version: 1, local_revision: 1, immutable_hash: KernelReader.hash(immutable), storage_state: "redacted", local_message_id: null, owns_message: 0, body_bytes: 0, created_at: Date.now(), updated_at: Date.now(), accounted_records: 1, accounted_bytes: 0 }
  row.accounted_bytes = KernelReader.accounting(row)
  yield* s.db.transaction((tx) => Effect.gen(function* () {
    yield* tx.insert(IMKernelReaderMessageTable).values(row).run()
    yield* tx.run(sql`UPDATE im_kernel_reader_meter SET used_records=used_records+1,used_bytes=used_bytes+${row.accounted_bytes},revision=revision+1 WHERE id=1`)
  }), { behavior: "immediate" })
  const before = yield* s.row()
  const budget = yield* s.census()
  yield* KernelReader.applyMessages(s.runtime, s.page, undefined, s.handle)
  expect(yield* s.row()).toEqual(before)
  expect((yield* s.row())!.metadata).toBe(legacy)
  const provenance = metadata(yield* s.row()).firstSeen
  expect(provenance?.origin === "kernel_live" ? provenance.sourceHash : provenance).toBeUndefined()
  expect(yield* s.census()).toEqual(budget)
})))
