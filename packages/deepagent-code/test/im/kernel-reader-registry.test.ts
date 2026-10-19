import { expect, test } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Layer, Queue, Scope, Stream, SubscriptionRef } from "effect"
import { eq } from "drizzle-orm"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "@deepagent-code/core/database/database"
import { IMBroadcasterLive, IMBroadcasterService } from "@deepagent-code/core/im/broadcaster"
import { KernelReader } from "@deepagent-code/core/im/kernel-reader"
import { IMKernelReaderScopeTable } from "@deepagent-code/core/im/kernel-reader.sql"
import { InstanceRegistry } from "@/effect/instance-registry"
import { InstanceStore } from "@/project/instance-store"
import { IMKernelReader } from "@/im/kernel/reader"
import { createHash } from "node:crypto"
import { KernelReaderSchema } from "@deepagent-code/core/im/kernel-reader.schema"
import { KernelClient } from "@/im/kernel/client"
import { KernelSdk } from "@/im/kernel/sdk"
import { IMReaderRegistry } from "@/im/kernel/reader-registry"
import { ListenerStop } from "@/server/listener-stop"
import { KernelLiveFirstSeenFixture } from "./fixture/kernel-live-first-seen"
import { ReaderInstanceFixture } from "./reader-instance-fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"

const it = testEffect(Layer.empty)
const config = { appkey: "isolated", navigator: "http://127.0.0.1:9", token: "isolated-token", userID: "alice", identity: { uuid: "alice", orgID: 1, name: "alice", orgAllGroupID: "unused" } }
const scopeKey = "a".repeat(64)
const projectionKey = "b".repeat(64)
const header = () => ({ version: 1 as const, scopeKey, currentCursor: "1", serverNow: Date.now(), maxPageItems: 32 as const, maxChangeBytes: 65536 as const, maxMessageBytes: 4194304 as const, maxWindowPages: 100000 as const })
const change = (input: { after: string }) => ({ version: 1 as const, scopeKey, after: input.after, upper: "1", scanCursor: "1", scanProjectionKey: "", pageToken: "", windowComplete: true, caughtUp: true, serverNow: Date.now(), items: input.after === "0" ? [{ visibility: "visible" as const, projectionKey, revision: "1", cursor: "1", conversationType: 1 as const, targetId: "bob", readOrdinal: "0", admittedOrdinal: "0", liveUnread: "0", storedUnread: "0", latestMessageId: "", latestSequence: "", latestMessageTime: 0, nextExpiryAt: 0 }] : [] })
const broadcaster = Layer.mock(IMBroadcasterService, { broadcast: () => {}, sendToUser: () => {}, register: () => true, unregister: () => {}, getConnectionCount: () => 0, getUserConnectionCount: () => 0 })
const fixture = <A, E>(run: (directory: string, client: Layer.Layer<KernelClient.Service>) => Effect.Effect<A, E, Database.Service | InstanceStore.Service | Scope.Scope | KernelClient.Service | IMBroadcasterService | InstanceRegistry.Service>, client: Layer.Layer<KernelClient.Service>) => Effect.gen(function* () {
  const directory = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "dac-im-registry-")))
  yield* Effect.addFinalizer(() => Effect.promise(() => rm(directory, { recursive: true, force: true })))
  return yield* run(directory, client).pipe(Effect.provide(Layer.mergeAll(Database.layerFromPath(join(directory, "reader.sqlite")), ReaderInstanceFixture.layer, ReaderInstanceFixture.registry, broadcaster, client)))
})
const leaseScope = Effect.gen(function* () {
  const scope = yield* Scope.make()
  yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
  return scope
})

