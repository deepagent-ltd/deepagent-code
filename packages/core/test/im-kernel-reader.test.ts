import { expect, test } from "bun:test"
import { Deferred, Effect, Fiber, Layer, Schema, Scope } from "effect"
import { sql } from "drizzle-orm"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "../src/database/database"
import { groupPageCandidates, IMRepository, IMRepositoryLive } from "../src/im/repository"
import { KernelReader } from "../src/im/kernel-reader"
import { KernelDelivery } from "../src/im/kernel-delivery"
import { KernelReaderSchema } from "../src/im/kernel-reader.schema"

const scopeKey = "a".repeat(64)
const projectionKey = "b".repeat(64)
const source = { realm: "http://127.0.0.1:9/", appkey: "isolated-reader", orgID: 1, senderID: "alice", credentialFingerprint: "c".repeat(64) }
const fixture = Effect.gen(function* () {
  const db = (yield* Database.Service).db
  const repo = yield* IMRepository
  const permission = { online: true, allowed: true, inspectAllowed: true, name: "fresh inspected peer", revision: "9007199254740993", admittedOrdinal: "1", readOrdinal: "0" }
  const inspected: { conversationType: 1 | 2; conversationID: string }[] = []
  const runtime = KernelReader.attach({ db, workspaceID: "workspace", userID: "server", source, current: () => Effect.sync(() => permission.online), inspect: (request) => Effect.suspend(() => { inspected.push(request); return permission.inspectAllowed ? Effect.succeed({ name: permission.name }) : Effect.fail(KernelReaderSchema.failure("reader_scope_mismatch", "inspect")) }), readCut: (request) => permission.allowed && request.projectionRevision === permission.revision ? Effect.succeed({ ...request, throughOrdinal: permission.admittedOrdinal, targetAdmittedOrdinal: permission.admittedOrdinal, readOrdinal: permission.readOrdinal, liveUnread: String(BigInt(permission.admittedOrdinal) - BigInt(permission.readOrdinal)), storedUnread: String(BigInt(permission.admittedOrdinal) - BigInt(permission.readOrdinal)), serverNow: Date.now(), complete: true }) : Effect.fail(KernelReaderSchema.failure("reader_stale", "getDeliveryReadCut")) })
  yield* Effect.addFinalizer(() => Effect.sync(() => KernelReader.close(runtime)))
  const now = Date.now()
  const change = { visibility: "visible" as const, projectionKey, revision: permission.revision, cursor: "9007199254740993", conversationType: 1 as const, targetId: "bob", readOrdinal: "0", admittedOrdinal: "1", liveUnread: "1", storedUnread: "1", latestMessageId: "same-opaque-kernel-id", latestSequence: "9007199254740993", latestMessageTime: now, nextExpiryAt: now + 60000 }
  const message = { effectKey: "d".repeat(64), messageId: "same-opaque-kernel-id", sequence: "9007199254740993", deliveryCursor: "9007199254740993", messageTime: now, expiresAt: now + 60000, senderId: "bob", targetId: "bob", conversationType: 1 as const, content: JSON.stringify({ content: "protected body" }), isSend: false, isRead: false }
  const changes = { version: 1 as const, scopeKey, after: "0", upper: change.cursor, scanCursor: change.cursor, scanProjectionKey: projectionKey, pageToken: "", windowComplete: true, caughtUp: true, serverNow: now, items: [change] }
  const messages = { version: 1 as const, scopeKey, projectionKey, projectionRevision: permission.revision, direction: "newer" as const, nextDeliveryCursor: message.deliveryCursor, finished: true, serverNow: now, items: [message] }
  yield* KernelReader.bind(runtime, scopeKey)
  return { db, repo, runtime, permission, inspected, change, message, changes, messages, output: <A, E>(groupID: string, effect: Effect.Effect<A, E>) => KernelReader.withOutput(runtime, { workspaceID: "workspace", userID: "server", groupIDs: [groupID] }, effect) }
})
async function isolated<A>(body: (filename: string) => Promise<A>) {
  const directory = await mkdtemp(join(tmpdir(), "dac-reader-store-"))
  try { return await body(join(directory, "reader.sqlite")) } finally { await rm(directory, { recursive: true, force: true }) }
}
function run<A, E>(filename: string, effect: Effect.Effect<A, E, Database.Service | IMRepository | Scope.Scope>) {
  const database = Database.layerFromPath(filename)
  return Effect.runPromise(effect.pipe(Effect.provide(Layer.provideMerge(IMRepositoryLive, database)), Effect.scoped))
}
const meter = (db: Database.Interface["db"]) => db.get<{ used_records: number; used_bytes: number }>(sql`SELECT used_records, used_bytes FROM im_kernel_reader_meter WHERE id = 1`)
const nameState = (db: Database.Interface["db"]) => Effect.gen(function* () {
  return { groups: yield* db.all<Record<string, unknown>>(sql`SELECT * FROM im_groups`), members: yield* db.all(sql`SELECT * FROM im_members`), projections: yield* db.all(sql`SELECT * FROM im_kernel_reader_projection`), scope: yield* db.all(sql`SELECT * FROM im_kernel_reader_scope`), messages: yield* db.all(sql`SELECT * FROM im_messages`), readerMessages: yield* db.all(sql`SELECT * FROM im_kernel_reader_message`), intents: yield* db.all(sql`SELECT * FROM im_kernel_reader_read_intent`), meter: yield* meter(db) }
})
test("explicit selected metadata refresh updates an unchanged old visible group without scanning deliveries", () => isolated((filename) => run(filename, Effect.gen(function* () {
  const s = yield* fixture
  yield* KernelReader.ensureScope(s.runtime)
  yield* KernelReader.applyChanges(s.runtime, s.changes)
  yield* KernelReader.applyMessages(s.runtime, s.messages)
  yield* KernelReader.checkpoint(s.runtime, [projectionKey], true)
  const groupID = (yield* KernelReader.projection(s.runtime, projectionKey))!.local_group_id!
  const before = yield* nameState(s.db)
  const originalName = s.permission.name
  s.inspected.length = 0
  s.permission.name = "当前原认证群名"
  expect(yield* KernelReader.refreshGroup(s.runtime, groupID)).toBe(true)
  expect(s.inspected).toEqual([{ conversationType: 1, conversationID: "bob" }])
  const after = yield* nameState(s.db)
  expect((yield* s.output(groupID, s.repo.getGroup({ groupID, userID: "server" })))?.name).toBe(s.permission.name)
  expect(after.groups).toEqual(before.groups.map((group) => ({ ...group, name: s.permission.name, updated_at: after.groups[0]?.updated_at })))
  expect(after.scope).toEqual(before.scope)
  expect(after.members).toEqual(before.members)
  expect(after.messages).toEqual(before.messages)
  expect(after.readerMessages).toEqual(before.readerMessages)
  expect(after.intents).toEqual(before.intents)
  expect(after.meter?.used_records).toBe(before.meter?.used_records)
  expect(after.meter!.used_bytes - before.meter!.used_bytes).toBe(Buffer.byteLength(s.permission.name) - Buffer.byteLength(originalName))
  expect(yield* KernelReader.refreshGroup(s.runtime, groupID)).toBe(false)
  expect(yield* nameState(s.db)).toEqual(after)
}))))

