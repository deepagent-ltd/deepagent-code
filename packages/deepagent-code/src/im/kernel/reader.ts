export * as IMKernelReader from "./reader"

import { Cause, Deferred, Effect, Fiber, Option, Ref, Semaphore, SubscriptionRef } from "effect"
import { SqlError } from "effect/unstable/sql/SqlError"
import { EffectDrizzleQueryError } from "drizzle-orm/effect-core/errors"
import { randomUUID } from "node:crypto"
import { Database } from "@deepagent-code/core/database/database"
import { KernelReader } from "@deepagent-code/core/im/kernel-reader"
import { KernelDelivery } from "@deepagent-code/core/im/kernel-delivery"
import { KernelDeliverySchema } from "@deepagent-code/core/im/kernel-delivery.schema"
import { Log } from "@deepagent-code/core/util/log"
import { KernelReaderSchema } from "@deepagent-code/core/im/kernel-reader.schema"
import { IMBroadcasterService } from "@deepagent-code/core/im/broadcaster"
import { SERVER_USER_ID } from "@/server/routes/instance/httpapi/utils/workspace-context"
import { KernelConfig } from "./config"
import { KernelClient } from "./client"
import { KernelSdk } from "./sdk"
import type { IMKernelExchange } from "./exchange"
import type { KernelTaskSourceWitness } from "./task-source-witness"

export const readerError = (error: KernelSdk.KernelError): KernelReaderSchema.Error => {
  const cause = typeof error.cause === "object" && error.cause !== null ? error.cause as { kind?: unknown; wireCode?: unknown } : undefined
  const code = cause?.kind === "reader_required" ? "reader_required" : cause?.kind === "upgrade_required" ? "reader_upgrade_required" : cause?.kind === "stale" ? "reader_stale" : cause?.kind === "unknown" ? "reader_unknown" : cause?.kind === "capacity" ? "reader_capacity" : "reader_unavailable"
  return new KernelReaderSchema.Error({ code, operation: error.operation, message: "Remote conversation is currently unavailable", ...(typeof cause?.wireCode === "number" && Number.isInteger(cause.wireCode) && cause.wireCode >= 0 && cause.wireCode <= 65535 ? { wireCode: cause.wireCode } : {}) })
}
export type State = { state: "idle" | "syncing" | "ready" | "partial" | "unavailable"; code?: KernelReaderSchema.Code; displayEpoch: string; legacyMirrorUnavailable: boolean }
export type RequestGate = <A, E>(effect: Effect.Effect<A, E>, lane: "foreground" | "background") => Effect.Effect<A, E | KernelReaderSchema.Error>
const log = Log.create({ service: "im-kernel-reader" })
// The query wrapper may contain SQL, parameters and remote content. Only these
// closed error classes and native SQLite codes can cross the diagnostic boundary.
export const syncFailureDiagnostic = (error: unknown) => {
  const cause = error instanceof EffectDrizzleQueryError && Cause.isCause(error.cause)
    ? Option.getOrUndefined(Cause.findErrorOption(error.cause)) : error
  const sql = cause instanceof SqlError ? cause.reason : undefined
  const native = sql?.cause
  const code = typeof native === "object" && native !== null && "code" in native ? native.code : undefined
  return {
    kind: error instanceof KernelReaderSchema.Error ? "kernel_reader"
      : error instanceof KernelDeliverySchema.Error ? "kernel_delivery"
      : error instanceof EffectDrizzleQueryError ? "drizzle_query"
      : error instanceof SqlError ? "sql"
      : error instanceof TypeError ? "type_error"
      : error instanceof RangeError ? "range_error" : "unclassified",
    ...(error instanceof KernelDeliverySchema.Error && [
      "KERNEL_DELIVERY_UNAVAILABLE", "KERNEL_DELIVERY_CONFLICT", "KERNEL_DELIVERY_UNKNOWN", "KERNEL_DELIVERY_RETIRED",
    ].includes(error.code) ? { failureCode: error.code } : {}),
    ...(sql && ["ConnectionError", "AuthenticationError", "AuthorizationError", "SqlSyntaxError", "UniqueViolation",
      "ConstraintError", "DeadlockError", "SerializationError", "LockTimeoutError", "StatementTimeoutError", "UnknownError",
    ].includes(sql._tag) ? { sqlReason: sql._tag } : {}),
    ...(typeof code === "string" && [
      "SQLITE_ERROR", "SQLITE_BUSY", "SQLITE_LOCKED", "SQLITE_READONLY", "SQLITE_IOERR", "SQLITE_CORRUPT",
      "SQLITE_FULL", "SQLITE_CANTOPEN", "SQLITE_CONSTRAINT", "SQLITE_CONSTRAINT_CHECK",
      "SQLITE_CONSTRAINT_FOREIGNKEY", "SQLITE_CONSTRAINT_NOTNULL", "SQLITE_CONSTRAINT_PRIMARYKEY",
      "SQLITE_CONSTRAINT_TRIGGER", "SQLITE_CONSTRAINT_UNIQUE", "SQLITE_CONSTRAINT_ROWID",
      "SQLITE_CONSTRAINT_DATATYPE", "SQLITE_READONLY_DBMOVED", "SQLITE_READONLY_CANTINIT",
    ].includes(code) ? { sqliteCode: code } : {}),
  }
}
type SyncStage = "reader" | "bind" | "ensure_scope" | "sender_cleanup" | "sender_retirement" |
  "receiver_baseline" | "local_metadata" | "live_cut" | "newer" | "older" | "changes" | "apply_messages" |
  "apply_changes" | "checkpoint" | "cleanup" | "sender_recovery" | "sender_recovery_messages" | "state"
