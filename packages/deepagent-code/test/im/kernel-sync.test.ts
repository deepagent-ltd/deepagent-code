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

// IMKernelSync over a real in-memory database + real IMRepository, with a fake KernelClient
// (PubSub-driven inbound, recordable sendText) and a recording broadcaster. Covers the B1 contract:
// inbound dedup → local write → broadcast → cursor advance; outbound local row → kernel (72h TTL is
// the client's concern) → ack write-back; pending drain with in-memory attempt cap; catch-up on
// reconnect. The real SDK never loads here.

const config: KernelConfig.Info = {
  appkey: "test-appkey",
  navigator: "http://127.0.0.1:9",
  token: "test-token",
  userID: "alice",
}

let clientState: SubscriptionRef.SubscriptionRef<KernelClient.ConnectionState>
let publishInbound: (msg: KernelClient.KernelTextMessage) => Effect.Effect<void>
let sentTexts: Array<KernelClient.SendTextInput>
let sendBehavior: (
  input: KernelClient.SendTextInput,
) => Effect.Effect<{ readonly messageID: string }, KernelSdk.KernelError>
let historyMessages: Array<KernelClient.KernelTextMessage>
let historyRequests: KernelSdk.FetchHistoryInput[]
let historyFailure: (input: KernelSdk.FetchHistoryInput) => boolean
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
        sendText: (input) => Effect.suspend(() => sendBehavior(input)),
        fetchHistory: (input) =>
          Effect.suspend(() => {
            historyRequests.push(input)
            if (historyFailure(input))
              return Effect.fail(new KernelSdk.KernelError({ operation: "fetchHistory", message: "test link down" }))
            const remaining = historyMessages
              .filter((message) => message.msgTime > input.after)
              .sort((a, b) => a.msgTime - b.msgTime)
            const messages = remaining.slice(0, input.count)
            return Effect.succeed({
              messages,
              isFinished: remaining.length <= input.count,
              latestTime: Math.max(input.after, ...messages.map((message) => message.msgTime)),
            })
          }),
        fetchConversations: () => Effect.succeed({ conversations: [], isFinished: true }),
        disconnect: Effect.void,
      }),
    )
  }),
)

const database = Database.layerFromPath(":memory:")
const repo = IMRepositoryLive.pipe(Layer.provide(database))
const syncLayer = IMKernelSync.layer(config).pipe(
  Layer.provide(repo),
  Layer.provide(Layer.succeed(IMBroadcasterService, broadcaster)),
  Layer.provide(fakeClient),
)

const it = testEffect(Layer.mergeAll(database, repo, syncLayer))

beforeEach(() => {
  sentTexts = []
  broadcasts = []
  historyMessages = []
  historyRequests = []
  historyFailure = () => false
  sendBehavior = (input) =>
    Effect.sync(() => {
      sentTexts.push(input)
      return { messageID: `km_ack_${sentTexts.length}` }
    })
})

const seedBoundGroup = (kernelConvID = "k:1:bob") =>
  Effect.gen(function* () {
    const repoSvc = yield* IMRepository
    const group = yield* repoSvc.createGroup({ workspaceID: "ws", type: "project", name: "bound", createdBy: "alice" })
    yield* repoSvc.bindKernelConversation({ groupID: group.id, kernelConvID })
    return group
  })

const inbound = (overrides: Partial<KernelClient.KernelTextMessage> = {}): KernelClient.KernelTextMessage => ({
  messageID: "km_in_1",
  conversationType: 1,
  conversationID: "bob",
  senderID: "bob",
  text: "hello alice",
  msgTime: 1_700_000_000_000,
  ...overrides,
})

const messageByKernelID = (kernelMsgID: string) =>
  Effect.gen(function* () {
    const repoSvc = yield* IMRepository
    return yield* repoSvc.getMessageByKernelMsgID(kernelMsgID)
  })

const pollKernelMessage = (kernelMsgID: string) =>
  pollWithTimeout(
    Effect.gen(function* () {
      const row = yield* messageByKernelID(kernelMsgID)
      return row ?? undefined
    }),
    `kernel message ${kernelMsgID} never landed`,
  )

