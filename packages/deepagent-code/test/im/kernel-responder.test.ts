import { beforeEach, describe, expect } from "bun:test"
import { Effect, Layer, PubSub, Stream, SubscriptionRef } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@deepagent-code/core/database/database"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { Git } from "@deepagent-code/core/git"
import { EventV2 } from "@deepagent-code/core/event"
import { ProjectV2 } from "@deepagent-code/core/project"
import { SessionV2 } from "@deepagent-code/core/session"
import { SessionExecution } from "@deepagent-code/core/session/execution"
import { SessionProjector } from "@deepagent-code/core/session/projector"
import { SessionStore } from "@deepagent-code/core/session/store"
import { SessionInputTable } from "@deepagent-code/core/session/sql"
import { IMRepository, IMRepositoryLive } from "@deepagent-code/core/im/repository"
import { IMBroadcasterService } from "@deepagent-code/core/im/broadcaster"
import type { IMBroadcaster } from "@deepagent-code/core/im/websocket"
import { AgentListProviderService } from "@deepagent-code/core/im/agent-list-provider"
import type { AgentQueryScope } from "@deepagent-code/core/im/agent-list-provider"
import type { AgentDescriptor } from "@deepagent-code/core/im/mention-parser"
import { KernelClient } from "@/im/kernel/client"
import { IMKernelSync } from "@/im/kernel/sync"
import { IMAgentExecution } from "@/im/im-agent-execution"
import type { KernelConfig } from "@/im/kernel/config"
import { pollWithTimeout, testEffect } from "../lib/effect"

// B2 @Agent 触发链（design §6）：内核入站消息落库后，群内 `@我 @Agent <问题>` 经与 handlers 同套
// 准入（resolveMentioned → 恰好一次 durable admission；不可派发 ⇒ 本地 receipt）。真 :memory:
// DB + 真 repo + 真 SessionV2（noop execution——admission 是 durable 行，唤醒无需 drain）+
// 假 KernelClient + stub 名册（general 声明 mention 触发器、quiet 未声明）。
// 门：响应器默认关；群聊必须 @我（alice）；私聊免 @我；门面身份缺席不触发。

const config: KernelConfig.Info = {
  appkey: "test-appkey",
  navigator: "http://127.0.0.1:9",
  token: "test-token",
  userID: "uuid-alice",
  identity: { uuid: "uuid-alice", name: "alice", orgAllGroupID: "org7", orgID: 7 },
}

const roster: AgentDescriptor[] = [
  { id: "general", name: "general", displayName: "General", visible: true, triggers: [{ event: "mention" }] },
  // 未声明 triggers 的 agent 按 W0.4 默认可 mention——不可派发必须显式声明非 mention 触发器。
  { id: "quiet", name: "quiet", displayName: "Quiet", visible: true, triggers: [{ event: "ci.failure" }] },
]

let clientState: SubscriptionRef.SubscriptionRef<KernelClient.ConnectionState>
let publishInbound: (msg: KernelClient.KernelTextMessage) => Effect.Effect<void>
let broadcasts: Array<{ groupID: string; type: string; data?: unknown }>
let historyMessages: KernelClient.KernelTextMessage[]
let listScopes: AgentQueryScope[]

const broadcaster: IMBroadcaster = {
  broadcast: (groupID, event) => {
    broadcasts.push({ groupID, type: event.type, data: (event as { data?: unknown }).data })
  },
  sendToUser: () => {},
  register: () => true,
  unregister: () => {},
  getConnectionCount: () => 0,
  getUserConnectionCount: () => 0,
}

