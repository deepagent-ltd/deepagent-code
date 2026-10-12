import { beforeEach, describe, expect } from "bun:test"
import { Effect, Layer, PubSub, Stream, SubscriptionRef } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { IMRepository, IMRepositoryLive } from "@deepagent-code/core/im/repository"
import { IMBroadcasterService } from "@deepagent-code/core/im/broadcaster"
import type { IMBroadcaster } from "@deepagent-code/core/im/websocket"
import { KernelClient } from "@/im/kernel/client"
import { KernelSdk } from "@/im/kernel/sdk"
import { IMKernelSync } from "@/im/kernel/sync"
import type { KernelConfig } from "@/im/kernel/config"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { InstanceRegistry } from "@/effect/instance-registry"

// B2 全员群 provision：带门面身份的 config ⇒ 引擎启动时把组织全员群（k:2:org7）幂等镜像到本地
// 群表（creator 坐本地操作者身份，facade uuid 坐成员），此后 org 群入站消息落库广播——B1 的
// "unbound conversation skip" 对全员群不再发生。真 :memory: DB + 真 repo + 假 client。

const config: KernelConfig.Info = {
  appkey: "test-appkey",
  navigator: "http://127.0.0.1:9",
  token: "test-token",
  userID: "uuid-alice",
  identity: { uuid: "uuid-alice", name: "alice", orgAllGroupID: "org7", orgID: 7 },
}

let clientState: SubscriptionRef.SubscriptionRef<KernelClient.ConnectionState>
let publishInbound: (msg: KernelClient.KernelTextMessage) => Effect.Effect<void>
let broadcasts: Array<{ groupID: string; type: string }>

const broadcaster: IMBroadcaster = {
  broadcast: (groupID, event) => {
    broadcasts.push({ groupID, type: event.type })
  },
  sendToUser: () => {},
  register: () => true,
  unregister: () => {},
  getConnectionCount: () => 0,
  getUserConnectionCount: () => 0,
}

const fakeClient = Layer.unwrap(
  Effect.gen(function* () {
    const state = yield* SubscriptionRef.make<KernelClient.ConnectionState>("disconnected")
    const pubsub = yield* PubSub.bounded<KernelClient.KernelTextMessage>(16)
    clientState = state
    publishInbound = (msg) => PubSub.publish(pubsub, msg).pipe(Effect.asVoid)
    return Layer.succeed(
      KernelClient.Service,
      KernelClient.Service.of({
        state,
        messages: Stream.fromPubSub(pubsub),
        sendText: () => Effect.succeed({ messageID: "km_ack_1" }),
        fetchHistory: () => Effect.succeed({ messages: [], isFinished: true, latestTime: 0 }),
        fetchConversations: () => Effect.succeed({ conversations: [], isFinished: true }),

        getDeliveryReader: () => Effect.fail(new KernelSdk.KernelError({ operation: "getDeliveryReader", message: "Protected reader unavailable in legacy fixture" })),
        getDeliveryChanges: () => Effect.fail(new KernelSdk.KernelError({ operation: "getDeliveryChanges", message: "Protected reader unavailable in legacy fixture" })),
        getDeliveryMessages: () => Effect.fail(new KernelSdk.KernelError({ operation: "getDeliveryMessages", message: "Protected reader unavailable in legacy fixture" })),
        getDeliveryReadCut: () => Effect.fail(new KernelSdk.KernelError({ operation: "getDeliveryReadCut", message: "Protected reader unavailable in legacy fixture" })),
        markDeliveryRead: () => Effect.fail(new KernelSdk.KernelError({ operation: "markDeliveryRead", message: "Protected reader unavailable in legacy fixture" })),
        disconnect: Effect.void,
      }),
    )
  }),
)

const database = Database.layerFromPath(":memory:")
const repo = IMRepositoryLive.pipe(Layer.provide(database))
const syncLayer = IMKernelSync.layer(config, {
  workspaceID: "ws",
  inspectConversation: (input) =>
    Effect.succeed({
      conversation_type: input.conversationType,
      conversation_id: input.conversationID,
      name: "全员群",
      member_uuids: ["uuid-alice", "uuid-bob"],
      org_id: 7,
    }),
}).pipe(Layer.provide(database),
  Layer.provide(InstanceRegistry.layer), Layer.provide(repo), Layer.provide(Layer.succeed(IMBroadcasterService, broadcaster)), Layer.provide(fakeClient))

const it = testEffect(Layer.mergeAll(database, repo, syncLayer))

beforeEach(() => {
  broadcasts = []
})

const provisionedGroup = Effect.gen(function* () {
  const repoSvc = yield* IMRepository
  return yield* repoSvc.getGroupByKernelConvID("k:2:org7")
})

describe("IMKernelSync org all-group provision (B2)", () => {
  it.live("layer build mirrors the org all-group locally: created, bound, and seated", () =>
    Effect.gen(function* () {
      const group = yield* provisionedGroup
      expect(group).toBeDefined()
      expect(group?.name).toBe("全员群")
      expect(group?.workspaceID).toBe("ws")
      expect(group?.kernelConvID).toBe("k:2:org7")

      const repoSvc = yield* IMRepository
      // membership-enforced fetch doubles as the seating assertion: the local operator identity
      // (GUI listGroups) and the facade identity must both resolve the group.
      expect((yield* repoSvc.getGroup({ groupID: group!.id, userID: "server" }))?.id).toBe(group!.id)
      expect((yield* repoSvc.getGroup({ groupID: group!.id, userID: "uuid-alice" }))?.id).toBe(group!.id)
    }),
  )

  it.live("provision is idempotent: a direct re-run keeps exactly one bound group", () =>
    Effect.gen(function* () {
      const first = yield* provisionedGroup
      const repoSvc = yield* IMRepository
      yield* IMKernelSync.provisionOrgAllGroup(repoSvc, config.identity!, "ws")
      const second = yield* provisionedGroup
      expect(second?.id).toBe(first?.id)
      expect(second?.createdAt).toBe(first?.createdAt)
      const page = yield* repoSvc.listGroups({ workspaceID: "ws", userID: "server" })
      expect(page).toHaveLength(1)
    }),
  )

  it.live("an inbound org-group message lands in the provisioned group and broadcasts", () =>
    Effect.gen(function* () {
      const group = yield* provisionedGroup
      expect(group).toBeDefined()
      const row = yield* pollWithTimeout(
        Effect.gen(function* () {
          yield* publishInbound({
            messageID: "km_org_1",
            conversationType: 2,
            conversationID: "org7",
            senderID: "uuid-bob",
            text: "hello org",
            msgTime: 1_700_000_000_000,
          })
          const repoSvc = yield* IMRepository
          return (yield* repoSvc.getMessageByKernelMsgID("km_org_1")) ?? undefined
        }),
        "org-group message never landed",
      )
      expect(row.groupID).toBe(group!.id)
      expect(row.senderID).toBe("uuid-bob")
      expect(broadcasts).toContainEqual({ groupID: group!.id, type: "message_created" })
    }),
  )
})
