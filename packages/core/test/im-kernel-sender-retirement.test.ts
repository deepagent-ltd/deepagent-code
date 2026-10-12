import { afterAll, expect, test } from "bun:test"
import { Cause, Effect, Exit, Layer, Scope } from "effect"
import { sql } from "drizzle-orm"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Database } from "../src/database/database"
import { IMRepository, IMRepositoryLive } from "../src/im/repository"
import { KernelDelivery } from "../src/im/kernel-delivery"
import { KernelReader } from "../src/im/kernel-reader"

const source = { realm: "http://127.0.0.1:9/", appkey: "private-sender-retirement", orgID: 1,
  senderID: "alice", credentialFingerprint: "c".repeat(64) }
const currentSource = { ...source, credentialFingerprint: "f".repeat(64) }
const scopeKey = "a".repeat(64)
const projectionKey = "b".repeat(64)
const resources = { databases: 0, directories: 0 }
afterAll(() => { expect(resources).toEqual({ databases: 0, directories: 0 }) })

async function isolated(body: (filename: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "dac-sender-retirement-"))
  resources.directories++
  try { await body(join(directory, "private.sqlite")) } finally {
    await rm(directory, { recursive: true, force: true })
    resources.directories--
  }
}
function run<A, E>(filename: string, effect: Effect.Effect<A, E, Database.Service | IMRepository | Scope.Scope>) {
  resources.databases++
  return Effect.runPromise(effect.pipe(Effect.provide(Layer.provideMerge(IMRepositoryLive, Database.layerFromPath(filename))),
    Effect.scoped)).finally(() => { resources.databases-- })
}
const fixture = (initialize = true) => Effect.gen(function* () {
  const db = (yield* Database.Service).db
  const repo = yield* IMRepository
  const observations = new WeakMap<object, { serverNow: number; scopeKey: string; version: 1 | 2; deadline: number }>()
  const owner = { current: true }
  const attach = (input: typeof source) => KernelReader.attach({ db, workspaceID: "workspace", userID: "server", source: input,
    current: () => Effect.succeed(owner.current), inspect: () => Effect.succeed({ name: "Private peer" }),
    readCut: (request) => Effect.succeed({ ...request, throughOrdinal: "0", targetAdmittedOrdinal: "0", readOrdinal: "0",
      liveUnread: "0", storedUnread: "0", serverNow: Date.now(), complete: true }),
    retirementObservation: (handle) => {
      const observation = observations.get(handle)
      observations.delete(handle)
      return observation
    } })
  const runtime = attach(currentSource)
  const previous = attach(source)
  const authority = KernelDelivery.runtime(source)
  const currentAuthority = KernelDelivery.runtime(currentSource)
  yield* Effect.addFinalizer(() => Effect.sync(() => {
    KernelReader.close(runtime); KernelReader.close(previous)
    KernelDelivery.close(authority); KernelDelivery.close(currentAuthority)
  }))
  yield* KernelReader.bind(previous, "d".repeat(64))
  yield* KernelReader.ensureScope(previous)
  const originalGroup = yield* KernelReader.pending(previous, { conversationType: 1, conversationID: "bob", name: "Old original" })
  yield* KernelReader.bind(runtime, scopeKey)
  const stored = yield* KernelReader.ensureScope(runtime)
  const now = Date.now()
  if (initialize) yield* KernelReader.applyChanges(runtime, { version: 1, scopeKey, after: "0", upper: "1", scanCursor: "1",
    scanProjectionKey: projectionKey, pageToken: "", windowComplete: true, caughtUp: true, serverNow: now,
    items: [{ visibility: "visible", projectionKey, revision: "1", cursor: "1", conversationType: 1, targetId: "bob",
      readOrdinal: "0", admittedOrdinal: "0", liveUnread: "0", storedUnread: "0", latestMessageId: "",
      latestSequence: "", latestMessageTime: 0, nextExpiryAt: 0 }] })
  const currentGroup = (yield* KernelReader.projection(runtime, projectionKey))?.local_group_id ?? ""
  const create = (id: string, options: { createdAt?: number; senderType?: "user" | "agent"; replyToID?: string } = {}) =>
    KernelDelivery.withCreation(authority, originalGroup, repo.createMessage({ groupID: originalGroup,
      senderID: "server", senderType: options.senderType ?? "user", type: "text", content: `Original ${id} 中文`,
      clientRequestID: id, createdAt: now - KernelDelivery.TTL - 10_000, ...options }))
  const observe = (milliseconds = 1000, serverNow = Date.now()) => {
    const handle = Object.freeze({ serverNow, scopeKey, version: 1 })
    observations.set(handle, { serverNow, scopeKey, version: 1, deadline: performance.now() + milliseconds })
    return handle
  }
  const snapshot = () => Effect.gen(function* () {
    return { messages: yield* db.all(sql`SELECT * FROM im_messages ORDER BY id`),
      receipts: yield* db.all(sql`SELECT * FROM im_kernel_delivery ORDER BY message_id`) }
  })
  return { db, repo, runtime, previous, authority, currentAuthority, owner, originalGroup, currentGroup,
    stored, create, observe, snapshot }
})

