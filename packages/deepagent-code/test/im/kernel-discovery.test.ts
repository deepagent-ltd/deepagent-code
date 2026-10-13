import { KernelSdk } from "@/im/kernel/sdk"
import { beforeEach, describe, expect } from "bun:test"
import { Effect, Layer, PubSub, Stream, SubscriptionRef } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { IMRepository, IMRepositoryLive } from "@deepagent-code/core/im/repository"
import { IMBroadcasterService } from "@deepagent-code/core/im/broadcaster"
import { KernelClient } from "@/im/kernel/client"
import { IMKernelSync } from "@/im/kernel/sync"
import { IMKernelExchange } from "@/im/kernel/exchange"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { InstanceRegistry } from "@/effect/instance-registry"

let publish: (message: KernelClient.KernelTextMessage) => Effect.Effect<void>
let clientState: SubscriptionRef.SubscriptionRef<KernelClient.ConnectionState>
let proofs: Record<string, IMKernelExchange.InspectConversationPayload>
let conversations: Array<{ conversationType: number; conversationID: string; sortTime: number }>
let conversationPage: KernelClient.Interface["fetchConversations"]
let history: KernelClient.KernelTextMessage[]
let historyRequests: Parameters<KernelClient.Interface["fetchHistory"]>[0][]
let inspections: IMKernelExchange.InspectConversationInput[]
let inspectionFailure: (input: IMKernelExchange.InspectConversationInput) => IMKernelExchange.ExchangeError | undefined

