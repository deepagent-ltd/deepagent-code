import { expect, test } from "bun:test"
import { Deferred, Effect, Fiber, Layer, Stream, SubscriptionRef } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { IMBroadcasterService } from "@deepagent-code/core/im/broadcaster"
import { KernelReader } from "@deepagent-code/core/im/kernel-reader"
import { IMKernelReader } from "@/im/kernel/reader"
import { KernelClient } from "@/im/kernel/client"
import { KernelSdk } from "@/im/kernel/sdk"
import { KernelConfig } from "@/im/kernel/config"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.merge(Database.layerFromPath(":memory:"), Layer.mock(IMBroadcasterService, { broadcast: () => {}, sendToUser: () => {}, register: () => true, unregister: () => {}, getConnectionCount: () => 0, getUserConnectionCount: () => 0 })))
test("a closed media profile is default off and upgrade-required remains an explicit typed reader failure", () => {
  expect(KernelConfig.protectedMediaFromEnv({})).toBe(false)
  expect(KernelConfig.protectedMediaFromEnv({ DEEPAGENT_IM_KERNEL_MEDIA_PROFILE: "mysql-protected-media-v1" })).toBe(true)
  expect(() => KernelConfig.protectedMediaFromEnv({ DEEPAGENT_IM_KERNEL_MEDIA_PROFILE: "unknown" })).toThrow()
  expect(IMKernelReader.readerError(new KernelSdk.KernelError({ operation: "read_cut", message: "upgrade", cause: { kind: "upgrade_required", wireCode: 12206 } })))
    .toMatchObject({ code: "reader_upgrade_required", wireCode: 12206 })
})
it.live("concurrent product refresh waits for the actual reader pass without issuing another native query", () => Effect.gen(function* () {
  const started = yield* Deferred.make<void>()
  const release = yield* Deferred.make<void>()
  const completed = yield* Deferred.make<void>()
  const ordinaryCompleted = yield* Deferred.make<void>()
  const state = yield* SubscriptionRef.make<KernelClient.ConnectionState>("connected")
  const calls = { reader: 0, changes: 0 }
  const client = Layer.mock(KernelClient.Service, {
    state,
    messages: Stream.empty,
    getDeliveryReader: () => Effect.gen(function* () {
      calls.reader++
      yield* Deferred.succeed(started, undefined)
      yield* Deferred.await(release)
      return { version: 1 as const, scopeKey: "a".repeat(64), currentCursor: "0", serverNow: Date.now(), maxPageItems: 32, maxChangeBytes: 65536, maxMessageBytes: 4194304, maxWindowPages: 100000 }
    }),
    getDeliveryChanges: (input) => Effect.sync(() => {
      calls.changes++
      return { version: 1 as const, scopeKey: input.scopeKey, after: input.after, upper: "0", scanCursor: "0", scanProjectionKey: "", pageToken: "", windowComplete: true, caughtUp: true, serverNow: Date.now(), items: [] }
    }),
  })
  const reader = yield* IMKernelReader.make({ appkey: "isolated", navigator: "http://127.0.0.1:9", token: "isolated-token", userID: "alice", identity: { uuid: "alice", orgID: 1, name: "alice", orgAllGroupID: "unused" } }, { workspaceID: "workspace" }).pipe(Effect.provide(client))
  const first = yield* Effect.forkChild(reader.sync)
  yield* Deferred.await(started)
  const ordinary = yield* Effect.forkChild(reader.withOutput({ workspaceID: "workspace", userID: "server", groupIDs: [] }, Effect.succeed("ordinary current read")).pipe(Effect.tap(() => Deferred.succeed(ordinaryCompleted, undefined))))
  yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined))
  expect((yield* Deferred.await(ordinaryCompleted).pipe(Effect.timeoutOption("20 millis")))._tag).toBe("None")
  const second = yield* Effect.forkChild(reader.sync.pipe(Effect.andThen(Deferred.succeed(completed, undefined))))
  expect((yield* Deferred.await(completed).pipe(Effect.timeoutOption("20 millis")))._tag).toBe("None")
  expect(calls).toEqual({ reader: 1, changes: 0 })
  yield* Deferred.succeed(release, undefined)
  yield* Fiber.join(first)
  yield* Fiber.join(second)
  expect(yield* Fiber.join(ordinary)).toBe("ordinary current read")
  expect(calls).toEqual({ reader: 1, changes: 1 })
  expect((yield* SubscriptionRef.get(reader.state)).state).toBe("ready")
}))