test("a current one-use purpose retires32 old canonical kr1 bodies independently of the current projection", () =>
  isolated((filename) => run(filename, Effect.gen(function* () {
    const s = yield* fixture()
    const originals = yield* Effect.forEach(Array.from({ length: 33 }, (_, index) => index), (index) => s.create(`old-${index}`))
    const recent = yield* s.create("recent", { createdAt: Date.now() })
    const agent = yield* s.create("agent", { senderType: "agent" })
    const reply = yield* s.create("reply", { replyToID: recent.id })
    const current = yield* KernelDelivery.withCreation(s.currentAuthority, s.currentGroup,
      s.repo.createMessage({ groupID: s.currentGroup, senderID: "server", senderType: "user", type: "text",
        content: "Current credential original", clientRequestID: "current", createdAt: Date.now() }))
    const before = yield* s.snapshot()
    expect(s.originalGroup).not.toBe(s.currentGroup)
    expect(yield* KernelDelivery.cleanupSender(s.runtime, Date.now())).toEqual([])
    expect(yield* s.snapshot()).toEqual(before)
    expect(yield* KernelDelivery.withSenderRetirement(s.runtime, s.observe(), KernelDelivery.retirePreviousSender())).toEqual([s.originalGroup])
    expect(yield* s.db.get(sql`SELECT count(*) n FROM im_messages WHERE group_id=${s.originalGroup} AND content='' AND deleted_at IS NOT NULL`)).toEqual({ n: 32 })
    expect((yield* s.snapshot()).receipts).toEqual(before.receipts)
    expect(yield* KernelDelivery.withSenderRetirement(s.runtime, s.observe(), KernelDelivery.retirePreviousSender())).toEqual([s.originalGroup])
    expect(yield* s.db.get(sql`SELECT count(*) n FROM im_messages WHERE group_id=${s.originalGroup} AND content='' AND deleted_at IS NOT NULL`)).toEqual({ n: 33 })
    for (const message of [recent, agent, reply, current]) expect(yield* s.db.get(sql`SELECT content,deleted_at FROM im_messages WHERE id=${message.id}`))
      .toEqual({ content: message.content, deleted_at: null })
    for (const message of originals) {
      const receipt = yield* KernelDelivery.read(s.db, message.id)
      expect(yield* s.db.get(sql`SELECT content,deleted_at FROM im_messages WHERE id=${message.id}`))
        .toEqual({ content: "", deleted_at: receipt!.binding.expiresAt })
    }
    expect((yield* s.snapshot()).receipts).toEqual(before.receipts)
    expect(yield* s.db.get(sql`SELECT count(*) n FROM session_input`)).toEqual({ n: 0 })
    expect(yield* s.db.get(sql`SELECT count(*) n FROM work_execution`)).toEqual({ n: 0 })
  }))))