type SyncNativeOperation = "getDeliveryReader" | "getDeliveryReceiverBaseline" | "getDeliveryLiveCut" |
  "getDeliveryLiveMessages" | "getDeliveryMessages" | "getDeliveryChanges"
export const make = (config: KernelConfig.Info, input: { workspaceID: string; userID?: string; ownerCurrent?: () => boolean; instanceCurrent?: Effect.Effect<boolean>; requestGate?: RequestGate; onOwnerRevoked?: (invalidate: () => void) => () => void; inspectConversation?: (input: IMKernelExchange.InspectConversationInput) => Effect.Effect<IMKernelExchange.InspectConversationPayload, IMKernelExchange.ExchangeError> }) => Effect.gen(function* () {
  const database = yield* Database.Service
  const client = yield* KernelClient.Service
  const broadcaster = yield* IMBroadcasterService
  const requests = yield* Semaphore.make(2)
  const syncLock = yield* Semaphore.make(1)
  const running = yield* Ref.make<{ completed: Deferred.Deferred<void>; handles: object[]; active: boolean } | undefined>(undefined)
  const scope = yield* Effect.scope
  const source = KernelConfig.deliverySource(config)
  // Original handles are prepared only by this reader/DB incarnation. The
  // native request's deadline is fixed and a rolled-back insert cannot renew it.
  const livePrepared = new WeakMap<object, { observation: KernelReaderSchema.LiveObservation; deadline: number }>()
  // Original native cut handles are per connection/receiver/projection; a new
  // generation captures a new acceptance baseline, never upgrades old rows.
  const liveCuts = new Map<string, object>()
  const liveSubscriberID = crypto.randomUUID().replaceAll("-", "")
  const receiverBaseline: { handle?: object } = {}
  // This capability comes only from the authenticated header of this owner.
  // It advertises support; the batch query still proves every requested row.
  const outputProofCapability: { scopeKey?: string } = {}
  const bindReader = (reader: Effect.Success<ReturnType<KernelClient.Interface["getDeliveryReader"]>>) =>
    KernelReader.bind(runtime, reader.scopeKey, reader.version).pipe(Effect.tap(() => Effect.sync(() => {
      outputProofCapability.scopeKey = reader.version === 2 && reader.outputProofAvailable === true ? reader.scopeKey : undefined
    })))

  const retirementObserved = new WeakMap<object, { serverNow: number; scopeKey: string; version: 1 | 2; deadline: number }>()
  // A caller deadline never frees a slot while the native SDK promise is still
  // pending. The real engine scope owns it through the SDK's actual settlement.
  const withRequest = <A, E>(effect: Effect.Effect<A, E>, lane: "foreground" | "background" = "foreground"): Effect.Effect<A, E | KernelReaderSchema.Error> => input.requestGate ? input.requestGate(Effect.gen(function* () {
    yield* KernelReader.current(runtime)
    const result = yield* effect
    yield* KernelReader.current(runtime)
    return result
  }), lane) : Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
    yield* KernelReader.current(runtime)
    yield* restore(requests.take(1))
    const fiber = yield* Effect.forkIn(Effect.gen(function* () {
      yield* KernelReader.current(runtime)
      const result = yield* effect
      yield* KernelReader.current(runtime)
      return result
    }).pipe(Effect.ensuring(requests.release(1)), Effect.uninterruptible), scope)
    return yield* restore(Fiber.join(fiber))
  }))
  const query = <A>(effect: Effect.Effect<A, KernelSdk.KernelError>, lane: "foreground" | "background" = "foreground") => withRequest(effect.pipe(Effect.mapError(readerError)), lane)
  const inspect = (request: { conversationType: 1 | 2; conversationID: string }) => Effect.gen(function* () {
    yield* KernelReader.current(runtime)
    if (!config.identity || !input.inspectConversation) return yield* KernelReaderSchema.failure("reader_unavailable", "inspect")
    const verified = yield* input.inspectConversation({ ...request, senderID: config.userID }).pipe(Effect.mapError(() => KernelReaderSchema.failure("reader_unavailable", "inspect")))
    yield* KernelReader.current(runtime)
    if (verified.conversation_type !== request.conversationType || verified.conversation_id !== request.conversationID || verified.org_id !== config.identity.orgID || !verified.member_uuids.includes(config.userID) || (request.conversationType === 1 && !verified.member_uuids.includes(request.conversationID))) return yield* KernelReaderSchema.failure("reader_scope_mismatch", "inspect")
    return { name: verified.name }
  })
  const runtime = KernelReader.attach({ db: database.db, workspaceID: input.workspaceID, userID: input.userID ?? SERVER_USER_ID, source, current: () => Effect.gen(function* () {
    if (input.ownerCurrent && !input.ownerCurrent() || input.instanceCurrent && !(yield* input.instanceCurrent)) return false
    return (yield* SubscriptionRef.get(client.state)) === "connected" && KernelReader.hash(KernelConfig.deliverySource(config)) === KernelReader.hash(source)
  }), readCut: (request) => query(client.getDeliveryReadCut(request)), outputProof: (request) => Effect.suspend(() =>
    request.version !== 2 || !client.getDeliveryOutputProof || outputProofCapability.scopeKey !== request.scopeKey
      ? Effect.fail(KernelReaderSchema.failure("reader_upgrade_required", "output-proof"))
      : query(client.getDeliveryOutputProof(request))), inspect, retirementObservation: (handle) => {
    const observed = retirementObserved.get(handle)
    retirementObserved.delete(handle)
    if (!observed || performance.now() >= observed.deadline || !KernelReader.active(runtime) ||
      input.ownerCurrent && !input.ownerCurrent() || KernelReader.hash(KernelConfig.deliverySource(config)) !== KernelReader.hash(source)) return undefined
    return observed
  }, liveObservation: (handle) => {
    const prepared = livePrepared.get(handle)
    const original = client.readLiveObservation?.(handle)
    if (!prepared || !original || performance.now() >= prepared.deadline || !KernelReader.active(runtime) || input.ownerCurrent && !input.ownerCurrent() || KernelReader.hash(KernelConfig.deliverySource(config)) !== KernelReader.hash(source)) return undefined
    const value = original.observation
    if (value.isSend || value.hasReference || value.receiverID !== config.userID || value.generation !== prepared.observation.transportGeneration || original.receivedAt !== prepared.observation.receivedAt || value.messageID !== prepared.observation.messageID || value.sequence !== prepared.observation.sequence || value.messageTime !== prepared.observation.messageTime || value.senderID !== prepared.observation.senderID || value.conversationType !== prepared.observation.conversationType || value.conversationID !== prepared.observation.conversationID || value.wireContent !== prepared.observation.wireContent || value.originalDestroyTime !== prepared.observation.originalDestroyTime) return undefined
    return prepared.observation
  } })
  const state = yield* SubscriptionRef.make<State>({ state: "idle", displayEpoch: runtime.displayEpoch, legacyMirrorUnavailable: true })
  // Watchers exist only after a real socket has passed the current output gate
  // and the broadcaster's global connection limit. Historical groups are not
  // retained in a process-wide notification or polling list.
  const watchedGroups = new Map<string, number>()
  const retired = { value: false }
  const maintenance = new Set<KernelDeliverySchema.SenderCleanupError["code"]>()
  const watchGroup = (groupID: string) => {
    watchedGroups.set(groupID, (watchedGroups.get(groupID) ?? 0) + 1)
    let active = true
    return () => {
      if (!active) return
      active = false
      const count = watchedGroups.get(groupID) ?? 0
      if (count > 1) watchedGroups.set(groupID, count - 1)
      if (count <= 1) watchedGroups.delete(groupID)
    }
  }
  const notify = (groupIDs: readonly string[], code?: KernelReaderSchema.Code) => Effect.sync(() => {
    if (retired.value) return
    if (!code && input.ownerCurrent && !input.ownerCurrent()) return
    Array.from(new Set(groupIDs)).forEach((groupID) => broadcaster.broadcast(groupID, code ? { type: "reader_invalidated", data: { groupID, displayEpoch: runtime.displayEpoch, code } } : { type: "reader_changed", data: { groupID, displayEpoch: runtime.displayEpoch } }))
  })
  const revoke = () => {
    if (retired.value) return
    retired.value = true
    KernelReader.close(runtime)
    Array.from(watchedGroups.keys()).forEach((groupID) => broadcaster.broadcast(groupID, { type: "reader_invalidated", data: { groupID, displayEpoch: runtime.displayEpoch, code: "reader_unavailable" } }))
  }
  const releaseOwner = input.onOwnerRevoked?.(revoke)
  yield* Effect.addFinalizer(() => Effect.sync(() => releaseOwner?.()))
  const invalidate = (code: KernelReaderSchema.Code = "reader_unavailable") => SubscriptionRef.set(state, { state: "unavailable", code, displayEpoch: runtime.displayEpoch, legacyMirrorUnavailable: true }).pipe(Effect.andThen(Effect.suspend(() => notify([...watchedGroups.keys()], code))))
  yield* Effect.addFinalizer(() => Effect.sync(revoke).pipe(Effect.andThen(invalidate())))
  const commit = <A, E>(effect: Effect.Effect<A, E>) => syncLock.withPermits(1)(effect)
  // Retained method shapes let historical readers decode old task records. No
  // reader incarnation can mint an IM execution witness after the cutover.
  const taskSource = {
    capture: (_messageID: string) => Effect.fail(KernelReaderSchema.failure("reader_unavailable", "retired-task-source")),
    read: (_handle: object): KernelTaskSourceWitness.Current | undefined => undefined,
    assert: (_handle: object) => Effect.fail(KernelReaderSchema.failure("reader_unavailable", "retired-task-source")),
  }
  const applyPage = (page: KernelReader.MessagesPage, started: number, handles: readonly object[]) => Effect.gen(function* () {
    handles.forEach((handle) => {
      const original = client.readLiveObservation?.(handle)
      if (original && !livePrepared.has(handle) && original.observation.receiverID === config.userID && !original.observation.isSend && !original.observation.hasReference && page.items.some((item) => item.messageId === original.observation.messageID && item.sequence === original.observation.sequence && item.messageTime === original.observation.messageTime && item.senderId === original.observation.senderID && item.conversationType === original.observation.conversationType && item.targetId === original.observation.conversationID && item.content === original.observation.wireContent && !item.isSend && (!("messageType" in item) || item.messageType === "jg:text") && (original.observation.originalDestroyTime === undefined || item.expiresAt === original.observation.originalDestroyTime))) {
        const value = original.observation
        livePrepared.set(handle, { deadline: started + 1000, observation: { scopeKey: page.scopeKey, projectionKey: page.projectionKey, projectionRevision: page.projectionRevision, sourceHash: KernelReader.hash(source), receiverID: value.receiverID, transportGeneration: value.generation, receivedAt: original.receivedAt, messageID: value.messageID, sequence: value.sequence, messageTime: value.messageTime, senderID: value.senderID, conversationType: value.conversationType, conversationID: value.conversationID, wireContent: value.wireContent, ...(value.originalDestroyTime !== undefined ? { originalDestroyTime: value.originalDestroyTime } : {}) } })
      }
    })
    return yield* commit(KernelReader.applyMessages(runtime, page, undefined, handles))
  })
  const maintainSender = (effect: Effect.Effect<string[], Effect.Error<ReturnType<typeof KernelDelivery.cleanupSender>> |
    Effect.Error<ReturnType<typeof KernelDelivery.retireSenderMedia>> | Effect.Error<ReturnType<typeof KernelDelivery.retireSenderReplies>>>) => commit(effect).pipe(
    Effect.catchTag("KernelDelivery.SenderRetirementDeferred", () => Effect.gen(function* () {
      // A fresh scope must be allowed to establish its own projection. This
      // catches only an absent mapping, never a changed owner or membership.
      yield* KernelReader.current(runtime)
      yield* commit(KernelReader.ensureScope(runtime))
      return [] as string[]
    })),
    Effect.catchTag("KernelDelivery.SenderCleanupError", (error) => Effect.gen(function* () {
      // A malformed body cannot starve projection or the separate credential
      // retirement batch. Current authority and database failures still escape.
      yield* KernelReader.current(runtime)
      yield* commit(KernelReader.ensureScope(runtime))
      if (!maintenance.has(error.code)) {
        maintenance.add(error.code)
        log.warn("Sender text cleanup requires review", { code: error.code, candidates: error.candidates })
      }
      return [] as string[]
    })),
  )
  const syncPass = (limit: number, lane: "foreground" | "background", currentPass: { completed: Deferred.Deferred<void>; handles: object[]; active: boolean }, liveHandle?: object) => Effect.suspend(() => {
    // This belongs to one serialized pass, never to concurrent HTTP consumers.
    const diagnostic: { stage: SyncStage; lastNativeOperation?: SyncNativeOperation } = { stage: "reader" }
    const observe = <A, E>(stage: SyncStage, effect: Effect.Effect<A, E>) => Effect.suspend(() => {
      diagnostic.stage = stage
      return effect
    })
    const querySync = <A>(operation: SyncNativeOperation, stage: SyncStage, effect: Effect.Effect<A, KernelSdk.KernelError>) =>
      observe(stage, Effect.suspend(() => {
        diagnostic.lastNativeOperation = operation
        return query(effect, lane)
      }))
    return Effect.gen(function* () {
    const budget = liveHandle || !input.requestGate ? 15_000 : lane === "background" ? 1000 : 3000
    const reader = yield* querySync("getDeliveryReader", "reader", client.getDeliveryReader())
    retirementObserved.set(reader, { serverNow: reader.serverNow, scopeKey: reader.scopeKey, version: reader.version, deadline: performance.now() + 1000 })
    yield* observe("bind", bindReader(reader))
    yield* observe("ensure_scope", commit(KernelReader.ensureScope(runtime)))
    yield* notify(yield* Effect.gen(function* () {
      const current = yield* observe("sender_cleanup", maintainSender(KernelDelivery.cleanupSender(runtime, reader.serverNow)))
      const previous = yield* observe("sender_retirement", KernelDelivery.withSenderRetirement(runtime, reader, Effect.gen(function* () {
        const text = yield* maintainSender(KernelDelivery.retirePreviousSender())
        const media = yield* maintainSender(KernelDelivery.retireSenderMedia())
        const replies = yield* maintainSender(KernelDelivery.retireSenderReplies())
        return [...new Set([...text, ...media, ...replies])]
      })))
      return [...new Set([...current, ...previous])]
    }).pipe(Effect.ensuring(Effect.sync(() => retirementObserved.delete(reader)))))
    yield* SubscriptionRef.set(state, { state: "syncing", displayEpoch: runtime.displayEpoch, legacyMirrorUnavailable: true })
    let queries = 1
    // Capture the original receiver connection before discovering projections.
    // An accepted old receipt remains historical even if its recipient effect
    // materializes later; a new DM no longer needs a preceding chat message.
    const receiverLive = reader.version === 2 && client.receiverBaselineAvailable?.() === true
    if (receiverLive) {
      if (!client.getDeliveryReceiverBaseline || !client.readReceiverBaseline)
        return yield* KernelReaderSchema.failure("reader_unavailable", "receiver-baseline")
      if (!receiverBaseline.handle || !client.readReceiverBaseline(receiverBaseline.handle)) {
        receiverBaseline.handle = yield* querySync("getDeliveryReceiverBaseline", "receiver_baseline", client.getDeliveryReceiverBaseline({ subscriberID: liveSubscriberID, scopeKey: reader.scopeKey }))
        queries++
      }
      if (!client.readReceiverBaseline(receiverBaseline.handle)) return yield* KernelReaderSchema.failure("reader_unavailable", "receiver-baseline")
    }
    // The mandatory current header and receiver baseline must not consume the
    // entire advisory dispatch window on a normal public connection. The
    // original query count and whole-pass hard timeout still bound each slice.
    const start = performance.now()
    let rawBytes = 0
    while (queries < limit && rawBytes < 16_777_216 && performance.now() - start < budget) {
      const stored = yield* observe("local_metadata", KernelReader.scope(runtime))
      if (!stored) return yield* KernelReaderSchema.failure("reader_unavailable", "sync")
      const continuation = KernelReaderSchema.decode(KernelReaderSchema.Continuation, stored.continuation, 8192)
      if (continuation.projections.length) {
        const completed: string[] = []
        for (const work of continuation.projections) {
          if (queries >= limit) break
          const projection = yield* observe("local_metadata", KernelReader.projection(runtime, work.projectionKey))
          if (!projection || projection.visibility !== "visible" || projection.server_revision !== work.serverRevision) return yield* KernelReaderSchema.failure("reader_stale", "projection")
          let finished = false
          for (let round = 0; round < 4 && queries < limit && performance.now() - start < budget; round++) {
            const currentProjection = yield* observe("local_metadata", KernelReader.projection(runtime, work.projectionKey))
            if (!currentProjection) return yield* KernelReaderSchema.failure("reader_stale", "projection")
            if (work.direction === "older" && currentProjection.history_complete) { finished = true; break }
            const privateLive = work.direction === "newer" && KernelReader.readerVersion(runtime) === 2 && client.liveReadAvailable?.() === true &&
              client.getDeliveryLiveCut && client.getDeliveryLiveMessages && client.readLiveCut
            const storedCut = liveCuts.get(work.projectionKey)
            const currentCut = storedCut && client.readLiveCut?.(storedCut) ? storedCut : undefined
            if (privateLive && !currentCut) {
              if (queries + 2 > limit) break
              const captured = yield* querySync("getDeliveryLiveCut", "live_cut", client.getDeliveryLiveCut!({ version: 2, subscriberID: liveSubscriberID, scopeKey: reader.scopeKey,
                projectionKey: work.projectionKey, projectionRevision: work.serverRevision },
                receiverLive ? receiverBaseline.handle : undefined))
              queries++
              if (liveCuts.size >= 64 && !liveCuts.has(work.projectionKey)) return yield* KernelReaderSchema.failure("reader_capacity", "live-cuts")
              liveCuts.set(work.projectionKey, captured)
            }
            if (performance.now() - start >= budget) break
            const observed = performance.now()
            const request = { version: KernelReader.readerVersion(runtime), scopeKey: reader.scopeKey,
              projectionKey: work.projectionKey, projectionRevision: work.serverRevision, direction: work.direction,
              ...(work.direction === "newer" ? { anchorDeliveryCursor: currentProjection.newer_after }
                : currentProjection.older_before ? { anchorDeliveryCursor: currentProjection.older_before } : {}), limit: privateLive ? 8 : 32 }
            const received = privateLive
              ? yield* querySync("getDeliveryLiveMessages", "newer", client.getDeliveryLiveMessages!(request, liveCuts.get(work.projectionKey)!))
              : { page: yield* querySync("getDeliveryMessages", work.direction, client.getDeliveryMessages(request)), handles: [] as object[] }
            const page = received.page
            queries++
            rawBytes += KernelReaderSchema.bytes(JSON.stringify(page))
            yield* notify(yield* observe("apply_messages", applyPage(page, observed, currentPass.active ? [...currentPass.handles, ...received.handles] : [])))
            yield* notify(yield* observe("cleanup", commit(KernelReader.cleanup(runtime, page.serverNow))))
            if (!page.finished) continue
            if (work.direction === "newer" && !currentProjection.history_complete) {
              if (queries >= limit || performance.now() - start >= budget) break
              const olderObserved = performance.now()
              const older = yield* querySync("getDeliveryMessages", "older", client.getDeliveryMessages({ version: KernelReader.readerVersion(runtime), scopeKey: reader.scopeKey, projectionKey: work.projectionKey, projectionRevision: work.serverRevision, direction: "older", ...(currentProjection.older_before ? { anchorDeliveryCursor: currentProjection.older_before } : {}), limit: 32 }))
              queries++
              rawBytes += KernelReaderSchema.bytes(JSON.stringify(older))
              yield* notify(yield* observe("apply_messages", applyPage(older, olderObserved, currentPass.active ? [...currentPass.handles] : [])))
              if (!older.finished) continue
            }
            finished = true
            break
          }
          if (finished) completed.push(work.projectionKey)
        }
        yield* observe("checkpoint", commit(KernelReader.checkpoint(runtime, completed, stored.page_token === null)))
        if (completed.length < continuation.projections.length) break
        continue
      }
      const page = yield* querySync("getDeliveryChanges", "changes", client.getDeliveryChanges({ version: KernelReader.readerVersion(runtime), scopeKey: reader.scopeKey, after: stored.window_after ?? stored.completed_after, limit: stored.fixed_limit, ...(stored.page_token ? { pageToken: stored.page_token } : {}) }))
      queries++
      rawBytes += KernelReaderSchema.bytes(JSON.stringify(page))
      yield* notify(yield* observe("apply_changes", commit(KernelReader.applyChanges(runtime, { ...page, items: page.items.map((item) => item.visibility === "revoked" ? { visibility: "revoked" as const, projectionKey: item.projectionKey, revision: item.revision, cursor: item.cursor } : item) }))))
      yield* notify(yield* observe("cleanup", commit(KernelReader.cleanup(runtime, page.serverNow))))
      const applied = yield* observe("local_metadata", KernelReader.scope(runtime))
      const pending = applied && KernelReaderSchema.decode(KernelReaderSchema.Continuation, applied.continuation, 8192).projections.length > 0
      if (!pending) yield* observe("checkpoint", commit(KernelReader.checkpoint(runtime, [], page.windowComplete)))
      if (page.caughtUp && !pending) break
    }
    for (const item of yield* observe("sender_recovery", KernelReader.senderRecovery(runtime, reader.serverNow))) {
      if (queries >= limit || rawBytes >= 16_777_216 || performance.now() - start >= budget) break
      const projection = yield* observe("local_metadata", KernelReader.projection(runtime, item.projectionKey))
      if (!projection?.server_revision) continue
      const page = yield* querySync("getDeliveryMessages", "sender_recovery_messages", client.getDeliveryMessages({ version: KernelReader.readerVersion(runtime), scopeKey: reader.scopeKey, projectionKey: item.projectionKey, projectionRevision: projection.server_revision, direction: "newer", anchorDeliveryCursor: (BigInt(item.deliveryCursor) - 1n).toString(), limit: 1 }))
      queries++
      rawBytes += KernelReaderSchema.bytes(JSON.stringify(page))
      if (page.items.some((message) => message.effectKey === item.effectKey)) yield* notify(yield* observe("apply_messages", commit(KernelReader.applyMessages(runtime, page, item.effectKey))))
    }
    const stored = yield* observe("local_metadata", KernelReader.scope(runtime))
    yield* SubscriptionRef.set(state, { state: stored?.phase === "idle" ? "ready" : "partial", displayEpoch: runtime.displayEpoch, legacyMirrorUnavailable: true })
  // The lane budget stops subsequent dispatch. Interrupting an already issued
  // page before its current checks and checkpoint discards all progress on a
  // normal public connection. The original hard bound still limits the pass;
  // native slots, source current checks and proof lifetimes stay unchanged.
  }).pipe(Effect.timeoutOption("15 seconds"), Effect.flatMap((result) => result._tag === "None" ? SubscriptionRef.set(state, { state: "partial", displayEpoch: runtime.displayEpoch, legacyMirrorUnavailable: true }) : Effect.void), Effect.catch((error) => Effect.gen(function* () {
    const code = error instanceof KernelReaderSchema.Error ? error.code : "reader_unavailable"
    const previous = yield* SubscriptionRef.get(state)
    // Diagnostics describe only this failed observation. They never renew the
    // reader, supply authority, or include remote content or credentials.
    if (previous.state !== "unavailable" || previous.code !== code) log.warn("Protected reader sync rejected", {
      category: error instanceof KernelReaderSchema.Error ? "kernel_reader" : "other",
      stage: diagnostic.stage,
      ...syncFailureDiagnostic(error),
      ...(diagnostic.lastNativeOperation ? { lastNativeOperation: diagnostic.lastNativeOperation } : {}),
      code,
      operation: error instanceof KernelReaderSchema.Error && [
        "current", "bind", "scope", "initialize", "sync", "projection", "changes", "messages", "checkpoint",
        "cleanup", "cleanup-body", "cleanup-clock", "cleanup-delete", "cleanup-member", "cleanup-retire",
        "cleanup-scope", "sender-recovery", "sender-receipt", "sender-retired-history", "receiver-baseline",
        "native-slots", "live-cuts", "workspace-lease", "workspace-initializing", "obligation-meter", "reserve", "meter", "live-sync",
        "reader", "getDeliveryReader", "getDeliveryChanges", "getDeliveryMessages", "getDeliveryReadCut",
        "getDeliveryLiveCut", "getDeliveryLiveMessages", "getDeliveryReceiverBaseline",
      ].includes(error.operation) ? error.operation : "unclassified",
      ...(error instanceof KernelReaderSchema.Error && error.wireCode !== undefined ? { wireCode: error.wireCode } : {}),
      lane,
    })
    if (code === "reader_stale") yield* commit(KernelReader.discardWindow(runtime)).pipe(Effect.ignore)
    yield* invalidate(code)
  })))
  })
  const runSync = (limit: number, lane: "foreground" | "background", liveHandle?: object) => Effect.gen(function* () {
    const currentPass = { completed: yield* Deferred.make<void>(), handles: [] as object[], active: true }
    const inflight = yield* Ref.modify(running, (value) => [value, value ?? currentPass])
    const selected = inflight ?? currentPass
    if (liveHandle && client.readLiveObservation?.(liveHandle)) {
      if (!selected.active) return yield* KernelReaderSchema.failure("reader_stale", "live-sync")
      if (!selected.handles.includes(liveHandle)) {
        if (selected.handles.length >= 32) return yield* KernelReaderSchema.failure("reader_capacity", "live-sync")
        selected.handles.push(liveHandle)
      }
    }
    if (inflight) return yield* Deferred.await(inflight.completed)
    // Share genuine current observations with the original pass before its first INSERT.
    // Joining does not extend either the pass deadline or the source witness lifetime.
    return yield* syncPass(limit, lane, currentPass, liveHandle).pipe(Effect.ensuring(Effect.sync(() => {
      currentPass.active = false
      currentPass.handles.length = 0
    }).pipe(Effect.andThen(Ref.set(running, undefined)), Effect.andThen(Deferred.succeed(currentPass.completed, undefined)))))
  })
  const sync = runSync(input.requestGate ? 4 : 128, "foreground")
  const syncSlice = runSync(4, "background")
  const observeLive = (handle: object) => Effect.gen(function* () {
    yield* KernelReader.current(runtime)
    if (!client.readLiveObservation?.(handle)) return
    yield* runSync(8, "background", handle)
  })
  const read = (input: { groupID: string; actionID?: string; reconcile?: boolean; continue?: boolean; cancel?: boolean; newAction?: boolean }) => Effect.gen(function* () {
    if ([input.reconcile, input.continue, input.cancel, input.newAction].filter(Boolean).length > 1 || (input.reconcile || input.continue || input.cancel || input.newAction) && !input.actionID || input.actionID !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(input.actionID)) return yield* KernelReaderSchema.failure("reader_scope_mismatch", "read-flags")
    const actionID = input.actionID ?? randomUUID()
    if (input.continue && !input.actionID) return yield* KernelReaderSchema.failure("reader_unknown", "read")
    if (input.continue) yield* sync
    const projection = (yield* KernelReader.projections(runtime, [input.groupID]))[0]
    if (!projection?.projection_key || !projection.server_revision || projection.visibility !== "visible") return yield* KernelReaderSchema.failure("reader_required", "read")
    const request = { version: KernelReader.readerVersion(runtime), scopeKey: (yield* KernelReader.scope(runtime))!.scope_key, projectionKey: projection.projection_key, projectionRevision: projection.server_revision }
    const lineage = yield* KernelReader.readAction(runtime, actionID)
    const existing = lineage.at(-1)
    if ((input.continue || input.cancel || input.reconcile) && !existing) return yield* KernelReaderSchema.failure("reader_unknown", "read")
    const current = yield* query(client.getDeliveryReadCut(request))
    if (existing && existing.projection_key !== projection.projection_key) return yield* KernelReaderSchema.failure("reader_mapping_conflict", "read")
    const target = existing?.original_target_admitted ?? current.targetAdmittedOrdinal
    const response = (status: "confirmed" | "partial" | "unknown" | "cancelled", view = current) => ({ ok: status === "confirmed" || status === "cancelled", reader: { actionID, state: status, targetAdmitted: target, readOrdinal: view.readOrdinal, liveUnread: view.liveUnread } })
    if (input.cancel) { yield* KernelReader.cancelRead(runtime, existing!.action_id); return response("cancelled") }
    if (existing?.phase === "cancelled") {
      if (input.continue || input.reconcile) return yield* KernelReaderSchema.failure("reader_unknown", "read")
      return response("cancelled")
    }
    if (input.continue && existing?.phase !== "confirmed") return yield* KernelReaderSchema.failure("reader_unknown", "read")
    if (existing?.phase === "confirmed" && (!input.continue || KernelReaderSchema.compareDecimal(current.readOrdinal, target) >= 0)) return response(KernelReaderSchema.compareDecimal(current.readOrdinal, target) >= 0 ? "confirmed" : "partial")
    if (existing && ["unknown", "dispatched"].includes(existing.phase)) {
      // A different device can advance the same ordinal. A fresh read cut
      // observes the target; only this dispatch's actual mark result settles it.
      return response("unknown")
    }
    if (input.reconcile) return yield* KernelReaderSchema.failure("reader_unknown", "read")
    if (existing && input.newAction) return response("unknown")
    if (!existing && !input.newAction) {
      yield* KernelReader.validateNewRead(runtime, { groupID: input.groupID, target })
      if (KernelReaderSchema.compareDecimal(current.readOrdinal, target) >= 0) return response("confirmed")
    }
    const prepared = yield* KernelReader.prepareRead(runtime, { actionID, groupID: input.groupID, cut: current, continue: input.continue, newAction: input.newAction })
    if (!prepared) return response("unknown")
    const dispatch = yield* KernelReader.dispatchRead(runtime, prepared.action_id)
    if (!dispatch) return response("unknown")
    const fixed = KernelReaderSchema.decode(KernelReaderSchema.Request, dispatch.request, 4096)
    if (fixed.throughOrdinal === undefined) return yield* KernelReaderSchema.failure("reader_mapping_conflict", "read")
    const result = yield* withRequest(client.markDeliveryRead({ ...fixed, throughOrdinal: fixed.throughOrdinal }).pipe(Effect.mapError(readerError), Effect.tap((result) => KernelReader.settleRead(runtime, dispatch.action_id, result)), Effect.tapError(() => KernelReader.settleRead(runtime, dispatch.action_id).pipe(Effect.ignore)))).pipe(Effect.option)
    yield* KernelReader.current(runtime)
    if (result._tag === "None") return response("unknown")
    yield* sync
    yield* notify([input.groupID])
    return response(KernelReaderSchema.compareDecimal(result.value.readOrdinal, target) >= 0 ? "confirmed" : "partial", result.value)
  })
  const verifyScope = Effect.gen(function* () {
    const header = yield* query(client.getDeliveryReader())
    yield* bindReader(header)
    if (!(yield* KernelReader.scope(runtime))) return yield* KernelReaderSchema.failure("reader_unavailable", "scope-proof")
  }).pipe(Effect.mapError((error) => error instanceof KernelReaderSchema.Error ? error : KernelReaderSchema.failure("reader_unavailable", "scope-proof")))
  const withOutput = <A, E, R>(request: { workspaceID: string; userID: string; groupIDs?: readonly string[] }, effect: Effect.Effect<A, E, R>, options?: { refreshBeforeEffect?: boolean }) => Effect.suspend(() => {
    if (retired.value || input.ownerCurrent && !input.ownerCurrent()) return KernelReaderSchema.failure("reader_unavailable", "owner")
    if (!options?.refreshBeforeEffect) return syncLock.withPermits(1)(KernelReader.withOutput(runtime, request, effect))
    return Effect.gen(function* () {
      const first = yield* syncLock.withPermits(1)(KernelReader.prepareOutput(runtime, request, effect).pipe(Effect.matchEffect({
        onFailure: (error) => error instanceof KernelReaderSchema.Error && error.code === "reader_stale" && error.operation === "getDeliveryReadCut" && error.wireCode === 12203
          ? Effect.succeed({ _tag: "Refresh" as const }) : Effect.fail(error),
        // This branch runs only after prepare succeeded. Failures in the business
        // effect or its postframe current check never enter onFailure above.
        onSuccess: (prepared) => prepared.pipe(Effect.map((value) => ({ _tag: "Done" as const, value }))),
      })))
      if (first._tag === "Done") return first.value
      // Sync commits take this same semaphore, so the failed preparation's
      // permit must be released first. The original query and time bounds hold.
      yield* KernelReader.current(runtime)
      yield* runSync(4, "foreground")
      yield* KernelReader.current(runtime)
      return yield* syncLock.withPermits(1)(KernelReader.withOutput(runtime, request, effect))
    })
  })
  return { runtime, state, sync, syncSlice, observeLive, refreshGroup: (groupID: string) => commit(KernelReader.refreshGroup(runtime, groupID)).pipe(Effect.tap((changed) => changed ? notify([groupID]) : Effect.void), Effect.asVoid), refreshPending: () => commit(KernelReader.refreshPending(runtime)).pipe(Effect.tap((changed) => changed.length ? notify(changed) : Effect.void), Effect.asVoid), captureTaskSource: (localMessageID: string) => commit(taskSource.capture(localMessageID)), readTaskSource: taskSource.read, assertTaskSource: taskSource.assert, verifyScope, read, invalidate, revoke, retire: KernelReader.retireReads(runtime), request: withRequest, watchGroup, hasActiveConnections: () => watchedGroups.size > 0, pending: (request: { conversationType: 1 | 2; conversationID: string; name: string }) => Effect.gen(function* () {
    if (!(yield* KernelReader.scope(runtime))) {
      const header = yield* query(client.getDeliveryReader())
      yield* bindReader(header)
    }
    return yield* KernelReader.pending(runtime, request)
  }), withOutput, conversation: (groupID: string) => Effect.gen(function* () { yield* KernelReader.current(runtime); return yield* KernelReader.senderConversation(database.db, groupID, source) }), inspect }
})
export type Interface = Effect.Success<ReturnType<typeof make>>