// PubSub drops pre-subscription publishes, so the first inbound message of a test is republished
// until it lands (the engine dedups by kernel_msg_id — republishing is safe). Once one message has
// landed the subscription is proven live and later one-shot publishes are guaranteed processed.
const publishUntilLanded = (msg: KernelClient.KernelTextMessage) =>
  pollWithTimeout(
    Effect.gen(function* () {
      yield* publishInbound(msg)
      const row = yield* messageByKernelID(msg.messageID)
      return row ?? undefined
    }),
    `kernel message ${msg.messageID} never landed`,
  )

describe("IMKernelSync inbound", () => {
  it.live("lands in the local store, broadcasts message_created, and advances the cursor", () =>
    Effect.gen(function* () {
      const group = yield* seedBoundGroup()
      const row = yield* publishUntilLanded(inbound())
      expect(row.groupID).toBe(group.id)
      expect(row.senderID).toBe("bob")
      expect(row.senderType).toBe("user")
      expect(row.type).toBe("text")
      expect(row.content).toBe("hello alice")
      expect(row.createdAt).toBe(1_700_000_000_000)
      expect(broadcasts).toContainEqual({ groupID: group.id, type: "message_created" })

      const repoSvc = yield* IMRepository
      const cursor = yield* repoSvc.getSyncCursor("k:1:bob")
      expect(cursor?.lastSyncTime).toBe(1_700_000_000_000)
    }),
  )

  it.live("deduplicates at-least-once delivery by kernel_msg_id and still advances the cursor", () =>
    Effect.gen(function* () {
      const group = yield* seedBoundGroup()
      yield* publishUntilLanded(inbound())

      // Redelivery of the same kernel message id (newer msgTime): no second row, cursor moves on.
      yield* publishInbound(inbound({ msgTime: 1_700_000_005_000 }))
      const repoSvc = yield* IMRepository
      yield* pollWithTimeout(
        Effect.gen(function* () {
          const cursor = yield* repoSvc.getSyncCursor("k:1:bob")
          return cursor && cursor.lastSyncTime >= 1_700_000_005_000 ? (true as const) : undefined
        }),
        "cursor never advanced past the redelivery",
      )
      const page = yield* repoSvc.listMessages({ groupID: group.id, limit: 10 })
      expect(page.messages).toHaveLength(1)
    }),
  )

  it.live("skips the own-echo and unbound conversations; supported traffic still lands", () =>
    Effect.gen(function* () {
      const group = yield* seedBoundGroup()
      // Warm-up: proves the inbound subscription is live so the skips below are real observations.
      yield* publishUntilLanded(inbound({ messageID: "km_warm" }))
      // Own echo (senderID === config.userID): skipped whole-message even before dedup.
      yield* publishInbound(inbound({ messageID: "km_echo", senderID: "alice" }))
      // Unbound conversation (no group carries k:1:stranger): skipped with a warn.
      yield* publishInbound(inbound({ messageID: "km_stranger", conversationID: "stranger" }))
      // Unsupported conversation type (system channel): skipped.
      yield* publishInbound(inbound({ messageID: "km_sys", conversationType: 7 }))
      // A real one proves the stream kept flowing past every skip.
      yield* publishInbound(inbound({ messageID: "km_real" }))
      yield* pollKernelMessage("km_real")

      const repoSvc = yield* IMRepository
      const page = yield* repoSvc.listMessages({ groupID: group.id, limit: 10 })
      expect(page.messages.map((msg) => msg.kernelMsgID).sort()).toEqual(["km_real", "km_warm"])
      expect(yield* messageByKernelID("km_echo")).toBeUndefined()
      expect(yield* messageByKernelID("km_stranger")).toBeUndefined()
      expect(yield* messageByKernelID("km_sys")).toBeUndefined()
    }),
  )

  it.live("catch-up on reconnect lands history messages through the same inbound path", () =>
    Effect.gen(function* () {
      yield* seedBoundGroup()
      historyMessages = [inbound({ messageID: "km_hist_1", msgTime: 1_700_000_100_000 })]
      yield* SubscriptionRef.set(clientState, "connected")

      const row = yield* pollKernelMessage("km_hist_1")
      expect(row.createdAt).toBe(1_700_000_100_000)
      const repoSvc = yield* IMRepository
      const cursor = yield* repoSvc.getSyncCursor("k:1:bob")
      expect(cursor?.lastSyncTime).toBe(1_700_000_100_000)
    }),
  )
})

