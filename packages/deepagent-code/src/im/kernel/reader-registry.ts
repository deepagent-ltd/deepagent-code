export * as IMReaderRegistry from "./reader-registry"

import { Context, Effect, Exit, Fiber, Option, Queue, Scope, Semaphore, Stream, SubscriptionRef } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { KernelReader } from "@deepagent-code/core/im/kernel-reader"
import { KernelDelivery } from "@deepagent-code/core/im/kernel-delivery"
import { KernelReaderSchema } from "@deepagent-code/core/im/kernel-reader.schema"
import { IMBroadcasterService } from "@deepagent-code/core/im/broadcaster"
import { InstanceRegistry } from "@/effect/instance-registry"
import { KernelClient } from "./client"
import { KernelConfig } from "./config"
import { IMKernelReader } from "./reader"
import type { IMKernelSync } from "./sync"

export interface Entry {
  readonly context: IMKernelSync.ReaderContext
  readonly reader: IMKernelReader.Interface
  readonly authority: KernelDelivery.Runtime
  readonly assertCurrent: Effect.Effect<void, KernelReaderSchema.Error>
  readonly hold: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E | KernelReaderSchema.Error, R>
  /** A queued send owns this entry after the HTTP scope has ended. */
  readonly retain: Effect.Effect<() => void, KernelReaderSchema.Error>
  readonly lifetime: { active: boolean; leases: number; native: number; queued: boolean; running: boolean; hint: boolean; lastUsed: number; lastSync: number }
  readonly scope: Scope.Closeable
  unregister: () => void
  closing?: Promise<void>
}

