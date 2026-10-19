export * as IMKernelSync from "./sync"

import { Context, Deferred, Effect, Exit, Layer, Option, Queue, Ref, Schedule, Scope, Stream, SubscriptionRef, Schema } from "effect"
import { AttachmentRefMetadata } from "@deepagent-code/core/im/sql"
import { IMRepository, IMRepositoryError, clientMessageID } from "@deepagent-code/core/im/repository"
import type { IMRepositoryInterface } from "@deepagent-code/core/im/repository"
import { Database } from "@deepagent-code/core/database/database"
import { Log } from "@deepagent-code/core/util/log"
import { MessageID } from "@deepagent-code/core/im/id"
import { MediaUploadCheckpoint } from "@deepagent-code/core/im/media-upload-checkpoint"
import { MediaUploadCheckpointModel } from "@deepagent-code/core/im/media-upload-checkpoint.model"
import { KernelDelivery } from "@deepagent-code/core/im/kernel-delivery"
import { KernelDeliverySchema } from "@deepagent-code/core/im/kernel-delivery.schema"
import { KernelReaderSchema } from "@deepagent-code/core/im/kernel-reader.schema"
import { IMBroadcasterService } from "@deepagent-code/core/im/broadcaster"
import { KernelClient } from "./client"
import { KernelSdk } from "./sdk"
import { KernelConfig } from "./config"
import { IMKernelReader } from "./reader"
import { IMKernelExchange } from "./exchange"
import { SERVER_USER_ID } from "@/server/routes/instance/httpapi/utils/workspace-context"
import { IMReaderRegistry } from "./reader-registry"
import { IMKernelMediaUpload } from "./media-upload"
import type { InstanceContext } from "@/project/instance-context"

type SendStage = "request_gate" | "gate_settled" | "wire_validation" | "sdk_send" | "send_settled" | "ack_current" | "ack_write"
const deliveryLog = Log.create({ service: "im.kernel.sync" })
export const deliveryFailureDiagnostic = (error: unknown) => {
  // Observation must neither invoke untrusted accessors nor replace a send error.
  try {
    const own = diagnosticData(error)
    const cause = diagnosticData(own.cause)
    const reader = error instanceof KernelReaderSchema.Error
    return {
      kind: reader ? "kernel_reader" : error instanceof KernelSdk.KernelError ? "kernel_sdk"
        : error instanceof IMRepositoryError ? "im_repository" : error instanceof KernelDeliverySchema.Error ? "kernel_delivery"
        : error instanceof TypeError ? "type_error" : error instanceof RangeError ? "range_error" : "unclassified",
      ...(reader && KernelReaderSchema.CODES.some((code) => code === own.code) ? { readerCode: own.code } : {}),
      ...(reader && typeof own.operation === "string" && ["native-slots", "workspace-lease", "current", "owner", "lease", "media_workspace", "send"].includes(own.operation) ? { readerOperation: own.operation } : {}),
      ...(error instanceof KernelSdk.KernelError && typeof own.operation === "string" && ["sendMedia", "media_send", "sendMessage", "sendText"].includes(own.operation) ? { sdkOperation: own.operation } : {}),
      ...(error instanceof IMRepositoryError && typeof own.code === "string" && ["kernel_delivery_unavailable", "message_identity_conflict", "attachment_unavailable", ...KernelReaderSchema.CODES].includes(own.code) ? { repositoryCode: own.code } : {}),
      ...(cause.name === "DeliveryError" && typeof cause.operation === "string" && ["media", "media_send", "capabilities", "media_capabilities", "send"].includes(cause.operation) ? { deliveryOperation: cause.operation } : {}),
      ...(cause.name === "DeliveryError" && typeof cause.kind === "string" && ["invalid_request", "invalid_response", "disconnected", "unknown", "transport_timeout", "capacity", "unavailable", "denied", "reader_required", "stale", "upgrade_required", "unsupported_capability", "conflict", "expired", "not_found", "legacy_api_disabled"].includes(cause.kind) ? { deliveryKind: cause.kind } : {}),
      ...(cause.name === "DeliveryError" && [11005, 11013, 12201, 12202, 12203, 12204, 12205, 12206, 30001].some((code) => code === cause.wireCode) ? { wireCode: cause.wireCode } : {}),
    }
  } catch { return { kind: "unclassified" } }
}
function diagnosticData(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) return {}
  return Object.fromEntries(Object.entries(Object.getOwnPropertyDescriptors(value)).filter(([key, descriptor]) => ["cause", "code", "name", "operation", "kind", "wireCode"].includes(key) && "value" in descriptor).map(([key, descriptor]) => [key, descriptor.value]))
}
function observeDelivery(input: { messageHash: string; lane: "foreground" | "background"; stage: SendStage; event: "begin" | "gate_settled" | "send_settled" | "failure" | "ack_false" }, error?: unknown) {
  try {
    const fields = { ...input, ...(error === undefined ? {} : deliveryFailureDiagnostic(error)) }
    if (input.event === "failure" || input.event === "ack_false") return deliveryLog.warn("protected delivery observation", fields)
    deliveryLog.debug("protected delivery observation", fields)
  }
  catch { /* Logging cannot change the original delivery outcome. */ }
}