test("explicit selected metadata refresh refuses missing, current, permission and late-revision failures without name writes", () => isolated((filename) => run(filename, Effect.gen(function* () {
  const s = yield* fixture
  yield* KernelReader.ensureScope(s.runtime)
  yield* KernelReader.applyChanges(s.runtime, s.changes)
  yield* KernelReader.checkpoint(s.runtime, [projectionKey], true)
  const groupID = (yield* KernelReader.projection(s.runtime, projectionKey))!.local_group_id!
  const before = yield* nameState(s.db)
  s.inspected.length = 0
  expect((yield* KernelReader.refreshGroup(s.runtime, "img_missing").pipe(Effect.flip))).toMatchObject({ code: "reader_required" })
  expect(s.inspected).toEqual([])
  s.permission.inspectAllowed = false
  expect((yield* KernelReader.refreshGroup(s.runtime, groupID).pipe(Effect.flip))).toMatchObject({ code: "reader_scope_mismatch" })
  expect(yield* nameState(s.db)).toEqual(before)
  s.permission.inspectAllowed = true
  s.permission.online = false
  expect((yield* KernelReader.refreshGroup(s.runtime, groupID).pipe(Effect.flip))).toMatchObject({ code: "reader_unavailable" })
  s.permission.online = true
  expect(yield* nameState(s.db)).toEqual(before)
  const engine = yield* KernelReader.current(s.runtime)
  const inspect = engine.inspect
  engine.inspect = (request) => inspect(request).pipe(Effect.tap(() => Effect.sync(() => { s.permission.online = false })))
  expect((yield* KernelReader.refreshGroup(s.runtime, groupID).pipe(Effect.flip))).toMatchObject({ code: "reader_unavailable" })
  s.permission.online = true
  expect(yield* nameState(s.db)).toEqual(before)
  engine.inspect = (request) => inspect(request).pipe(Effect.tap(() => s.db.run(sql`UPDATE im_kernel_reader_projection SET local_revision=local_revision+1 WHERE local_group_id=${groupID}`).pipe(Effect.orDie)))
  expect((yield* KernelReader.refreshGroup(s.runtime, groupID).pipe(Effect.flip))).toMatchObject({ code: "reader_stale" })
  expect((yield* nameState(s.db)).groups).toEqual(before.groups)
  expect(yield* meter(s.db)).toEqual(before.meter)
}))))

test("explicit selected metadata refresh rolls back real quota and projection CAS failure", () => isolated((filename) => run(filename, Effect.gen(function* () {
  const s = yield* fixture
  yield* KernelReader.ensureScope(s.runtime)
  yield* KernelReader.applyChanges(s.runtime, s.changes)
  yield* KernelReader.checkpoint(s.runtime, [projectionKey], true)
  const groupID = (yield* KernelReader.projection(s.runtime, projectionKey))!.local_group_id!
  yield* s.db.run(sql`UPDATE im_kernel_reader_meter SET used_bytes=${KernelReaderSchema.BYTE_LIMIT} WHERE id=1`)
  const full = yield* nameState(s.db)
  s.permission.name = "x".repeat(512)
  expect((yield* KernelReader.refreshGroup(s.runtime, groupID).pipe(Effect.flip))).toMatchObject({ code: "reader_capacity" })
  expect(yield* nameState(s.db)).toEqual(full)
  yield* s.db.run(sql`UPDATE im_kernel_reader_meter SET used_bytes=${full.meter!.used_bytes - 4096} WHERE id=1`)
  yield* s.db.run(sql`CREATE TRIGGER refuse_selected_name BEFORE UPDATE OF owned_group_bytes ON im_kernel_reader_projection BEGIN SELECT RAISE(IGNORE); END`)
  const before = yield* nameState(s.db)
  expect((yield* KernelReader.refreshGroup(s.runtime, groupID).pipe(Effect.flip))).toMatchObject({ code: "reader_stale" })
  expect(yield* nameState(s.db)).toEqual(before)
}))))

