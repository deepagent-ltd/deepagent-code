import { beforeEach, describe, expect } from "bun:test"
import { Effect, Layer, PubSub, Stream, SubscriptionRef } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { IMRepository, IMRepositoryLive } from "@deepagent-code/core/im/repository"
import { IMBroadcasterService } from "@deepagent-code/core/im/broadcaster"
import { KernelClient } from "@/im/kernel/client"
import { IMKernelSync } from "@/im/kernel/sync"
import { IMKernelExchange } from "@/im/kernel/exchange"
import { pollWithTimeout, testEffect } from "../lib/effect"

let publish: (message: KernelClient.KernelTextMessage) => Effect.Effect<void>
let proofs: Record<string, IMKernelExchange.InspectConversationPayload>
let conversations: Array<{ conversationType: number; conversationID: string; sortTime: number }>
let history: KernelClient.KernelTextMessage[]
let inspections: IMKernelExchange.InspectConversationInput[]

const database = Database.layerFromPath(":memory:")
const repository = IMRepositoryLive.pipe(Layer.provide(database))
const client = Layer.effect(
  KernelClient.Service,
  Effect.gen(function* () {
    const messages = yield* PubSub.bounded<KernelClient.KernelTextMessage>(32)
    publish = (message) => PubSub.publish(messages, message).pipe(Effect.asVoid)
    return KernelClient.Service.of({
      state: yield* SubscriptionRef.make<KernelClient.ConnectionState>("disconnected"),
      messages: Stream.fromPubSub(messages),
      sendText: () => Effect.succeed({ messageID: "sent" }),
      fetchConversations: () => Effect.sync(() => ({ conversations, isFinished: true })),
      fetchHistory: (input) =>
        Effect.sync(() => {
          const messages = history.filter(
            (message) => message.conversationID === input.conversationID && message.msgTime > input.after,
          )
          return {
            messages,
            isFinished: true,
            latestTime: Math.max(input.after, ...messages.map((message) => message.msgTime)),
          }
        }),
      disconnect: Effect.void,
    })
  }),
)
const sync = IMKernelSync.layer(
  {
    userID: "alice",
    appkey: "test",
    navigator: "http://127.0.0.1:9",
    token: "test",
    identity: { uuid: "alice", name: "Alice", orgID: 7, orgAllGroupID: "org7" },
  },
  {
    workspaceID: "ws",
    inspectConversation: (input) =>
      Effect.suspend(() => {
        inspections.push(input)
        const proof = proofs[input.conversationID]
        if (proof) return Effect.succeed(proof)
        return Effect.fail(
          new IMKernelExchange.ExchangeError({
            code: "im_not_group_member",
            message: "Access denied",
            retryable: false,
          }),
        )
      }),
  },
).pipe(
  Layer.provide(repository),
  Layer.provide(client),
  Layer.provide(
    Layer.succeed(IMBroadcasterService, {
      broadcast: () => {},
      sendToUser: () => {},
      register: () => true,
      unregister: () => {},
      getConnectionCount: () => 0,
      getUserConnectionCount: () => 0,
    }),
  ),
)
const it = testEffect(Layer.mergeAll(database, repository, sync))

beforeEach(() => {
  proofs = {
    bob: { conversation_type: 1, conversation_id: "bob", name: "Bob", member_uuids: ["alice", "bob"], org_id: 7 },
    invited: {
      conversation_type: 2,
      conversation_id: "invited",
      name: "研发",
      member_uuids: ["alice", "bob"],
      org_id: 7,
    },
  }
  conversations = []
  history = []
  inspections = []
})

const inbound = (overrides: Partial<KernelClient.KernelTextMessage> = {}): KernelClient.KernelTextMessage => ({
  messageID: "first_dm",
  conversationType: 1,
  conversationID: "bob",
  senderID: "bob",
  text: "hello",
  msgTime: 1_700_000_000_000,
  ...overrides,
})
const land = (message: KernelClient.KernelTextMessage) =>
  pollWithTimeout(
    Effect.gen(function* () {
      yield* publish(message)
      const repo = yield* IMRepository
      return yield* repo.getMessageByKernelMsgID(message.messageID)
    }),
    "verified message did not arrive",
  )

