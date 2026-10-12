export * as KernelSdk from "./sdk"

import { Context, Effect, Layer, Queue, Schedule, Schema, Semaphore, Stream } from "effect"
import * as Log from "@deepagent-code/core/util/log"
import type { KernelConfig } from "./config"
import type { DeliveryReaderInfo, DeliveryChangesRequest, DeliveryChangesResult, DeliveryMessagesRequest, DeliveryMessagesResult, DeliveryProjectionRequest, DeliveryReadCutResult, DeliveryMarkReadRequest, ProtectedMediaAttachment, ProtectedMediaCapabilities, ProtectedMediaTransferCapabilities, ProtectedMediaUploadProgress, ProtectedMediaBeginRequest, ProtectedMediaMetadata, ProtectedMediaObjectRequest, ProtectedMediaChunkRequest, ProtectedMediaRangeRequest, ProtectedCurrentLinkFacts } from "@deepagent-code/im-kernel-sdk"

// jugglechat-websdk 的机械边界：浏览器 shim 装载、init/connect/disconnect、原生事件→队列、
// sendMessage/getMessages 调用。本层不做任何业务归一化（那是 client.ts 的职责），也不直接
// 被业务代码消费——唯一消费者是 KernelClient / IMKernelSync。

// d.ts 未声明但协议原生支持的字段（UpMsg proto #11/#12，PoC §16 实测 websdk 透传稳定生效）。
declare module "@deepagent-code/im-kernel-sdk" {
  interface Message {
    /** 逐消息 TTL（毫秒）；服务端 destroy_time = send_time + lifeTime，到期 hismsgs 不可读。 */
    lifeTime?: number
    lifeTimeAfterRead?: number
    /** 服务端回显/下发的到期时刻（life_time 双轨语义的查询层依据）。 */
    destroyTime?: number
  }
}

const log = Log.create({ service: "im-kernel-sdk" })