describe("IMKernelSync durable history pagination", () => {
  it.live("recovers more than 20 messages with overlapping pages and a saturated timestamp boundary", () =>
    Effect.gen(function* () {
      const group = yield* seedBoundGroup()
      historyMessages = Array.from({ length: 255 }, (_, index) =>
        inbound({ messageID: `history_${index}`, msgTime: 1_700_000_000_000 + (index < 205 ? 0 : index) }),
      )
      const sync = yield* IMKernelSync.Service
      yield* sync.catchUp
      const repoSvc = yield* IMRepository
      const messages = yield* repoSvc.listMessages({ groupID: group.id, limit: 500 })
      expect(messages.messages).toHaveLength(255)
      expect(new Set(messages.messages.map((message) => message.kernelMsgID)).size).toBe(255)
      expect(historyRequests.map((request) => request.count)).toContain(400)
      expect((yield* SubscriptionRef.get(sync.recovery)).status).toBe("ready")
      expect((yield* repoSvc.getSyncCursor(IMKernelSync.historyCursorKey("k:1:bob")))?.lastSyncTime).toBe(
        1_700_000_000_253,
      )
      yield* sync.catchUp
      expect((yield* repoSvc.listMessages({ groupID: group.id, limit: 500 })).messages).toHaveLength(255)
    }),
  )

  it.live("a failed later page retains a durable checkpoint, and live traffic cannot skip the backlog", () =>
    Effect.gen(function* () {
      const group = yield* seedBoundGroup()
      historyMessages = Array.from({ length: 225 }, (_, index) =>
        inbound({ messageID: `retry_${index}`, msgTime: 1_700_000_000_000 + index }),
      )
      const sync = yield* IMKernelSync.Service
      const repoSvc = yield* IMRepository
      yield* publishUntilLanded(inbound({ messageID: "live_future", msgTime: 1_800_000_000_000 }))
      historyFailure = (request) => request.after > 0
      yield* sync.catchUp
      expect((yield* SubscriptionRef.get(sync.recovery)).status).toBe("failed")
      const checkpoint = yield* repoSvc.getSyncCursor(IMKernelSync.historyCursorKey("k:1:bob"))
      expect(checkpoint?.lastSyncTime).toBe(1_700_000_000_098)
      historyRequests = []
      historyFailure = () => false
      yield* sync.catchUp
      expect(historyRequests[0].after).toBe(checkpoint!.lastSyncTime)
      expect((yield* repoSvc.listMessages({ groupID: group.id, limit: 500 })).messages).toHaveLength(226)
      expect((yield* SubscriptionRef.get(sync.recovery)).status).toBe("ready")
    }),
  )

  it.live("reports a non-progressing timestamp page and never skips its boundary", () =>
    Effect.gen(function* () {
      yield* seedBoundGroup()
      historyMessages = Array.from({ length: 12_801 }, (_, index) =>
        inbound({ messageID: `saturated_${index}`, msgTime: 1_700_000_000_000 }),
      )
      const sync = yield* IMKernelSync.Service
      yield* sync.catchUp
      const repoSvc = yield* IMRepository
      expect((yield* SubscriptionRef.get(sync.recovery)).status).toBe("failed")
      expect((yield* SubscriptionRef.get(sync.recovery)).message).toContain("timestamp boundary")
      expect((yield* repoSvc.getSyncCursor(IMKernelSync.historyCursorKey("k:1:bob")))?.lastSyncTime).toBe(
        1_699_999_999_999,
      )
      expect(historyRequests.at(-1)?.count).toBe(12_800)
      expect(yield* repoSvc.getMessageByKernelMsgID("saturated_12800")).toBeUndefined()
    }),
  )
})