test("cloned clocks, elapsed deadlines, exited frames and a consumed purpose cannot retire body text", () =>
  isolated((filename) => run(filename, Effect.gen(function* () {
    const s = yield* fixture()
    yield* s.create("purpose-boundaries")
    const before = yield* s.snapshot()
    const original = s.observe()
    expect(Exit.isFailure(yield* Effect.exit(KernelDelivery.withSenderRetirement({ ...s.runtime }, original, KernelDelivery.retirePreviousSender())))).toBe(true)
    expect(Exit.isFailure(yield* Effect.exit(KernelDelivery.withSenderRetirement(s.runtime, { ...original }, KernelDelivery.retirePreviousSender())))).toBe(true)
    expect(Exit.isFailure(yield* Effect.exit(KernelDelivery.withSenderRetirement(s.runtime, s.observe(-1), KernelDelivery.retirePreviousSender())))).toBe(true)
    expect(Exit.isFailure(yield* Effect.exit(KernelDelivery.withSenderRetirement(s.runtime, s.observe(1000, NaN), KernelDelivery.retirePreviousSender())))).toBe(true)
    const exited = yield* KernelDelivery.withSenderRetirement(s.runtime, original, Effect.context<never>())
    expect(Exit.isFailure(yield* Effect.exit(KernelDelivery.retirePreviousSender().pipe(Effect.provide(exited))))).toBe(true)
    expect(Exit.isFailure(yield* Effect.exit(KernelDelivery.withSenderRetirement(s.runtime, original, KernelDelivery.retirePreviousSender())))).toBe(true)
    expect(Exit.isFailure(yield* Effect.exit(KernelDelivery.withSenderRetirement(s.runtime, s.observe(10),
      Effect.sleep("20 millis").pipe(Effect.andThen(KernelDelivery.retirePreviousSender())))))).toBe(true)
    expect(yield* s.snapshot()).toEqual(before)
    yield* KernelDelivery.withSenderRetirement(s.runtime, s.observe(), Effect.gen(function* () {
      expect(yield* KernelDelivery.retirePreviousSender()).toEqual([s.originalGroup])
      expect(Exit.isFailure(yield* Effect.exit(KernelDelivery.retirePreviousSender()))).toBe(true)
    }))
    const settled = yield* s.snapshot()
    KernelReader.close(s.runtime)
    expect(Exit.isFailure(yield* Effect.exit(KernelDelivery.withSenderRetirement(s.runtime, s.observe(), KernelDelivery.retirePreviousSender())))).toBe(true)
    expect(yield* s.snapshot()).toEqual(settled)
  }))))

for (const fault of ["original_member", "current_member", "current_scope", "current_metadata", "current_projection", "old_metadata", "source", "deadline"] as const)
  test(`late ${fault} withdrawal rolls back every old canonical body and original receipt`, () =>
    isolated((filename) => run(filename, Effect.gen(function* () {
      const s = yield* fixture()
      const message = yield* s.create(`late-${fault}`)
      const before = yield* s.snapshot()
      const statements = {
        original_member: `DELETE FROM im_members WHERE group_id=NEW.group_id AND member_id='server'`,
        current_member: `DELETE FROM im_members WHERE group_id='${s.currentGroup}' AND member_id='server'`,
        current_scope: `UPDATE im_kernel_reader_scope SET local_revision=local_revision+1 WHERE reader_key='${s.stored.reader_key}'`,
        current_metadata: `UPDATE im_kernel_reader_projection SET metadata=json_set(metadata,'$.targetId','different-target') WHERE local_group_id='${s.currentGroup}'`,
        current_projection: `DELETE FROM im_kernel_reader_projection WHERE local_group_id='${s.currentGroup}'`,
        old_metadata: `UPDATE im_kernel_reader_projection SET metadata_hash='${"e".repeat(64)}' WHERE local_group_id=NEW.group_id`,
        source: `UPDATE im_messages SET content=content WHERE id=NEW.id`,
        deadline: `UPDATE im_messages SET content=content WHERE id=NEW.id`,
      }
      yield* s.db.run(`CREATE TEMP TRIGGER private_retire_late AFTER UPDATE OF content ON im_messages WHEN NEW.id='${message.id}' AND NEW.content='' BEGIN ${statements[fault]}; END`)
      if (fault === "source" || fault === "deadline") {
        // The real engine's current hook observes the body write in this same
        // transaction, just as a Host owner or credential withdrawal would.
        const engine = yield* KernelReader.current(s.runtime)
        engine.current = () => s.db.get<{ content: string }>(sql`SELECT content FROM im_messages WHERE id=${message.id}`)
          .pipe(Effect.flatMap((row) => row?.content !== "" ? Effect.succeed(true) : fault === "source"
            ? Effect.succeed(false) : Effect.sleep("20 millis").pipe(Effect.as(true))), Effect.catch(() => Effect.succeed(false)))
      }
      const refused = yield* Effect.exit(KernelDelivery.withSenderRetirement(s.runtime, s.observe(fault === "deadline" ? 10 : 1000), KernelDelivery.retirePreviousSender()))
      expect(Exit.isFailure(refused)).toBe(true)
      if (Exit.isFailure(refused)) expect(Cause.squash(refused.cause)).toMatchObject({ code: fault === "source" ? "reader_unavailable" : "KERNEL_DELIVERY_UNAVAILABLE" })
      expect(yield* s.snapshot()).toEqual(before)
      expect(yield* s.db.get(sql`SELECT count(*) n FROM im_members WHERE group_id=${s.originalGroup} AND member_id='server'`)).toEqual({ n: 1 })
      expect(yield* s.db.get(sql`SELECT count(*) n FROM im_members WHERE group_id=${s.currentGroup} AND member_id='server'`)).toEqual({ n: 1 })
    }))))

