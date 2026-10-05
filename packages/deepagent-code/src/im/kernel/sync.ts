export * as IMKernelSync from "./sync"

import { realpath } from "node:fs/promises"
import { Cause, Context, Effect, Layer, Option, Queue, Ref, Schedule, Stream, SubscriptionRef } from "effect"
import { IMRepository } from "@deepagent-code/core/im/repository"
import type { IMPendingKernelMessage, IMRepositoryInterface } from "@deepagent-code/core/im/repository"
import { IMBroadcasterService } from "@deepagent-code/core/im/broadcaster"
import { MentionParser } from "@deepagent-code/core/im/mention-parser"
import { AgentListProviderService } from "@deepagent-code/core/im/agent-list-provider"
import { SessionV2 } from "@deepagent-code/core/session"
import * as Log from "@deepagent-code/core/util/log"
import { IMAgentExecution } from "@/im/im-agent-execution"
import { defaultMentionReceiptPort, resolveMentioned } from "@/session/event-dispatcher"
import { SERVER_USER_ID } from "@/server/routes/instance/httpapi/utils/workspace-context"
import { KernelClient } from "./client"
import { KernelSdk } from "./sdk"
import type { KernelConfig } from "./config"

// 内核↔本地同步引擎（design §2/§7：本地 sqlite 是消息权威存储，内核只做在线路由 + TTL 离线队列）。
//
//   收：KernelClient.messages → 回声/去重判断 → IMRepository 落库（kernel_msg_id = 去重身份，
//       unique index 兜底）→ IMBroadcaster 广播 message_created（现有 GUI/TUI 即时点亮）。
//   发：本地先落库（handlers/im.ts 或 im-reply-outbox）→ send() 入队 → 内核（带 72h TTL）
//       → ack 回写 kernel_msg_id；失败行保持 pending（kernel_msg_id IS NULL），drainPending
//       在连接恢复 + 每 30s 重投，内存计次封顶后死信（进程重启后恢复重试）。
//   补：连接建立时 hismsgs 拉最近一页兜底（WS sync 队列只覆盖近窗，72h 窗口靠它，design §9
//       双通道）；按 im_sync_cursors 游标向前分页留 follow-up。
//   B2：门面身份的组织全员群在引擎启动时幂等 provision（建群+绑定）；群内 `@我 @Agent` 触发
//       本地 durable admission（design §6，响应器默认关）。私聊会话 provision、文件消息、
//       已读回执留 follow-up。

const log = Log.create({ service: "im-kernel-sync" })

// im_groups.kernel_conv_id 的绑定键约定：`k:<channel_type>:<id>`
// （channel_type 1=私聊，id=对端 kernel userId；2=群聊，id=kernel groupId）。
export const kernelConvKey = (conversationType: 1 | 2, conversationID: string) =>
  `k:${conversationType}:${conversationID}`

export const parseKernelConvKey = (
  key: string,
): { readonly conversationType: 1 | 2; readonly conversationID: string } | undefined => {
  const match = /^k:([12]):(.+)$/.exec(key)
  if (!match) return undefined
  return { conversationType: Number(match[1]) as 1 | 2, conversationID: match[2] }
}

export interface SendInput {
  /** 目标群 id（本地）。群的 kernel 绑定由引擎解析；未绑定的群是纯本地会话，send 是 no-op。 */
  readonly groupID: string
  /** 本地已落库的消息 id——ack 回写与 pending 重投的身份。 */
  readonly messageID: string
  readonly content: string
}

interface QueuedSend {
  readonly kernelConvID: string
  readonly messageID: string
  readonly content: string
}