describe("trusted receiving-side conversation discovery", () => {
  it.live("the first DM and the first invited-group message create one visible bound mirror each", () =>
    Effect.gen(function* () {
      const direct = yield* land(inbound())
      const group = yield* land(inbound({ messageID: "first_group", conversationType: 2, conversationID: "invited" }))
      const repo = yield* IMRepository
      const visible = yield* repo.listGroups({ workspaceID: "ws", userID: "server" })
      expect(visible.find((item) => item.id === direct.groupID)?.type).toBe("direct")
      expect(visible.find((item) => item.id === group.groupID)?.name).toBe("研发")
      yield* land(inbound({ messageID: "second_dm" }))
      expect((yield* repo.listKernelBoundGroups).filter((item) => item.kernelConvID === "k:1:bob")).toHaveLength(1)
      expect(inspections).toContainEqual({ conversationType: 2, conversationID: "invited", senderID: "bob" })
    }),
  )

  it.live("rejects unknown, cross-org, wrong-conversation, and forged-sender proofs without creating groups", () =>
    Effect.gen(function* () {
      yield* land(inbound())
      proofs.cross = { ...proofs.invited, conversation_id: "cross", org_id: 8 }
      proofs.wrong = { ...proofs.invited }
      proofs.forged = { ...proofs.invited, conversation_id: "forged" }
      yield* publish(inbound({ messageID: "unknown", conversationType: 2, conversationID: "unknown" }))
      yield* publish(inbound({ messageID: "cross", conversationType: 2, conversationID: "cross" }))
      yield* publish(inbound({ messageID: "wrong", conversationType: 2, conversationID: "wrong" }))
      yield* publish(
        inbound({ messageID: "forged", conversationType: 2, conversationID: "forged", senderID: "mallory" }),
      )
      yield* land(inbound({ messageID: "barrier" }))
      const repo = yield* IMRepository
      for (const id of ["unknown", "cross", "wrong", "forged"]) {
        expect(yield* repo.getGroupByKernelConvID(`k:2:${id}`)).toBeUndefined()
        expect(yield* repo.getMessageByKernelMsgID(id)).toBeUndefined()
      }
    }),
  )

  it.live("offline conversation discovery verifies a new group before recovering its first message", () =>
    Effect.gen(function* () {
      conversations = [{ conversationType: 2, conversationID: "invited", sortTime: 1_700_000_000_000 }]
      history = [inbound({ messageID: "offline_first", conversationType: 2, conversationID: "invited" })]
      const engine = yield* IMKernelSync.Service
      yield* engine.catchUp
      const repo = yield* IMRepository
      expect(yield* repo.getMessageByKernelMsgID("offline_first")).toBeDefined()
      expect(inspections).toEqual([
        { conversationType: 2, conversationID: "invited" },
        { conversationType: 2, conversationID: "invited", senderID: "bob" },
      ])
      expect((yield* SubscriptionRef.get(engine.recovery)).status).toBe("ready")
    }),
  )

  it.live("concurrent mirror creation is atomic and preserves one binding plus local membership", () =>
    Effect.gen(function* () {
      const repo = yield* IMRepository
      const input = {
        workspaceID: "ws",
        type: "project" as const,
        name: "Atomic",
        createdBy: "server",
        kernelConvID: "k:2:atomic",
        members: [{ memberID: "bob", memberType: "user" as const }],
      }
      const groups = yield* Effect.all(
        Array.from({ length: 8 }, () => repo.ensureKernelGroup(input)),
        { concurrency: 8 },
      )
      expect(new Set(groups.map((group) => group.id)).size).toBe(1)
      expect(
        (yield* repo.listGroups({ workspaceID: "ws", userID: "server" })).filter(
          (group) => group.kernelConvID === input.kernelConvID,
        ),
      ).toHaveLength(1)
    }),
  )
})