test("authenticated group names create and refresh existing mirrors without changing delivery or cursors", () => isolated((filename) => run(filename, Effect.gen(function* () {
  const s = yield* fixture
  s.permission.name = "原始中文群名"
  const groupID = yield* KernelReader.pending(s.runtime, { conversationType: 2, conversationID: "group-original", name: "untrusted creation title" })
  expect((yield* s.output(groupID, s.repo.getGroup({ groupID, userID: "server" })))?.name).toBe(s.permission.name)
  const changes = { ...s.changes, items: [{ ...s.change, conversationType: 2 as const, targetId: "group-original" }] }
  yield* KernelReader.applyChanges(s.runtime, changes)
  yield* KernelReader.applyMessages(s.runtime, { ...s.messages, items: [{ ...s.message, conversationType: 2 as const, targetId: "group-original" }] })
  yield* KernelReader.checkpoint(s.runtime, [projectionKey], true)
  const before = yield* nameState(s.db)
  const projection = (yield* KernelReader.projection(s.runtime, projectionKey))!
  const initialName = s.permission.name
  s.permission.name = "经过当前成员验证的群名甲"
  expect(yield* KernelReader.pending(s.runtime, { conversationType: 2, conversationID: "group-original", name: "caller cannot overwrite" })).toBe(groupID)
  const after = yield* nameState(s.db)
  expect((yield* s.output(groupID, s.repo.getGroup({ groupID, userID: "server" })))?.name).toBe(s.permission.name)
  expect(after.groups).toEqual(before.groups.map((group) => ({ ...group, name: s.permission.name, updated_at: after.groups[0]?.updated_at })))
  expect(after.scope).toEqual(before.scope)
  expect(after.members).toEqual(before.members)
  expect(after.messages).toEqual(before.messages)
  expect(after.readerMessages).toEqual(before.readerMessages)
  expect(after.intents).toEqual(before.intents)
  expect(after.meter?.used_records).toBe(before.meter?.used_records)
  expect(after.meter!.used_bytes - before.meter!.used_bytes).toBe(Buffer.byteLength(s.permission.name) - Buffer.byteLength(initialName))
  const refreshed = (yield* KernelReader.projection(s.runtime, projectionKey))!
  expect(refreshed).toEqual({ ...projection, owned_group_bytes: projection.owned_group_bytes + Buffer.byteLength(s.permission.name) - Buffer.byteLength(initialName), accounted_bytes: projection.accounted_bytes + Buffer.byteLength(s.permission.name) - Buffer.byteLength(initialName), local_revision: projection.local_revision + 1, updated_at: refreshed.updated_at })
  const stored = (yield* KernelReader.scope(s.runtime))!
  s.permission.name = "第二次正式名称"
  expect(yield* KernelReader.applyChanges(s.runtime, { ...changes, after: stored.completed_after })).toEqual([groupID])
  const repeated = (yield* KernelReader.projection(s.runtime, projectionKey))!
  expect(repeated.metadata).toBe(refreshed.metadata)
  expect(repeated.cursor).toBe(refreshed.cursor)
  expect(repeated.newer_after).toBe(refreshed.newer_after)
  expect(repeated.older_before).toBe(refreshed.older_before)
  expect(repeated.accounted_records).toBe(refreshed.accounted_records)
  expect((yield* KernelReader.scope(s.runtime))?.continuation).toBe(JSON.stringify({ version: 1, projections: [] }))
  expect((yield* s.output(groupID, s.repo.getGroup({ groupID, userID: "server" })))?.name).toBe(s.permission.name)
}))))
test("authenticated group name refresh stays closed on current membership and invalid metadata", () => isolated((filename) => run(filename, Effect.gen(function* () {
  const s = yield* fixture
  const groupID = yield* KernelReader.pending(s.runtime, { conversationType: 2, conversationID: "group-original", name: "ignored" })
  const before = yield* nameState(s.db)
  s.permission.name = "unverified private title"
  s.permission.inspectAllowed = false
  expect(yield* KernelReader.pending(s.runtime, { conversationType: 2, conversationID: "group-original", name: "ignored" }).pipe(Effect.flip)).toMatchObject({ code: "reader_scope_mismatch" })
  expect(yield* nameState(s.db)).toEqual(before)
  s.permission.inspectAllowed = true
  s.permission.online = false
  expect(yield* KernelReader.pending(s.runtime, { conversationType: 2, conversationID: "group-original", name: "ignored" }).pipe(Effect.flip)).toMatchObject({ code: "reader_unavailable" })
  expect(yield* nameState(s.db)).toEqual(before)
  s.permission.online = true
  s.permission.name = "界".repeat(171)
  expect(yield* KernelReader.pending(s.runtime, { conversationType: 2, conversationID: "group-original", name: "ignored" }).pipe(Effect.flip)).toMatchObject({ code: "reader_mapping_conflict" })
  expect(yield* nameState(s.db)).toEqual(before)
  expect(groupID.startsWith("img_kr_")).toBe(true)
}))))
test("authenticated group name quota and projection CAS failures roll back the complete file transaction", () => isolated((filename) => run(filename, Effect.gen(function* () {
  const s = yield* fixture
  yield* KernelReader.pending(s.runtime, { conversationType: 2, conversationID: "group-original", name: "ignored" })
  yield* s.db.run(sql`UPDATE im_kernel_reader_meter SET used_bytes = ${KernelReaderSchema.BYTE_LIMIT}`)
  const full = yield* nameState(s.db)
  s.permission.name = "界".repeat(160)
  expect(yield* KernelReader.pending(s.runtime, { conversationType: 2, conversationID: "group-original", name: "ignored" }).pipe(Effect.flip)).toMatchObject({ code: "reader_capacity" })
  expect(yield* nameState(s.db)).toEqual(full)
  yield* s.db.run(sql`UPDATE im_kernel_reader_meter SET used_bytes = ${KernelReaderSchema.BYTE_LIMIT - 4096}`)
  yield* s.db.run(sql`CREATE TRIGGER reject_name_projection BEFORE UPDATE OF owned_group_bytes ON im_kernel_reader_projection BEGIN SELECT RAISE(IGNORE); END`)
  const conflict = yield* nameState(s.db)
  expect(yield* KernelReader.pending(s.runtime, { conversationType: 2, conversationID: "group-original", name: "ignored" }).pipe(Effect.flip)).toMatchObject({ code: "reader_stale" })
  expect(yield* nameState(s.db)).toEqual(conflict)
}))))
test("only the original retired runtime moves its dispatched read to unknown without claiming a result, freeing the higher-target explicit action", () => isolated((filename) => run(filename, Effect.gen(function* () {
  const s = yield* fixture
  yield* KernelReader.ensureScope(s.runtime)
  yield* KernelReader.applyChanges(s.runtime, s.changes)
  yield* KernelReader.checkpoint(s.runtime, [projectionKey], true)
  const groupID = (yield* KernelReader.projection(s.runtime, projectionKey))!.local_group_id!
  const cut: KernelReaderSchema.Cut = { version: 1, scopeKey, projectionKey, projectionRevision: s.permission.revision,
    throughOrdinal: "1", targetAdmittedOrdinal: "1", readOrdinal: "0", liveUnread: "1", storedUnread: "1", serverNow: Date.now(), complete: true }
  const prepared = yield* KernelReader.prepareRead(s.runtime, { actionID: "retired-original", groupID, cut })
  yield* KernelReader.dispatchRead(s.runtime, prepared!.action_id)
  const before = yield* KernelReader.readIntent(s.runtime, prepared!.action_id)
  if (!before) return yield* KernelReaderSchema.failure("reader_mapping_conflict", "fixture-dispatched")
  const budget = yield* meter(s.db)
  expect(before?.phase).toBe("dispatched")
  expect(yield* KernelReader.retireReads(s.runtime).pipe(Effect.flip)).toMatchObject({ code: "reader_unavailable" })
  expect(yield* KernelReader.readIntent(s.runtime, prepared!.action_id)).toEqual(before)
  KernelReader.close(s.runtime)
  yield* KernelReader.retireReads(s.runtime)
  const after = yield* s.db.get<NonNullable<typeof before>>(sql`SELECT * FROM im_kernel_reader_read_intent WHERE action_id='retired-original'`)
  if (!after) return yield* KernelReaderSchema.failure("reader_mapping_conflict", "fixture-retired")
  expect(after).toEqual({ ...before, phase: "unknown", local_revision: before!.local_revision + 1, updated_at: after!.updated_at })
  expect(after?.result).toBeNull()
  expect(after?.settled_at).toBeNull()
  expect(yield* meter(s.db)).toEqual(budget)
  expect(yield* KernelReader.settleRead(s.runtime, prepared!.action_id, { ...cut, readOrdinal: "1", liveUnread: "0", storedUnread: "0" }).pipe(Effect.flip)).toMatchObject({ code: "reader_unavailable" })
  expect(yield* s.db.get(sql`SELECT * FROM im_kernel_reader_read_intent WHERE action_id='retired-original'`)).toEqual(after)
  yield* KernelReader.retireReads(s.runtime)
  expect(yield* s.db.get(sql`SELECT * FROM im_kernel_reader_read_intent WHERE action_id='retired-original'`)).toEqual(after)
  const fresh = yield* fixture
  yield* KernelReader.ensureScope(fresh.runtime)
  expect(yield* KernelReader.retireReads(fresh.runtime).pipe(Effect.flip)).toMatchObject({ code: "reader_unavailable" })
  const revision = (BigInt(s.permission.revision) + 1n).toString()
  fresh.permission.revision = revision
  fresh.permission.admittedOrdinal = "2"
  yield* KernelReader.applyChanges(fresh.runtime, { ...s.changes, after: s.change.cursor,
    upper: revision, scanCursor: revision, serverNow: Date.now(),
    items: [{ ...s.change, revision, cursor: revision, admittedOrdinal: "2", liveUnread: "2", storedUnread: "2" }] })
  const next = yield* KernelReader.prepareRead(fresh.runtime, { actionID: "new-higher-target", groupID,
    cut: { ...cut, projectionRevision: revision, throughOrdinal: "2", targetAdmittedOrdinal: "2", liveUnread: "2", storedUnread: "2", serverNow: Date.now() }, newAction: true })
  expect(next?.phase).toBe("prepared")
  expect(next?.original_target_admitted).toBe("2")
  expect(yield* KernelReader.readIntent(fresh.runtime, "retired-original")).toEqual(after)
}))))
test("explicit higher targets preserve unknown history and reserve at most eight uncertain read slots", () => isolated((filename) => run(filename, Effect.gen(function* () {
  const s = yield* fixture
  yield* KernelReader.ensureScope(s.runtime)
  yield* KernelReader.applyChanges(s.runtime, s.changes)
  yield* KernelReader.checkpoint(s.runtime, [projectionKey], true)
  const groupID = (yield* KernelReader.projection(s.runtime, projectionKey))!.local_group_id!
  const cut = (target: string): KernelReaderSchema.Cut => ({ version: 1, scopeKey, projectionKey, projectionRevision: s.permission.revision, throughOrdinal: target, targetAdmittedOrdinal: target, readOrdinal: s.permission.readOrdinal, liveUnread: String(BigInt(target) - BigInt(s.permission.readOrdinal)), storedUnread: String(BigInt(target) - BigInt(s.permission.readOrdinal)), serverNow: Date.now(), complete: false })
  const advance = (target: string) => Effect.gen(function* () {
    s.permission.admittedOrdinal = target
    s.permission.revision = String(BigInt(s.change.revision) + BigInt(target) - 1n)
    const after = (yield* KernelReader.scope(s.runtime))!.completed_after
    yield* KernelReader.applyChanges(s.runtime, { ...s.changes, after, upper: s.permission.revision, scanCursor: s.permission.revision, items: [{ ...s.change, revision: s.permission.revision, cursor: s.permission.revision, admittedOrdinal: target, readOrdinal: s.permission.readOrdinal, liveUnread: cut(target).liveUnread, storedUnread: cut(target).storedUnread }] })
    yield* KernelReader.checkpoint(s.runtime, [projectionKey], true)
  })
  const original = yield* KernelReader.prepareRead(s.runtime, { groupID, actionID: "a-original-unknown", cut: cut("1") })
  yield* KernelReader.dispatchRead(s.runtime, original!.action_id)
  yield* KernelReader.settleRead(s.runtime, original!.action_id)
  const before = yield* KernelReader.readIntent(s.runtime, original!.action_id)
  yield* advance("2")
  expect(yield* KernelReader.prepareRead(s.runtime, { groupID, actionID: "normal-next", cut: cut("2") }).pipe(Effect.flip)).toMatchObject({ code: "reader_unknown" })
  expect(yield* KernelReader.prepareRead(s.runtime, { groupID, actionID: "same-target", cut: cut("1"), newAction: true }).pipe(Effect.flip)).toMatchObject({ code: "reader_stale" })
  const newAction = yield* KernelReader.prepareRead(s.runtime, { groupID, actionID: "z-new-action", cut: cut("2"), newAction: true })
  expect(yield* KernelReader.prepareRead(s.runtime, { groupID, actionID: "second-inflight", cut: cut("3"), newAction: true }).pipe(Effect.flip)).toMatchObject({ code: "reader_unknown" })
  yield* KernelReader.dispatchRead(s.runtime, newAction!.action_id)
  yield* KernelReader.settleRead(s.runtime, newAction!.action_id, { ...cut("2"), readOrdinal: "2", liveUnread: "0", storedUnread: "0", complete: true })
  s.permission.readOrdinal = "2"
  expect(yield* KernelReader.readIntent(s.runtime, original!.action_id)).toEqual(before)
  const visible = yield* s.output(groupID, s.repo.getGroup({ groupID, userID: "server" }))
  expect(visible?.reader?.readAction).toMatchObject({ actionID: "z-new-action", phase: "confirmed", cutIndex: 0 })
  expect(visible?.reader?.unresolvedReadActions).toEqual([{ actionID: "a-original-unknown", cutID: "a-original-unknown", phase: "unknown", cutIndex: 0, targetAdmitted: "1", throughOrdinal: "1", targetReached: true }])
  expect(visible?.reader?.admittedOrdinal).toBe("2")
  expect(visible?.reader?.liveUnread).toBe("0")
  for (const target of ["3", "4", "5", "6", "7", "8", "9"]) {
    yield* advance(target)
    const prepared = yield* KernelReader.prepareRead(s.runtime, { groupID, actionID: `unknown-${target}`, cut: cut(target), newAction: true })
    yield* KernelReader.dispatchRead(s.runtime, prepared!.action_id)
    yield* KernelReader.settleRead(s.runtime, prepared!.action_id)
  }
  yield* advance("10")
  const full = yield* meter(s.db)
  expect(yield* KernelReader.prepareRead(s.runtime, { groupID, actionID: "ninth-slot", cut: cut("10"), newAction: true }).pipe(Effect.flip)).toMatchObject({ code: "reader_capacity" })
  expect(yield* meter(s.db)).toEqual(full)
  expect((yield* s.output(groupID, s.repo.getGroup({ groupID, userID: "server" })))?.reader?.unresolvedReadActions).toHaveLength(8)
  expect(yield* KernelReader.readIntent(s.runtime, original!.action_id)).toEqual(before)
}))))
test("cold public GET stays read-only and legacy marker families never escape; local chat stays visible", () => isolated((filename) => run(filename, Effect.gen(function* () {
  const s = yield* fixture
  const local = yield* s.repo.createGroup({ workspaceID: "workspace", name: "pure local", type: "project", createdBy: "server" })
  const localMessage = yield* s.repo.createMessage({ groupID: local.id, senderID: "server", senderType: "user", type: "text", content: "local positive" })
  for (const family of ["group", "message", "metadata", "receipt"]) {
    const group = yield* s.repo.createGroup({ workspaceID: "workspace", name: `secret ${family}`, type: "project", createdBy: "server" })
    const message = yield* s.repo.createMessage({ groupID: group.id, senderID: "bob", senderType: "user", type: "text", content: `secret ${family}`, ...(family === "message" ? { kernelMsgID: `legacy-${family}` } : {}), ...(family === "metadata" ? { metadata: { type: "kernel_sync", liveEligible: false } } : {}) })
    if (family === "group") yield* s.repo.bindKernelConversation({ groupID: group.id, kernelConvID: "k:1:legacy" })
    if (family === "receipt") yield* s.db.run(sql`INSERT INTO im_kernel_delivery(message_id,binding,binding_hash,wire_id,state,created_at,updated_at) VALUES(${message.id},${JSON.stringify({ version: 1, messageID: message.id, groupID: group.id, workspaceID: "workspace", source, conversationType: 1, conversationID: "legacy", messageHash: "a".repeat(64), wireID: "legacy-receipt", textHash: "a".repeat(64), createdAt: message.createdAt, expiresAt: message.createdAt + 60000 })},${"a".repeat(64)},'legacy-receipt','prepared',${message.createdAt},${message.createdAt})`)
    expect(yield* s.repo.getMessage(message.id).pipe(Effect.flip)).toMatchObject({ code: "reader_legacy_unverified" })
    expect(yield* s.repo.listMessages({ groupID: group.id, limit: 32 }).pipe(Effect.flip)).toMatchObject({ code: "reader_legacy_unverified" })
  }
  expect((yield* s.repo.listGroups({ workspaceID: "workspace", userID: "server" })).map((group) => group.id)).toEqual([local.id])
  expect((yield* s.repo.getMessage(localMessage.id))?.content).toBe("local positive")
  expect((yield* s.repo.searchMessages({ workspaceID: "workspace", userID: "server", query: "secret", limit: 32 })).messages).toEqual([])
  expect(yield* meter(s.db)).toBeUndefined()
}))))
test("pending is a real local mapping, cannot receive or mark until the exact real projection arrives", () => isolated((filename) => run(filename, Effect.gen(function* () {
  const s = yield* fixture
  const groupID = yield* KernelReader.pending(s.runtime, { conversationType: 1, conversationID: "bob", name: "ignored claimed name" })
  expect((yield* s.output(groupID, s.repo.getGroup({ groupID, userID: "server" })))?.reader).toEqual({ mode: "protected", state: "pending", liveUnread: null, peerID: "bob" })
  expect(yield* KernelReader.applyMessages(s.runtime, s.messages).pipe(Effect.flip)).toMatchObject({ code: "reader_stale" })
  expect((yield* s.db.get<{ total: number }>(sql`SELECT count(*) AS total FROM im_kernel_reader_message`))?.total).toBe(0)
  yield* KernelReader.applyChanges(s.runtime, s.changes)
  yield* KernelReader.applyMessages(s.runtime, s.messages)
  yield* KernelReader.checkpoint(s.runtime, [projectionKey], true)
  const page = yield* s.output(groupID, s.repo.listMessages({ groupID, limit: 32 }))
  expect(page.messages.map((message) => message.content)).toEqual(["protected body"])
  expect(page.reader?.projectionRevision).toBe("9007199254740993")
  expect((yield* s.db.get<{ value: string }>(sql`SELECT sequence AS value FROM im_kernel_reader_message`))?.value).toBe("9007199254740993")
  expect((yield* s.db.get<{ project_id: null }>(sql`SELECT project_id FROM im_groups WHERE id=${groupID}`))?.project_id).toBeNull()
  expect((yield* meter(s.db))?.used_records).toBe(7)
}))))
test("exact repeated page keeps one mirror and one meter charge; changed immutable bytes roll back", () => isolated((filename) => run(filename, Effect.gen(function* () {
  const s = yield* fixture
  yield* KernelReader.ensureScope(s.runtime)
  yield* KernelReader.applyChanges(s.runtime, s.changes)
  yield* KernelReader.applyMessages(s.runtime, s.messages)
  const before = yield* meter(s.db)
  yield* KernelReader.applyMessages(s.runtime, s.messages)
  expect(yield* meter(s.db)).toEqual(before)
  expect(yield* KernelReader.applyMessages(s.runtime, { ...s.messages, items: [{ ...s.message, content: "changed body" }] }).pipe(Effect.flip)).toMatchObject({ code: "reader_mapping_conflict" })
  expect(yield* meter(s.db)).toEqual(before)
  expect((yield* s.db.get<{ total: number }>(sql`SELECT count(*) AS total FROM im_messages`))?.total).toBe(1)
}))))
test("failure after body insertion rolls back body, meter, and projection cursor in the same file transaction", () => isolated((filename) => run(filename, Effect.gen(function* () {
  const s = yield* fixture
  yield* KernelReader.ensureScope(s.runtime)
  yield* KernelReader.applyChanges(s.runtime, s.changes)
  const before = yield* meter(s.db)
  yield* s.db.run("CREATE TRIGGER reader_late_fault BEFORE INSERT ON im_kernel_reader_message BEGIN SELECT RAISE(ABORT,'late page failure'); END")
  yield* KernelReader.applyMessages(s.runtime, s.messages).pipe(Effect.exit)
  expect(yield* meter(s.db)).toEqual(before)
  expect((yield* s.db.get<{ total: number }>(sql`SELECT count(*) AS total FROM im_messages`))?.total).toBe(0)
  expect((yield* KernelReader.projections(s.runtime))[0].newer_after).toBe("0")
  expect((yield* KernelReader.scope(s.runtime))?.completed_after).toBe("0")
}))))
test("current cut, actual runtime identity, and post-read local revision are all required to output cached content", () => isolated((filename) => run(filename, Effect.gen(function* () {
  const s = yield* fixture
  yield* KernelReader.ensureScope(s.runtime)
  yield* KernelReader.applyChanges(s.runtime, s.changes)
  yield* KernelReader.applyMessages(s.runtime, s.messages)
  const groupID = (yield* KernelReader.projections(s.runtime))[0].local_group_id!
  s.permission.allowed = false
  expect(yield* s.output(groupID, s.repo.listMessages({ groupID, limit: 32 })).pipe(Effect.flip)).toMatchObject({ code: "reader_stale" })
  s.permission.allowed = true
  expect(yield* KernelReader.withOutput({ ...s.runtime }, { workspaceID: "workspace", userID: "server", groupIDs: [groupID] }, s.repo.listMessages({ groupID, limit: 32 })).pipe(Effect.flip)).toMatchObject({ code: "reader_legacy_unverified" })
  expect(yield* s.output(groupID, s.repo.listMessages({ groupID, limit: 32 }).pipe(Effect.tap(() => s.db.run(sql`UPDATE im_kernel_reader_projection SET local_revision=local_revision+1 WHERE local_group_id=${groupID}`)))).pipe(Effect.flip)).toMatchObject({ code: "reader_stale" })
  s.permission.online = false
  expect(yield* s.output(groupID, s.repo.listMessages({ groupID, limit: 32 })).pipe(Effect.flip)).toMatchObject({ code: "reader_legacy_unverified" })
}))))

