import { expect, test } from "bun:test"
import { Effect, Layer, Scope } from "effect"
import { sql } from "drizzle-orm"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Database } from "../src/database/database"
import { IMRepository, IMRepositoryLive } from "../src/im/repository"
import { KernelDelivery } from "../src/im/kernel-delivery"
import { KernelReader } from "../src/im/kernel-reader"

const source = { realm: "http://127.0.0.1:9/", appkey: "private-sender-ttl", orgID: 1,
  senderID: "alice", credentialFingerprint: "c".repeat(64) }
const scopeKey = "a".repeat(64)
const metadata = { type: "code_ref" as const, path: "private.ts", startLine: 1, endLine: 2 }
const attach = (db: Database.Interface["db"], current = () => Effect.succeed(true), fingerprint = source.credentialFingerprint) =>
  KernelReader.attach({ db, workspaceID: "workspace", userID: "server", source: { ...source, credentialFingerprint: fingerprint },
    current, inspect: () => Effect.succeed({ name: "private peer" }),
    readCut: (request) => Effect.succeed({ ...request, throughOrdinal: "0", targetAdmittedOrdinal: "0", readOrdinal: "0",
      liveUnread: "0", storedUnread: "0", serverNow: Date.now(), complete: true }) })
const fixture = Effect.gen(function* () {
  const db = (yield* Database.Service).db
  const repo = yield* IMRepository
  const runtime = attach(db)
  const authority = KernelDelivery.runtime(source)
  yield* Effect.addFinalizer(() => Effect.sync(() => { KernelReader.close(runtime); KernelDelivery.close(authority) }))
  yield* KernelReader.bind(runtime, scopeKey)
  yield* KernelReader.ensureScope(runtime)
  const group = yield* repo.createGroup({ workspaceID: "workspace", type: "project", name: "Private sender TTL", createdBy: "server" })
  yield* repo.bindKernelConversation({ groupID: group.id, kernelConvID: "k:1:bob" })
  const create = (requestID: string, options: { createdAt?: number; senderType?: "user" | "agent"; replyToID?: string } = {}) =>
    KernelDelivery.withCreation(authority, group.id, repo.createMessage({ groupID: group.id, clientRequestID: requestID,
      senderID: "server", senderType: options.senderType ?? "user", type: "text", content: `Private original ${requestID} 中文`,
      metadata, ...options }))
  return { db, repo, runtime, authority, group, create }
})
async function isolated(body: (filename: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "dac-sender-ttl-"))
  try { await body(join(directory, "private.sqlite")) } finally { await rm(directory, { recursive: true, force: true }) }
}
function run<A, E>(filename: string, effect: Effect.Effect<A, E, Database.Service | IMRepository | Scope.Scope>) {
  const database = Database.layerFromPath(filename)
  return Effect.runPromise(effect.pipe(Effect.provide(Layer.provideMerge(IMRepositoryLive, database)), Effect.scoped))
}
const snapshot = (db: Database.Interface["db"]) => Effect.gen(function* () {
  const messages = yield* db.all(sql`SELECT * FROM im_messages ORDER BY id`)
  const receipts = yield* db.all(sql`SELECT * FROM im_kernel_delivery ORDER BY message_id`)
  return { messages, receipts }
})

test("one trusted clock cleans at most32 original sender bodies and leaves receipts and unrelated text untouched", () =>
  isolated((filename) => run(filename, Effect.gen(function* () {
    const s = yield* fixture
    const old = Date.now() - 10_000
    const messages = yield* Effect.forEach(Array.from({ length: 33 }, (_, index) => index), (index) => s.create(`old-${index}`, { createdAt: old }))
    const dispatch = yield* KernelDelivery.withVerification(s.authority,
      { conversationType: 1, conversationID: "bob", orgID: 1, memberIDs: ["alice", "bob"] },
      s.repo.claimKernelDelivery(s.authority, messages[0]!.id))
    expect(dispatch).toBeDefined()
    expect(yield* s.repo.acknowledgeKernelDelivery(s.authority, dispatch!, "actual-module-ack")).toBe(true)
    const recent = yield* s.create("recent")
    const agent = yield* s.create("agent-copy", { createdAt: old, senderType: "agent" })
    const reply = yield* s.create("reply-copy", { createdAt: old, replyToID: recent.id })
    const ordinary = yield* s.repo.createGroup({ workspaceID: "workspace", type: "project", name: "Ordinary", createdBy: "server" })
    const local = yield* s.repo.createMessage({ groupID: ordinary.id, senderID: "server", senderType: "user", type: "text", content: "Ordinary body", createdAt: old })
    const before = yield* snapshot(s.db)
    const clock = old + KernelDelivery.TTL
    const foreign = attach(s.db, undefined, "f".repeat(64))
    yield* KernelReader.bind(foreign, scopeKey)
    expect(yield* KernelDelivery.cleanupSender(foreign, clock)).toEqual([])
    expect(yield* snapshot(s.db)).toEqual(before)
    KernelReader.close(foreign)
    expect(yield* KernelDelivery.cleanupSender(s.runtime, clock)).toEqual([s.group.id])
    expect(yield* s.db.get(sql`SELECT count(*) AS n FROM im_messages WHERE content='' AND deleted_at=${clock}`)).toEqual({ n: 32 })
    expect((yield* snapshot(s.db)).receipts).toEqual(before.receipts)
    for (const message of [recent, agent, reply, local]) {
      expect(yield* s.db.get(sql`SELECT content,deleted_at FROM im_messages WHERE id=${message.id}`))
        .toEqual({ content: message.content, deleted_at: null })
    }
    expect(yield* KernelDelivery.cleanupSender(s.runtime, clock)).toEqual([s.group.id])
    expect(yield* s.db.get(sql`SELECT count(*) AS n FROM im_messages WHERE content='' AND deleted_at=${clock}`)).toEqual({ n: 33 })
    const settled = yield* snapshot(s.db)
    expect(yield* KernelDelivery.cleanupSender(s.runtime, clock)).toEqual([])
    expect(yield* snapshot(s.db)).toEqual(settled)
    expect(settled.receipts).toEqual(before.receipts)
  }))))