const fakeClient = Layer.unwrap(
  Effect.gen(function* () {
    const state = yield* SubscriptionRef.make<KernelClient.ConnectionState>("connected")
    const pubsub = yield* PubSub.bounded<KernelClient.KernelTextMessage>(16)
    clientState = state
    publishInbound = (msg) => PubSub.publish(pubsub, msg).pipe(Effect.asVoid)
    return Layer.succeed(
      KernelClient.Service,
      KernelClient.Service.of({
        state,
        messages: Stream.fromPubSub(pubsub),
        sendText: () => Effect.succeed({ messageID: "km_ack_1" }),
        fetchHistory: () =>
          Effect.sync(() => ({
            messages: historyMessages,
            isFinished: true,
            latestTime: Math.max(0, ...historyMessages.map((message) => message.msgTime)),
          })),
        fetchConversations: () => Effect.succeed({ conversations: [], isFinished: true }),
        disconnect: Effect.void,
      }),
    )
  }),
)

const agentProviders = Layer.mock(AgentListProviderService, {
  listAgents: (input) =>
    Effect.sync(() => {
      listScopes.push(input)
      return roster
    }),
})

const database = Database.layerFromPath(":memory:")
const events = EventV2.layer.pipe(Layer.provide(database))
const projector = SessionProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
const store = SessionStore.layer.pipe(Layer.provide(database))
const projects = ProjectV2.layer.pipe(
  Layer.provide(database),
  Layer.provide(FSUtil.defaultLayer),
  Layer.provide(Git.defaultLayer),
)
const v2Session = SessionV2.layer.pipe(
  Layer.provide(SessionExecution.noopLayer),
  Layer.provide(store),
  Layer.provide(projector),
  Layer.provide(events),
  Layer.provide(database),
  Layer.provide(projects),
  Layer.orDie,
)
const repo = IMRepositoryLive.pipe(Layer.provide(database))
const inspectConversation = (input: { conversationType: 1 | 2; conversationID: string; senderID?: string }) =>
  Effect.succeed({
    conversation_type: input.conversationType,
    conversation_id: input.conversationID,
    name: input.conversationID,
    member_uuids: ["uuid-alice", "uuid-bob"],
    org_id: 7,
  })

const syncLayer = IMKernelSync.layer(config, {
  workspaceID: "ws",
  inspectConversation,
  responder: { enabled: true, directory: "/tmp" },
}).pipe(
  Layer.provide(repo),
  Layer.provide(Layer.succeed(IMBroadcasterService, broadcaster)),
  Layer.provide(fakeClient),
  Layer.provide(v2Session),
  Layer.provide(agentProviders),
)

const it = testEffect(Layer.mergeAll(database, events, projector, store, projects, v2Session, repo, syncLayer))

beforeEach(() => {
  broadcasts = []
  listScopes = []
  historyMessages = []
})

const orgGroup = Effect.gen(function* () {
  const repoSvc = yield* IMRepository
  const group = yield* repoSvc.getGroupByKernelConvID("k:2:org7")
  if (!group) return yield* Effect.die(new Error("org all-group was not provisioned"))
  return group
})

const inbound = (overrides: Partial<KernelClient.KernelTextMessage> = {}): KernelClient.KernelTextMessage => ({
  messageID: "km_in_1",
  conversationType: 2,
  conversationID: "org7",
  senderID: "uuid-bob",
  text: "@alice @general 你好",
  msgTime: 1_700_000_000_000,
  ...overrides,
})

const inputCount = (sessionID: SessionV2.ID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    return (yield* db
      .select({ id: SessionInputTable.id })
      .from(SessionInputTable)
      .where(eq(SessionInputTable.session_id, sessionID))
      .all()
      .pipe(Effect.orDie)).length
  })

const kernelLanded = (kernelMsgID: string) =>
  Effect.gen(function* () {
    const repoSvc = yield* IMRepository
    return (yield* repoSvc.getMessageByKernelMsgID(kernelMsgID)) ?? undefined
  })

const publishUntilAdmitted = (msg: KernelClient.KernelTextMessage, sessionID: SessionV2.ID, expected: number) =>
  Effect.gen(function* () {
    const sync = yield* IMKernelSync.Service
    yield* sync.catchUp
    yield* pollWithTimeout(
      Effect.gen(function* () {
        yield* publishInbound(msg)
        return (yield* inputCount(sessionID)) >= expected ? (true as const) : undefined
      }),
      `mention ${msg.messageID} never admitted`,
    )
  })