it.live("active socket ownership controls polling and invalidation after the last connection releases", () => Effect.gen(function* () {
  const invalidated: string[] = []
  const state = yield* SubscriptionRef.make<KernelClient.ConnectionState>("connected")
  const reader = yield* IMKernelReader.make({ appkey: "isolated", navigator: "http://127.0.0.1:9", token: "isolated-token", userID: "alice", identity: { uuid: "alice", orgID: 1, name: "alice", orgAllGroupID: "unused" } }, { workspaceID: "workspace" }).pipe(Effect.provide(Layer.merge(Layer.mock(KernelClient.Service, { state }), Layer.mock(IMBroadcasterService, { broadcast: (groupID, event) => { if (event.type === "reader_invalidated") invalidated.push(groupID) }, sendToUser: () => {}, register: () => true, unregister: () => {}, getConnectionCount: () => 0, getUserConnectionCount: () => 0 }))))
  expect(reader.hasActiveConnections()).toBe(false)
  const first = reader.watchGroup("first")
  const sameGroup = reader.watchGroup("first")
  const second = reader.watchGroup("second")
  first()
  expect(reader.hasActiveConnections()).toBe(true)
  yield* reader.invalidate()
  expect(invalidated).toEqual(["first", "second"])
  first()
  sameGroup()
  yield* reader.invalidate()
  expect(invalidated).toEqual(["first", "second", "second"])
  second()
  expect(reader.hasActiveConnections()).toBe(false)
  yield* reader.invalidate()
  expect(invalidated).toEqual(["first", "second", "second"])
}))

it.live("explicit read reconciliation observes another device reaching the target without settling the original unknown action", () => Effect.gen(function* () {
  const state = yield* SubscriptionRef.make<KernelClient.ConnectionState>("connected")
  const scopeKey = "a".repeat(64)
  const projectionKey = "b".repeat(64)
  const now = Date.now()
  const calls = { cut: 0, mark: 0 }
  const reader = yield* IMKernelReader.make({ appkey: "isolated", navigator: "http://127.0.0.1:9", token: "isolated-token", userID: "alice", identity: { uuid: "alice", orgID: 1, name: "alice", orgAllGroupID: "unused" } }, { workspaceID: "workspace", inspectConversation: () => Effect.succeed({ conversation_type: 1 as const, conversation_id: "bob", org_id: 1, member_uuids: ["alice", "bob"], name: "bob" }) }).pipe(Effect.provide(Layer.mock(KernelClient.Service, { state, getDeliveryReadCut: (request) => Effect.sync(() => { calls.cut++; return { ...request, throughOrdinal: "1", targetAdmittedOrdinal: "1", readOrdinal: "1", liveUnread: "0", storedUnread: "0", serverNow: Date.now(), complete: true } }), markDeliveryRead: () => Effect.sync(() => { calls.mark++; throw new Error("reconciliation dispatched a mark") }) })))
  yield* KernelReader.bind(reader.runtime, scopeKey)
  yield* KernelReader.ensureScope(reader.runtime)
  yield* KernelReader.applyChanges(reader.runtime, { version: 1, scopeKey, after: "0", upper: "1", scanCursor: "1", scanProjectionKey: projectionKey, pageToken: "", windowComplete: true, caughtUp: true, serverNow: now, items: [{ visibility: "visible", projectionKey, revision: "1", cursor: "1", conversationType: 1, targetId: "bob", readOrdinal: "0", admittedOrdinal: "1", liveUnread: "1", storedUnread: "1", latestMessageId: "original", latestSequence: "1", latestMessageTime: now, nextExpiryAt: now + 60000 }] })
  const groupID = (yield* KernelReader.projection(reader.runtime, projectionKey))!.local_group_id!
  const prepared = yield* KernelReader.prepareRead(reader.runtime, { actionID: "original-unknown-action", groupID, cut: { version: 1, scopeKey, projectionKey, projectionRevision: "1", throughOrdinal: "1", targetAdmittedOrdinal: "1", readOrdinal: "0", liveUnread: "1", storedUnread: "1", serverNow: now, complete: false } })
  yield* KernelReader.dispatchRead(reader.runtime, prepared!.action_id)
  yield* KernelReader.settleRead(reader.runtime, prepared!.action_id)
  const before = yield* KernelReader.readIntent(reader.runtime, prepared!.action_id)
  const response = yield* reader.read({ groupID, actionID: "original-unknown-action", reconcile: true })
  expect(response).toEqual({ ok: false, reader: { actionID: "original-unknown-action", state: "unknown", targetAdmitted: "1", readOrdinal: "1", liveUnread: "0" } })
  expect(yield* KernelReader.readIntent(reader.runtime, prepared!.action_id)).toEqual(before)
  expect(before?.phase).toBe("unknown")
  expect(before?.result).toBeNull()
  expect(calls).toEqual({ cut: 1, mark: 0 })
}))

