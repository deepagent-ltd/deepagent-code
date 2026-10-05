export * as KernelSdk from "./sdk"

import { Context, Effect, Layer, Queue, Schedule, Schema, Stream } from "effect"
import * as Log from "@deepagent-code/core/util/log"
import type { KernelConfig } from "./config"

// jugglechat-websdk 的机械边界：浏览器 shim 装载、init/connect/disconnect、原生事件→队列、
// sendMessage/getMessages 调用。本层不做任何业务归一化（那是 client.ts 的职责），也不直接
// 被业务代码消费——唯一消费者是 KernelClient / IMKernelSync。

// d.ts 未声明但协议原生支持的字段（UpMsg proto #11/#12，PoC §16 实测 websdk 透传稳定生效）。
declare module "jugglechat-websdk" {
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
export type RawEvent = RawStateChanged | RawMessageReceived

export interface OutboundTextMessage {
  readonly conversationType: number
  readonly conversationID: string
  readonly text: string
  /** 逐消息 TTL 毫秒数（硬约束⑨：全部业务消息 72h = 259200000，由 KernelClient.sendText 注入）。 */
  readonly lifeTime: number
}

export interface FetchHistoryInput {
  readonly conversationType: number
  readonly conversationID: string
}

export interface Interface {
  readonly rawEvents: Stream.Stream<RawEvent>
  readonly sendMessage: (input: OutboundTextMessage) => Effect.Effect<{ readonly messageID: string }, KernelError>
  readonly fetchHistory: (input: FetchHistoryInput) => Effect.Effect<readonly unknown[], KernelError>
  readonly disconnect: Effect.Effect<void>
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
      const offer = (event: RawEvent) => {
        if (!Queue.offerUnsafe(queue, event)) log.error("kernel event queue full; dropping event", { tag: event.tag })
      }

      // shims 必须先于 SDK bundle 求值（SDK 在 import 时捕获浏览器全局）。
      yield* Effect.promise(() => import("./shims"))
      const JuggleIM = (yield* Effect.promise(() => import("jugglechat-websdk"))).default
      const im = JuggleIM.init({ appkey: config.appkey, navList: [config.navigator] })

      im.on(JuggleIM.Event.STATE_CHANGED, (event: { state?: unknown; code?: unknown }) => {
        if (typeof event?.state !== "number") return
        offer({
          tag: "state_changed",
          state: event.state,
          ...(typeof event.code === "number" ? { code: event.code } : {}),
        })
      })
      im.on(JuggleIM.Event.MESSAGE_RECEIVED, (payload: unknown) => {
        offer({ tag: "message_received", payload })
      })

      const connect = Effect.promise(() => im.connect({ token: config.token })).pipe(
        Effect.timeoutOrElse({
          duration: "20 seconds",
          orElse: () => Effect.fail(new KernelError({ operation: "connect", message: "kernel connect timed out" })),
        }),
        Effect.mapError((error) =>
          error instanceof KernelError ? error : new KernelError({ operation: "connect", message: describeError(error), cause: error }),
        ),
      )
      // 已连接后的断线由 SDK 自动重连（同一 token）；connect 本身的失败在这里有界重试。
      // token 过期（TTL 数小时）后的持续失败是 B2 exchange 刷新 token 的接缝。
      yield* connect.pipe(
        Effect.tapError((error) => Effect.sync(() => log.warn("kernel connect failed", { message: error.message }))),
        Effect.retry(Schedule.exponential("1 second").pipe(Schedule.both(Schedule.recurs(10)))),
        Effect.catch((error) => Effect.sync(() => log.error("kernel connect gave up", { message: error.message }))),
        Effect.forkScoped,
      )

      yield* Effect.addFinalizer(() => Effect.promise(() => im.disconnect()).pipe(Effect.ignore))

      const describe = (operation: string) => (error: unknown) =>
        new KernelError({ operation, message: describeError(error), cause: error })

      return Service.of({
        rawEvents: Stream.fromQueue(queue),
        sendMessage: (input) =>
          Effect.gen(function* () {
            // d.ts 把 Message.conversationType 错标成枚举对象类型（协议实际是 number），且漏标
            // lifeTime（上方 module augmentation 已补类型）——边界处一次性收窄转换。
            const ack = yield* Effect.promise(() =>
              im.sendMessage({
                conversationType: input.conversationType,
                conversationId: input.conversationID,
                name: JuggleIM.MessageType.TEXT,
                content: { content: input.text },
                lifeTime: input.lifeTime,
              } as unknown as Parameters<typeof im.sendMessage>[0]),
            ).pipe(Effect.mapError(describe("sendMessage")))
            const messageID = (ack as { messageId?: unknown }).messageId
            if (typeof messageID !== "string" || messageID.length === 0)
              return yield* new KernelError({ operation: "sendMessage", message: "kernel ack carried no messageId" })
            return { messageID }
          }),
        fetchHistory: (input) =>
          Effect.gen(function* () {
            const result = yield* Effect.promise(() =>
              im.getMessages({ conversationId: input.conversationID, conversationType: input.conversationType }),
            ).pipe(Effect.mapError(describe("fetchHistory")))
            return Array.isArray(result.messages) ? result.messages : []
          }),
        disconnect: Effect.promise(() => im.disconnect()).pipe(Effect.ignore),
      })
    }),
  )