export const kernelConvKey = (conversationType: 1 | 2, conversationID: string) => `k:${conversationType}:${conversationID}`
export const parseKernelConvKey = (key: string): { readonly conversationType: 1 | 2; readonly conversationID: string } | undefined => {
  const match = /^k:([12]):(.+)$/.exec(key)
  return match ? { conversationType: match[1] === "1" ? 1 : 2, conversationID: match[2] } : undefined
}
export const historyCursorKey = (convKey: string) => `history:v2:${convKey}`
export interface SendInput { readonly groupID: string; readonly messageID: string; readonly content: string }
export interface RecoveryState { readonly status: "pending" | "ready" | "failed"; readonly message?: string }
export interface ReaderLease {
  readonly engine: Interface
  readonly reader: IMKernelReader.Interface
  readonly workspaceID: string
  readonly userID: string
  readonly directory: string
  readonly assertCurrent: Effect.Effect<void, KernelReaderSchema.Error>
}
export interface ReaderContext { readonly instance: InstanceContext; readonly workspaceID: string; readonly userID: string; readonly instanceCurrent: Effect.Effect<boolean> }
export interface Interface {
  readonly receiptSource?: KernelDeliverySchema.Source
  readonly getDeliveryReceipt?: NonNullable<KernelClient.Interface["getDeliveryReceipt"]>
  readonly createMessage: IMRepositoryInterface["createMessage"]
  readonly createAttachment?: IMRepositoryInterface["createAttachment"]
  readonly prepareMediaContinuation?: (input:MediaUploadCheckpoint.Request) => Effect.Effect<void,IMRepositoryError>
  readonly deliveryStatuses: (messageIDs: readonly string[]) => ReturnType<IMRepositoryInterface["kernelDeliveryStatuses"]>
  readonly deliveryStatus: (messageID: string) => ReturnType<IMRepositoryInterface["kernelDeliveryStatus"]>
  readonly state: SubscriptionRef.SubscriptionRef<KernelClient.ConnectionState>
  readonly send: (input: SendInput) => Effect.Effect<void>
  readonly drainPending: Effect.Effect<void>
  readonly recovery: SubscriptionRef.SubscriptionRef<RecoveryState>
  readonly catchUp: Effect.Effect<void>
  readonly reader?: IMKernelReader.Interface
  /** Available only on the captured workspace engine returned by a lease. */
  readonly media?: KernelSdk.Media
  readonly acquireReader?: (context: ReaderContext) => Effect.Effect<ReaderLease, KernelReaderSchema.Error, Scope.Scope>
  /** Existing Entry only; this never resolves a path or creates a reader. */
}
export class Service extends Context.Service<Service, Interface>()("@deepagent-code/im/kernel/Sync") {}
export interface LayerOptions {
  /** Captured only by the owning facade generation; never a wire grant. */
  readonly ownerCurrent?: () => boolean
  readonly onOwnerRevoked?: (invalidate: () => void) => () => void
  readonly inspectConversation?: (input: IMKernelExchange.InspectConversationInput) => Effect.Effect<IMKernelExchange.InspectConversationPayload, IMKernelExchange.ExchangeError>
  readonly workspaceID?: string
  readonly responder?: { readonly enabled: boolean; readonly directory: string }
}
// Retained for callers that explicitly need a failure for the retired global mirror path.
export const provisionOrgAllGroup = (_repo: IMRepositoryInterface, _identity: KernelConfig.Identity, _workspaceID: string): Effect.Effect<void> => Effect.void
export const layer = (config: KernelConfig.Info, options?: LayerOptions) => Layer.effect(Service, Effect.gen(function* () {
  const repo = yield* IMRepository
  const database = yield* Database.Service
  const client = yield* KernelClient.Service
  const broadcaster = yield* IMBroadcasterService
  const registry = yield* IMReaderRegistry.make(config, options)
  const recovery = yield* SubscriptionRef.make<RecoveryState>({ status: "pending" })
  const sends = yield* Queue.bounded<{ entry: IMReaderRegistry.Entry; input: SendInput; lane: "foreground" | "background"; release: () => void }>(128)
  yield* Effect.addFinalizer(() => Queue.clear(sends).pipe(Effect.tap((jobs) => Effect.sync(() => jobs.forEach((job) => job.release()))), Effect.andThen(Queue.shutdown(sends))))
  const inflight = yield* Ref.make<ReadonlySet<string>>(new Set())
  const engines = new WeakMap<IMReaderRegistry.Entry, Interface>()
  const deliver = (entry: IMReaderRegistry.Entry, input: SendInput, lane: "foreground" | "background" = "foreground") => entry.hold(Effect.gen(function* () {
    if (!config.identity || !options?.inspectConversation || !KernelDelivery.active(entry.authority) || (yield* SubscriptionRef.get(client.state)) !== "connected") return
    const acquired = yield* Ref.modify(inflight, (set) => set.has(input.messageID) ? [false, set] : [true, new Set(set).add(input.messageID)])
    if (!acquired) return
    yield* Effect.gen(function* () {
      const group = yield* repo.getGroupByID(input.groupID)
      if (!group?.kernelConvID || group.workspaceID !== entry.context.workspaceID) return
      const parsed = group.kernelConvID.startsWith("kr1:") ? yield* entry.reader.conversation(group.id) : parseKernelConvKey(group.kernelConvID)
      if (!parsed) return
      const message = repo.getRawMessageForKernelDelivery ? yield* repo.getRawMessageForKernelDelivery(input.messageID) : undefined
      if (!message || message.groupID !== group.id) return
      const proof = yield* options.inspectConversation!({ ...parsed, senderID: config.userID }).pipe(Effect.option)
      yield* entry.assertCurrent
      if (Option.isNone(proof) || proof.value.org_id !== config.identity!.orgID || proof.value.conversation_id !== parsed.conversationID || proof.value.conversation_type !== parsed.conversationType || !proof.value.member_uuids.includes(config.userID)) return
      const dispatch = yield* KernelDelivery.withVerification(entry.authority, { conversationType: parsed.conversationType, conversationID: parsed.conversationID, orgID: proof.value.org_id, memberIDs: proof.value.member_uuids }, repo.claimKernelDelivery(entry.authority, input.messageID))
      if (!dispatch) return
      const observation = { messageHash: KernelDelivery.hash({ messageID: input.messageID }), lane, stage: "request_gate" as SendStage }
      observeDelivery({ ...observation, event: "begin" })
      const send = Effect.suspend(() => {
        observation.stage = "gate_settled"
        observeDelivery({ ...observation, event: "gate_settled" })
        observation.stage = dispatch.binding.version === 1 ? "sdk_send" : "wire_validation"
        return dispatch.binding.version === 1 ? client.sendText({ conversationType: dispatch.binding.conversationType, conversationID: dispatch.binding.conversationID, text: dispatch.text, messageID: dispatch.binding.messageID, wireID: dispatch.binding.wireID, expiresAt: dispatch.binding.expiresAt }) : Effect.gen(function* () {
        const binding = dispatch.binding
        if (binding.version !== 2 || !client.sendMedia) return yield* new KernelSdk.KernelError({ operation: "media_send", message: "Protected media is unavailable" })
        const body = yield* Effect.try({ try: () => KernelReaderSchema.wireContent(binding.wireContent, binding.messageType, binding.expiresAt), catch: () => new KernelSdk.KernelError({ operation: "media_send", message: "The original media receipt is invalid" }) })
        if (!body.remoteAttachments) return yield* new KernelSdk.KernelError({ operation: "media_send", message: "The original media receipt is invalid" })
        const attachments = body.remoteAttachments.map(({ profile: _profile, ...item }) => item)
        if (JSON.stringify({ v: 1, content: body.content, attachments }) !== binding.wireContent) return yield* new KernelSdk.KernelError({ operation: "media_send", message: "The original media bytes do not match the receipt" })
        observation.stage = "sdk_send"
        return yield* client.sendMedia({ conversationType: binding.conversationType, conversationID: binding.conversationID, content: body.content, attachments, messageID: binding.messageID, wireID: binding.wireID, expiresAt: binding.expiresAt })
      })
      })
      const outcome = yield* entry.reader.request(send.pipe(Effect.flatMap((ack) => Effect.gen(function* () {
        observation.stage = "send_settled"
        observeDelivery({ ...observation, event: "send_settled" })
        observation.stage = "ack_current"
        yield* entry.assertCurrent
        observation.stage = "ack_write"
        const acknowledged = yield* repo.acknowledgeKernelDelivery(entry.authority, dispatch, ack.messageID)
        if (!acknowledged) observeDelivery({ ...observation, event: "ack_false" })
        return acknowledged
      }))), lane).pipe(Effect.tapError((error) => Effect.sync(() => observeDelivery({ ...observation, event: "failure" }, error))), Effect.option)
      if (Option.isNone(outcome) || !outcome.value) yield* repo.uncertainKernelDelivery(entry.authority, dispatch).pipe(Effect.ignore)
      yield* entry.assertCurrent
      yield* registry.hint(entry)
      broadcaster.broadcast(group.id, { type: "reader_changed", data: { groupID: group.id, displayEpoch: entry.reader.runtime.displayEpoch } })
    }).pipe(Effect.ensuring(Ref.update(inflight, (set) => new Set([...set].filter((id) => id !== input.messageID)))))
  })).pipe(Effect.ignore)
  const enqueue = (entry: IMReaderRegistry.Entry, input: SendInput, lane: "foreground" | "background") => Effect.gen(function* () {
    const group = yield* repo.getGroupByID(input.groupID)
    if (group?.workspaceID !== entry.context.workspaceID) return yield* KernelReaderSchema.failure("reader_scope_mismatch", "send")
    const release = yield* entry.retain
    const accepted = { value: false }
    yield* Queue.offer(sends, { entry, input, lane, release }).pipe(Effect.timeoutOption("900 millis"), Effect.flatMap((offered) => {
      accepted.value = Option.isSome(offered) && offered.value
      return accepted.value ? Effect.void : KernelReaderSchema.failure("reader_capacity", "send-queue")
    }), Effect.ensuring(Effect.sync(() => { if (!accepted.value) release() })))
  })
  const fixedEngine = (entry: IMReaderRegistry.Entry) => Effect.gen(function* () {
    const existing = engines.get(entry)
    if (existing) return existing
    const scopedRecovery = yield* SubscriptionRef.make<RecoveryState>({ status: "pending" })
    const mediaRequest = <A>(effect: Effect.Effect<A, KernelSdk.KernelError>) => entry.hold(entry.reader.request(effect.pipe(
      Effect.tap(() => entry.assertCurrent),
    ))).pipe(Effect.mapError((error) => error instanceof KernelSdk.KernelError ? error : new KernelSdk.KernelError({
      operation: "media_workspace", message: "A current workspace media reader is required", cause: error,
    })))
    const mediaClient = client.media
    const media = mediaClient ? {
      capabilities: () => mediaRequest(mediaClient.capabilities()),
      transferCapabilities: mediaClient.transferCapabilities ? () => mediaRequest(mediaClient.transferCapabilities!()) : undefined,
      uploadProgress: mediaClient.uploadProgress ? (input: Parameters<NonNullable<KernelSdk.Media["uploadProgress"]>>[0]) => mediaRequest(mediaClient.uploadProgress!(input)) : undefined,
      begin: (input: Parameters<KernelSdk.Media["begin"]>[0]) => mediaRequest(mediaClient.begin(input)),
      putChunk: (input: Parameters<KernelSdk.Media["putChunk"]>[0]) => mediaRequest(mediaClient.putChunk(input)),
      finalize: (input: Parameters<KernelSdk.Media["finalize"]>[0]) => mediaRequest(mediaClient.finalize(input)),
      status: (input: Parameters<KernelSdk.Media["status"]>[0]) => mediaRequest(mediaClient.status(input)),
      cancel: (input: Parameters<KernelSdk.Media["cancel"]>[0]) => mediaRequest(mediaClient.cancel(input)),
      readRange: (input: Parameters<KernelSdk.Media["readRange"]>[0]) => mediaRequest(mediaClient.readRange(input)),
    } : undefined
    const catchUp = entry.hold(entry.reader.sync.pipe(Effect.andThen(Effect.gen(function* () {
      const current = yield* SubscriptionRef.get(entry.reader.state)
      yield* SubscriptionRef.set(scopedRecovery, current.state === "ready" ? { status: "ready" } : current.state === "unavailable" ? { status: "failed", message: "Remote conversation is currently unavailable" } : { status: "pending" })
    })))).pipe(Effect.ignore)
    const drainPending = entry.hold(Effect.gen(function* () {
      for (const row of yield* repo.listPendingKernelMessages({ limit: 32, runtime: entry.authority })) {
        if ((yield* repo.getGroupByID(row.message.groupID))?.workspaceID === entry.context.workspaceID) yield* deliver(entry, { groupID: row.message.groupID, messageID: row.message.id, content: row.message.content }, "background")
      }
    })).pipe(Effect.ignore)
    type Continuation = {
      requestHash: string; sourceHash: string; outcome: "preparing" | "ready" | "unknown";
      completed: Deferred.Deferred<Exit.Exit<void, IMRepositoryError>>; pendingNative: number; issued: boolean; uncertain: boolean; finished: boolean;
      value?: { hash: string; deadline: number; attachments: KernelDeliverySchema.MediaCreation["attachments"]; sourceHash: string }
    }
    const continuations = new Map<string, Continuation>()
    const mediaFailure = (error:unknown) => error instanceof IMRepositoryError ? error : new IMRepositoryError({code:error instanceof MediaUploadCheckpointModel.Error && ["IM_MEDIA_UPLOAD_CONFLICT","IM_MEDIA_UPLOAD_LEGACY"].includes(error.code) || error instanceof KernelDeliverySchema.Error && error.code === "KERNEL_DELIVERY_RETIRED" ? "message_identity_conflict" : "reader_unavailable",message:error instanceof MediaUploadCheckpointModel.Error ? error.message : "Remote conversation is currently unavailable"})
    const prepareMediaContinuation = (request: MediaUploadCheckpoint.Request) => entry.hold(Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
      const previous = yield* restore(KernelDelivery.read(database.db, request.messageID))
      if (previous) return
      yield* restore(MediaUploadCheckpoint.emptyBusiness(database.db, request.messageID))
      const requestHash = MediaUploadCheckpoint.requestHash(request)
      const sourceHash = KernelDelivery.hash(entry.authority.source)
      const existing = continuations.get(request.messageID)
      if (existing) {
        if (existing.requestHash !== requestHash || existing.sourceHash !== sourceHash) return yield* MediaUploadCheckpointModel.conflict()
        if (existing.outcome === "preparing") return yield* restore(Deferred.await(existing.completed).pipe(Effect.flatMap((exit) => exit)))
        if (existing.outcome === "unknown") return yield* MediaUploadCheckpointModel.unknown()
        if (existing.value && performance.now() < existing.value.deadline) return
        continuations.delete(request.messageID)
      }
      continuations.forEach((value, key) => {
        // Only a fully known readonly continuation expires; pending or uncertain effects own slots.
        if (value.outcome === "ready" && value.value && performance.now() >= value.value.deadline) continuations.delete(key)
      })
      if (!media || !mediaClient || config.protectedMedia !== true || continuations.size >= 128) return yield* MediaUploadCheckpointModel.capacity()
      const original: Continuation = { requestHash, sourceHash, outcome: "preparing", completed: Deferred.makeUnsafe(),
        pendingNative: 0, issued: false, uncertain: false, finished: false }
      // One original body/source reservation before plan/claim/remote IO. Exact concurrent callers
      // join its actual completion, never create a second upload or renew its authority deadline.
      continuations.set(request.messageID, original)
      const releaseKnownFailure = () => {
        if (original.finished && !original.uncertain && original.pendingNative === 0 && original.outcome !== "ready" &&
          continuations.get(request.messageID) === original) continuations.delete(request.messageID)
      }
      const mutation = <A>(run: () => Effect.Effect<A, KernelSdk.KernelError>) => mediaRequest(Effect.suspend(() => {
        original.pendingNative++
        original.issued = true
        const observation = { knownRefusal: false }
        return run().pipe(Effect.tapError((error) => Effect.sync(() => {
          const cause = error.cause
          // These are the SDK's typed negative dispatch results. Transport/response ambiguity,
          // timeout/cancel/disconnect and unknown are never treated as a cleanup receipt.
          observation.knownRefusal = typeof cause === "object" && cause !== null && "name" in cause && cause.name === "DeliveryError" &&
            "kind" in cause && ["denied", "reader_required", "stale", "capacity", "invalid_request", "legacy_api_disabled", "unsupported_capability", "upgrade_required", "conflict", "expired", "not_found"].includes(String(cause.kind))
        })), Effect.onExit((exit) => Effect.sync(() => {
          original.pendingNative--
          if (Exit.isFailure(exit) && !observation.knownRefusal) original.uncertain = true
          releaseKnownFailure()
        })))
      }))
      const trackedMedia: KernelSdk.Media = { ...media,
        begin: (input) => mutation(() => mediaClient.begin(input)),
        putChunk: (input) => mutation(() => mediaClient.putChunk(input)),
        finalize: (input) => mutation(() => mediaClient.finalize(input)),
      }
      return yield* restore(Effect.gen(function* () {
      const group = yield* repo.getGroupByID(request.groupID)
      if (!group?.kernelConvID || group.workspaceID !== entry.context.workspaceID || request.senderID !== entry.context.userID) return yield* MediaUploadCheckpointModel.conflict()
      const conversation = group.kernelConvID.startsWith("kr1:") ? yield* entry.reader.conversation(group.id) : parseKernelConvKey(group.kernelConvID)
      if (!conversation) return yield* MediaUploadCheckpointModel.conflict()
      const attachment = yield* MediaUploadCheckpoint.read(database.db,request.attachmentIDs[0]??"")
      if (!attachment) return yield* MediaUploadCheckpointModel.legacy()
      const normalized = {...request,content:request.batch ? request.content : attachment.local.filename}
      const plans = yield* MediaUploadCheckpoint.plan(entry.reader.runtime,normalized)
      const inspected = yield* entry.reader.inspect(conversation)
      yield* entry.assertCurrent
      const attachments = yield* Effect.forEach(plans,(plan) => Effect.gen(function* () {
        const claimed = yield* MediaUploadCheckpoint.claim(entry.reader.runtime,plan.origin.attachment.id)
        const remote = yield* IMKernelMediaUpload.upload(trackedMedia,plan.origin.attachment,{source:entry.authority.source,messageID:request.messageID,...conversation,checkpoint:{runtime:entry.reader.runtime,original:claimed}})
        return {local:plan.origin.attachment,remote}
      }))
      yield* entry.assertCurrent
      // Go's Begin on the stored upload ID reauthorized the old object under
      // current credentials before any pending source marker can be reconciled.
      if (group.kernelConvID.startsWith("kr1:")) {
        const reconciled = yield* entry.reader.pending({...conversation,name:inspected.name})
        if (reconciled !== group.id) return yield* MediaUploadCheckpointModel.conflict()
      }
      yield* entry.assertCurrent
        if (continuations.get(request.messageID) !== original || KernelDelivery.hash(entry.authority.source) !== sourceHash)
          return yield* MediaUploadCheckpointModel.conflict()
        original.value = { hash: MediaUploadCheckpoint.requestHash(normalized), deadline: performance.now() + 1000, attachments, sourceHash }
        original.outcome = "ready"
      }).pipe(Effect.mapError(mediaFailure))).pipe(Effect.onExit((exit) => Effect.sync(() => {
        original.finished = true
        if (Exit.isFailure(exit)) {
          original.outcome = "unknown"
          releaseKnownFailure()
        }
        Deferred.doneUnsafe(original.completed, Effect.succeed(exit))
      })))
    }))).pipe(Effect.mapError(mediaFailure))
    const engine: Interface = {
      createAttachment:(input) => entry.hold(MediaUploadCheckpoint.withOrigin(entry.reader.runtime,input.groupID??"",repo.createAttachment(input))).pipe(Effect.mapError(mediaFailure)),
      prepareMediaContinuation,
      createMessage: (input) => entry.hold(Effect.gen(function* () {
        const group = yield* repo.getGroupByID(input.groupID)
        if (group?.workspaceID !== entry.context.workspaceID) return yield* KernelReaderSchema.failure("reader_scope_mismatch", "createMessage")
        if (!group.kernelConvID) return yield* repo.createMessage(input)
        const conversation = group.kernelConvID.startsWith("kr1:") ? yield* entry.reader.conversation(group.id) : parseKernelConvKey(group.kernelConvID)
        if (!conversation) return yield* KernelReaderSchema.failure("reader_scope_mismatch", "createMessage")
        const inspected = yield* entry.reader.inspect(conversation)
        if (input.type !== "file" && group.kernelConvID.startsWith("kr1:")) yield* entry.reader.pending({ ...conversation, name: inspected.name })
        yield* entry.assertCurrent
        if (input.type !== "file") {
          const create = KernelDelivery.withCreation(entry.authority, input.groupID, repo.createMessage(input))
          // Membership inspection and pending mapping above may wait for the network.
          // Admit text only after a fresh current proof, without replaying its write.
          return yield* input.type === "text"
            ? entry.reader.withOutput(
                { workspaceID: entry.context.workspaceID, userID: entry.context.userID, groupIDs: [input.groupID] },
                create,
                { refreshBeforeEffect: true },
              )
            : create
        }
        const requested = input.attachments ?? (input.attachment ? [input.attachment] : [])
        if (!requested.length || requested.length > 4 || new Set(requested.map((item) => item.id)).size !== requested.length || input.attachments !== undefined && input.attachment || !media || config.protectedMedia !== true || requested.some((item) => item.workspaceID !== entry.context.workspaceID)) return yield* new IMRepositoryError({ code: "attachment_unavailable", message: "Protected media is unavailable" })
        if (input.attachments !== undefined ? !Array.isArray(input.metadata) || input.metadata.length !== requested.length || input.metadata.some((item, index) => item.type !== "attachment_ref" || item.batch !== true || item.attachmentID !== requested[index]?.id) : !Schema.is(AttachmentRefMetadata)(input.metadata) || input.metadata.attachmentID !== requested[0]?.id || input.metadata.batch !== undefined) return yield* new IMRepositoryError({ code: "attachment_unavailable", message: "Original media metadata is unavailable" })
        const messageID = input.clientRequestID ? clientMessageID(input.senderID, input.clientRequestID) : input.id ?? MessageID.create()
        // Retired is a persisted identity, not missing. This live-only preflight
        // must reject before attachment lookup, FD, Begin, Finalize or send.
        const previous = yield* KernelDelivery.read(database.db, messageID)
        if (!previous && !continuations.has(messageID)) yield* prepareMediaContinuation({messageID,clientRequestID:input.clientRequestID??"",groupID:input.groupID,senderID:input.senderID,content:input.content,replyToID:input.replyToID,attachmentIDs:requested.map((item)=>item.id),batch:input.attachments!==undefined})
        if (previous && group.kernelConvID.startsWith("kr1:")) yield* entry.reader.pending({...conversation,name:inspected.name})
        const locals = yield* Effect.forEach(requested, (item) => repo.getAttachment(item.id).pipe(Effect.flatMap((local) => local && local.groupID === group.id && local.workspaceID === entry.context.workspaceID && local.uploadedBy === input.senderID && (local.messageID === null || local.messageID === messageID) ? Effect.succeed(local) : Effect.fail(new IMRepositoryError({ code: "attachment_unavailable", message: "The original attachment is unavailable" })))))
        const old = previous?.binding.version === 2 ? previous.binding : undefined
        if (previous && !old) return yield* new IMRepositoryError({ code: "message_identity_conflict", message: "The original message has a different transport identity" })
        if (old && (old.localAttachments.length !== locals.length || old.localAttachments.some((item, index) => item.localAttachmentID !== locals[index]?.id))) return yield* new IMRepositoryError({ code: "message_identity_conflict", message: "The original attachment order differs" })
        const requestedPlan:MediaUploadCheckpoint.Request = {messageID,clientRequestID:input.clientRequestID??"",groupID:input.groupID,senderID:input.senderID,content:input.content,replyToID:input.replyToID,attachmentIDs:locals.map((item)=>item.id),batch:input.attachments!==undefined}
        const pending = continuations.get(messageID)
        const continuation = pending?.outcome === "ready" ? pending.value : undefined
        if (!old && (!continuation || performance.now()>=continuation.deadline || continuation.hash !== MediaUploadCheckpoint.requestHash(requestedPlan) || continuation.sourceHash !== KernelDelivery.hash(entry.authority.source) || continuation.attachments.length !== locals.length || continuation.attachments.some((item,index)=>MediaUploadCheckpointModel.attachmentHash(item.local)!==MediaUploadCheckpointModel.attachmentHash(locals[index]!)))) return yield* MediaUploadCheckpointModel.conflict()
        const attachments = yield* Effect.forEach(locals, (local, index) => Effect.gen(function* () {
          const remote = old ? old.attachments[index] : continuation!.attachments[index]?.remote
          if (!remote) return yield* new IMRepositoryError({ code: "attachment_unavailable", message: "The original attachment mapping is unavailable" })
          return { local, remote }
        }))
        yield* entry.assertCurrent
        const created = yield* KernelDelivery.withMediaCreation(entry.authority, { messageID, groupID: group.id, senderID: input.senderID, content: input.content, attachments }, repo.createMessage({ ...input, id: messageID }))
        if (pending?.outcome === "ready" && continuations.get(messageID) === pending) continuations.delete(messageID)
        return created
      })).pipe(Effect.mapError((error) => error instanceof IMRepositoryError ? error : new IMRepositoryError({
        code: error instanceof KernelDeliverySchema.Error && error.code === "KERNEL_DELIVERY_RETIRED" ? "message_identity_conflict" : "reader_unavailable",
        message: error instanceof KernelDeliverySchema.Error && error.code === "KERNEL_DELIVERY_RETIRED" ? "The original message body has expired; it cannot be uploaded or sent again" : "Remote conversation is currently unavailable",
      }))),
      receiptSource: entry.authority.source,
      getDeliveryReceipt: client.getDeliveryReceipt ? (request) =>
        entry.hold(entry.reader.request(client.getDeliveryReceipt!(request))).pipe(Effect.mapError((error) =>
          error instanceof KernelSdk.KernelError ? error : new KernelSdk.KernelError({
            operation: "receipt", message: "Current receipt reader is unavailable", cause: error,
          }))) : undefined,
      deliveryStatuses: (ids) => entry.hold(repo.kernelDeliveryStatuses(ids, entry.authority)).pipe(Effect.mapError(() => new IMRepositoryError({ code: "reader_unavailable", message: "Remote conversation is currently unavailable" }))),
      deliveryStatus: (id) => entry.hold(repo.kernelDeliveryStatus(id, entry.authority)).pipe(Effect.mapError(() => new IMRepositoryError({ code: "reader_unavailable", message: "Remote conversation is currently unavailable" }))),
      state: client.state, recovery: scopedRecovery, reader: entry.reader, media, catchUp, drainPending,
      send: (input) => enqueue(entry, input, "foreground").pipe(Effect.ignore),
    }
    engines.set(entry, engine)
    return engine
  })
  yield* Stream.runForEach(Stream.fromQueue(sends), (job) => deliver(job.entry, job.input, job.lane).pipe(Effect.ensuring(Effect.sync(job.release)))).pipe(Effect.forkScoped)
  const drainPending = Effect.suspend(() => Effect.forEach(registry.entries(), (entry) => fixedEngine(entry).pipe(Effect.flatMap((engine) => engine.drainPending)), { discard: true }))
  yield* Effect.suspend(() => drainPending).pipe(Effect.repeat(Schedule.spaced("30 seconds")), Effect.forkScoped)
  return Service.of({
    acquireReader: (context) => Effect.gen(function* () {
      const entry = yield* registry.acquire(context)
      return { engine: yield* fixedEngine(entry), reader: entry.reader, workspaceID: context.workspaceID, userID: context.userID, directory: context.instance.directory, assertCurrent: entry.assertCurrent }
    }),
    // Background producers route from the actual durable group. They can only
    // retain an already registered current Instance, never initialize from a path.
    // HTTP and WS callers keep their captured, fixed-entry engine instead.
    createMessage: (input) => Effect.gen(function* () {
      const group = yield* repo.getGroupByID(input.groupID)
      if (!group?.kernelConvID) return yield* repo.createMessage(input)
      const entry = registry.find(group.workspaceID, SERVER_USER_ID)
      if (!entry) return yield* new IMRepositoryError({ code: "reader_unavailable", message: "A current workspace reader is required" })
      return yield* (yield* fixedEngine(entry)).createMessage(input)
    }),
    deliveryStatuses: () => Effect.fail(new IMRepositoryError({ code: "reader_unavailable", message: "A current workspace reader is required" })),
    deliveryStatus: () => Effect.fail(new IMRepositoryError({ code: "reader_unavailable", message: "A current workspace reader is required" })),
    state: client.state, recovery, drainPending,
    catchUp: Effect.suspend(() => Effect.forEach(registry.entries(), registry.hint, { discard: true })),
    send: (input) => Effect.gen(function* () {
      const group = yield* repo.getGroupByID(input.groupID)
      const entry = group && registry.find(group.workspaceID, SERVER_USER_ID)
      if (entry) yield* enqueue(entry, input, "background")
    }).pipe(Effect.ignore),
  })
}))
export const layerFromConfig = (config: KernelConfig.Info, options?: LayerOptions) => {
  const sdk = KernelSdk.liveFromConfig(config)
  return layer(config, options).pipe(Layer.provide(KernelClient.layer.pipe(Layer.provide(sdk))))
}