describe("IMKernelSync outbound", () => {
  const seedPendingMessage = (content: string) =>
    Effect.gen(function* () {
      const group = yield* seedBoundGroup()
      const repoSvc = yield* IMRepository
      const message = yield* repoSvc.createMessage({
        groupID: group.id,
        senderID: "alice",
        senderType: "user",
        type: "text",
        content,
      })
      return { group, message }
    })

  it.live("send → kernel ack writes kernel_msg_id back onto the local row", () =>
    Effect.gen(function* () {
      const { group, message } = yield* seedPendingMessage("hi bob")
      const sync = yield* IMKernelSync.Service
      yield* sync.send({ groupID: group.id, messageID: message.id, content: "hi bob" })

      const repoSvc = yield* IMRepository
      const row = yield* pollWithTimeout(
        Effect.gen(function* () {
          const current = yield* repoSvc.getMessage(message.id)
          return current?.kernelMsgID ? current : undefined
        }),
        "kernel ack never written back",
      )
      expect(row.kernelMsgID).toBe("km_ack_1")
      expect(sentTexts).toEqual([{ conversationType: 1, conversationID: "bob", text: "hi bob" }])
    }),
  )

  it.live("send is a no-op for a group with no kernel binding (pure-local conversation)", () =>
    Effect.gen(function* () {
      const repoSvc = yield* IMRepository
      const group = yield* repoSvc.createGroup({
        workspaceID: "ws",
        type: "project",
        name: "local",
        createdBy: "alice",
      })
      const message = yield* repoSvc.createMessage({
        groupID: group.id,
        senderID: "alice",
        senderType: "user",
        type: "text",
        content: "local only",
      })
      const sync = yield* IMKernelSync.Service
      // Deterministic: send() resolves the binding inline and returns without queueing, and the
      // pending-drain join excludes unbound groups — no code path can reach sendText afterwards.
      yield* sync.send({ groupID: group.id, messageID: message.id, content: "local only" })
      expect(sentTexts).toHaveLength(0)
    }),
  )

  it.live("a failed send stays pending and drainPending redelivers once the link recovers", () =>
    Effect.gen(function* () {
      sendBehavior = (input) =>
        Effect.suspend(() => {
          sentTexts.push(input)
          return Effect.fail(new KernelSdk.KernelError({ operation: "sendMessage", message: "link down" }))
        })
      const { group, message } = yield* seedPendingMessage("offline hello")
      const sync = yield* IMKernelSync.Service
      yield* sync.send({ groupID: group.id, messageID: message.id, content: "offline hello" })

      yield* pollWithTimeout(
        Effect.sync(() => (sentTexts.length >= 1 ? (true as const) : undefined)),
        "failing send was never attempted",
      )
      const repoSvc = yield* IMRepository
      expect((yield* repoSvc.getMessage(message.id))?.kernelMsgID).toBeNull()

      // Link recovers: the state flip triggers drainPending (and an empty catch-up).
      sendBehavior = (input) =>
        Effect.sync(() => {
          sentTexts.push(input)
          return { messageID: "km_ack_recovered" }
        })
      yield* SubscriptionRef.set(clientState, "connected")
      const row = yield* pollWithTimeout(
        Effect.gen(function* () {
          const current = yield* repoSvc.getMessage(message.id)
          return current?.kernelMsgID ? current : undefined
        }),
        "pending message never redelivered",
      )
      expect(row.kernelMsgID).toBe("km_ack_recovered")
      expect(sentTexts).toHaveLength(2)
    }),
  )

  it.live("the in-memory attempt cap dead-letters a persistently failing send", () =>
    Effect.gen(function* () {
      // Connect first so the state-change drain fires on an empty pending list; every attempt
      // below then comes from an explicit drainPending pass.
      yield* SubscriptionRef.set(clientState, "connected")
      sendBehavior = (input) =>
        Effect.suspend(() => {
          sentTexts.push(input)
          return Effect.fail(new KernelSdk.KernelError({ operation: "sendMessage", message: "link down" }))
        })
      const { message } = yield* seedPendingMessage("never deliverable")
      const sync = yield* IMKernelSync.Service

      for (let pass = 0; pass < 12; pass++) {
        yield* sync.drainPending
      }
      // 8 = SEND_MAX_ATTEMPTS: attempts 9+ are skipped without touching the kernel.
      expect(sentTexts).toHaveLength(8)
      const repoSvc = yield* IMRepository
      expect((yield* repoSvc.getMessage(message.id))?.kernelMsgID).toBeNull()

      yield* sync.drainPending
      expect(sentTexts).toHaveLength(8)
    }),
  )
})