test("inclusive unchanged change-window boundary does not schedule another body scan or mutate its projection", () => isolated((filename) => run(filename, Effect.gen(function* () {
  const s = yield* fixture
  yield* KernelReader.ensureScope(s.runtime)
  yield* KernelReader.applyChanges(s.runtime, s.changes)
  yield* KernelReader.applyMessages(s.runtime, s.messages)
  yield* KernelReader.checkpoint(s.runtime, [projectionKey], true)
  const before = (yield* KernelReader.projections(s.runtime))[0]
  yield* KernelReader.applyChanges(s.runtime, { ...s.changes, after: s.change.cursor, serverNow: Date.now() })
  const window = yield* KernelReader.scope(s.runtime)
  expect(KernelReaderSchema.decode(KernelReaderSchema.Continuation, window!.continuation, 8192).projections).toEqual([])
  expect((yield* KernelReader.projections(s.runtime))[0]).toEqual(before)
  yield* KernelReader.checkpoint(s.runtime, [], true)
  expect((yield* KernelReader.scope(s.runtime))?.phase).toBe("idle")
  expect((yield* KernelReader.scope(s.runtime))?.completed_after).toBe(s.change.cursor)
}))))

test("discarding stale unfinished work preserves the completed cursor and allows a fresh revision window", () => isolated((filename) => run(filename, Effect.gen(function* () {
  const s = yield* fixture
  yield* KernelReader.ensureScope(s.runtime)
  yield* KernelReader.applyChanges(s.runtime, s.changes)
  expect((yield* KernelReader.scope(s.runtime))?.phase).toBe("partial")
  yield* KernelReader.discardWindow(s.runtime)
  const stored = yield* KernelReader.scope(s.runtime)
  expect(stored).toMatchObject({ phase: "idle", completed_after: "0", window_after: null, window_upper: null, page_token: null })
  expect(KernelReaderSchema.decode(KernelReaderSchema.Continuation, stored!.continuation, 8192).projections).toEqual([])
  const revision = "9007199254740994"
  yield* KernelReader.applyChanges(s.runtime, { ...s.changes, upper: revision, scanCursor: revision, items: [{ ...s.change, revision, cursor: revision }] })
  expect((yield* KernelReader.projections(s.runtime))[0].server_revision).toBe(revision)
  expect((yield* KernelReader.scope(s.runtime))?.completed_after).toBe("0")
}))))

