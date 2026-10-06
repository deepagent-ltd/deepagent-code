export * as IMKernelSync from "./sync"

import { realpath } from "node:fs/promises"
import { Cause, Context, Effect, Layer, Option, Queue, Ref, Schedule, Semaphore, Stream, SubscriptionRef } from "effect"
import { IMRepository } from "@deepagent-code/core/im/repository"
import type {
  IMPendingKernelMessage,
  IMRepositoryInterface,
  LiveMentionContext,
} from "@deepagent-code/core/im/repository"
import { IMBroadcasterService } from "@deepagent-code/core/im/broadcaster"
import { MentionParser } from "@deepagent-code/core/im/mention-parser"
import { AgentListProviderService } from "@deepagent-code/core/im/agent-list-provider"
import { SessionV2 } from "@deepagent-code/core/session"
import * as Log from "@deepagent-code/core/util/log"
import { IMAgentExecution } from "@/im/im-agent-execution"
import { SERVER_USER_ID } from "@/server/routes/instance/httpapi/utils/workspace-context"
import { KernelClient } from "./client"
import { KernelSdk } from "./sdk"
import type { KernelConfig } from "./config"
import { IMKernelExchange } from "./exchange"

// 内核↔本地同步引擎（design §2/§7：本地 sqlite 是消息权威存储，内核只做在线路由 + TTL 离线队列）。
//
//   收：KernelClient.messages → 回声/去重判断 → IMRepository 落库（kernel_msg_id = 去重身份，
//       unique index 兜底）→ IMBroadcaster 广播 message_created（现有 GUI/TUI 即时点亮）。
//   发：本地先落库（handlers/im.ts 或 im-reply-outbox）→ send() 入队 → 内核（带 72h TTL）
//       → ack 回写 kernel_msg_id；失败行保持 pending（kernel_msg_id IS NULL），drainPending
//       在连接恢复 + 每 30s 重投，内存计次封顶后死信（进程重启后恢复重试）。
//   补：平台验证 SDK 会话列表后发现新私聊/群；hismsgs 显式正序分页，独立历史水位在落库后推进。
//       时间边界保留重叠，饱和页扩容到上限仍不前进则显式失败，避免跳过同毫秒消息。
//   @Agent 仅接受完成恢复后的新实时消息；历史与 SDK 延迟补推只同步本地视图。

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
  readonly recovery: SubscriptionRef.SubscriptionRef<RecoveryState>
  readonly catchUp: Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/im/kernel/Sync") {}

const PENDING_DRAIN_LIMIT = 50
const SEND_MAX_ATTEMPTS = 8
const DRAIN_INTERVAL = "30 seconds"
// 与门面 service/imfacade 的 orgAllGroupName 常量对齐（组织全员群的显示名）。
const ORG_ALL_GROUP_NAME = "全员群"
const HISTORY_PAGE_SIZE = 100
const MAX_HISTORY_PAGE_SIZE = 12_800
export const historyCursorKey = (convKey: string) => `history:v2:${convKey}`

export interface RecoveryState {
  readonly status: "pending" | "ready" | "failed"
  readonly message?: string
}