describe("IMKernelSync @Agent responder (B2)", () => {
  it.live("group message `@我 @Agent …` admits exactly one durable input on the stable (group, agent) session", () =>
    Effect.gen(function* () {
      const group = yield* orgGroup
      const sessionID = IMAgentExecution.imSessionIDFor(group.id, "general")
      yield* publishUntilAdmitted(inbound(), sessionID, 1)

      const v2 = yield* SessionV2.Service
      const info = yield* v2.get(sessionID)
      expect(IMAgentExecution.imSessionMetadata(info)).toEqual({ groupID: group.id, agent: "general" })
      expect(broadcasts).toContainEqual({
        groupID: group.id,
        type: "agent_status",
        data: { messageID: (yield* kernelLanded("km_in_1"))!.id, agentID: "general", status: "started" },
      })
      expect(listScopes).toContainEqual({ workspaceID: "ws", userID: "server" })
      // 幂等：同一内核消息重投在去重层短路，不会二次准入。
      yield* publishInbound(inbound({ msgTime: 1_700_000_005_000 }))
      yield* pollWithTimeout(
        Effect.gen(function* () {
          const repoSvc = yield* IMRepository
          const cursor = yield* repoSvc.getSyncCursor("k:2:org7")
          return cursor && cursor.lastSyncTime >= 1_700_000_005_000 ? (true as const) : undefined
        }),
        "cursor never advanced past the redelivery",
      )
      expect(yield* inputCount(sessionID)).toBe(1)
    }),
  )

  it.live("gates: group messages without @我 or without an agent mention never admit", () =>
    Effect.gen(function* () {
      const group = yield* orgGroup
      const sessionID = IMAgentExecution.imSessionIDFor(group.id, "general")
      // 引擎按序处理（同一 PubSub 队列）：后一条准入消息落地时，前面的被门消息已处理完。
      yield* publishUntilAdmitted(inbound({ messageID: "km_gate_warm", text: "@alice @general warm" }), sessionID, 1)
      yield* publishInbound(inbound({ messageID: "km_gate_nome", text: "@general 没@我" }))
      yield* publishInbound(inbound({ messageID: "km_gate_noagent", text: "@alice 没@agent" }))
      yield* publishUntilAdmitted(
        inbound({ messageID: "km_gate_marker", text: "@alice @general marker" }),
        sessionID,
        2,
      )
      expect(yield* inputCount(sessionID)).toBe(2)
    }),
  )

  it.live("direct conversations admit without the @我 half (the conversation is inherently addressed)", () =>
    Effect.gen(function* () {
      const repoSvc = yield* IMRepository
      const group = yield* repoSvc.createGroup({ workspaceID: "ws", type: "project", name: "dm", createdBy: "server" })
      yield* repoSvc.bindKernelConversation({ groupID: group.id, kernelConvID: "k:1:uuid-bob" })
      const sessionID = IMAgentExecution.imSessionIDFor(group.id, "general")
      yield* publishUntilAdmitted(
        inbound({ messageID: "km_dm_1", conversationType: 1, conversationID: "uuid-bob", text: "@general hi" }),
        sessionID,
        1,
      )
      const v2 = yield* SessionV2.Service
      expect(IMAgentExecution.imSessionMetadata(yield* v2.get(sessionID))).toEqual({
        groupID: group.id,
        agent: "general",
      })
    }),
  )

  it.live("an undispatchable mention lands a local receipt instead of an admission", () =>
    Effect.gen(function* () {
      const sync = yield* IMKernelSync.Service
      yield* sync.catchUp
      const group = yield* orgGroup
      const sessionID = IMAgentExecution.imSessionIDFor(group.id, "quiet")
      const receipt = yield* pollWithTimeout(
        Effect.gen(function* () {
          yield* publishInbound(inbound({ messageID: "km_quiet_1", text: "@alice @quiet 你好" }))
          const repoSvc = yield* IMRepository
          const page = yield* repoSvc.listMessages({ groupID: group.id, limit: 20 })
          return page.messages.find(
            (m) => (m.metadata as { type?: unknown } | null)?.type === "agent_no_trigger_mention",
          )
        }),
        "mention receipt never landed",
      )
      expect((receipt.metadata as { agentID?: unknown }).agentID).toBe("quiet")
      // receipt 与准入在同一顺序纤维内：receipt 可见即准入已定论。
      expect(yield* inputCount(sessionID)).toBe(0)
    }),
  )

  it.live("history and delayed WS replay land without durable admission; a new live mention admits once", () =>
    Effect.gen(function* () {
      const group = yield* orgGroup
      const sessionID = IMAgentExecution.imSessionIDFor(group.id, "general")
      const sync = yield* IMKernelSync.Service
      historyMessages = [inbound({ messageID: "history_mention", msgTime: 1_700_000_000_100 })]
      yield* sync.catchUp
      expect(yield* kernelLanded("history_mention")).toBeDefined()
      expect(yield* inputCount(sessionID)).toBe(0)
      // A delayed SDK sync notification has a different message ID but predates recovery's kernel-time barrier.
      yield* pollWithTimeout(
        Effect.gen(function* () {
          yield* publishInbound(inbound({ messageID: "delayed_ws", msgTime: 1_700_000_000_050 }))
          return yield* kernelLanded("delayed_ws")
        }),
        "delayed replay did not land",
      )
      expect(yield* inputCount(sessionID)).toBe(0)
      yield* publishUntilAdmitted(
        inbound({ messageID: "live_after_recovery", msgTime: 1_700_000_000_200 }),
        sessionID,
        1,
      )
      yield* publishInbound(inbound({ messageID: "live_after_recovery", msgTime: 1_700_000_000_200 }))
      // Running another recovery settles the inbound semaphore and cannot admit history a second time.
      yield* sync.catchUp
      expect(yield* inputCount(sessionID)).toBe(1)
      expect(listScopes).toHaveLength(1)
    }),
  )

  it.live("responder off (the default): even a fully addressed mention never admits", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // 独立图：无 responder 选项（=默认关）。fakeClient 重建会把模块级 publishInbound 指到
        // 这台引擎——本测试是文件内最后一台构建，重指向安全。
        const offDatabase = Database.layerFromPath(":memory:")
        const offRepo = IMRepositoryLive.pipe(Layer.provide(offDatabase))
        const offSync = IMKernelSync.layer(config, { workspaceID: "ws", inspectConversation }).pipe(
          Layer.provide(offRepo),
          Layer.provide(Layer.succeed(IMBroadcasterService, broadcaster)),
          Layer.provide(fakeClient),
        )
        const ctx = yield* Layer.build(Layer.mergeAll(offDatabase, offRepo, offSync))
        yield* Effect.gen(function* () {
          const repoSvc = yield* IMRepository
          const group = yield* repoSvc.getGroupByKernelConvID("k:2:org7")
          expect(group).toBeDefined()
          // 落库先于准入判定且在同一个顺序纤维内：行可见即 maybeAdmitMentions 已跑完。
          yield* pollWithTimeout(
            Effect.gen(function* () {
              yield* publishInbound(inbound({ messageID: "km_off_1" }))
              return (yield* repoSvc.getMessageByKernelMsgID("km_off_1")) ?? undefined
            }),
            "message never landed with responder off",
          )
          const { db } = yield* Database.Service
          const rows = yield* db.select({ id: SessionInputTable.id }).from(SessionInputTable).all().pipe(Effect.orDie)
          expect(rows).toHaveLength(0)
        }).pipe(Effect.provide(ctx))
      }),
    ),
  )
})