function nativeShutdownFixture(
  options: Parameters<typeof KernelLiveFirstSeenFixture.make>[0],
  run: (input: {
    directory: string
    database: Database.Interface
    native: ReturnType<typeof KernelLiveFirstSeenFixture.make>
    client: KernelClient.Interface
    store: InstanceStore.Interface
    registry: IMReaderRegistry.Interface
    entry: IMReaderRegistry.Entry
    scope: Scope.Closeable
  }) => Effect.Effect<void, unknown, Scope.Scope>,
  readerOptions?: Parameters<typeof IMReaderRegistry.make>[1],
) {
  return Effect.gen(function* () {
    const directory = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "dac-im-registry-shutdown-")))
    yield* Effect.addFinalizer(() => Effect.promise(() => rm(directory, { recursive: true, force: true })))
    const native = KernelLiveFirstSeenFixture.make(options)
    yield* Effect.addFinalizer(() => Effect.sync(() => native.server.stop(true)))
    const config = { appkey: `private-registry-shutdown-${native.server.port}`, navigator: native.server.url.origin,
      token: "private-first-seen-token", userID: "receiver", identity: { uuid: "receiver", orgID: 1, name: "Receiver", orgAllGroupID: "unused" } }
    return yield* Effect.gen(function* () {
      const client = yield* KernelClient.Service
      yield* pollWithTimeout(SubscriptionRef.get(client.state).pipe(Effect.map((state) => state === "connected" ? true : undefined)), "original SDK did not connect")
      const store = yield* InstanceStore.Service
      const workspace = join(directory, "workspace")
      yield* Effect.promise(() => mkdir(workspace))
      const instance = yield* store.load({ directory: workspace })
      const scope = yield* leaseScope
      const registry = yield* IMReaderRegistry.make(config, readerOptions).pipe(Effect.provideService(Scope.Scope, scope))
      const entry = yield* registry.acquire({ instance, workspaceID: workspace, userID: "server",
        instanceCurrent: store.peek(workspace).pipe(Effect.map((current) => current === instance)) })
      yield* pollWithTimeout(Effect.sync(() => entry.lifetime.lastSync > 0 && !entry.lifetime.native && !entry.lifetime.running && !entry.lifetime.queued ? true : undefined), "original registry did not become idle")
      return yield* run({ directory, database: yield* Database.Service, native, client, store, registry, entry, scope })
    }).pipe(Effect.provide(Layer.mergeAll(
      Database.layerFromPath(join(directory, "reader.sqlite")), ReaderInstanceFixture.layer,
      ReaderInstanceFixture.registry, IMBroadcasterLive,
      KernelClient.layer.pipe(Layer.provide(KernelSdk.liveFromConfig(config))),
    )))
  })
}

function stopRegistry(scope: Scope.Closeable) {
  return ListenerStop.make({ scope, unpublish: Effect.void, websockets: { closeAll: Effect.void },
    http: { closeAll: Effect.void, close: Effect.void } })
}