const database = Database.layerFromPath(":memory:")
const repository = IMRepositoryLive.pipe(Layer.provide(database))
const client = Layer.effect(
  KernelClient.Service,
  Effect.gen(function* () {
    const messages = yield* PubSub.bounded<KernelClient.KernelTextMessage>(32)
    clientState = yield* SubscriptionRef.make<KernelClient.ConnectionState>("disconnected")
    publish = (message) => PubSub.publish(messages, message).pipe(Effect.asVoid)
    return KernelClient.Service.of({
      state: clientState,
      messages: Stream.fromPubSub(messages),
      sendText: () => Effect.succeed({ messageID: "sent" }),
      fetchConversations: (input) => conversationPage(input),
      fetchHistory: (input) =>
        Effect.sync(() => {
          historyRequests.push(input)
          const remaining = history.filter(
            (message) => message.conversationID === input.conversationID && message.msgTime > input.after,
          )
          const messages = remaining.slice(0, input.count)
          return {
            messages,
            isFinished: remaining.length <= input.count,
            latestTime: Math.max(input.after, ...messages.map((message) => message.msgTime)),
          }
        }),
      getDeliveryReader: () => Effect.fail(new KernelSdk.KernelError({ operation: "getDeliveryReader", message: "Protected reader unavailable in legacy fixture" })),
      getDeliveryChanges: () => Effect.fail(new KernelSdk.KernelError({ operation: "getDeliveryChanges", message: "Protected reader unavailable in legacy fixture" })),
      getDeliveryMessages: () => Effect.fail(new KernelSdk.KernelError({ operation: "getDeliveryMessages", message: "Protected reader unavailable in legacy fixture" })),
      getDeliveryReadCut: () => Effect.fail(new KernelSdk.KernelError({ operation: "getDeliveryReadCut", message: "Protected reader unavailable in legacy fixture" })),
      markDeliveryRead: () => Effect.fail(new KernelSdk.KernelError({ operation: "markDeliveryRead", message: "Protected reader unavailable in legacy fixture" })),
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
        const failure = inspectionFailure(input)
        if (failure) return Effect.fail(failure)
        const proof = proofs[input.conversationID]
        if (proof) return Effect.succeed(proof)
        return Effect.fail(
          new IMKernelExchange.ExchangeError({
            code: "im_not_group_member",
            message: "Access denied",
            status: 403,
            retryable: false,
          }),
        )
      }),
  },
).pipe(
  Layer.provide(repository),
  Layer.provide(database),
  Layer.provide(InstanceRegistry.layer),
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
  conversationPage = () => Effect.sync(() => ({ conversations, isFinished: true }))
  history = []
  historyRequests = []
  inspections = []
  inspectionFailure = () => undefined
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

  it.live("a denied historical sender cannot block valid messages before, after, or on later pages", () =>
    Effect.gen(function* () {
      conversations = [{ conversationType: 2, conversationID: "invited", sortTime: 1_700_000_000_224 }]
      inspectionFailure = (input) =>
        input.senderID === "deleted"
          ? new IMKernelExchange.ExchangeError({
              code: "im_not_found",
              message: "Identity no longer exists",
              status: 404,
              retryable: false,
            })
          : undefined
      history = Array.from({ length: 225 }, (_, index) =>
        inbound({
          messageID: `history_${index}`,
          conversationType: 2,
          conversationID: "invited",
          senderID: [0, 50, 99, 124, 224].includes(index) ? "deleted" : "bob",
          text: "@Alice @general historical text must not execute",
          msgTime: 1_700_000_000_000 + index,
        }),
      )
      const engine = yield* IMKernelSync.Service
      const repo = yield* IMRepository
      yield* engine.catchUp
      expect((yield* SubscriptionRef.get(engine.recovery)).status).toBe("ready")
      const group = yield* repo.getGroupByKernelConvID("k:2:invited")
      expect((yield* repo.listMessages({ groupID: group!.id, limit: 500 })).messages).toHaveLength(220)
      expect(historyRequests.length).toBeGreaterThan(2)
      for (const index of [0, 50, 99, 124, 224])
        expect(yield* repo.getMessageByKernelMsgID(`history_${index}`)).toBeUndefined()
      for (const index of [1, 49, 51, 98, 100, 123, 125, 223])
        expect(yield* repo.getMessageByKernelMsgID(`history_${index}`)).toBeDefined()
      expect((yield* repo.getSyncCursor(IMKernelSync.historyCursorKey("k:2:invited")))?.lastSyncTime).toBe(
        1_700_000_000_223,
      )
      expect(yield* repo.listPendingMentions({ origin: "kernel_live", receiverID: "alice" })).toEqual([])
      yield* engine.catchUp
      expect((yield* repo.listMessages({ groupID: group!.id, limit: 500 })).messages).toHaveLength(220)
    }),
  )

  it.live("stale conversation hints are isolated while discovery continues into later pages", () =>
    Effect.gen(function* () {
      const requests: number[] = []
      const denied = {
        deleted: { code: "im_not_found", status: 404 },
        removed: { code: "im_not_group_member", status: 403 },
        invalid: { code: "im_invalid_group", status: 400 },
      }
      inspectionFailure = (input) => {
        const rejection = denied[input.conversationID as keyof typeof denied]
        return rejection
          ? new IMKernelExchange.ExchangeError({ ...rejection, message: "Stale conversation", retryable: false })
          : undefined
      }
      conversationPage = (input) =>
        Effect.sync(() => {
          requests.push(input.before)
          return {
            conversations: (requests.length === 1 ? ["deleted", "removed", "invalid"] : ["invited"]).map(
              (conversationID) => ({ conversationType: 2, conversationID, sortTime: 1_700_000_000_000 }),
            ),
            isFinished: requests.length > 1,
          }
        })
      history = [inbound({ messageID: "after_stale_hints", conversationType: 2, conversationID: "invited" })]
      const engine = yield* IMKernelSync.Service
      const repo = yield* IMRepository
      yield* engine.catchUp
      expect((yield* SubscriptionRef.get(engine.recovery)).status).toBe("ready")
      expect(requests).toHaveLength(2)
      expect(yield* repo.getMessageByKernelMsgID("after_stale_hints")).toBeDefined()
      for (const conversationID of Object.keys(denied))
        expect(yield* repo.getGroupByKernelConvID(`k:2:${conversationID}`)).toBeUndefined()
    }),
  )

  it.live("a system failure after a rejected item retains the prior page checkpoint for retry", () =>
    Effect.gen(function* () {
      conversations = [{ conversationType: 2, conversationID: "invited", sortTime: 1_700_000_000_224 }]
      proofs.invited = { ...proofs.invited, member_uuids: ["alice", "bob", "recovering"] }
      const unavailable = { active: true }
      inspectionFailure = (input) => {
        if (input.senderID === "deleted")
          return new IMKernelExchange.ExchangeError({
            code: "im_not_found",
            status: 404,
            retryable: false,
            message: "Gone",
          })
        if (input.senderID === "recovering" && unavailable.active)
          return new IMKernelExchange.ExchangeError({
            code: "im_unavailable",
            status: 503,
            retryable: true,
            message: "Retry later",
          })
      }
      history = Array.from({ length: 225 }, (_, index) =>
        inbound({
          messageID: `checkpoint_${index}`,
          conversationType: 2,
          conversationID: "invited",
          senderID: index === 50 ? "deleted" : index === 100 ? "recovering" : "bob",
          msgTime: 1_700_000_000_000 + index,
        }),
      )
      const engine = yield* IMKernelSync.Service
      const repo = yield* IMRepository
      yield* engine.catchUp
      expect((yield* SubscriptionRef.get(engine.recovery)).status).toBe("failed")
      expect((yield* repo.getSyncCursor(IMKernelSync.historyCursorKey("k:2:invited")))?.lastSyncTime).toBe(
        1_700_000_000_098,
      )
      expect(yield* repo.getMessageByKernelMsgID("checkpoint_50")).toBeUndefined()
      expect(yield* repo.getMessageByKernelMsgID("checkpoint_100")).toBeUndefined()
      unavailable.active = false
      historyRequests = []
      yield* engine.catchUp
      expect(historyRequests.find((request) => request.conversationID === "invited")?.after).toBe(1_700_000_000_098)
      expect((yield* SubscriptionRef.get(engine.recovery)).status).toBe("ready")
      const group = yield* repo.getGroupByKernelConvID("k:2:invited")
      expect((yield* repo.listMessages({ groupID: group!.id, limit: 500 })).messages).toHaveLength(224)
      expect(yield* repo.getMessageByKernelMsgID("checkpoint_50")).toBeUndefined()
    }),
  )

  for (const phase of ["discovery", "history"] as const) {
    it.live(`${phase} still rejects a successful inspect response with a mismatched organization`, () =>
      Effect.gen(function* () {
        if (phase === "discovery")
          conversations = [{ conversationType: 2, conversationID: "invited", sortTime: 1_700_000_000_000 }]
        const repo = yield* IMRepository
        if (phase === "history")
          yield* repo.ensureKernelGroup({
            workspaceID: "ws",
            type: "project",
            name: "Known",
            createdBy: "server",
            kernelConvID: "k:2:invited",
            members: [],
          })
        proofs.invited = { ...proofs.invited, org_id: 8 }
        history = [inbound({ messageID: "foreign_proof", conversationType: 2, conversationID: "invited" })]
        const engine = yield* IMKernelSync.Service
        yield* engine.catchUp
        expect((yield* SubscriptionRef.get(engine.recovery)).status).toBe("failed")
        expect(yield* repo.getMessageByKernelMsgID("foreign_proof")).toBeUndefined()
        expect(yield* repo.getSyncCursor(IMKernelSync.historyCursorKey("k:2:invited"))).toBeUndefined()
      }),
    )
  }

  for (const failure of [
    { code: "transport_error", retryable: true },
    { code: "im_not_found", status: 503, retryable: true },
    { code: "im_not_found", status: 500, retryable: false },
    { code: "im_not_found", retryable: false },
    { code: "im_key_invalid", status: 403, retryable: false },
    { code: "im_identity_disabled", status: 403, retryable: false },
    { code: "im_cross_org", status: 403, retryable: false },
    { code: "invalid_response", status: 400, retryable: false },
    { code: "http_error", status: 404, retryable: false },
  ]) {
    for (const phase of ["discovery", "history"] as const) {
      it.live(`${phase} keeps ${failure.code}/${failure.status ?? "no-status"} as a failed recovery`, () =>
        Effect.gen(function* () {
          conversations = [{ conversationType: 2, conversationID: "invited", sortTime: 1_700_000_000_000 }]
          history = [inbound({ messageID: "denied", conversationType: 2, conversationID: "invited" })]
          inspectionFailure = (input) =>
            (phase === "discovery" && !input.senderID) || (phase === "history" && input.senderID)
              ? new IMKernelExchange.ExchangeError({ ...failure, message: "System failure must remain visible" })
              : undefined
          const engine = yield* IMKernelSync.Service
          const repo = yield* IMRepository
          yield* engine.catchUp
          expect((yield* SubscriptionRef.get(engine.recovery)).status).toBe("failed")
          expect(yield* repo.getMessageByKernelMsgID("denied")).toBeUndefined()
          expect(yield* repo.getSyncCursor(IMKernelSync.historyCursorKey("k:2:invited"))).toBeUndefined()
        }),
      )
    }
  }

  it.live("a live item denial still fails recovery and never lands the unverified message", () =>
    Effect.gen(function* () {
      yield* land(inbound({ messageID: "subscription_ready" }))
      const engine = yield* IMKernelSync.Service
      const repo = yield* IMRepository
      yield* SubscriptionRef.set(clientState, "connected")
      yield* engine.catchUp
      expect((yield* SubscriptionRef.get(engine.recovery)).status).toBe("ready")
      inspectionFailure = (input) =>
        input.senderID === "deleted"
          ? new IMKernelExchange.ExchangeError({ code: "im_not_found", status: 404, retryable: false, message: "Gone" })
          : undefined
      yield* publish(inbound({ messageID: "live_denied", senderID: "deleted" }))
      yield* land(inbound({ messageID: "live_barrier" }))
      expect((yield* SubscriptionRef.get(engine.recovery)).status).toBe("failed")
      expect(yield* repo.getMessageByKernelMsgID("live_denied")).toBeUndefined()
      expect(yield* repo.listPendingMentions({ origin: "kernel_live", receiverID: "alice" })).toEqual([])
    }),
  )

  it.live("a nonprogressing last discovery page exhausts the budget and keeps recovery failed", () =>
    Effect.gen(function* () {
      const requested: number[] = []
      conversationPage = (input) =>
        Effect.sync(() => {
          requested.push(input.before)
          return {
            conversations: [
              {
                conversationType: 7,
                conversationID: "unsupported",
                sortTime: Number.MAX_SAFE_INTEGER - 2 - Math.floor((requested.length - 1) / 2) * 2,
              },
            ],
            isFinished: false,
          }
        })
      const engine = yield* IMKernelSync.Service
      yield* engine.catchUp
      expect(requested).toHaveLength(1_000)
      expect(requested[999]).toBe(requested[998] - 2)
      const recovery = yield* SubscriptionRef.get(engine.recovery)
      expect(recovery.status).toBe("failed")
      expect(recovery.message).not.toContain("KernelError")
      expect(yield* (yield* IMRepository).getGroupByKernelConvID("k:7:unsupported")).toBeUndefined()
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