export interface LayerOptions {
  readonly inspectConversation?: (
    input: IMKernelExchange.InspectConversationInput,
  ) => Effect.Effect<IMKernelExchange.InspectConversationPayload, IMKernelExchange.ExchangeError>

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
// 导出供 layer build 调用一次 + 测试直接驱动幂等重跑。失败由后续可信发现重试。
export const provisionOrgAllGroup = (
  repo: IMRepositoryInterface,
  identity: KernelConfig.Identity,
  workspaceID: string,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const convKey = kernelConvKey(2, identity.orgAllGroupID)
    yield* repo
      .ensureKernelGroup({
        workspaceID,
        type: "project",
        name: ORG_ALL_GROUP_NAME,
        createdBy: SERVER_USER_ID,
        kernelConvID: convKey,
        members: [{ memberID: identity.uuid, memberType: "user" }],
      })
      .pipe(
        Effect.catch((error) =>
          Effect.sync(() =>
            log.error("org all-group provision failed; conversation discovery will retry", {
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
      const inboundLock = yield* Semaphore.make(1)
      const recoveryLock = yield* Semaphore.make(1)
      const recovery = yield* SubscriptionRef.make<RecoveryState>({ status: "pending" })
      const replayBefore = yield* Ref.make(0)

      const ensureConversation = (input: IMKernelExchange.InspectConversationInput) =>
        Effect.gen(function* () {
          const convKey = kernelConvKey(input.conversationType, input.conversationID)
          if (!options?.inspectConversation) {
            if (config.identity)
              return yield* new KernelSdk.KernelError({
                operation: "inspectConversation",
                message: "Facade conversation verification is unavailable",
              })
            return yield* repo.getGroupByKernelConvID(convKey)
          }
          const verified = yield* options.inspectConversation(input)
          if (
            verified.conversation_type !== input.conversationType ||
            verified.conversation_id !== input.conversationID ||
            verified.org_id !== config.identity?.orgID ||
            !verified.member_uuids.includes(config.userID) ||
            (input.senderID && !verified.member_uuids.includes(input.senderID)) ||
            (input.conversationType === 1 &&
              (!verified.member_uuids.includes(input.conversationID) ||
                (input.senderID && input.senderID !== input.conversationID && input.senderID !== config.userID)))
          )
            return yield* new KernelSdk.KernelError({
              operation: "inspectConversation",
              message: "Platform conversation proof does not match the requested identity or members",
            })
          const group = yield* repo.ensureKernelGroup({
            workspaceID,
            type: input.conversationType === 1 ? "direct" : "project",
            name: verified.name,
            createdBy: SERVER_USER_ID,
            kernelConvID: convKey,
            members: verified.member_uuids
              .filter((uuid) => input.conversationType === 2 || uuid !== config.userID)
              .map((uuid) => ({ memberID: uuid, memberType: "user" as const })),
          })
          return group
        })

      // B2 @Agent 触发链的依赖：SessionV2 admission 与 agent 名册。生产 server 图里恒在；
      // 缺席（孤立嵌入/单测）⇒ 响应器强制关闭并响亮告警——入站落库主路径不受影响。
      const v2Session = Option.getOrUndefined(yield* Effect.serviceOption(SessionV2.Service))
      const agentListProvider = Option.getOrUndefined(yield* Effect.serviceOption(AgentListProviderService))
      const responderActive =
        responder?.enabled === true &&
        v2Session !== undefined &&
        agentListProvider !== undefined &&
        config.identity !== undefined
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
        repo
          .upsertSyncCursor({ conversationID: convKey, lastSyncTime: msgTime })
          .pipe(
            Effect.catch((error) =>
              Effect.sync(() => log.error("sync cursor advance failed", { convKey, message: error.message })),
            ),
          )

      const liveIntentFor = (msg: KernelClient.KernelTextMessage): LiveMentionContext | undefined => {
        if (!responderActive || !v2Session || !agentListProvider || !responder || !config.identity) return
        const names = MentionParser.parse(msg.text)
        const ownName = config.identity.name.toLowerCase()
        if (msg.conversationType === 2 && !names.some((name) => name.toLowerCase() === ownName)) return
        const targets = names.filter((name) => name.toLowerCase() !== ownName)
        if (targets.length === 0) return
        return {
          names: targets,
          directory: responder.directory,
          workspaceID,
          userID: SERVER_USER_ID,
          origin: "kernel_live",
          receiverID: config.identity.uuid,
          conversationType: msg.conversationType,
          conversationID: msg.conversationID,
        }
      }
      const reconcileMentions = Effect.gen(function* () {
        if (!responderActive || !v2Session || !agentListProvider || !responder || !config.identity) return
        yield* IMAgentExecution.reconcileMentions({
          repo,
          v2Session,
          agents: agentListProvider,
          broadcaster,
          origin: "kernel_live",
          receiverID: config.identity.uuid,
          authorize: (intent) =>
            Effect.gen(function* () {
              if (
                intent.directory !== responder.directory ||
                intent.workspace_id !== workspaceID ||
                !intent.conversation_id ||
                (intent.conversation_type !== 1 && intent.conversation_type !== 2)
              )
                return yield* Effect.fail(new Error("IM intent routing changed"))
              const group = yield* ensureConversation({
                conversationType: intent.conversation_type,
                conversationID: intent.conversation_id,
                senderID: intent.message.senderID,
              })
              if (group?.id !== intent.message.groupID) return yield* Effect.fail(new Error("IM membership changed"))
            }),
        })
      })

      const handleInbound = (msg: KernelClient.KernelTextMessage, origin: "live" | "history" | "unverified") =>
        inboundLock.withPermits(1)(
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
            const existing = yield* repo.getMessageByKernelMsgID(msg.messageID)
            if (existing) {
              yield* advanceCursor(convKey, msg.msgTime)
              // A periodic history poll may beat the live websocket delivery. Only rows explicitly
              // observed while already online may reconcile that later live notification.
              if (
                origin === "live" &&
                existing.metadata &&
                typeof existing.metadata === "object" &&
                "type" in existing.metadata &&
                existing.metadata.type === "kernel_sync" &&
                "liveEligible" in existing.metadata &&
                existing.metadata.liveEligible === true &&
                existing.senderID === msg.senderID &&
                existing.content === msg.text &&
                existing.createdAt === msg.msgTime
              ) {
                const group = yield* ensureConversation({
                  conversationType: msg.conversationType,
                  conversationID: msg.conversationID,
                  senderID: existing.senderID,
                })
                if (
                  group?.id === existing.groupID &&
                  (yield* SubscriptionRef.get(recovery)).status === "ready" &&
                  (yield* SubscriptionRef.get(client.state)) === "connected" &&
                  msg.msgTime > (yield* Ref.get(replayBefore))
                ) {
                  yield* repo.createMessage({
                    id: existing.id,
                    groupID: existing.groupID,
                    senderID: existing.senderID,
                    senderType: "user",
                    type: "text",
                    content: existing.content,
                    kernelMsgID: msg.messageID,
                    createdAt: existing.createdAt,
                    metadata: { type: "kernel_sync", liveEligible: true },
                    mentionIntent: liveIntentFor(msg),
                  })
                  yield* reconcileMentions
                }
              }
              return
            }
            const group = yield* ensureConversation({
              conversationType: msg.conversationType,
              conversationID: msg.conversationID,
              senderID: msg.senderID,
            })
            if (!group) {
              log.warn("kernel conversation is not verified or bound", {
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
              mentionIntent: origin === "live" ? liveIntentFor(msg) : undefined,
              metadata:
                origin === "history" && (yield* SubscriptionRef.get(recovery)).status === "ready"
                  ? { type: "kernel_sync", liveEligible: true }
                  : origin === "unverified" && liveIntentFor(msg)
                    ? {
                        type: "error",
                        code: "IM_EXECUTION_NOT_ADMITTED",
                        message:
                          "This mention was not executed because realtime delivery could not be verified during recovery. Send a new request after recovery.",
                        retryable: false,
                      }
                    : undefined,
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
            if (
              origin === "live" &&
              (yield* SubscriptionRef.get(recovery)).status === "ready" &&
              (yield* SubscriptionRef.get(client.state)) === "connected" &&
              msg.msgTime > (yield* Ref.get(replayBefore))
            )
              yield* reconcileMentions
          }),
        )

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
            content:
              row.message.senderType === "agent"
                ? `[Agent·${row.message.senderID}] ${row.message.content}`
                : row.message.content,
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

      // SDK cursors are strict timestamps, not message IDs. Keep the last millisecond open and
      // enlarge a saturated boundary page; advancing past that boundary would silently lose ties.
      const catchUpConversation = (group: { kernelConvID: string | null }, recovering: boolean) =>
        Effect.gen(function* () {
          if (!group.kernelConvID) return
          const parsed = parseKernelConvKey(group.kernelConvID)
          if (!parsed) return
          const cursorKey = historyCursorKey(group.kernelConvID)
          const cursor = yield* repo.getSyncCursor(cursorKey)
          const progress = { after: cursor?.lastSyncTime ?? 0, count: HISTORY_PAGE_SIZE }
          for (let pageNumber = 0; pageNumber < 1_000; pageNumber++) {
            const page = yield* client.fetchHistory({ ...parsed, ...progress })
            for (const msg of page.messages) {
              if (msg.conversationType !== parsed.conversationType || msg.conversationID !== parsed.conversationID)
                return yield* new KernelSdk.KernelError({
                  operation: "fetchHistory",
                  message: "History page crossed a conversation boundary",
                })
              yield* handleInbound(msg, "history")
            }
            if (recovering) yield* Ref.update(replayBefore, (time) => Math.max(time, page.latestTime))
            const next = Math.max(progress.after, page.latestTime - 1)
            // This checkpoint belongs only to fully persisted history pages, never realtime traffic.
            yield* repo.upsertSyncCursor({ conversationID: cursorKey, lastSyncTime: next })
            if (page.isFinished) return
            if (next <= progress.after) {
              if (progress.count >= MAX_HISTORY_PAGE_SIZE)
                return yield* new KernelSdk.KernelError({
                  operation: "fetchHistory",
                  message: "History timestamp boundary exceeds the page limit; cursor retained for retry",
                })
              progress.count *= 2
              continue
            }
            progress.after = next
            progress.count = HISTORY_PAGE_SIZE
          }
          return yield* new KernelSdk.KernelError({
            operation: "fetchHistory",
            message: "History pass exceeded its page budget; cursor retained for retry",
          })
        })

      const catchUp = recoveryLock.withPermits(1)(
        Effect.gen(function* () {
          const recovering = (yield* SubscriptionRef.get(recovery)).status !== "ready"
          if (recovering) yield* SubscriptionRef.set(recovery, { status: "pending" })
          // getConversations discovers first DMs and invited groups even when the local database has
          // no binding yet. The list supplies hints only; the facade verifies each hint independently.
          if (options?.inspectConversation) {
            const progress = { before: Number.MAX_SAFE_INTEGER, count: HISTORY_PAGE_SIZE }
            for (let pageNumber = 0; pageNumber < 1_000; pageNumber++) {
              const page = yield* client.fetchConversations(progress)
              for (const conversation of page.conversations) {
                if (recovering) yield* Ref.update(replayBefore, (time) => Math.max(time, conversation.sortTime))
                if (conversation.conversationType !== 1 && conversation.conversationType !== 2) continue
                yield* ensureConversation({
                  conversationType: conversation.conversationType,
                  conversationID: conversation.conversationID,
                })
              }
              if (page.isFinished) break
              if (pageNumber === 999)
                return yield* new KernelSdk.KernelError({
                  operation: "fetchConversations",
                  message: "Conversation discovery exceeded its page budget",
                })
              const next = Math.min(progress.before, ...page.conversations.map((item) => item.sortTime + 1))
              if (next >= progress.before) {
                if (progress.count >= MAX_HISTORY_PAGE_SIZE)
                  return yield* new KernelSdk.KernelError({
                    operation: "fetchConversations",
                    message: "Conversation timestamp boundary exceeds the page limit",
                  })
                progress.count *= 2
                continue
              }
              progress.before = next
              progress.count = HISTORY_PAGE_SIZE
            }
          }
          for (const group of yield* repo.listKernelBoundGroups) yield* catchUpConversation(group, recovering)
          yield* SubscriptionRef.set(recovery, { status: "ready" })
          yield* reconcileMentions
        }).pipe(
          Effect.catchCause((cause) => {
            const error = Cause.squash(cause)
            log.error("kernel recovery failed; Agent admission stays disabled until retry", {
              code:
                error instanceof IMKernelExchange.ExchangeError
                  ? error.code
                  : error instanceof KernelSdk.KernelError
                    ? error.operation
                    : "unexpected_failure",
            })
            return SubscriptionRef.set(recovery, {
              status: "failed",
              message:
                "IM history synchronization failed. Retry after the connection and conversation permissions recover.",
            })
          }),
        ),
      )

      // 收消息主路径：内核 WS → 归一化 → 去重落库 → 广播。
      yield* Stream.runForEach(client.messages, (msg) =>
        Effect.gen(function* () {
          const ready =
            (yield* SubscriptionRef.get(recovery)).status === "ready" &&
            (yield* SubscriptionRef.get(client.state)) === "connected"
          const origin = ready && msg.msgTime > (yield* Ref.get(replayBefore)) ? "live" : "unverified"
          yield* handleInbound(msg, origin)
        }).pipe(
          Effect.catchCause((cause) => {
            const error = Cause.squash(cause)
            log.error("inbound kernel message failed; history recovery will retry", {
              code:
                error instanceof IMKernelExchange.ExchangeError
                  ? error.code
                  : error instanceof KernelSdk.KernelError
                    ? error.operation
                    : "unexpected_failure",
            })
            return SubscriptionRef.set(recovery, {
              status: "failed",
              message:
                "IM history synchronization failed. Retry after the connection and conversation permissions recover.",
            })
          }),
        ),
      ).pipe(Effect.forkScoped)

      // 发送 worker：HTTP handler / reply outbox 入队的本地行 → 内核。
      yield* Stream.runForEach(Stream.fromQueue(sendQueue), (input) => deliver(input).pipe(Effect.asVoid)).pipe(
        Effect.forkScoped,
      )

      // 连接恢复：pending 重投 + hismsgs 兜底。
      yield* Stream.runForEach(SubscriptionRef.changes(client.state), (state) =>
        state === "connected"
          ? SubscriptionRef.set(recovery, { status: "pending" }).pipe(
              Effect.andThen(Effect.zip(drainPending, catchUp)),
              Effect.catchCause((cause) =>
                Effect.sync(() => log.error("post-connect sync pass failed", { cause: Cause.pretty(cause) })),
              ),
            )
          : SubscriptionRef.set(recovery, { status: "pending" }),
      ).pipe(Effect.forkScoped)

      // 周期兜底：内核一直连着但某次发送失败的场景。
      yield* Effect.zip(
        drainPending,
        Effect.gen(function* () {
          if ((yield* SubscriptionRef.get(client.state)) === "connected") {
            yield* catchUp
          }
        }),
      ).pipe(
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
                Effect.sync(() =>
                  log.error("kernel send group lookup failed", { groupID: input.groupID, message: error.message }),
                ),
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
        recovery,
        catchUp,
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