function shutdownTest(name: string, run: () => Effect.Effect<void, unknown, Scope.Scope>) {
  if (process.env.DAC_IM_REGISTRY_SHUTDOWN_CASE === name) {
    it.live(name, run)
    return
  }
  if (process.env.DAC_IM_REGISTRY_SHUTDOWN_CASE) return
  // The real SDK retains its transport singleton across init/disconnect. Each
  // native case gets an actual process lifetime rather than resetting SDK state.
  test(name, async () => {
    const root = await mkdtemp(join(tmpdir(), "dac-im-registry-shutdown-child-"))
    const child = Bun.spawn([process.execPath, "test", import.meta.path, "--test-name-pattern",
      `^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "--timeout", "15000"], {
      cwd: process.cwd(), env: { ...process.env, DAC_IM_REGISTRY_SHUTDOWN_CASE: name }, stdout: "pipe", stderr: "pipe",
    })
    const output = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    await Promise.all([Bun.write(join(root, "stdout-private.log"), output[0]), Bun.write(join(root, "stderr-private.log"), output[1])])
    if (output[2] !== 0) console.error({ case: name, childLogRoot: root })
    expect(output[2]).toBe(0)
  }, 20000)
}

shutdownTest("whole-registry shutdown disconnects the original in-flight readonly query before joining child scopes", () => {
  const stalled = { value: false }
  return nativeShutdownFixture({ queryDelayMs: (topic) => stalled.value && topic === "qry_delivery_reader" ? 3000 : 0 },
    (input) => Effect.gen(function* () {
      const before = input.native.topics.filter((topic) => topic === "qry_delivery_reader").length
      stalled.value = true
      const request = yield* Effect.forkChild(input.entry.reader.request(input.client.getDeliveryReader()))
      yield* pollWithTimeout(Effect.sync(() => input.native.topics.filter((topic) => topic === "qry_delivery_reader").length === before + 1 ? true : undefined), "readonly query did not reach the actual peer")
      expect(input.registry.statistics().native).toBe(1)
      const stop = stopRegistry(input.scope)
      const started = performance.now()
      yield* Effect.promise(() => stop(true))
      expect(performance.now() - started).toBeLessThan(1950)
      expect(yield* Fiber.join(request).pipe(Effect.flip)).toMatchObject({ operation: "getDeliveryReader", cause: { kind: "disconnected" } })
      expect(input.entry.lifetime.active).toBe(false)
      expect(yield* input.entry.assertCurrent.pipe(Effect.flip)).toMatchObject({ code: "reader_unavailable" })
      expect(input.registry.statistics()).toEqual({ entries: 0, owned: 0, native: 0 })
      yield* pollWithTimeout(Effect.sync(() => input.native.state.disconnected > 0 ? true : undefined), "original SDK socket did not close")
      expect(input.native.topics.filter((topic) => topic === "qry_delivery_reader")).toHaveLength(before + 1)
    }))
})

shutdownTest("whole-registry shutdown leaves dispatched original SDK send and mark-read outcomes unknown without repeating them", () => {
  const published = { count: 0 }
  return nativeShutdownFixture({
    outboundPublish: () => { published.count++; return { code: 0, messageId: "private-unobserved-ack", timestamp: Date.now(), msgSeqNo: 1 } },
    afterOutboundPublish: () => "drop_ack",
    queryDelayMs: (topic) => topic === "mark_delivery_read" ? 3000 : 0,
    response: (topic, request, original) => topic === "qry_delivery_capabilities"
      ? { name: "DeliveryCapabilities", value: { version: 1, profile: "mysql-receipt-v1", maxLifetimeMs: 259200000, maxContentBytes: 65536, eventualDelivery: false } }
      : topic === "mark_delivery_read"
        ? { name: "DeliveryReadCutResult", value: { ...request, throughOrdinal: "1", targetAdmittedOrdinal: "1", readOrdinal: "1", liveUnread: "0", storedUnread: "0", serverNow: Date.now(), complete: true } }
        : original,
  }, (input) => Effect.gen(function* () {
    const send = yield* Effect.forkChild(input.entry.reader.request(input.client.sendText({ conversationType: 1,
      conversationID: "sender", text: "private controlled shutdown", messageID: "private-shutdown-local",
      wireID: "private-shutdown-wire", expiresAt: Date.now() + 60000 })))
    const mark = yield* Effect.forkChild(input.entry.reader.request(input.client.markDeliveryRead({ version: 1,
      scopeKey, projectionKey, projectionRevision: "1", throughOrdinal: "1" })))
    yield* pollWithTimeout(Effect.sync(() => published.count === 1 && input.native.topics.includes("mark_delivery_read") ? true : undefined), "original write calls did not reach the peer")
    expect(input.registry.statistics().native).toBe(2)
    yield* Effect.promise(() => stopRegistry(input.scope)(true))
    expect(yield* Fiber.join(send).pipe(Effect.flip)).toMatchObject({ operation: "sendMessage", cause: { kind: "unknown" } })
    expect(yield* Fiber.join(mark).pipe(Effect.flip)).toMatchObject({ operation: "markDeliveryRead", cause: { kind: "unknown" } })
    yield* Effect.sleep("100 millis")
    expect(published.count).toBe(1)
    expect(input.native.topics.filter((topic) => topic === "mark_delivery_read")).toHaveLength(1)
    expect(input.registry.statistics()).toEqual({ entries: 0, owned: 0, native: 0 })
  }))
})

shutdownTest("ordinary workspace retirement leaves the original SDK connected and another captured workspace usable", () =>
  nativeShutdownFixture({}, (input) => Effect.gen(function* () {
    const directory = join(input.directory, "other-workspace")
    yield* Effect.promise(() => mkdir(directory))
    const instance = yield* input.store.load({ directory })
    const entry = yield* input.registry.acquire({ instance, workspaceID: directory, userID: "server",
      instanceCurrent: input.store.peek(directory).pipe(Effect.map((current) => current === instance)) })
    yield* input.store.dispose(input.entry.context.instance)
    expect(input.entry.lifetime.active).toBe(false)
    expect(input.native.state.disconnected).toBe(0)
    expect(yield* SubscriptionRef.get(input.client.state)).toBe("connected")
    yield* entry.assertCurrent
    yield* entry.reader.sync
    expect(input.registry.find(directory, "server")).toBe(entry)
    expect(entry.lifetime.active).toBe(true)
    expect(input.registry.statistics().entries).toBe(1)
    yield* Effect.promise(() => stopRegistry(input.scope)(true))
    expect(input.registry.statistics()).toEqual({ entries: 0, owned: 0, native: 0 })
  })),
)

it.live("a disconnect defect preserves shutdown failure while still joining every owned reader child scope", () => Effect.gen(function* () {
  const state = yield* SubscriptionRef.make<KernelClient.ConnectionState>("connected")
  const client = Layer.mock(KernelClient.Service, { state, messages: Stream.empty,
    disconnect: Effect.die(new Error("controlled disconnect defect")),
    getDeliveryReader: () => Effect.succeed(header()),
    getDeliveryChanges: (input) => Effect.succeed({ ...change(input), items: [] }),
  })
  yield* fixture((directory) => Effect.gen(function* () {
    const store = yield* InstanceStore.Service
    const instance = yield* store.load({ directory })
    const scope = yield* leaseScope
    const registry = yield* IMReaderRegistry.make(config).pipe(Effect.provideService(Scope.Scope, scope))
    const entry = yield* registry.acquire({ instance, workspaceID: directory, userID: "server",
      instanceCurrent: store.peek(directory).pipe(Effect.map((current) => current === instance)) })
    const closed = { count: 0 }
    yield* Scope.addFinalizer(entry.scope, Effect.sync(() => { closed.count++ }))
    const stop = stopRegistry(scope)
    const failure = yield* Effect.promise(() => stop(true).catch((error: unknown) => error))
    expect(failure).toMatchObject({ code: "LISTENER_STOP_FAILED", stage: "scope", reason: "failed" })
    expect(closed.count).toBe(1)
    expect(entry.lifetime.active).toBe(false)
    expect(registry.statistics()).toEqual({ entries: 0, owned: 0, native: 0 })
    expect(yield* Effect.promise(() => stop(true).catch((error: unknown) => error))).toBe(failure)
    expect(closed.count).toBe(1)
  }), client)
}))

it.live("advisory hints coalesce for five seconds while foreground and original live-lane consumers remain immediate", () => Effect.gen(function* () {
  const calls = { reader: 0 }
  const live = yield* Queue.bounded<object>(4)
  const observed = { handle: Object.freeze({}), deadline: 0 }
  const state = yield* SubscriptionRef.make<KernelClient.ConnectionState>("connected")
  const client = Layer.mock(KernelClient.Service, {
    state, messages: Stream.empty, disconnect: Effect.void, liveObservations: Stream.fromQueue(live),
    // This controlled transport hint drives the real registry lane. Empty
    // native pages below deliberately create no task source or authority.
    readLiveObservation: (handle) => handle === observed.handle && performance.now() < observed.deadline
      ? { receivedAt: Date.now(), observation: { version: 1, messageType: "jg:text", messageID: "hint", sequence: "1", messageTime: Date.now(),
          senderID: "bob", receiverID: "alice", generation: 1, conversationType: 1, conversationID: "bob",
          wireContent: "hint", isSend: false, hasReference: false } }
      : undefined,
    getDeliveryReader: () => KernelSdk.request("getDeliveryReader", () => {
      calls.reader++
      return Promise.resolve(header())
    }),
    getDeliveryChanges: (input) => KernelSdk.request("getDeliveryChanges", () => Promise.resolve({ ...change(input), items: [] })),
  })
  yield* fixture((directory) => Effect.gen(function* () {
    const store = yield* InstanceStore.Service
    const instance = yield* store.load({ directory })
    const registryScope = yield* leaseScope
    const registry = yield* IMReaderRegistry.make(config).pipe(Effect.provideService(Scope.Scope, registryScope))
    const entry = yield* registry.acquire({ instance, workspaceID: directory, userID: "server",
      instanceCurrent: store.peek(directory).pipe(Effect.map((current) => current === instance)) })
    yield* pollWithTimeout(Effect.sync(() => entry.lifetime.lastSync > 0 && !entry.lifetime.running ? true : undefined), "initial advisory pass did not finish")
    const before = calls.reader
    yield* Effect.forEach(Array.from({ length: 100 }), () => registry.hint(entry), { discard: true })
    yield* Effect.sleep("1100 millis")
    expect(calls.reader).toBe(before)
    expect(entry.lifetime.hint).toBe(true)
    expect(entry.lifetime.queued).toBe(false)
    yield* entry.reader.sync
    expect(calls.reader).toBe(before + 1)
    observed.deadline = performance.now() + 1000
    yield* Queue.offer(live, observed.handle)
    yield* pollWithTimeout(Effect.sync(() => calls.reader === before + 2 ? true : undefined), "live observation waited behind advisory cadence", "900 millis")
    expect(performance.now()).toBeLessThan(observed.deadline)
    observed.deadline = 0
    yield* Queue.offer(live, observed.handle)
    yield* Effect.sleep("100 millis")
    expect(calls.reader).toBe(before + 2)
    yield* pollWithTimeout(Effect.sync(() => calls.reader === before + 3 && !entry.lifetime.running ? true : undefined), "pending hint did not run after five seconds", "6 seconds")
    expect(entry.lifetime.hint).toBe(false)
    const complete = calls.reader
    yield* registry.hint(entry)
    yield* Scope.close(registryScope, Exit.void)
    yield* registry.hint(entry)
    observed.deadline = performance.now() + 1000
    yield* Queue.offer(live, observed.handle)
    yield* Effect.sleep("1100 millis")
    expect(calls.reader).toBe(complete)
    expect(entry.lifetime.active).toBe(false)
    expect(registry.statistics()).toEqual({ entries: 0, owned: 0, native: 0 })
  }), client)
}), 20000)

it.live("two actual directories share two native slots; disposing stalled A immediately revokes only A and its late response cannot mutate or close recreated A", () => Effect.gen(function* () {
  const started = yield* Deferred.make<void>()
  const settled = yield* Deferred.make<void>()
  const native = { release: () => {}, stall: false, active: 0, maximum: 0, mark: 0, cuts: 0 }
  const pending = new Promise<void>((resolve) => { native.release = resolve })
  const state = yield* SubscriptionRef.make<KernelClient.ConnectionState>("connected")
  const request = <A>(operation: string, run: () => PromiseLike<A>) => Effect.gen(function* () {
    native.active++
    native.maximum = Math.max(native.maximum, native.active)
    return yield* KernelSdk.request(operation, run).pipe(Effect.ensuring(Effect.sync(() => { native.active-- })))
  })
  const client = Layer.mock(KernelClient.Service, {
    state, messages: Stream.empty, disconnect: Effect.void,
    getDeliveryReader: () => request("getDeliveryReader", () => Promise.resolve(header())),
    getDeliveryChanges: (input) => Effect.suspend(() => {
      if (!native.stall) return request("getDeliveryChanges", () => Promise.resolve(change(input)))
      native.stall = false
      return Deferred.succeed(started, undefined).pipe(Effect.andThen(request("getDeliveryChanges", () => pending.then(() => change(input)))), Effect.ensuring(Deferred.succeed(settled, undefined)))
    }),
    getDeliveryMessages: (input) => request("getDeliveryMessages", () => Promise.resolve({ ...input, nextDeliveryCursor: "0", finished: true, serverNow: Date.now(), items: [] })),
    getDeliveryReadCut: (input) => request("getDeliveryReadCut", () => { native.cuts++; return Promise.resolve({ ...input, throughOrdinal: "0", targetAdmittedOrdinal: "0", readOrdinal: "0", liveUnread: "0", storedUnread: "0", serverNow: Date.now(), complete: true }) }),
    markDeliveryRead: () => Effect.sync(() => { native.mark++; throw new Error("revoked reader issued a mark") }),
  })
  yield* fixture((directory) => Effect.gen(function* () {
    const store = yield* InstanceStore.Service
    const db = (yield* Database.Service).db
    const registry = yield* IMReaderRegistry.make(config, { inspectConversation: (input) => Effect.succeed({ conversation_type: input.conversationType, conversation_id: input.conversationID, org_id: 1, name: "bob", member_uuids: ["alice", "bob"] }) })
    const directoryA = join(directory, "a")
    const directoryB = join(directory, "b")
    yield* Effect.promise(() => Promise.all([mkdir(directoryA), mkdir(directoryB)]))
    const a = yield* store.load({ directory: directoryA })
    const b = yield* store.load({ directory: directoryB })
    const oldLease = yield* leaseScope
    const bLease = yield* leaseScope
    const acquire = (instance: typeof a, scope: Scope.Closeable) => registry.acquire({ instance, workspaceID: instance.directory, userID: "server", instanceCurrent: store.peek(instance.directory).pipe(Effect.map((current) => current === instance)) }).pipe(Effect.provideService(Scope.Scope, scope))
    const entryA = yield* acquire(a, oldLease)
    yield* entryA.reader.sync
    const rowA = (yield* KernelReader.scope(entryA.reader.runtime))!
    const before = yield* db.select().from(IMKernelReaderScopeTable).where(eq(IMKernelReaderScopeTable.reader_key, rowA.reader_key)).get()
    native.stall = true
    yield* registry.hint(entryA)
    const oldSync = yield* Effect.forkChild(entryA.reader.syncSlice)
    yield* Deferred.await(started)
    yield* Effect.sleep("1100 millis")
    expect(entryA.lifetime.running).toBe(false)
    expect(native.active).toBe(1)
    expect(registry.find(b.directory, "server")).toBeUndefined()
    const entryB = yield* acquire(b, bLease)
    const rowB = (yield* KernelReader.scope(entryB.reader.runtime))!
    expect(rowA.reader_key).not.toBe(rowB.reader_key)
    const groupB = (yield* KernelReader.projection(entryB.reader.runtime, projectionKey))!.local_group_id!
    const currentB = () => entryB.reader.withOutput({ workspaceID: b.directory, userID: "server", groupIDs: [groupB] }, Effect.succeed("B current body"))
    expect(yield* currentB()).toBe("B current body")
    expect(native.active).toBe(1)
    expect(native.maximum).toBe(2)
    const disposing = yield* Effect.forkChild(store.dispose(a))
    yield* pollWithTimeout(Effect.sync(() => !entryA.lifetime.active ? true : undefined), "A did not revoke", "2 seconds")
    expect((yield* Deferred.await(settled).pipe(Effect.timeoutOption("20 millis")))._tag).toBe("None")
    yield* Effect.addFinalizer(() => Effect.sync(native.release))
    const retiringContext = yield* store.peek(a.directory)
    if (retiringContext !== undefined) {
      const resurrected = yield* acquire(a, oldLease)
      yield* Effect.sync(native.release)
      yield* Fiber.join(oldSync)
      yield* Fiber.join(disposing)
      expect(resurrected.reader.runtime.displayEpoch).not.toBe(entryA.reader.runtime.displayEpoch)
      expect(retiringContext).toBeUndefined()
    }
    expect(retiringContext).toBeUndefined()
    expect(yield* acquire(a, oldLease).pipe(Effect.flip)).toMatchObject({ code: "reader_scope_mismatch" })
    expect(yield* entryA.assertCurrent.pipe(Effect.flip)).toMatchObject({ code: "reader_unavailable" })
    expect(yield* entryA.reader.withOutput({ workspaceID: a.directory, userID: "server" }, Effect.succeed("old body")).pipe(Effect.flip)).toMatchObject({ code: "reader_unavailable" })
    expect(yield* entryA.reader.read({ groupID: groupB, actionID: "old-a-mark" }).pipe(Effect.flip)).toMatchObject({ code: "reader_unavailable" })
    expect(native.mark).toBe(0)
    expect(yield* currentB()).toBe("B current body")
    const reloading = yield* Effect.forkChild(store.reload({ directory: directoryA }))
    yield* Effect.sync(native.release)
    yield* Fiber.join(oldSync)
    yield* Fiber.join(disposing)
    const recreated = yield* Fiber.join(reloading)
    expect(recreated).not.toBe(a)
    expect(yield* db.select().from(IMKernelReaderScopeTable).where(eq(IMKernelReaderScopeTable.reader_key, rowA.reader_key)).get()).toEqual(before)
    const newLease = yield* leaseScope
    const successor = yield* acquire(recreated, newLease)
    expect(successor.reader.runtime.displayEpoch).not.toBe(entryA.reader.runtime.displayEpoch)
    yield* successor.reader.sync
    expect((yield* KernelReader.scope(successor.reader.runtime))!.reader_key).toBe(rowA.reader_key)
    yield* Scope.close(oldLease, Exit.void)
    yield* successor.assertCurrent
    expect(registry.find(recreated.directory, "server")).toBe(successor)
    expect(registry.find(b.directory, "server")).toBe(entryB)
    expect(native.mark).toBe(0)
    expect(native.maximum).toBeLessThanOrEqual(2)
    expect(native.active).toBe(0)
  }), client)
}))

it.live("the bounded registry never evicts active leases and idle eviction retains the file-backed scope", () => Effect.gen(function* () {
  const state = yield* SubscriptionRef.make<KernelClient.ConnectionState>("connected")
  const client = Layer.mock(KernelClient.Service, { state, messages: Stream.empty, disconnect: Effect.void, getDeliveryReader: () => Effect.succeed(header()), getDeliveryChanges: (input) => Effect.succeed({ ...change(input), items: [] }) })
  yield* fixture((directory) => Effect.gen(function* () {
    const store = yield* InstanceStore.Service
    const db = (yield* Database.Service).db
    const registry = yield* IMReaderRegistry.make(config, { inspectConversation: (input) => Effect.succeed({ conversation_type: input.conversationType, conversation_id: input.conversationID, org_id: 1, name: "bob", member_uuids: ["alice", "bob"] }) })
    const retained: { scope: Scope.Closeable; entry: IMReaderRegistry.Entry }[] = []
    for (let index = 0; index < 64; index++) {
      const path = join(directory, String(index))
      yield* Effect.promise(() => mkdir(path))
      const instance = yield* store.load({ directory: path })
      const scope = yield* leaseScope
      const entry = yield* registry.acquire({ instance, workspaceID: path, userID: "server", instanceCurrent: store.peek(path).pipe(Effect.map((current) => current === instance)) }).pipe(Effect.provideService(Scope.Scope, scope))
      retained.push({ scope, entry })
    }
    const path = join(directory, "65")
    yield* Effect.promise(() => mkdir(path))
    const instance = yield* store.load({ directory: path })
    const acquire = registry.acquire({ instance, workspaceID: path, userID: "server", instanceCurrent: store.peek(path).pipe(Effect.map((current) => current === instance)) })
    expect(yield* acquire.pipe(Effect.scoped, Effect.flip)).toMatchObject({ code: "reader_capacity", operation: "workspace-registry" })
    expect(registry.statistics().entries).toBe(64)
    yield* retained[0]!.entry.reader.sync
    const original = yield* KernelReader.scope(retained[0]!.entry.reader.runtime)
    yield* Scope.close(retained[0]!.scope, Exit.void)
    yield* pollWithTimeout(Effect.sync(() => !retained[0]!.entry.lifetime.queued && !retained[0]!.entry.lifetime.running && !retained[0]!.entry.lifetime.native ? true : undefined), "idle entry did not settle", "2 seconds")
    const replacementScope = yield* leaseScope
    const replacement = yield* acquire.pipe(Effect.provideService(Scope.Scope, replacementScope))
    expect(registry.statistics().entries).toBe(64)
    expect(retained[0]!.entry.lifetime.active).toBe(false)
    expect(registry.find(path, "server")).toBe(replacement)
    expect((yield* db.select().from(IMKernelReaderScopeTable).where(eq(IMKernelReaderScopeTable.reader_key, original!.reader_key)).get())?.reader_key).toBe(original!.reader_key)
  }), client)
}), 15000)


it.live("each real reader slice makes at most four native queries and leaves the remaining projection work in the file-backed continuation", () => Effect.gen(function* () {
  const calls: string[] = []
  const state = yield* SubscriptionRef.make<KernelClient.ConnectionState>("connected")
  const client = Layer.mock(KernelClient.Service, {
    state, messages: Stream.empty, disconnect: Effect.void,
    getDeliveryReader: () => Effect.sync(() => { calls.push("reader"); return header() }),
    getDeliveryChanges: (input) => Effect.sync(() => {
      calls.push("changes")
      return { ...change(input), items: Array.from({ length: 32 }, (_, index) => ({ ...change({ after: "0" }).items[0]!, projectionKey: createHash("sha256").update(String(index)).digest("hex"), targetId: `bob_${index}` })) }
    }),
    getDeliveryMessages: (input) => Effect.sync(() => { calls.push(input.direction); return { ...input, nextDeliveryCursor: "0", finished: true, serverNow: Date.now(), items: [] } }),
  })
  yield* fixture((directory) => Effect.gen(function* () {
    const store = yield* InstanceStore.Service
    const instance = yield* store.load({ directory })
    const reader = yield* IMKernelReader.make(config, { workspaceID: directory, instanceCurrent: store.peek(directory).pipe(Effect.map((current) => current === instance)), requestGate: (effect) => effect, inspectConversation: (input) => Effect.succeed({ conversation_type: input.conversationType, conversation_id: input.conversationID, org_id: 1, name: input.conversationID, member_uuids: ["alice", input.conversationID] }) })
    yield* reader.syncSlice
    expect(calls).toEqual(["reader", "changes", "newer", "older"])
    const first = (yield* KernelReader.scope(reader.runtime))!
    expect(first.phase).toBe("partial")
    expect(KernelReaderSchema.decode(KernelReaderSchema.Continuation, first.continuation, 8192).projections).toHaveLength(31)
    calls.length = 0
    yield* reader.syncSlice
    expect(calls).toEqual(["reader", "newer", "older", "newer"])
    const second = (yield* KernelReader.scope(reader.runtime))!
    expect(KernelReaderSchema.decode(KernelReaderSchema.Continuation, second.continuation, 8192).projections).toHaveLength(30)
    expect(second.completed_after).toBe("0")
  }), client)
}))


shutdownTest("cancelled same-projection consumers share only their still-pending original native cut", () => {
  const stalled = { value: false, delay: 2200, admitted: "0" }
  return nativeShutdownFixture({
    queryDelayMs: (topic) => stalled.value && topic === "qry_delivery_read_cut" ? stalled.delay : 0,
    response: (topic, request, original) => topic === "qry_delivery_read_cut"
      ? { name: "DeliveryReadCutResult", value: { ...request, throughOrdinal: stalled.admitted, targetAdmittedOrdinal: stalled.admitted, readOrdinal: "0", liveUnread: stalled.admitted, storedUnread: stalled.admitted, serverNow: Date.now(), complete: stalled.admitted === "0" } }
      : original,
  }, (input) => Effect.gen(function* () {
    const row = (yield* KernelReader.projection(input.entry.reader.runtime, projectionKey))!
    const db = input.database.db
    const consumed = { count: 0 }
    const body = () => input.entry.reader.withOutput({ workspaceID: input.entry.context.workspaceID, userID: "server", groupIDs: [row.local_group_id!] },
      KernelReader.gateGroup(db, row.local_group_id!).pipe(Effect.tap(() => Effect.sync(() => { consumed.count++ })), Effect.map((group) => group?.mode)))
    const cuts = () => input.native.topics.filter((topic) => topic === "qry_delivery_read_cut").length
    const before = cuts()
    stalled.value = true
    const first = yield* Effect.forkChild(body())
    yield* pollWithTimeout(Effect.sync(() => cuts() === before + 1 ? true : undefined), "first actual SDK cut did not reach peer")
    yield* Fiber.interrupt(first)
    expect(input.registry.statistics().native).toBe(1)
    const second = yield* Effect.forkChild(body())
    yield* Effect.sleep("60 millis")
    yield* Fiber.interrupt(second)
    const result = yield* body()
    expect(result).toBe("protected")
    expect(cuts()).toBe(before + 1)
    expect(consumed.count).toBe(1)
    expect(input.registry.statistics().native).toBe(0)
    // Completion removes the flight. A later request must obtain a fresh current cut.
    stalled.value = false
    expect(yield* body()).toBe("protected")
    expect(cuts()).toBe(before + 2)
    expect(consumed.count).toBe(2)
    // The original one-second consumption bound remains independent of sharing.
    const expired = input.entry.reader.withOutput({ workspaceID: input.entry.context.workspaceID, userID: "server", groupIDs: [row.local_group_id!] }, Effect.sleep("1100 millis"))
    expect(yield* expired.pipe(Effect.flip)).toMatchObject({ code: "reader_stale", operation: "output-deadline" })
    const expiring = input.native.add("original-short-lived", { publish: false })
    expiring.expiresAt = Date.now() + 1200
    yield* input.entry.reader.sync
    stalled.admitted = "1"
    const near = cuts()
    stalled.value = true
    stalled.delay = 1500
    const original = yield* Effect.forkChild(body())
    yield* pollWithTimeout(Effect.sync(() => cuts() === near + 1 ? true : undefined), "near-expiry original cut did not reach peer")
    yield* Fiber.interrupt(original)
    yield* Effect.sleep("800 millis")
    // This late join cannot restart the original message's remaining lifetime.
    const expiredJoin = yield* body().pipe(Effect.exit)
    expect(Date.now()).toBeGreaterThanOrEqual(expiring.expiresAt)
    expect(yield* Effect.flip(expiredJoin)).toMatchObject({ code: "reader_stale", operation: "output-deadline" })
    expect(cuts()).toBe(near + 1)
    expect(consumed.count).toBe(2)
    stalled.delay = 2200
    const lateBefore = cuts()
    const late = yield* Effect.forkChild(body())
    yield* pollWithTimeout(Effect.sync(() => cuts() === lateBefore + 1 ? true : undefined), "revoked original SDK cut did not reach peer")
    const retiring = yield* Effect.forkChild(input.store.dispose(input.entry.context.instance))
    yield* pollWithTimeout(Effect.sync(() => !input.entry.lifetime.active ? true : undefined), "captured owner did not revoke")
    expect(yield* Fiber.join(late).pipe(Effect.flip)).toMatchObject({ code: "reader_unavailable" })
    yield* Fiber.join(retiring)
    expect(consumed.count).toBe(2)
    expect(input.registry.statistics().native).toBe(0)
    expect(input.native.topics.filter((topic) => topic === "mark_delivery_read")).toHaveLength(0)
  }), { inspectConversation: (request) => Effect.succeed({ conversation_type: request.conversationType, conversation_id: request.conversationID, org_id: 1, name: request.conversationID, member_uuids: ["receiver", "sender"] }) })
})

shutdownTest("one pending foreground native cut cannot starve an advisory header from the free slot", () => {
  const foreground = { settled: false }
  return nativeShutdownFixture({
    queryDelayMs: (topic) => topic === "qry_delivery_read_cut" ? 9000 : 0,
    response: (topic, request, original) => topic === "qry_delivery_read_cut"
      ? { name: "DeliveryReadCutResult", value: { ...request, throughOrdinal: "0", targetAdmittedOrdinal: "0",
          readOrdinal: "0", liveUnread: "0", storedUnread: "0", serverNow: Date.now(), complete: true } }
      : original,
  }, (input) => Effect.gen(function* () {
    const headers = input.native.topics.filter((topic) => topic === "qry_delivery_reader").length
    const lastSync = input.entry.lifetime.lastSync
    const consumer = yield* Effect.forkChild(input.entry.reader.request(input.client.getDeliveryReadCut({ version: 1,
      scopeKey, projectionKey, projectionRevision: "1" }).pipe(Effect.tap(() => Effect.sync(() => { foreground.settled = true })))))
    yield* pollWithTimeout(Effect.sync(() => input.native.topics.includes("qry_delivery_read_cut") ? true : undefined), "foreground cut did not reach the actual SDK peer")
    expect(input.registry.statistics().native).toBe(1)
    yield* input.registry.hint(input.entry)
    yield* pollWithTimeout(Effect.sync(() => input.native.topics.filter((topic) => topic === "qry_delivery_reader").length > headers ? true : undefined),
      "advisory header was starved while the second native slot was free", "7500 millis")
    expect(performance.now() - lastSync).toBeGreaterThanOrEqual(5000)
    expect(foreground.settled).toBe(false)
    expect(input.registry.statistics().native).toBeGreaterThanOrEqual(1)
    expect(input.registry.statistics().native).toBeLessThanOrEqual(2)
    yield* Fiber.interrupt(consumer)
    expect(foreground.settled).toBe(false)
    expect(input.registry.statistics().native).toBeGreaterThanOrEqual(1)
    yield* pollWithTimeout(Effect.sync(() => foreground.settled ? true : undefined), "cancelled consumer released the actual SDK operation before settlement", "5 seconds")
    yield* pollWithTimeout(Effect.sync(() => input.registry.statistics().native === 0 ? true : undefined), "native slots were not released after actual settlement")
    expect(input.native.topics.filter((topic) => topic === "qry_delivery_read_cut")).toHaveLength(1)
    expect(input.native.topics.filter((topic) => topic === "mark_delivery_read")).toHaveLength(0)
    yield* Effect.promise(() => stopRegistry(input.scope)(true))
    expect(input.registry.statistics()).toEqual({ entries: 0, owned: 0, native: 0 })
  }))
})