test("a mismatched later body rolls back the entire batch without rewriting its original hashes", () =>
  isolated((filename) => run(filename, Effect.gen(function* () {
    const s = yield* fixture
    const old = Date.now() - 10_000
    yield* s.create("valid-body", { createdAt: old - 1 })
    const bad = yield* s.create("changed-body", { createdAt: old })
    yield* s.db.run(sql`UPDATE im_messages SET content='changed original body' WHERE id=${bad.id}`)
    const before = yield* snapshot(s.db)
    expect(yield* KernelDelivery.cleanupSender(s.runtime, old + KernelDelivery.TTL).pipe(Effect.flip))
      .toMatchObject({ _tag: "KernelDelivery.SenderCleanupError", code: "sender_body_mismatch", candidates: 2 })
    expect(yield* snapshot(s.db)).toEqual(before)
  }))))

test("late membership or original runtime withdrawal rolls back every sender tombstone", () =>
  isolated((filename) => run(filename, Effect.gen(function* () {
    const s = yield* fixture
    const old = Date.now() - 10_000
    const message = yield* s.create("late-revoke", { createdAt: old })
    const before = yield* snapshot(s.db)
    yield* s.db.run("CREATE TEMP TRIGGER private_sender_membership_revoke AFTER UPDATE OF content ON im_messages WHEN NEW.sender_type='user' AND NEW.type='text' AND NEW.content='' BEGIN DELETE FROM im_members WHERE group_id=NEW.group_id AND member_id='server'; END")
    expect(yield* KernelDelivery.cleanupSender(s.runtime, old + KernelDelivery.TTL).pipe(Effect.flip))
      .toMatchObject({ code: "KERNEL_DELIVERY_UNAVAILABLE" })
    expect(yield* snapshot(s.db)).toEqual(before)
    yield* s.db.run(sql`DROP TRIGGER private_sender_membership_revoke`)
    const current = attach(s.db, () => s.db.get<{ content: string }>(sql`SELECT content FROM im_messages WHERE id=${message.id}`)
      .pipe(Effect.map((row) => row?.content !== ""), Effect.catch(() => Effect.succeed(false))))
    yield* KernelReader.bind(current, scopeKey)
    expect(yield* KernelDelivery.cleanupSender(current, old + KernelDelivery.TTL).pipe(Effect.flip))
      .toMatchObject({ code: "reader_unavailable" })
    expect(yield* snapshot(s.db)).toEqual(before)
    KernelReader.close(current)
  }))))

test("cold sender tombstones preserve exact request IDs and cannot recreate or dispatch expired text", () =>
  isolated(async (filename) => {
    const initial = await run(filename, Effect.gen(function* () {
      const s = yield* fixture
      const old = Date.now() - 10_000
      const message = yield* s.create("cold-original", { createdAt: old })
      const receipt = yield* KernelDelivery.read(s.db, message.id)
      yield* KernelDelivery.cleanupSender(s.runtime, old + KernelDelivery.TTL)
      return { message, receipt, after: yield* snapshot(s.db), clock: old + KernelDelivery.TTL }
    }))
    await run(filename, Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const repo = yield* IMRepository
      const current = attach(db)
      const foreign = attach(db, undefined, "f".repeat(64))
      yield* Effect.addFinalizer(() => Effect.sync(() => { KernelReader.close(current); KernelReader.close(foreign) }))
      yield* KernelReader.bind(current, scopeKey)
      yield* KernelReader.bind(foreign, scopeKey)
      expect(yield* KernelDelivery.cleanupSender(current, initial.clock)).toEqual([])
      expect(yield* KernelDelivery.cleanupSender(foreign, initial.clock)).toEqual([])
      expect(yield* KernelDelivery.cleanupSender(current, NaN).pipe(Effect.flip))
        .toMatchObject({ code: "KERNEL_DELIVERY_UNAVAILABLE" })
      expect(yield* repo.createMessage({ groupID: initial.message.groupID, clientRequestID: "cold-original",
        senderID: "server", senderType: "user", type: "text", content: initial.message.content,
        metadata }).pipe(Effect.flip)).toMatchObject({ code: "message_identity_conflict" })
      const authority = KernelDelivery.runtime(source)
      expect(yield* KernelDelivery.withVerification(authority,
        { conversationType: 1, conversationID: "bob", orgID: 1, memberIDs: ["alice", "bob"] },
        repo.claimKernelDelivery(authority, initial.message.id))).toBeUndefined()
      KernelDelivery.close(authority)
      expect(yield* KernelDelivery.read(db, initial.message.id)).toEqual(initial.receipt)
      expect(yield* snapshot(db)).toEqual(initial.after)
    }))
  }))