export const make = (config: KernelConfig.Info, options?: IMKernelSync.LayerOptions) => Effect.gen(function* () {
  const database = yield* Database.Service
  const client = yield* KernelClient.Service
  const broadcaster = yield* IMBroadcasterService
  const instances = yield* InstanceRegistry.Service
  const scope = yield* Effect.scope
  const construction = yield* Semaphore.make(1)
  const native = yield* Semaphore.make(2)
  const background = yield* Semaphore.make(1)
  const queue = yield* Queue.dropping<Entry>(64)
  const entries = new Map<string, Entry>()
  const owned = new Set<Entry>()
  const key = (context: { workspaceID: string; userID: string }) => JSON.stringify([context.workspaceID, context.userID])
  const ownerCurrent = () => !options?.ownerCurrent || options.ownerCurrent()
  const revoke = (entry: Entry) => {
    if (!entry.lifetime.active) return
    entry.lifetime.active = false
    entry.lifetime.hint = false
    entry.reader.revoke()
    KernelDelivery.close(entry.authority)
    if (entries.get(key(entry.context)) === entry) entries.delete(key(entry.context))
    entry.unregister()
  }
  const retire = (entry: Entry) => {
    revoke(entry)
    entry.closing ??= Effect.runPromise(entry.reader.retire.pipe(Effect.ensuring(Scope.close(entry.scope, Exit.void)))).finally(() => { owned.delete(entry) })
    return entry.closing
  }
  const retireDirectory = (directory: string) => {
    const matching = Array.from(owned).filter((entry) => entry.context.instance.directory === directory)
    // Revoke every incarnation before awaiting any uninterruptible native promise.
    matching.forEach(revoke)
    return Promise.all(matching.map(retire)).then(() => {})
  }
  const unregisterDirectory = instances.registerDisposer(retireDirectory)
  const releaseOwner = options?.onOwnerRevoked?.(() => Array.from(owned).forEach(revoke))
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      unregisterDirectory()
      releaseOwner?.()
      Array.from(owned).forEach(revoke)
    }).pipe(
      // Child scopes retain dispatched native requests until actual settlement.
      // Disconnect the owning client after revocation, before joining those scopes.
      Effect.andThen(client.disconnect),
      Effect.ensuring(Effect.promise(() => Promise.all(Array.from(owned).map(retire)))),
    ),
  )
  const hint = (entry: Entry) => Effect.gen(function* () {
    if (!entry.lifetime.active) return
    entry.lifetime.hint = true
    if (entry.lifetime.queued || entry.lifetime.running) return
    // Advisory polling coalesces until the existing scheduler revisits this
    // hint. Foreground sync and original live observations remain immediate;
    // no completed reader response or authority witness is reused here.
    if (entry.lifetime.lastSync > 0 && performance.now() - entry.lifetime.lastSync < 5000) return
    entry.lifetime.queued = true
    if (!(yield* Queue.offer(queue, entry))) entry.lifetime.queued = false
  })
  const retain = (entry: Entry) => entry.assertCurrent.pipe(Effect.andThen(Effect.sync(() => {
    entry.lifetime.leases++
    entry.lifetime.lastUsed = performance.now()
    let active = true
    return () => {
      if (!active) return
      active = false
      entry.lifetime.leases--
      entry.lifetime.lastUsed = performance.now()
    }
  })))
  const services = Context.make(Database.Service, database).pipe(Context.add(KernelClient.Service, client), Context.add(IMBroadcasterService, broadcaster))
  const create = (context: IMKernelSync.ReaderContext) => Effect.gen(function* () {
    const child = yield* Scope.make()
    const lifetime = { active: true, leases: 0, native: 0, queued: false, running: false, hint: false, lastUsed: performance.now(), lastSync: 0 }
    const assertCurrent = Effect.suspend(() => !lifetime.active || !ownerCurrent() ? KernelReaderSchema.failure("reader_unavailable", "workspace-lease") : context.instanceCurrent.pipe(Effect.flatMap((current) => current ? Effect.void : KernelReaderSchema.failure("reader_scope_mismatch", "workspace-lease"))))
    // FIFO semaphores age queued foreground work. A background call takes its
    // dedicated permit first, so background waiters cannot occupy both slots.
    const request: IMKernelReader.RequestGate = (effect, lane) => Effect.uninterruptibleMask((restore) => {
      const permits = { background: false, native: false, dispatched: false, counted: false }
      const release = Effect.gen(function* () {
        if (permits.native) yield* native.release(1)
        if (permits.background) yield* background.release(1)
        lifetime.native--
      })
      return Effect.gen(function* () {
        yield* assertCurrent
        lifetime.native++
        permits.counted = true
        const take = (semaphore: Semaphore.Semaphore) => restore(semaphore.take(1)).pipe(Effect.timeoutOption(lane === "foreground" ? "900 millis" : "5 seconds"), Effect.flatMap((result) => Option.isSome(result) ? Effect.void : KernelReaderSchema.failure("reader_capacity", "native-slots")))
        if (lane === "background") { yield* take(background); permits.background = true }
        yield* take(native)
        permits.native = true
        yield* assertCurrent
        const actual = yield* Effect.forkIn(Effect.gen(function* () {
          yield* assertCurrent
          const result = yield* effect
          yield* assertCurrent
          return result
        }).pipe(Effect.uninterruptible, Effect.ensuring(release)), child)
        permits.dispatched = true
        return yield* restore(Fiber.join(actual))
      }).pipe(Effect.ensuring(Effect.suspend(() => permits.dispatched ? Effect.void : permits.counted ? release : Effect.void)))
    })
    const reader = yield* IMKernelReader.make(config, { workspaceID: context.workspaceID, userID: context.userID, ownerCurrent: () => lifetime.active && ownerCurrent(), instanceCurrent: context.instanceCurrent, requestGate: request, inspectConversation: options?.inspectConversation }).pipe(Effect.provide(services), Effect.provideService(Scope.Scope, child), Effect.onExit((exit) => Exit.isFailure(exit) ? Effect.sync(() => { lifetime.active = false }).pipe(Effect.andThen(Scope.close(child, exit))) : Effect.void))
    const entry: Entry = {
      context, reader, authority: KernelDelivery.runtime(KernelConfig.deliverySource(config)), assertCurrent: assertCurrent.pipe(Effect.andThen(KernelReader.current(reader.runtime)), Effect.asVoid), lifetime, scope: child, unregister: () => {},
      retain: Effect.suspend(() => retain(entry)),
      hold: (effect) => Effect.acquireUseRelease(retain(entry), () => assertCurrent.pipe(Effect.andThen(effect), Effect.tap(() => assertCurrent)), (release) => Effect.sync(release)),
    }
    entry.unregister = InstanceRegistry.registerInstanceStateDisposer(context.instance, () => retire(entry))
    owned.add(entry)
    entries.set(key(context), entry)
    return entry
  })
  const acquire = (context: IMKernelSync.ReaderContext) => Effect.acquireRelease(construction.withPermits(1)(Effect.gen(function* () {
    if (!ownerCurrent() || !(yield* context.instanceCurrent)) return yield* KernelReaderSchema.failure("reader_scope_mismatch", "workspace-lease")
    const existing = entries.get(key(context))
    if (existing && existing.context.instance === context.instance && existing.lifetime.active) {
      const release = yield* retain(existing)
      return { entry: existing, release }
    }
    if (existing) {
      if (yield* existing.context.instanceCurrent) return yield* KernelReaderSchema.failure("reader_mapping_conflict", "workspace-incarnation")
      yield* Effect.promise(() => { revoke(existing); void retire(existing); return Promise.resolve() })
    }
    if (owned.size >= 64) {
      const idle = Array.from(owned).filter((entry) => entry.lifetime.active && !entry.lifetime.leases && !entry.lifetime.native && !entry.lifetime.queued && !entry.lifetime.running && !entry.reader.hasActiveConnections()).sort((a, b) => a.lifetime.lastUsed - b.lifetime.lastUsed)[0]
      if (!idle) return yield* KernelReaderSchema.failure("reader_capacity", "workspace-registry")
      yield* Effect.promise(() => retire(idle))
    }
    if (owned.size >= 64) return yield* KernelReaderSchema.failure("reader_capacity", "workspace-registry")
    const entry = yield* create(context)
    return { entry, release: yield* retain(entry) }
  })), (lease) => Effect.sync(lease.release)).pipe(Effect.tap((lease) => Effect.gen(function* () {
    // A new workspace binds through the foreground slot before joining the
    // background queue. A stalled background custodian in A cannot starve B.
    if (!(yield* KernelReader.scope(lease.entry.reader.runtime))) {
      if (lease.entry.lifetime.native) return yield* KernelReaderSchema.failure("reader_unavailable", "workspace-initializing")
      yield* lease.entry.reader.sync
      if (!(yield* KernelReader.scope(lease.entry.reader.runtime))) return yield* KernelReaderSchema.failure("reader_unavailable", "workspace-initializing")
    }
    yield* lease.entry.assertCurrent
    yield* hint(lease.entry)
  })), Effect.map((lease) => lease.entry), Effect.mapError((error) => error instanceof KernelReaderSchema.Error ? error : KernelReaderSchema.failure("reader_unavailable", "workspace-initializing")))
  yield* Stream.runForEach(Stream.fromQueue(queue), (entry) => Effect.gen(function* () {
    entry.lifetime.queued = false
    if (!entry.lifetime.active) return
    entry.lifetime.running = true
    entry.lifetime.hint = false
    yield* entry.hold(entry.reader.syncSlice).pipe(Effect.ignore, Effect.ensuring(Effect.sync(() => { entry.lifetime.running = false; entry.lifetime.lastSync = performance.now() })))
    // The periodic scheduler requeues active partial work at the tail. It does
    // not recursively drain a single workspace's full history.
  })).pipe(Effect.forkIn(scope))
  yield* Effect.gen(function* () {
    while (true) {
      yield* Effect.sleep("1 second")
      if ((yield* SubscriptionRef.get(client.state)) !== "connected") continue
      for (const entry of entries.values()) {
        if (!(yield* entry.context.instanceCurrent)) { revoke(entry); void retire(entry); continue }
        if (entry.lifetime.leases > (entry.lifetime.running ? 1 : 0) || entry.reader.hasActiveConnections() || entry.lifetime.hint) yield* hint(entry)
      }
    }
  }).pipe(Effect.forkIn(scope))
  yield* Stream.runForEach(SubscriptionRef.changes(client.state), (state) => Effect.forEach(Array.from(entries.values()), (entry) => state === "connected" ? hint(entry) : entry.reader.invalidate(), { discard: true })).pipe(Effect.forkIn(scope))
  if (client.liveObservations) yield* Stream.runForEach(client.liveObservations, (handle) => Effect.gen(function* () {
    if (!client.readLiveObservation?.(handle) || !ownerCurrent()) return
    // Dispatch only to already captured Entries. A notification never resolves
    // a path, creates an Instance, or grants task execution permission.
    yield* Effect.forEach(Array.from(entries.values()).filter((entry) => entry.lifetime.active),
      (entry) => entry.hold(entry.reader.observeLive(handle)).pipe(Effect.ignore), { concurrency: 2, discard: true })
  })).pipe(Effect.forkIn(scope))
  return { acquire, hint, find: (workspaceID: string, userID: string) => entries.get(key({ workspaceID, userID })), entries: () => Array.from(entries.values()), statistics: () => ({ entries: entries.size, owned: owned.size, native: Array.from(owned).reduce((sum, entry) => sum + entry.lifetime.native, 0) }) }
})
export type Interface = Effect.Success<ReturnType<typeof make>>