test("cold reopen retains tombstone identity and cannot reconstruct a retirement or weaken dispatch fingerprint", () =>
  isolated(async (filename) => {
    const original = await run(filename, Effect.gen(function* () {
      const s = yield* fixture()
      const message = yield* s.create("cold-original")
      const receipt = yield* KernelDelivery.read(s.db, message.id)
      expect(yield* KernelDelivery.withVerification(s.currentAuthority,
        { conversationType: 1, conversationID: "bob", orgID: 1, memberIDs: ["alice", "bob"] },
        s.repo.claimKernelDelivery(s.currentAuthority, message.id))).toBeUndefined()
      yield* KernelDelivery.withSenderRetirement(s.runtime, s.observe(), KernelDelivery.retirePreviousSender())
      return { message, receipt, after: yield* s.snapshot() }
    }))
    await run(filename, Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const repo = yield* IMRepository
      expect(Exit.isFailure(yield* Effect.exit(KernelDelivery.retirePreviousSender()))).toBe(true)
      expect(yield* KernelDelivery.read(db, original.message.id)).toEqual(original.receipt)
      const authority = KernelDelivery.runtime(source)
      yield* Effect.addFinalizer(() => Effect.sync(() => KernelDelivery.close(authority)))
      expect(yield* KernelDelivery.withVerification(authority,
        { conversationType: 1, conversationID: "bob", orgID: 1, memberIDs: ["alice", "bob"] },
        repo.claimKernelDelivery(authority, original.message.id))).toBeUndefined()
      expect(Exit.isFailure(yield* Effect.exit(repo.createMessage({ groupID: original.message.groupID,
        senderID: "server", senderType: "user", type: "text", content: original.message.content,
        clientRequestID: "cold-original" })))).toBe(true)
      expect(yield* db.all(sql`SELECT * FROM im_messages ORDER BY id`)).toEqual(original.after.messages)
      expect(yield* db.all(sql`SELECT * FROM im_kernel_delivery ORDER BY message_id`)).toEqual(original.after.receipts)
    }))
    expect(resources).toEqual({ databases: 0, directories: 1 })
  }))

test("an uninitialized current projection defers only old body retirement and does not infer an original conversation", () =>
  isolated((filename) => run(filename, Effect.gen(function* () {
    const s = yield* fixture(false)
    yield* s.create("uninitialized-current-projection")
    // Represent a fresh current reader whose delivery scope was just created:
    // the old canonical group still exists, but no current projection exists.
    const before = yield* s.snapshot()
    expect(yield* KernelDelivery.withSenderRetirement(s.runtime, s.observe(), KernelDelivery.retirePreviousSender()).pipe(Effect.flip))
      .toMatchObject({ _tag: "KernelDelivery.SenderRetirementDeferred", candidates: 1 })
    expect(yield* s.snapshot()).toEqual(before)
  }))))