export class KernelError extends Schema.ErrorClass<KernelError>("KernelError")({
  operation: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

export interface RawStateChanged {
  readonly tag: "state_changed"
  readonly state: number
  readonly code?: number
}
export interface RawMessageReceived {
  readonly tag: "message_received"
  readonly payload: unknown
}
export interface RawProtectedLiveObserved {
  readonly tag: "protected_live_observed"
  readonly handle: object
}
export type RawEvent = RawStateChanged | RawMessageReceived | RawProtectedLiveObserved

export interface OutboundTextMessage {
  readonly messageID: string
  readonly wireID: string
  readonly conversationType: number
  readonly conversationID: string
  readonly text: string
  /** 本地准备时固定到期时间的剩余毫秒数，最多 72h，由 KernelClient.sendText 注入。 */
  readonly lifeTime: number
  readonly expiresAt: number
}
export interface OutboundMediaMessage {
  readonly messageID: string
  readonly wireID: string
  readonly conversationType: 1 | 2
  readonly conversationID: string
  readonly content: string
  readonly attachments: readonly ProtectedMediaAttachment[]
  readonly expiresAt: number
}

/** Internal typed transport. Every operation uses the SDK's captured Navigator
 * and actual credential generation; descriptors do not grant read authority. */
export interface Media {
  readonly capabilities: () => Effect.Effect<ProtectedMediaCapabilities, KernelError>
  readonly transferCapabilities?: () => Effect.Effect<ProtectedMediaTransferCapabilities, KernelError>
  readonly uploadProgress?: (input: ProtectedMediaObjectRequest) => Effect.Effect<ProtectedMediaUploadProgress, KernelError>
  readonly begin: (input: ProtectedMediaBeginRequest) => Effect.Effect<ProtectedMediaMetadata, KernelError>
  readonly putChunk: (input: ProtectedMediaChunkRequest) => Effect.Effect<ProtectedMediaMetadata, KernelError>
  readonly finalize: (input: ProtectedMediaObjectRequest) => Effect.Effect<ProtectedMediaMetadata, KernelError>
  readonly status: (input: ProtectedMediaObjectRequest) => Effect.Effect<ProtectedMediaMetadata, KernelError>
  readonly cancel: (input: ProtectedMediaObjectRequest) => Effect.Effect<ProtectedMediaMetadata, KernelError>
  readonly readRange: (input: ProtectedMediaRangeRequest) => Effect.Effect<Uint8Array, KernelError>
}

export interface FetchHistoryInput {
  readonly conversationType: number
  readonly conversationID: string
  readonly after: number
  readonly count: number
}

export interface HistoryPage {
  readonly messages: readonly unknown[]
  readonly isFinished: boolean
}

export interface ConversationPage {
  readonly conversations: ReadonlyArray<{ conversationType: number; conversationID: string; sortTime: number }>
  readonly isFinished: boolean
}

export interface Interface {
  readonly rawEvents: Stream.Stream<RawEvent>
  readonly captureCurrentLink?: () => object | undefined
  readonly readCurrentLink?: (handle: object) => ProtectedCurrentLinkFacts | undefined
  readonly sendMessage: (input: OutboundTextMessage) => Effect.Effect<{ readonly messageID: string }, KernelError>
  readonly sendMedia?: (input: OutboundMediaMessage) => Effect.Effect<{ readonly messageID: string }, KernelError>
  readonly media?: Media
  readonly fetchHistory: (input: FetchHistoryInput) => Effect.Effect<HistoryPage, KernelError>
  readonly fetchConversations: (input: {
    readonly before: number
    readonly count: number
  }) => Effect.Effect<ConversationPage, KernelError>
  readonly disconnect: Effect.Effect<void>
  readonly liveReadAvailable?: () => boolean
  readonly receiverBaselineAvailable?: () => boolean
  readonly readReceiverBaseline?: (baseline: object) => boolean
  readonly getDeliveryReceiverBaseline?: (input: { subscriberID: string; scopeKey: string }) => Effect.Effect<object, KernelError>
  readonly readLiveCut?: (cut: object) => boolean
  readonly getDeliveryLiveCut?: (input: DeliveryProjectionRequest & { subscriberID: string }, baseline?: object) => Effect.Effect<object, KernelError>
  readonly getDeliveryLiveMessages?: (input: DeliveryMessagesRequest, cut: object) => Effect.Effect<{ page: DeliveryMessagesResult; handles: object[] }, KernelError>
  readonly getDeliveryReader: () => Effect.Effect<DeliveryReaderInfo, KernelError>
  readonly getDeliveryChanges: (input: DeliveryChangesRequest) => Effect.Effect<DeliveryChangesResult, KernelError>
  readonly getDeliveryMessages: (input: DeliveryMessagesRequest) => Effect.Effect<DeliveryMessagesResult, KernelError>
  readonly getDeliveryReadCut: (input: DeliveryProjectionRequest) => Effect.Effect<DeliveryReadCutResult, KernelError>
  readonly markDeliveryRead: (input: DeliveryMarkReadRequest) => Effect.Effect<DeliveryReadCutResult, KernelError>
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/im/kernel/Sdk") {}

// jugglechat-websdk 的按 messageId 去重水位线是 bundle 模块级全局的：同进程两个 SDK 实例会互踩
// 丢消息（PoC §16 SDK 缺陷备案，浏览器多实例同样存在）。部署形态是每进程一个内核客户端，这里
// 用构建期防呆守住：第二次构建 live 层直接 defect，而不是静默互踩。
let liveInstances = 0

const describeError = (error: unknown): string => {
  if (error instanceof Error) return error.message
  // 内核错误对象是 { code, msg } 形状
  if (typeof error === "object" && error !== null && "msg" in error) return String((error as { msg: unknown }).msg)
  return String(error)
}

// Rejected SDK promises are recoverable transport failures. Effect.promise would turn them into
// defects, bypassing the sync engine's retry, recovery diagnostics, and pending-send preservation.
export const request = <A>(operation: string, run: () => PromiseLike<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new KernelError({ operation, message: describeError(cause), cause }),
  })

export const liveFromConfig = (config: KernelConfig.Info) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      if (liveInstances > 0)
        return yield* Effect.die(
          new Error(
            "jugglechat-websdk allows exactly one kernel client per process (module-global dedup watermark); refused to build a second KernelSdk live layer",
          ),
        )
      liveInstances++
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          liveInstances--
        }),
      )

      const queue = yield* Queue.bounded<RawEvent>(2048)
      const slots = yield* Semaphore.make(2)
      const boundedRequest = <A>(operation: string, run: () => PromiseLike<A>) => slots.withPermits(1)(request(operation, run).pipe(Effect.uninterruptible))
      const offer = (event: RawEvent) => {
        if (!Queue.offerUnsafe(queue, event)) log.error("kernel event queue full; dropping event", { tag: event.tag })
      }

      // shims 必须先于 SDK bundle 求值（SDK 在 import 时捕获浏览器全局）。
      yield* Effect.promise(() => import("./shims"))
      const JuggleIM = (yield* Effect.promise(() => import("@deepagent-code/im-kernel-sdk"))).default
      const im = JuggleIM.init({ appkey: config.appkey, navList: [config.navigator], isSync: false, protectedDeliveryReader: true, protectedMedia: config.protectedMedia === true })
      const { KernelTaskLiveOrigin } = yield* Effect.promise(() => import("./task-live-origin"))
      const releaseLiveObserver = KernelTaskLiveOrigin.subscribe(im, (handle) => offer({ tag: "protected_live_observed", handle }))
      yield* Effect.addFinalizer(() => Effect.sync(releaseLiveObserver))

      im.on(JuggleIM.Event.STATE_CHANGED, (event: { state?: unknown; code?: unknown }) => {
        if (typeof event?.state !== "number") return
        offer({
          tag: "state_changed",
          state: event.state,
          ...(typeof event.code === "number" ? { code: event.code } : {}),
        })
      })

      const connect = request("connect", () => im.connect({ token: config.token })).pipe(
        Effect.timeoutOrElse({
          duration: "20 seconds",
          orElse: () => Effect.fail(new KernelError({ operation: "connect", message: "kernel connect timed out" })),
        }),
      )
      // 已连接后的断线由 SDK 自动重连（同一 token）；connect 本身的失败在这里有界重试。
      // facade 对有时效凭据在断线后重新 exchange，安装新 SDK 前关闭当前 scope。
      yield* connect.pipe(
        Effect.tapError((error) => Effect.sync(() => log.warn("kernel connect failed", { message: error.message }))),
        Effect.retry(Schedule.exponential("1 second").pipe(Schedule.both(Schedule.recurs(10)))),
        Effect.catch((error) => Effect.sync(() => log.error("kernel connect gave up", { message: error.message }))),
        Effect.forkScoped,
      )

      yield* Effect.addFinalizer(() => request("disconnect", () => im.disconnect()).pipe(Effect.ignore))

      return Service.of({
        rawEvents: Stream.fromQueue(queue),
        captureCurrentLink: () => im.captureProtectedCurrentLink(),
        readCurrentLink: (handle) => im.readProtectedCurrentLink(handle),
        sendMessage: (input) =>
          Effect.gen(function* () {
            // d.ts 把 Message.conversationType 错标成枚举对象类型（协议实际是 number），且漏标
            // lifeTime（上方 module augmentation 已补类型）——边界处一次性收窄转换。
            const ack = yield* boundedRequest("sendMessage", () =>
              im.sendProtectedMessage({
                tid: input.messageID,
                clientMsgId: input.wireID,
                conversationType: input.conversationType as 1 | 2,
                conversationId: input.conversationID,
                name: "jg:text",
                content: { content: input.text },
                deliveryExpiresAt: input.expiresAt,
              }),
            )
            const messageID = (ack as { messageId?: unknown }).messageId
            if (typeof messageID !== "string" || messageID.length === 0)
              return yield* new KernelError({ operation: "sendMessage", message: "kernel ack carried no messageId" })
            return { messageID }
          }),
        sendMedia: (input) => boundedRequest("sendMedia", () => im.sendProtectedMedia({
          tid: input.messageID, clientMsgId: input.wireID, name: "dac:media.v1", conversationType: input.conversationType,
          conversationId: input.conversationID, content: { v: 1, content: input.content, attachments: input.attachments },
          deliveryExpiresAt: input.expiresAt,
        })).pipe(Effect.flatMap((ack) => typeof ack.messageId === "string" && ack.messageId.length > 0 ?
          Effect.succeed({ messageID: ack.messageId }) : Effect.fail(new KernelError({ operation: "sendMedia", message: "kernel ack carried no messageId" })))),
        media: {
          capabilities: () => boundedRequest("media_capabilities", () => im.getProtectedMediaCapabilities()),
          transferCapabilities: () => boundedRequest("media_transfer_capabilities", () => im.getProtectedMediaTransferCapabilities()),
          uploadProgress: (input) => boundedRequest("media_upload_progress", () => im.getProtectedMediaUploadProgress(input)),
          begin: (input) => boundedRequest("media_begin", () => im.beginProtectedMedia(input)),
          putChunk: (input) => boundedRequest("media_chunk", () => im.putProtectedMediaChunk(input)),
          finalize: (input) => boundedRequest("media_finalize", () => im.finalizeProtectedMedia(input)),
          status: (input) => boundedRequest("media_status", () => im.getProtectedMedia(input)),
          cancel: (input) => boundedRequest("media_cancel", () => im.cancelProtectedMedia(input)),
          readRange: (input) => boundedRequest("media_range", () => im.readProtectedMediaRange(input)),
        },
        fetchHistory: () => Effect.fail(new KernelError({ operation: "fetchHistory", message: "Protected delivery reader is required" })),
        fetchConversations: () => Effect.fail(new KernelError({ operation: "fetchConversations", message: "Protected delivery reader is required" })),
        liveReadAvailable: () => im.isProtectedLiveReadAvailable(),
        receiverBaselineAvailable: () => im.isProtectedReceiverBaselineAvailable(),
        readReceiverBaseline: (baseline) => im.readProtectedReceiverBaseline(baseline) !== undefined,
        getDeliveryReceiverBaseline: (input) => boundedRequest("getDeliveryReceiverBaseline", () => im.getDeliveryReceiverBaseline(input)),
        readLiveCut: (cut) => im.readProtectedLiveCut(cut) !== undefined,
        getDeliveryLiveCut: (input, baseline) => boundedRequest("getDeliveryLiveCut", () => im.getDeliveryLiveCut(input, baseline)),
        getDeliveryLiveMessages: (input, cut) => boundedRequest("getDeliveryLiveMessages", () => im.getDeliveryLiveMessages(input, cut)).pipe(
          Effect.flatMap((handle) => Effect.suspend(() => {
            const original = KernelTaskLiveOrigin.capturePage(im, handle)
            return original ? Effect.succeed(original) : Effect.fail(new KernelError({ operation: "getDeliveryLiveMessages", message: "Original live page unavailable" }))
          })),
        ),
        getDeliveryReader: () => boundedRequest("getDeliveryReader", () => im.getDeliveryReader()),
        getDeliveryChanges: (input) => boundedRequest("getDeliveryChanges", () => im.getDeliveryChanges(input)),
        getDeliveryMessages: (input) => boundedRequest("getDeliveryMessages", () => im.getDeliveryMessages(input)),
        getDeliveryReadCut: (input) => boundedRequest("getDeliveryReadCut", () => im.getDeliveryReadCut(input)),
        markDeliveryRead: (input) => boundedRequest("markDeliveryRead", () => im.markDeliveryRead(input)),
        disconnect: request("disconnect", () => im.disconnect()).pipe(Effect.ignore),
      })
    }),
  )