export interface Interface {
  /** 内核连接状态机（透传 KernelClient.state，给 B2 的 UI 指示器）。 */
  readonly state: SubscriptionRef.SubscriptionRef<KernelClient.ConnectionState>
  /** 尽力而为：入队即返回，永不失败——本地已落库的行是权威副本。 */
  readonly send: (input: SendInput) => Effect.Effect<void>
  /** pending（未 ack）本地行 → 内核 的一轮重投。连接恢复时、每 30s、测试显式驱动。 */
  readonly drainPending: Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/im/kernel/Sync") {}

const PENDING_DRAIN_LIMIT = 50
const SEND_MAX_ATTEMPTS = 8
const DRAIN_INTERVAL = "30 seconds"
// 与门面 service/imfacade 的 orgAllGroupName 常量对齐（组织全员群的显示名）。
const ORG_ALL_GROUP_NAME = "全员群"

export interface LayerOptions {
  /** 全员群 provision 与 agent 名册查询的本地 workspace 身份（前端按 directory 路由时的查询键）。
   *  缺省 DEEPAGENT_IM_WORKSPACE_ID ?? process.cwd()——单用户本地 server 的 cwd 即项目目录。 */
  readonly workspaceID?: string
  /** @Agent 响应器（design §6）：群内 `@我 @Agent <问题>` 触发本地 durable admission；私聊免 @我。
   *  默认关（防意外扣费）；env DEEPAGENT_IM_AGENT_RESPONDER=on 开启，工作目录缺省
   *  DEEPAGENT_IM_AGENT_RESPONDER_DIRECTORY ?? process.cwd()。离线不补跑。 */
  readonly responder?: {
    readonly enabled: boolean
    readonly directory: string
  }
}

const responderFromEnv = (): LayerOptions["responder"] => {
  if (process.env.DEEPAGENT_IM_AGENT_RESPONDER !== "on") return undefined
  return { enabled: true, directory: process.env.DEEPAGENT_IM_AGENT_RESPONDER_DIRECTORY ?? process.cwd() }
}

// macOS 的 /tmp 是指向 /private/tmp 的符号链接：InstanceState.directory 经 realpath 规范化，
// workspace 过滤与 agent inScope 判断都是字符串比较——env/选项传入的路径必须同样 canonicalize，
// 否则 /tmp/... 与 /private/tmp/... 失配（群查不到、responder 名册只剩内置 agent）。
// 路径不存在时保留原值（realpath 失败不阻塞引擎启动）。
const canonicalPath = (p: string) => Effect.tryPromise(() => realpath(p)).pipe(Effect.orElseSucceed(() => p))

// B2 全员群 provision：门面身份的组织全员群（内核 groupId = org<orgId>，认领时 facade 已把本身份
// 加入内核群）幂等镜像到本地群表并绑定内核会话。creator 坐本地操作者身份（listGroups 按
// membership 过滤——不坐进去本地 GUI 看不到这个群）；facade uuid 坐普通成员。
// 导出供 layer build 调用一次 + 测试直接驱动幂等重跑。任何失败只记日志（provision 是增强，
// 绝不阻塞引擎启动）；失败后入站 org 群消息按未绑定跳过并告警。
export const provisionOrgAllGroup = (
  repo: IMRepositoryInterface,
  identity: KernelConfig.Identity,
  workspaceID: string,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const convKey = kernelConvKey(2, identity.orgAllGroupID)
    const bound = yield* repo.getGroupByKernelConvID(convKey).pipe(
      Effect.tapError((error) =>
        Effect.sync(() => log.error("org all-group binding lookup failed", { convKey, message: error.message })),
      ),
      Effect.orElseSucceed(() => undefined),
    )
    if (bound) return
    yield* repo
      .createGroup({
        workspaceID,
        type: "project",
        name: ORG_ALL_GROUP_NAME,
        createdBy: SERVER_USER_ID,
        members: [{ memberID: identity.uuid, memberType: "user" }],
      })
      .pipe(
        Effect.flatMap((group) => repo.bindKernelConversation({ groupID: group.id, kernelConvID: convKey })),
        Effect.tap(() => Effect.sync(() => log.info("org all-group provisioned", { convKey, workspaceID }))),
        Effect.catch((error) =>
          Effect.sync(() =>
            log.error("org all-group provision failed; inbound org-group messages will be skipped", {
              convKey,
              message: error.message,
            }),
          ),
        ),
      )
  })