it.live("resuming a prepared action whose target was reached elsewhere still settles its original actual mark result", () => Effect.gen(function* () {
  const state = yield* SubscriptionRef.make<KernelClient.ConnectionState>("connected")
  const scopeKey = "a".repeat(64)
  const projectionKey = "b".repeat(64)
  const now = Date.now()
  const marks: { projectionRevision: string; throughOrdinal: string }[] = []
  const reader = yield* IMKernelReader.make({ appkey: "isolated", navigator: "http://127.0.0.1:9", token: "isolated-token", userID: "alice", identity: { uuid: "alice", orgID: 1, name: "alice", orgAllGroupID: "unused" } }, { workspaceID: "workspace", inspectConversation: () => Effect.succeed({ conversation_type: 1 as const, conversation_id: "bob", org_id: 1, member_uuids: ["alice", "bob"], name: "bob" }) }).pipe(Effect.provide(Layer.mock(KernelClient.Service, {
    state,
    getDeliveryReadCut: (request) => Effect.succeed({ ...request, throughOrdinal: "1", targetAdmittedOrdinal: "1", readOrdinal: "1", liveUnread: "0", storedUnread: "0", serverNow: now, complete: true }),
    markDeliveryRead: (request) => Effect.sync(() => { marks.push(request); return { ...request, projectionRevision: "2", targetAdmittedOrdinal: "1", readOrdinal: "1", liveUnread: "0", storedUnread: "0", serverNow: now, complete: true } }),
    getDeliveryReader: () => Effect.succeed({ version: 1, scopeKey, currentCursor: "2", serverNow: now, maxPageItems: 32, maxChangeBytes: 65536, maxMessageBytes: 4194304, maxWindowPages: 100000 }),
    getDeliveryChanges: (request) => Effect.succeed({ version: 1, scopeKey, after: request.after, upper: "2", scanCursor: "2", scanProjectionKey: "", pageToken: "", windowComplete: true, caughtUp: true, serverNow: now, items: [] }),
  })))
  yield* KernelReader.bind(reader.runtime, scopeKey)
  yield* KernelReader.ensureScope(reader.runtime)
  const item = { visibility: "visible" as const, projectionKey, revision: "1", cursor: "1", conversationType: 1 as const, targetId: "bob", readOrdinal: "0", admittedOrdinal: "1", liveUnread: "1", storedUnread: "1", latestMessageId: "original", latestSequence: "1", latestMessageTime: now, nextExpiryAt: now + 60000 }
  const page = { version: 1 as const, scopeKey, after: "0", upper: "1", scanCursor: "1", scanProjectionKey: projectionKey, pageToken: "", windowComplete: true, caughtUp: true, serverNow: now, items: [item] }
  yield* KernelReader.applyChanges(reader.runtime, page)
  const groupID = (yield* KernelReader.projection(reader.runtime, projectionKey))!.local_group_id!
  const prepared = yield* KernelReader.prepareRead(reader.runtime, { actionID: "prepared-original-action", groupID, cut: { version: 1, scopeKey, projectionKey, projectionRevision: "1", throughOrdinal: "1", targetAdmittedOrdinal: "1", readOrdinal: "0", liveUnread: "1", storedUnread: "1", serverNow: now, complete: false } })
  yield* KernelReader.checkpoint(reader.runtime, [projectionKey], true)
  yield* KernelReader.applyChanges(reader.runtime, { ...page, after: "1", upper: "2", scanCursor: "2", items: [{ ...item, revision: "2", cursor: "2", readOrdinal: "1", liveUnread: "0", storedUnread: "0" }] })
  yield* KernelReader.checkpoint(reader.runtime, [projectionKey], true)
  const response = yield* reader.read({ groupID, actionID: "prepared-original-action" })
  const settled = yield* KernelReader.readIntent(reader.runtime, prepared!.action_id)
  expect(response.reader.state).toBe("confirmed")
  expect(marks).toHaveLength(1)
  expect(marks[0]).toMatchObject({ projectionRevision: "1", throughOrdinal: "1" })
  expect(settled?.phase).toBe("confirmed")
  expect(settled?.request).toBe(prepared!.request)
  expect(settled?.original_target_admitted).toBe("1")
  expect(settled?.result).not.toBeNull()
}))