test("reader page times and wire errors reject non-finite, fractional and out-of-range numbers", () => {
  const time = Schema.decodeUnknownSync(KernelReaderSchema.Time)
  for (const value of [NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) expect(() => time(value)).toThrow()
  expect(time(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER)
  for (const value of [NaN, Infinity, -1, 12203.5, 65536]) expect(() => new KernelReaderSchema.Error({ code: "reader_stale", operation: "query", wireCode: value, message: "Remote conversation is currently unavailable" })).toThrow()
  expect(new KernelReaderSchema.Error({ code: "reader_stale", operation: "query", wireCode: 12203, message: "Remote conversation is currently unavailable" }).wireCode).toBe(12203)
})

test("cold credential change excludes the previous ownsender receipt without blocking current received bodies", () => isolated((filename) => run(filename, Effect.gen(function* () {
  const s = yield* fixture
  yield* KernelReader.ensureScope(s.runtime)
  yield* KernelReader.applyChanges(s.runtime, s.changes)
  yield* KernelReader.applyMessages(s.runtime, s.messages)
  const groupID = (yield* KernelReader.projections(s.runtime))[0].local_group_id!
  const authority = KernelDelivery.runtime(source)
  const own = yield* KernelDelivery.withCreation(authority, groupID, s.repo.createMessage({ groupID, senderID: "server", senderType: "user", type: "text", content: "original ownsender", clientRequestID: "cold-original-sender" }))
  const dispatch = yield* KernelDelivery.withVerification(authority, { conversationType: 1, conversationID: "bob", orgID: 1, memberIDs: ["alice", "bob"] }, s.repo.claimKernelDelivery(authority, own.id))
  expect(dispatch).toBeDefined()
  yield* s.repo.acknowledgeKernelDelivery(authority, dispatch!, "own-kernel-ack")
  yield* KernelReader.applyMessages(s.runtime, { ...s.messages, items: [{ ...s.message, effectKey: "e".repeat(64), messageId: "own-kernel-ack", sequence: "9007199254740994", deliveryCursor: "9007199254740994", senderId: "alice", isSend: true, content: JSON.stringify({ content: "original ownsender" }), expiresAt: dispatch!.binding.expiresAt }] })
  expect((yield* s.output(groupID, s.repo.listMessages({ groupID, limit: 32 }))).messages.map((row) => row.content).sort()).toEqual(["original ownsender", "protected body"])
  const previous = yield* s.db.get<{ binding: string; binding_hash: string }>(sql`SELECT binding,binding_hash FROM im_kernel_delivery WHERE message_id=${own.id}`)
  const fresh = KernelReader.attach({ db: s.db, workspaceID: "workspace", userID: "server", source: { ...source, credentialFingerprint: "f".repeat(64) }, current: () => Effect.succeed(true), inspect: () => Effect.succeed({ name: "current peer" }), readCut: (request) => Effect.succeed({ ...request, throughOrdinal: "1", targetAdmittedOrdinal: "1", readOrdinal: "0", liveUnread: "1", storedUnread: "1", serverNow: Date.now(), complete: true }) })
  yield* Effect.addFinalizer(() => Effect.sync(() => KernelReader.close(fresh)))
  yield* KernelReader.bind(fresh, scopeKey)
  yield* KernelReader.ensureScope(fresh)
  const page = yield* KernelReader.withOutput(fresh, { workspaceID: "workspace", userID: "server", groupIDs: [groupID] }, s.repo.listMessages({ groupID, limit: 32 }))
  expect(page.messages.map((row) => row.content)).toEqual(["protected body"])
  expect(yield* s.db.get(sql`SELECT binding,binding_hash FROM im_kernel_delivery WHERE message_id=${own.id}`)).toEqual(previous)
  expect(yield* s.db.get(sql`SELECT content,kernel_msg_id FROM im_messages WHERE id=${own.id}`)).toEqual({ content: "original ownsender", kernel_msg_id: null })
  const recovery = { ...s.messages, items: [{ ...s.message, effectKey: "e".repeat(64), messageId: "own-kernel-ack", sequence: "9007199254740994", deliveryCursor: "9007199254740994", senderId: "alice", isSend: true, content: JSON.stringify({ content: "original ownsender" }), expiresAt: dispatch!.binding.expiresAt }] }
  const beforeRecovery = yield* meter(s.db)
  const beforeCursor = (yield* KernelReader.projection(fresh, projectionKey))!.newer_after
  yield* s.db.run("CREATE TRIGGER sender_recovery_late_fault BEFORE UPDATE OF owns_message ON im_kernel_reader_message WHEN OLD.owns_message=0 AND NEW.owns_message=1 BEGIN SELECT RAISE(ABORT,'private recovery fault'); END")
  yield* KernelReader.applyMessages(fresh, recovery, "e".repeat(64)).pipe(Effect.exit)
  expect(yield* meter(s.db)).toEqual(beforeRecovery)
  expect((yield* s.db.get<{ total: number }>(sql`SELECT count(*) AS total FROM im_messages`))?.total).toBe(2)
  yield* s.db.run("DROP TRIGGER sender_recovery_late_fault")
  yield* KernelReader.applyMessages(fresh, recovery, "e".repeat(64))
  expect((yield* meter(s.db))!.used_records).toBe(beforeRecovery!.used_records + 1)
  expect((yield* KernelReader.projection(fresh, projectionKey))!.newer_after).toBe(beforeCursor)
  const afterRecovery = yield* meter(s.db)
  yield* KernelReader.applyMessages(fresh, recovery, "e".repeat(64))
  expect(yield* meter(s.db)).toEqual(afterRecovery)
  const recovered = yield* KernelReader.withOutput(fresh, { workspaceID: "workspace", userID: "server", groupIDs: [groupID] }, s.repo.listMessages({ groupID, limit: 32 }))
  expect(recovered.messages.map((row) => row.content).sort()).toEqual(["original ownsender", "protected body"])
  expect(yield* s.db.get(sql`SELECT binding,binding_hash FROM im_kernel_delivery WHERE message_id=${own.id}`)).toEqual(previous)
  expect(yield* s.db.get(sql`SELECT content,kernel_msg_id FROM im_messages WHERE id=${own.id}`)).toEqual({ content: "original ownsender", kernel_msg_id: null })
}))))

test("more than thirty-two persistent projections remain page-addressable and two fresh cuts run concurrently", () => isolated((filename) => run(filename, Effect.gen(function* () {
  const s = yield* fixture
  yield* KernelReader.ensureScope(s.runtime)
  const now = Date.now()
  const items = Array.from({ length: 33 }, (_, index) => ({ ...s.change, projectionKey: (index + 1).toString(16).padStart(64, "0"), targetId: `peer-${index}`, cursor: String(index + 1), admittedOrdinal: "0", readOrdinal: "0", liveUnread: "0", storedUnread: "0", latestMessageId: "", latestSequence: "", latestMessageTime: 0, nextExpiryAt: 0 }))
  for (const page of [items.slice(0, 32), items.slice(32)]) {
    const after = (yield* KernelReader.scope(s.runtime))!.completed_after
    yield* KernelReader.applyChanges(s.runtime, { ...s.changes, after, upper: page.at(-1)!.cursor, scanCursor: page.at(-1)!.cursor, scanProjectionKey: page.at(-1)!.projectionKey, items: page, serverNow: now })
    for (const item of page) yield* KernelReader.applyMessages(s.runtime, { ...s.messages, projectionKey: item.projectionKey, projectionRevision: item.revision, items: [], serverNow: now })
    yield* KernelReader.checkpoint(s.runtime, page.map((item) => item.projectionKey), true)
  }
  yield* s.db.run(sql`UPDATE im_groups SET created_at=${now} WHERE workspace_id='workspace'`)
  const readerKey = (yield* KernelReader.scope(s.runtime))!.reader_key
  expect((yield* KernelReader.pageIdentity(s.runtime, { workspaceID: "workspace", userID: "server" })).readerKey).toBe(readerKey)
  expect(yield* KernelReader.pageIdentity(s.runtime, { workspaceID: "different-workspace", userID: "server" }).pipe(Effect.flip)).toMatchObject({ code: "reader_scope_mismatch", operation: "group-page" })
  const selected: string[] = []
  let upper: KernelReaderSchema.GroupPosition | undefined
  let after: KernelReaderSchema.GroupPosition | undefined
  while (true) {
    const page = yield* groupPageCandidates(s.db, { workspaceID: "workspace", userID: "server", lane: "protected", readerKey, limit: 2, upper, after })
    selected.push(...page.rows.map((row) => row.id))
    if (!page.hasMore) break
    upper = page.upper
    after = page.rows.at(-1)
  }
  expect(new Set(selected).size).toBe(33)
  expect(selected.length).toBe(33)
  expect(yield* KernelReader.projections(s.runtime).pipe(Effect.flip)).toMatchObject({ code: "reader_capacity" })
  expect((yield* KernelReader.projection(s.runtime, items[32]!.projectionKey))?.target_id).toBe("peer-32")
  const started = yield* Deferred.make<void>()
  const release = yield* Deferred.make<void>()
  const observed = { active: 0, maximum: 0, calls: 0 }
  const current = KernelReader.attach({ db: s.db, workspaceID: "workspace", userID: "server", source, current: () => Effect.succeed(true), inspect: () => Effect.succeed({ name: "current peer" }), readCut: (request) => Effect.gen(function* () {
    observed.active++
    observed.calls++
    observed.maximum = Math.max(observed.maximum, observed.active)
    if (observed.active === 2) yield* Deferred.succeed(started, undefined)
    yield* Deferred.await(release)
    observed.active--
    return { ...request, throughOrdinal: "0", targetAdmittedOrdinal: "0", readOrdinal: "0", liveUnread: "0", storedUnread: "0", serverNow: Date.now(), complete: true }
  }) })
  yield* Effect.addFinalizer(() => Effect.sync(() => KernelReader.close(current)))
  yield* KernelReader.bind(current, scopeKey)
  yield* KernelReader.ensureScope(current)
  const page = yield* groupPageCandidates(s.db, { workspaceID: "workspace", userID: "server", lane: "protected", readerKey, limit: 2 })
  const query = yield* Effect.forkChild(KernelReader.withOutput(current, { workspaceID: "workspace", userID: "server", groupIDs: page.rows.map((row) => row.id) }, Effect.gen(function* () {
    const groups = yield* Effect.forEach(page.rows, (row) => s.repo.getGroup({ groupID: row.id, workspaceID: "workspace", userID: "server" }))
    return { groups, reader: yield* KernelReader.groupPageState(s.db) }
  })))
  yield* Deferred.await(started)
  expect(observed).toEqual({ active: 2, maximum: 2, calls: 2 })
  yield* Deferred.succeed(release, undefined)
  const result = yield* Fiber.join(query)
  expect(result.groups.length).toBe(2)
  expect(result.reader?.proofWindowMs).toBeGreaterThanOrEqual(999)
  expect(result.reader?.proofWindowMs).toBeLessThanOrEqual(1000)
  expect(observed.active).toBe(0)
}))))

test("a later true read observation retains original recipient identity bytes and never creates a read action", () => isolated((filename) => run(filename, Effect.gen(function* () {
  const s = yield* fixture
  yield* KernelReader.ensureScope(s.runtime)
  yield* KernelReader.applyChanges(s.runtime, s.changes)
  yield* KernelReader.applyMessages(s.runtime, s.messages)
  const before = yield* s.db.get(sql`SELECT metadata,immutable_hash,body_hash FROM im_kernel_reader_message`)
  const beforeMeter = yield* meter(s.db)
  yield* KernelReader.applyMessages(s.runtime, { ...s.messages, items: [{ ...s.message, isRead: true }] })
  expect(yield* s.db.get(sql`SELECT metadata,immutable_hash,body_hash FROM im_kernel_reader_message`)).toEqual(before)
  expect(yield* meter(s.db)).toEqual(beforeMeter)
  expect((yield* s.db.get<{ total: number }>(sql`SELECT count(*) AS total FROM im_kernel_reader_read_intent`))?.total).toBe(0)
  expect(yield* KernelReader.applyMessages(s.runtime, { ...s.messages, items: [{ ...s.message, isRead: true, isSend: true }] }).pipe(Effect.flip)).toMatchObject({ code: "reader_mapping_conflict" })
}))))

test("a pure revoked identity tombstone merges into its inspected pending mapping with exact meter release", () => isolated((filename) => run(filename, Effect.gen(function* () {
  const s = yield* fixture
  yield* KernelReader.ensureScope(s.runtime)
  yield* KernelReader.applyChanges(s.runtime, { ...s.changes, upper: "1", scanCursor: "1", items: [{ visibility: "revoked", projectionKey, revision: "1", cursor: "1" }] })
  yield* KernelReader.checkpoint(s.runtime, [], true)
  const groupID = yield* KernelReader.pending(s.runtime, { conversationType: 1, conversationID: "bob", name: "ignored" })
  const before = yield* meter(s.db)
  yield* KernelReader.applyChanges(s.runtime, { ...s.changes, after: "1" })
  expect((yield* meter(s.db))!.used_records).toBe(before!.used_records - 1)
  expect((yield* s.db.get<{ total: number }>(sql`SELECT count(*) AS total FROM im_kernel_reader_projection`))?.total).toBe(1)
  expect((yield* KernelReader.projection(s.runtime, projectionKey))?.local_group_id).toBe(groupID)
  yield* KernelReader.applyMessages(s.runtime, s.messages)
  expect((yield* s.output(groupID, s.repo.listMessages({ groupID, limit: 32 }))).messages[0]?.content).toBe("protected body")
}))))


test("cold credential change before the first sender page creates a current owned mirror and preserves the acknowledged receipt", () => isolated((filename) => run(filename, Effect.gen(function* () {
  const s = yield* fixture
  yield* KernelReader.ensureScope(s.runtime)
  yield* KernelReader.applyChanges(s.runtime, s.changes)
  const groupID = (yield* KernelReader.projections(s.runtime))[0].local_group_id!
  const authority = KernelDelivery.runtime(source)
  const own = yield* KernelDelivery.withCreation(authority, groupID, s.repo.createMessage({ groupID, senderID: "server", senderType: "user", type: "text", content: "first cold echo", clientRequestID: "first-cold-echo" }))
  const dispatch = yield* KernelDelivery.withVerification(authority, { conversationType: 1, conversationID: "bob", orgID: 1, memberIDs: ["alice", "bob"] }, s.repo.claimKernelDelivery(authority, own.id))
  expect(dispatch).toBeDefined()
  yield* s.repo.acknowledgeKernelDelivery(authority, dispatch!, "first-cold-kernel-ack")
  const original = yield* nameState(s.db)
  const receipt = yield* s.db.get(sql`SELECT * FROM im_kernel_delivery WHERE message_id=${own.id}`)
  const originalMessage = yield* s.db.get(sql`SELECT * FROM im_messages WHERE id=${own.id}`)
  KernelReader.close(s.runtime)
  const currentSource = { ...source, credentialFingerprint: "f".repeat(64) }
  const fresh = KernelReader.attach({ db: s.db, workspaceID: "workspace", userID: "server", source: currentSource, current: () => Effect.succeed(true), inspect: () => Effect.succeed({ name: "current peer" }), readCut: (request) => Effect.succeed({ ...request, throughOrdinal: "1", targetAdmittedOrdinal: "1", readOrdinal: "0", liveUnread: "1", storedUnread: "1", serverNow: Date.now(), complete: true }) })
  yield* Effect.addFinalizer(() => Effect.sync(() => KernelReader.close(fresh)))
  yield* KernelReader.bind(fresh, scopeKey)
  yield* KernelReader.ensureScope(fresh)
  const page = { ...s.messages, items: [{ ...s.message, effectKey: "e".repeat(64), messageId: "first-cold-kernel-ack", sequence: "9007199254740994", deliveryCursor: "9007199254740994", senderId: "alice", isSend: true, content: JSON.stringify({ content: "first cold echo" }), expiresAt: dispatch!.binding.expiresAt }] }
  const before = yield* nameState(s.db)
  // Credential rotation is the only allowed source difference. Each other
  // identity mismatch keeps the original receipt and reader checkpoint intact.
  for (const changed of [{ realm: "https://foreign.invalid/" }, { appkey: "foreign-app" }, { orgID: 2 }, { senderID: "mallory" }]) {
    const binding = { ...dispatch!.binding, source: { ...dispatch!.binding.source, ...changed } }
    const wireID = `dac_${KernelDelivery.hash(["im-kernel-wire-v1", binding.source, binding.messageID])}`
    yield* s.db.run(sql`UPDATE im_kernel_delivery SET binding=${JSON.stringify({ ...binding, wireID })},binding_hash=${KernelDelivery.hash({ ...binding, wireID })},wire_id=${wireID} WHERE message_id=${own.id}`)
    expect((yield* KernelReader.applyMessages(fresh, page).pipe(Effect.flip))).toMatchObject({ code: "reader_mapping_conflict", operation: "sender-receipt" })
    expect(yield* nameState(s.db)).toEqual(before)
  }
  yield* s.db.run(sql`UPDATE im_kernel_delivery SET binding=${JSON.stringify(dispatch!.binding)},binding_hash=${KernelDelivery.hash(dispatch!.binding)},wire_id=${dispatch!.binding.wireID} WHERE message_id=${own.id}`)
  expect((yield* KernelReader.applyMessages(fresh, { ...page, items: [{ ...page.items[0]!, content: JSON.stringify({ content: "changed echo" }) }] }).pipe(Effect.flip))).toMatchObject({ code: "reader_mapping_conflict", operation: "sender-receipt" })
  expect(yield* nameState(s.db)).toEqual(before)
  const foreignWorkspace = { ...dispatch!.binding, workspaceID: "foreign-workspace" }
  yield* s.db.run(sql`UPDATE im_kernel_delivery SET binding=${JSON.stringify(foreignWorkspace)},binding_hash=${KernelDelivery.hash(foreignWorkspace)} WHERE message_id=${own.id}`)
  expect((yield* KernelReader.applyMessages(fresh, page).pipe(Effect.flip))).toMatchObject({ code: "reader_mapping_conflict", operation: "sender-receipt" })
  expect(yield* nameState(s.db)).toEqual(before)
  yield* s.db.run(sql`UPDATE im_kernel_delivery SET binding=${JSON.stringify(dispatch!.binding)},binding_hash=${KernelDelivery.hash(dispatch!.binding)} WHERE message_id=${own.id}`)
  yield* KernelReader.applyMessages(fresh, page)
  const current = yield* KernelReader.withOutput(fresh, { workspaceID: "workspace", userID: "server", groupIDs: [groupID] }, s.repo.listMessages({ groupID, limit: 32 }))
  expect(current.messages.map((row) => row.content)).toEqual(["first cold echo"])
  expect(current.messages[0]!.id).not.toBe(own.id)
  expect(yield* s.db.get(sql`SELECT * FROM im_kernel_delivery WHERE message_id=${own.id}`)).toEqual(receipt)
  expect(yield* s.db.get(sql`SELECT * FROM im_messages WHERE id=${own.id}`)).toEqual(originalMessage)
  const after = yield* nameState(s.db)
  expect(after.readerMessages).toHaveLength(1)
  expect(after.readerMessages[0]).toMatchObject({ owns_message: 1, message_id: "first-cold-kernel-ack" })
  expect(after.meter!.used_records).toBe(before.meter!.used_records + 2)
  yield* KernelReader.applyMessages(fresh, page)
  expect((yield* nameState(s.db)).messages).toEqual(after.messages)
  expect((yield* nameState(s.db)).readerMessages).toEqual(after.readerMessages)
  expect(yield* meter(s.db)).toEqual(after.meter)
  KernelReader.close(fresh)
  const retired = yield* nameState(s.db)
  expect((yield* KernelReader.applyMessages(fresh, page).pipe(Effect.flip))).toMatchObject({ code: "reader_unavailable" })
  expect(yield* nameState(s.db)).toEqual(retired)
}))))


test("slow authenticated cut starts a bounded local output window after settlement and preserves current and revision fences", () => isolated((filename) => run(filename, Effect.gen(function* () {
  const s = yield* fixture
  yield* KernelReader.ensureScope(s.runtime)
  yield* KernelReader.applyChanges(s.runtime, s.changes)
  yield* KernelReader.applyMessages(s.runtime, s.messages)
  const groupID = (yield* KernelReader.projection(s.runtime, projectionKey))!.local_group_id!
  const engine = yield* KernelReader.current(s.runtime)
  const originalCut = engine.readCut
  const before = yield* nameState(s.db)
  const calls: string[] = []
  engine.readCut = (request) => originalCut(request).pipe(Effect.flatMap((cut) => Effect.sleep("1100 millis").pipe(Effect.as(cut))), Effect.tap(() => Effect.sync(() => { calls.push("original-cut") })))
  const page = yield* s.output(groupID, Effect.gen(function* () {
    return { messages: yield* s.repo.listMessages({ groupID, limit: 2 }), reader: yield* KernelReader.groupPageState(s.db) }
  }))
  expect(page.messages.messages.map((message) => message.content)).toEqual(["protected body"])
  expect(calls).toEqual(["original-cut"])
  expect(page.reader!.proofWindowMs).toBeGreaterThanOrEqual(1)
  expect(page.reader!.proofWindowMs).toBeLessThanOrEqual(1000)
  expect(Schema.is(KernelReaderSchema.GroupPageReader)(page.reader)).toBe(true)
  expect(page.reader!.nextExpiryAt).toBe(s.message.expiresAt)
  expect(yield* nameState(s.db)).toEqual(before)
  engine.readCut = (request) => originalCut(request).pipe(Effect.tap(() => Effect.sync(() => { s.permission.online = false })))
  expect((yield* s.output(groupID, s.repo.listMessages({ groupID, limit: 2 })).pipe(Effect.flip))).toMatchObject({ code: "reader_unavailable" })
  s.permission.online = true
  expect(yield* nameState(s.db)).toEqual(before)
  // A real concurrent message-page checkpoint changes the original snapshot;
  // a newer local consumption window must not make that snapshot current.
  engine.readCut = (request) => originalCut(request).pipe(Effect.tap(() => KernelReader.applyMessages(s.runtime, { ...s.messages, items: [] }).pipe(Effect.orDie)))
  expect((yield* s.output(groupID, s.repo.listMessages({ groupID, limit: 2 })).pipe(Effect.flip))).toMatchObject({ code: "reader_stale", operation: "output-revision" })
}))))

test("slow authenticated cut never renews a message expiry consumed during its flight", () => isolated((filename) => run(filename, Effect.gen(function* () {
  const s = yield* fixture
  yield* KernelReader.ensureScope(s.runtime)
  const expiresAt = Date.now() + 200
  yield* KernelReader.applyChanges(s.runtime, { ...s.changes, items: [{ ...s.change, nextExpiryAt: expiresAt }] })
  yield* KernelReader.applyMessages(s.runtime, { ...s.messages, items: [{ ...s.message, expiresAt }] })
  const groupID = (yield* KernelReader.projection(s.runtime, projectionKey))!.local_group_id!
  const engine = yield* KernelReader.current(s.runtime)
  const originalCut = engine.readCut
  const before = yield* nameState(s.db)
  engine.readCut = (request) => originalCut(request).pipe(Effect.flatMap((cut) => Effect.sleep("300 millis").pipe(Effect.as(cut))))
  expect((yield* s.output(groupID, s.repo.listMessages({ groupID, limit: 2 })).pipe(Effect.flip))).toMatchObject({ code: "reader_stale", operation: "output-deadline" })
  expect(yield* nameState(s.db)).toEqual(before)
}))))


test("slow authenticated pending inspection starts its local consumption window without admitting any message", () => isolated((filename) => run(filename, Effect.gen(function* () {
  const s = yield* fixture
  yield* KernelReader.ensureScope(s.runtime)
  const groupID = yield* KernelReader.pending(s.runtime, { conversationType: 1, conversationID: "bob", name: "caller title" })
  const engine = yield* KernelReader.current(s.runtime)
  const originalInspect = engine.inspect
  const before = yield* nameState(s.db)
  engine.inspect = (request) => originalInspect(request).pipe(Effect.delay("1100 millis"))
  const page = yield* s.output(groupID, Effect.gen(function* () {
    return { group: yield* s.repo.getGroup({ groupID, userID: "server" }), reader: yield* KernelReader.groupPageState(s.db) }
  }))
  expect(page.group!.id).toBe(groupID)
  expect(page.group!.reader?.state).toBe("pending")
  expect(page.reader!.proofWindowMs).toBeGreaterThanOrEqual(1)
  expect(page.reader!.proofWindowMs).toBeLessThanOrEqual(1000)
  expect(Schema.is(KernelReaderSchema.GroupPageReader)(page.reader)).toBe(true)
  expect(page.reader!.nextExpiryAt).toBeNull()
  expect((yield* nameState(s.db)).messages).toHaveLength(0)
  expect(yield* nameState(s.db)).toEqual(before)
}))))