// 导出让测试注入假 KernelClient（layerFromConfig 固定焊死真 SDK；测试经此层提供假 client）。
export const layer = (config: KernelConfig.Info, options?: LayerOptions) => {
  const workspaceIDOption = options?.workspaceID ?? process.env.DEEPAGENT_IM_WORKSPACE_ID ?? process.cwd()
  const responderOption = options?.responder ?? responderFromEnv()
  return Layer.effect(
    Service,
    Effect.gen(function* () {
      const workspaceID = yield* canonicalPath(workspaceIDOption)
      const responder = responderOption
        ? { enabled: responderOption.enabled, directory: yield* canonicalPath(responderOption.directory) }
        : undefined
      const repo = yield* IMRepository
      const broadcaster = yield* IMBroadcasterService
      const client = yield* KernelClient.Service
      // 有界即背压（production-runtime-integrity 禁 unbounded）：满时 send 的 offer 挂起，
      // HTTP handler/outbox 等待 worker  drain——本地行已落库，等待不丢数据。
      const sendQueue = yield* Queue.bounded<QueuedSend>(1024)
      // 在投消息 id（即时发送与 drain 可能同时拣起同一条：ack 回写幂等，但内核会发重）。
      const inflight = yield* Ref.make<ReadonlySet<string>>(new Set())
      const attempts = yield* Ref.make<ReadonlyMap<string, number>>(new Map())

      // B2 @Agent 触发链的依赖：SessionV2 admission 与 agent 名册。生产 server 图里恒在；
      // 缺席（孤立嵌入/单测）⇒ 响应器强制关闭并响亮告警——入站落库主路径不受影响。
      const v2Session = Option.getOrUndefined(yield* Effect.serviceOption(SessionV2.Service))
      const agentListProvider = Option.getOrUndefined(yield* Effect.serviceOption(AgentListProviderService))
      const responderActive =
        responder?.enabled === true && v2Session !== undefined && agentListProvider !== undefined && config.identity !== undefined
      if (responder?.enabled && !responderActive)
        log.warn(
          "IM agent responder is on but cannot activate (needs facade identity + SessionV2 + AgentListProvider); @Agent triggers will not run",
        )

      // B2 全员群 provision（引擎启动一次，幂等——细节见 provisionOrgAllGroup）。
      if (config.identity) yield* provisionOrgAllGroup(repo, config.identity, workspaceID)

      // 返回是否拿到内核 ack；永不失败（false = 仍 pending，由 drain 计次重试）。
      const deliver = (input: QueuedSend): Effect.Effect<boolean> =>
        Effect.gen(function* () {
          const parsed = parseKernelConvKey(input.kernelConvID)
          if (!parsed) {
            log.error("malformed kernel conversation key; message cannot reach the kernel", {
              kernelConvID: input.kernelConvID,
              messageID: input.messageID,
            })
            return false
          }
          const acquired = yield* Ref.modify(inflight, (set) =>
            set.has(input.messageID) ? [false, set] : [true, new Set(set).add(input.messageID)],
          )
          // 另一条路径正在投递同一条——不算失败（避免 drain 误计次）。
          if (!acquired) return true
          return yield* deliverAcquired(input, parsed).pipe(
            Effect.ensuring(
              Ref.update(inflight, (set) => {
                const next = new Set(set)
                next.delete(input.messageID)
                return next
              }),
            ),
          )
        }).pipe(Effect.catch(() => Effect.succeed(false)))

      const deliverAcquired = (
        input: QueuedSend,
        parsed: { readonly conversationType: 1 | 2; readonly conversationID: string },
      ): Effect.Effect<boolean> =>
        Effect.gen(function* () {
          const ack = yield* client
            .sendText({
              conversationType: parsed.conversationType,
              conversationID: parsed.conversationID,
              text: input.content,
            })
            .pipe(
              Effect.tapError((error) =>
                Effect.sync(() =>
                  log.warn("kernel send failed; message stays pending", {
                    messageID: input.messageID,
                    message: error.message,
                  }),
                ),
              ),
              Effect.option,
            )
          if (Option.isNone(ack)) return false
          yield* repo
            .setMessageKernelMsgID({ messageID: input.messageID, kernelMsgID: ack.value.messageID })
            .pipe(
              Effect.catch((error) =>
                Effect.sync(() =>
                  log.error("kernel ack write-back failed", { messageID: input.messageID, message: error.message }),
                ),
              ),
            )
          return true
        })

      const advanceCursor = (convKey: string, msgTime: number) =>
        repo.upsertSyncCursor({ conversationID: convKey, lastSyncTime: msgTime }).pipe(
          Effect.catch((error) =>
            Effect.sync(() => log.error("sync cursor advance failed", { convKey, message: error.message })),
          ),
        )

      // B2 @Agent 触发链（design §6）：群内 `@我 @Agent <问题>` → 本地 durable admission（复用
      // im-agent-execution 的幂等准入：prompt id 由 (消息 id, agent) 派生，重放是 exact-retry
      // 空操作）。私聊免 @我（会话天然点对点）。非 dispatchable 的 mention 落本地 receipt——
      // receipt 不上内核，远程发送者不可见。整条链 best-effort：任何失败只记日志，绝不影响落库。
      const maybeAdmitMentions = (
        groupID: string,
        messageID: string,
        msg: KernelClient.KernelTextMessage,
      ): Effect.Effect<void> =>
        Effect.gen(function* () {
          if (!responderActive || !v2Session || !agentListProvider || !responder) return
          const self = config.identity
          if (!self) return
          // 群聊必须 @我（`@某人 @Agent` 的 `@某人` 半）；子串匹配是门槛，agent 名解析才是权威。
          if (msg.conversationType === 2 && !msg.text.toLowerCase().includes(`@${self.name.toLowerCase()}`)) return
          const names = MentionParser.parse(msg.text).filter((name) => name.toLowerCase() !== self.name.toLowerCase())
          if (names.length === 0) return
          const agents = yield* agentListProvider.listAgents({ workspaceID, userID: SERVER_USER_ID }).pipe(
            Effect.tapError((error) =>
              Effect.sync(() =>
                log.warn("kernel @Agent admission: agent registry unavailable; mention not admitted", {
                  message: error.message,
                }),
              ),
            ),
            Effect.option,
          )
          if (Option.isNone(agents)) return
          for (const mention of resolveMentioned(agents.value, names)) {
            // 与 handlers/im.ts 的准入链对齐：不可派发 ⇒ durable receipt；可派发 ⇒ agent_status
            // 广播 + 恰好一次 durable admission（终端回复经 im_reply_outbox 回到群里）。
            if (!mention.dispatchable || !mention.agent) {
              yield* defaultMentionReceiptPort.receipt({
                eventID: messageID,
                groupID,
                messageID,
                agentID: mention.agent?.id,
                agentNames: [mention.name],
                reason: mention.agent ? "agent_no_trigger_mention" : "no_declared_trigger",
              }).pipe(Effect.catch(() => Effect.void))
              continue
            }
            broadcaster.broadcast(groupID, {
              type: "agent_status",
              data: { messageID, agentID: mention.agent.id, status: "started" },
            })
            yield* IMAgentExecution.admitMention(v2Session, {
              groupID,
              messageID,
              agent: mention.agent.name,
              senderID: msg.senderID,
              content: msg.text,
              directory: responder.directory,
            }).pipe(
              Effect.catch((error) =>
                Effect.sync(() =>
                  log.error("kernel @Agent admission failed", {
                    messageID,
                    agent: mention.agent?.name,
                    message: error instanceof Error ? error.message : String(error),
                  }),
                ),
              ),
            )
          }
        })

      const handleInbound = (msg: KernelClient.KernelTextMessage) =>
        Effect.gen(function* () {
          if (msg.conversationType !== 1 && msg.conversationType !== 2) {
            log.warn("kernel message on an unsupported conversation type; skipped", {
              conversationType: msg.conversationType,
              messageID: msg.messageID,
            })
            return
          }
          const convKey = kernelConvKey(msg.conversationType, msg.conversationID)
          // 自己的回声（内核回推本机消息）：v1 无跨设备（约束⑦），本机消息已由本地发送路径落库，
          // 整条跳过（比 kernel_msg_id 命中已 ack 行更宽——ack 竞态下也不会写重）。
          if (msg.senderID === config.userID) return
          // at-least-once 去重：kernel_msg_id 的 unique index 是最终防线，这里先查一轮省一次写。
          if (yield* repo.getMessageByKernelMsgID(msg.messageID)) {
            yield* advanceCursor(convKey, msg.msgTime)
            return
          }
          const group = yield* repo.getGroupByKernelConvID(convKey)
          if (!group) {
            log.warn("kernel message for an unbound conversation; skipped (bindings are provisioned via the facade in B2)", {
              convKey,
              messageID: msg.messageID,
            })
            return
          }
          const message = yield* repo.createMessage({
            groupID: group.id,
            senderID: msg.senderID,
            senderType: "user",
            type: "text",
            content: msg.text,
            kernelMsgID: msg.messageID,
            createdAt: msg.msgTime,
          })
          broadcaster.broadcast(group.id, {
            type: "message_created",
            data: {
              id: message.id,
              groupID: message.groupID,
              senderID: message.senderID,
              senderType: message.senderType,
              messageType: message.type,
              content: message.content,
              mentions: message.mentions,
              metadata: message.metadata,
              replyToID: message.replyToID,
              createdAt: message.createdAt,
              updatedAt: message.updatedAt,
            },
          })
          yield* advanceCursor(convKey, msg.msgTime)
          yield* maybeAdmitMentions(group.id, message.id, msg)
        })

      const drainPending: Effect.Effect<void> = Effect.gen(function* () {
        if ((yield* SubscriptionRef.get(client.state)) !== "connected") return
        const pending = yield* repo.listPendingKernelMessages({ limit: PENDING_DRAIN_LIMIT }).pipe(
          Effect.tapError((error) =>
            Effect.sync(() => log.error("pending kernel message scan failed", { message: error.message })),
          ),
          Effect.orElseSucceed((): IMPendingKernelMessage[] => []),
        )
        for (const row of pending) {
          const tried = (yield* Ref.get(attempts)).get(row.message.id) ?? 0
          if (tried >= SEND_MAX_ATTEMPTS) continue
          const acked = yield* deliver({
            kernelConvID: row.kernelConvID,
            messageID: row.message.id,
            content: row.message.content,
          })
          if (acked) {
            yield* Ref.update(attempts, (map) => {
              const next = new Map(map)
              next.delete(row.message.id)
              return next
            })
            continue
          }
          const now = tried + 1
          yield* Ref.update(attempts, (map) => new Map(map).set(row.message.id, now))
          if (now >= SEND_MAX_ATTEMPTS)
            log.error("kernel send dead-lettered at the in-memory attempt cap (retried again after process restart)", {
              messageID: row.message.id,
              attempts: now,
            })
        }
      })

      // 离线补拉兜底（design §9 双通道）：WS sync 队列覆盖近窗（isSync 默认开，消息经
      // message_received 正常进 handleInbound）；hismsgs 拉 72h 窗口。B1 拉最近一页 +
      // 去重落库；按 im_sync_cursors 游标向前分页留 B2。
      const catchUp = Effect.gen(function* () {
        const groups = yield* repo.listKernelBoundGroups
        for (const group of groups) {
          if (!group.kernelConvID) continue
          const parsed = parseKernelConvKey(group.kernelConvID)
          if (!parsed) continue
          const history = yield* client.fetchHistory(parsed).pipe(
            Effect.tapError((error) =>
              Effect.sync(() =>
                log.warn("kernel history catch-up failed", { convKey: group.kernelConvID, message: error.message }),
              ),
            ),
            Effect.option,
          )
          if (Option.isNone(history)) continue
          for (const msg of history.value) {
            yield* handleInbound(msg).pipe(
              Effect.catchCause((cause) =>
                Effect.sync(() => log.error("catch-up inbound failed", { cause: Cause.pretty(cause) })),
              ),
            )
          }
        }
      })

      // 收消息主路径：内核 WS → 归一化 → 去重落库 → 广播。
      yield* Stream.runForEach(client.messages, (msg) =>
        handleInbound(msg).pipe(
          Effect.catchCause((cause) =>
            Effect.sync(() => log.error("inbound kernel message failed", { cause: Cause.pretty(cause) })),
          ),
        ),
      ).pipe(Effect.forkScoped)

      // 发送 worker：HTTP handler / reply outbox 入队的本地行 → 内核。
      yield* Stream.runForEach(Stream.fromQueue(sendQueue), (input) => deliver(input).pipe(Effect.asVoid)).pipe(
        Effect.forkScoped,
      )

      // 连接恢复：pending 重投 + hismsgs 兜底。
      yield* Stream.runForEach(SubscriptionRef.changes(client.state), (state) =>
        state === "connected"
          ? Effect.zip(drainPending, catchUp).pipe(
              Effect.catchCause((cause) =>
                Effect.sync(() => log.error("post-connect sync pass failed", { cause: Cause.pretty(cause) })),
              ),
            )
          : Effect.void,
      ).pipe(Effect.forkScoped)

      // 周期兜底：内核一直连着但某次发送失败的场景。
      yield* drainPending.pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => log.error("pending drain pass failed", { cause: Cause.pretty(cause) })),
        ),
        Effect.repeat(Schedule.spaced(DRAIN_INTERVAL)),
        Effect.forkScoped,
      )

      return Service.of({
        state: client.state,
        send: (input) =>
          Effect.gen(function* () {
            const group = yield* repo.getGroupByID(input.groupID).pipe(
              Effect.tapError((error) =>
                Effect.sync(() => log.error("kernel send group lookup failed", { groupID: input.groupID, message: error.message })),
              ),
              Effect.orElseSucceed(() => undefined),
            )
            // 未绑定内核会话的群是纯本地会话（如"我的 Agent"私聊，design §5）——no-op。
            if (!group?.kernelConvID) return
            yield* Queue.offer(sendQueue, {
              kernelConvID: group.kernelConvID,
              messageID: input.messageID,
              content: input.content,
            })
          }),
        drainPending,
      })
    }),
  )
}

export const layerFromConfig = (config: KernelConfig.Info, options?: LayerOptions) => {
  // 同一个 sdk layer 对象喂给 KernelClient——Effect 的 memoMap 按对象身份去重，复建会触发
  // KernelSdk 的进程单例防呆。
  const sdk = KernelSdk.liveFromConfig(config)
  return layer(config, options).pipe(Layer.provide(KernelClient.layer.pipe(Layer.provide(sdk))))
}