it.live("an explicit new action persists and marks its fresh higher target while preserving an unknown original even if that target was read elsewhere", () => Effect.gen(function* () {
  const state = yield* SubscriptionRef.make<KernelClient.ConnectionState>("connected")
  const scopeKey = "a".repeat(64)
  const projectionKey = "b".repeat(64)
  const now = Date.now()
  const marks: { projectionRevision: string; throughOrdinal: string }[] = []
  const reader = yield* IMKernelReader.make({ appkey: "isolated", navigator: "http://127.0.0.1:9", token: "isolated-token", userID: "alice", identity: { uuid: "alice", orgID: 1, name: "alice", orgAllGroupID: "unused" } }, { workspaceID: "workspace", inspectConversation: () => Effect.succeed({ conversation_type: 1 as const, conversation_id: "bob", org_id: 1, member_uuids: ["alice", "bob"], name: "bob" }) }).pipe(Effect.provide(Layer.mock(KernelClient.Service, {
    state,
    getDeliveryReadCut: (request) => Effect.succeed({ ...request, throughOrdinal: "2", targetAdmittedOrdinal: "2", readOrdinal: "2", liveUnread: "0", storedUnread: "0", serverNow: now, complete: true }),
    markDeliveryRead: (request) => Effect.sync(() => { marks.push(request); return { ...request, targetAdmittedOrdinal: "2", readOrdinal: "2", liveUnread: "0", storedUnread: "0", serverNow: now, complete: true } }),
    getDeliveryReader: () => Effect.succeed({ version: 1, scopeKey, currentCursor: "2", serverNow: now, maxPageItems: 32, maxChangeBytes: 65536, maxMessageBytes: 4194304, maxWindowPages: 100000 }),
    getDeliveryChanges: (request) => Effect.succeed({ version: 1, scopeKey, after: request.after, upper: "2", scanCursor: "2", scanProjectionKey: "", pageToken: "", windowComplete: true, caughtUp: true, serverNow: now, items: [] }),
  })))
  yield* KernelReader.bind(reader.runtime, scopeKey)
  yield* KernelReader.ensureScope(reader.runtime)
  const item = { visibility: "visible" as const, projectionKey, revision: "1", cursor: "1", conversationType: 1 as const, targetId: "bob", readOrdinal: "0", admittedOrdinal: "1", liveUnread: "1", storedUnread: "1", latestMessageId: "original", latestSequence: "1", latestMessageTime: now, nextExpiryAt: now + 60000 }
  const page = { version: 1 as const, scopeKey, after: "0", upper: "1", scanCursor: "1", scanProjectionKey: projectionKey, pageToken: "", windowComplete: true, caughtUp: true, serverNow: now, items: [item] }
  yield* KernelReader.applyChanges(reader.runtime, page)
  const groupID = (yield* KernelReader.projection(reader.runtime, projectionKey))!.local_group_id!
  const original = yield* KernelReader.prepareRead(reader.runtime, { actionID: "original-unknown", groupID, cut: { version: 1, scopeKey, projectionKey, projectionRevision: "1", throughOrdinal: "1", targetAdmittedOrdinal: "1", readOrdinal: "0", liveUnread: "1", storedUnread: "1", serverNow: now, complete: false } })
  yield* KernelReader.dispatchRead(reader.runtime, original!.action_id)
  yield* KernelReader.settleRead(reader.runtime, original!.action_id)
  const before = yield* KernelReader.readIntent(reader.runtime, original!.action_id)
  yield* KernelReader.checkpoint(reader.runtime, [projectionKey], true)
  yield* KernelReader.applyChanges(reader.runtime, { ...page, after: "1", upper: "2", scanCursor: "2", items: [{ ...item, revision: "2", cursor: "2", admittedOrdinal: "2", readOrdinal: "2", liveUnread: "0", storedUnread: "0" }] })
  yield* KernelReader.checkpoint(reader.runtime, [projectionKey], true)
  expect(yield* reader.read({ groupID, newAction: true }).pipe(Effect.flip)).toMatchObject({ code: "reader_scope_mismatch" })
  expect(yield* reader.read({ groupID, actionID: "new-invalid", newAction: true, reconcile: true }).pipe(Effect.flip)).toMatchObject({ code: "reader_scope_mismatch" })
  expect(yield* reader.read({ groupID, actionID: "new-ordinary" }).pipe(Effect.flip)).toMatchObject({ code: "reader_unknown" })
  const result = yield* reader.read({ groupID, actionID: "new-explicit", newAction: true })
  expect(result.reader).toMatchObject({ actionID: "new-explicit", state: "confirmed", targetAdmitted: "2", readOrdinal: "2" })
  const persisted = yield* KernelReader.readIntent(reader.runtime, "new-explicit")
  expect(persisted).toMatchObject({ phase: "confirmed", original_target_admitted: "2", through_ordinal: "2", cut_index: 0 })
  expect(persisted?.result).not.toBeNull()
  expect(marks).toHaveLength(1)
  expect(marks[0]).toMatchObject({ version: 1, scopeKey, projectionKey, projectionRevision: "2", throughOrdinal: "2" })
  expect(yield* KernelReader.readIntent(reader.runtime, original!.action_id)).toEqual(before)
  expect((yield* reader.read({ groupID, actionID: "new-explicit", newAction: true })).reader.state).toBe("confirmed")
  expect(marks).toHaveLength(1)
  expect(yield* KernelReader.readIntent(reader.runtime, "new-explicit")).toEqual(persisted)
}))
