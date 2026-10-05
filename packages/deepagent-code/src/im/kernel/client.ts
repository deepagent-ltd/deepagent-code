export * as KernelClient from "./client"

import { Cause, Context, Effect, Layer, PubSub, Schema, Stream, SubscriptionRef } from "effect"
import * as Log from "@deepagent-code/core/util/log"
import { KernelSdk } from "./sdk"

// 内核客户端封装：连接状态机 + 文本消息归一化 + 带 TTL 的发送。架构（design §2）：
// 内核只做在线路由 + TTL 离线队列，本地 sqlite 是消息权威存储；本服务是内核 WS 的单一口，
// 同步引擎（sync.ts）消费 messages 落库，发送路径经 sendText 上内核。

// 硬约束⑨：全部业务消息 life_time = 72h（毫秒）。与内核 app 配置 his_msg_save_day=3 配套成双轨。
export const MESSAGE_TTL_MS = 259_200_000

export const ConnectionState = Schema.Literals(["connecting", "connected", "disconnected", "failed"])
export type ConnectionState = Schema.Schema.Type<typeof ConnectionState>

export interface KernelTextMessage {
  readonly messageID: string
  /** 1 = 私聊（conversationID 是对端 kernel userId），2 = 群聊（kernel groupId）。 */
  readonly conversationType: number
  readonly conversationID: string
  readonly senderID: string
  readonly text: string
  /** 内核侧发送时刻（ms），本地落库的权威 createdAt。 */
  readonly msgTime: number
}

export interface SendTextInput {
  readonly conversationType: number
  readonly conversationID: string
  readonly text: string
}

export interface Interface {
  /** 连接状态机——UI 经它观察内核链路（B2 的连接状态指示器的数据源）。 */
  readonly state: SubscriptionRef.SubscriptionRef<ConnectionState>
  /** 归一化后的入站文本消息流（jg:text 以外、字段不全的载荷已在此丢弃）。 */
  readonly messages: Stream.Stream<KernelTextMessage>
  /** ack 后 resolve 出内核 messageId；失败（含 15s ack 超时）为 KernelError。 */
  readonly sendText: (input: SendTextInput) => Effect.Effect<{ readonly messageID: string }, KernelSdk.KernelError>
  /** hismsgs 历史拉取（离线补拉兜底通道），结果过同一条归一化。 */
  readonly fetchHistory: (input: KernelSdk.FetchHistoryInput) => Effect.Effect<KernelTextMessage[], KernelSdk.KernelError>
  readonly disconnect: Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/im/kernel/Client") {}

const log = Log.create({ service: "im-kernel-client" })

// jugglechat-websdk ConnectionState 数值（d.ts CONNECT_STATE；PoC 实测 0/1/2）。
const mapState = (state: number): ConnectionState | undefined => {
  if (state === 0) return "connected"
  if (state === 1 || state === 6) return "connecting" // CONNECTING / RECONNECTING
  if (state === 2) return "disconnected"
  if (state === 3) return "failed" // CONNECT_FAILED
  return undefined // DB_OPENED / DB_CLOSED 与链路状态无关
}

// 原生载荷 → KernelTextMessage。B1 只承载 jg:text（发图发文件的 document/Image shim 是 V2 的事）。
// 导出给同步引擎的 hismsgs 补拉复用——WS 推送与历史拉取走同一条归一化。
export const normalizeTextMessage = (payload: unknown): KernelTextMessage | undefined => {
  if (typeof payload !== "object" || payload === null) return undefined
  const msg = payload as Record<string, unknown>
  if (msg.name !== "jg:text") return undefined
  const content = msg.content
  const text =
    typeof content === "object" && content !== null ? (content as Record<string, unknown>).content : undefined
  if (typeof text !== "string") return undefined
  const sender = typeof msg.sender === "object" && msg.sender !== null ? (msg.sender as Record<string, unknown>) : undefined
  if (
    typeof msg.messageId !== "string" ||
    typeof msg.conversationId !== "string" ||
    typeof msg.conversationType !== "number" ||
    typeof sender?.id !== "string"
  )
    return undefined
  return {
    messageID: msg.messageId,
    conversationType: msg.conversationType,
    conversationID: msg.conversationId,
    senderID: sender.id,
    text,
    msgTime: typeof msg.sentTime === "number" ? msg.sentTime : Date.now(),
  }
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sdk = yield* KernelSdk.Service
    const state = yield* SubscriptionRef.make<ConnectionState>("connecting")
    const pubsub = yield* PubSub.bounded<KernelTextMessage>(1024)

    const onRawEvent = (event: KernelSdk.RawEvent) => {
      if (event.tag === "state_changed") {
        const mapped = mapState(event.state)
        return mapped ? SubscriptionRef.set(state, mapped) : Effect.void
      }
      const msg = normalizeTextMessage(event.payload)
      if (!msg) return Effect.void
      return PubSub.publish(pubsub, msg).pipe(Effect.asVoid)
    }

    yield* Stream.runForEach(sdk.rawEvents, (event) =>
      onRawEvent(event).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => log.error("kernel event handling failed", { cause: Cause.pretty(cause) })),
        ),
      ),
    ).pipe(Effect.forkScoped)

    return Service.of({
      state,
      messages: Stream.fromPubSub(pubsub),
      sendText: (input) =>
        sdk.sendMessage({ ...input, lifeTime: MESSAGE_TTL_MS }).pipe(
          Effect.timeoutOrElse({
            duration: "15 seconds",
            orElse: () =>
              Effect.fail(new KernelSdk.KernelError({ operation: "sendText", message: "kernel ack timed out (15s)" })),
          }),
        ),
      fetchHistory: (input) =>
        sdk.fetchHistory(input).pipe(
          Effect.map((payloads) =>
            payloads.flatMap((payload) => {
              const msg = normalizeTextMessage(payload)
              return msg ? [msg] : []
            }),
          ),
        ),
      disconnect: sdk.disconnect,
    })
  }),
)
