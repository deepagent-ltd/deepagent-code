import { beforeEach, describe, expect, test } from "bun:test"
import { Effect, Layer, Queue, Ref, Stream, SubscriptionRef } from "effect"
import { KernelClient } from "@/im/kernel/client"
import { KernelSdk } from "@/im/kernel/sdk"
import { pollWithTimeout, testEffect } from "../lib/effect"

// KernelClient over a fake KernelSdk (queue-driven raw events + recorded sends). Covers the state
// machine mapping, the closed legacy event boundary, the 72h lifeTime injection on send, and
// normalization/history helpers. Protected first-seen provenance is exercised separately through
// the real SDK WS → current Entry → native-query fixture, without model execution.

let sentMessages: Array<KernelSdk.OutboundTextMessage>
let sendResult: Effect.Effect<{ readonly messageID: string }, KernelSdk.KernelError>
let historyPayloads: readonly unknown[]
let rawQueue: Queue.Queue<KernelSdk.RawEvent>

const fakeSdk = Layer.unwrap(
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<KernelSdk.RawEvent>()
    rawQueue = queue
    return Layer.succeed(
      KernelSdk.Service,
      KernelSdk.Service.of({
        rawEvents: Stream.fromQueue(queue),
        sendMessage: (input) =>
          Effect.suspend(() => {
            sentMessages.push(input)
            return sendResult
          }),
        fetchHistory: () => Effect.suspend(() => Effect.succeed({ messages: historyPayloads, isFinished: true })),
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

const it = testEffect(KernelClient.layer.pipe(Layer.provide(fakeSdk)))

beforeEach(() => {
  sentMessages = []
  sendResult = Effect.succeed({ messageID: "km_ack_1" })
  historyPayloads = []
})

const textPayload = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: "jg:text",
  messageId: "km_1",
  conversationId: "bob",
  conversationType: 1,
  sender: { id: "bob" },
  content: { content: "hello" },
  sentTime: 1_700_000_000_000,
  ...overrides,
})

describe("KernelClient.normalizeTextMessage", () => {
  test("normalizes a well-formed jg:text payload", () => {
    expect(KernelClient.normalizeTextMessage(textPayload())).toEqual({
      messageID: "km_1",
      conversationType: 1,
      conversationID: "bob",
      senderID: "bob",
      text: "hello",
      msgTime: 1_700_000_000_000,
    })
  })

  test("drops non-text message kinds and payloads with missing/garbled fields", () => {
    expect(KernelClient.normalizeTextMessage(textPayload({ name: "jg:file" }))).toBeUndefined()
    expect(KernelClient.normalizeTextMessage(textPayload({ messageId: 42 }))).toBeUndefined()
    expect(KernelClient.normalizeTextMessage(textPayload({ conversationId: undefined }))).toBeUndefined()
    expect(KernelClient.normalizeTextMessage(textPayload({ conversationType: "1" }))).toBeUndefined()
    expect(KernelClient.normalizeTextMessage(textPayload({ sender: null }))).toBeUndefined()
    expect(KernelClient.normalizeTextMessage(textPayload({ sender: { id: 7 } }))).toBeUndefined()
    expect(KernelClient.normalizeTextMessage(textPayload({ content: { content: 42 } }))).toBeUndefined()
    expect(KernelClient.normalizeTextMessage(textPayload({ content: null }))).toBeUndefined()
    expect(KernelClient.normalizeTextMessage(null)).toBeUndefined()
    expect(KernelClient.normalizeTextMessage("jg:text")).toBeUndefined()
  })

  test("rejects invalid timestamps instead of turning replay into a new local-time message", () => {
    for (const sentTime of [undefined, null, NaN, Infinity, 0, -1, 1.5, "1700000000000"])
      expect(KernelClient.normalizeTextMessage(textPayload({ sentTime }))).toBeUndefined()
  })
})

describe("KernelClient state machine", () => {
  it.live("maps SDK connection states and ignores unrelated states", () =>
    Effect.gen(function* () {
      const client = yield* KernelClient.Service
      expect(yield* SubscriptionRef.get(client.state)).toBe("connecting")

      const expectState = (state: number, expected: KernelClient.ConnectionState) =>
        Effect.gen(function* () {
          yield* Queue.offer(rawQueue, { tag: "state_changed", state })
          yield* pollWithTimeout(
            Effect.gen(function* () {
              const current = yield* SubscriptionRef.get(client.state)
              return current === expected ? (true as const) : undefined
            }),
            `state ${state} never mapped to ${expected}`,
          )
        })

      yield* expectState(0, "connected")
      // DB_OPENED / DB_CLOSED carry no link information — the current state must survive them.
      yield* Queue.offer(rawQueue, { tag: "state_changed", state: 4 })
      yield* Queue.offer(rawQueue, { tag: "state_changed", state: 5 })
      yield* Effect.sleep("50 millis")
      expect(yield* SubscriptionRef.get(client.state)).toBe("connected")

      yield* expectState(6, "connecting")
      yield* expectState(1, "connecting")
      yield* expectState(3, "failed")
      yield* expectState(2, "disconnected")
    }),
  )
})

describe("KernelClient messages", () => {
  it.live("legacy payloads and copied protected handles enter neither message stream", () =>
    Effect.gen(function* () {
      const client = yield* KernelClient.Service
      const scope = yield* Effect.scope
      const received = yield* Ref.make<Array<KernelClient.KernelTextMessage>>([])
      const live = yield* Ref.make<object[]>([])
      yield* Stream.runForEach(client.messages, (message) => Ref.update(received, (items) => [...items, message])).pipe(Effect.forkIn(scope))
      yield* Stream.runForEach(client.liveObservations!, (handle) => Ref.update(live, (items) => [...items, handle])).pipe(Effect.forkIn(scope))
      yield* Queue.offer(rawQueue, { tag: "state_changed", state: 0 })
      yield* pollWithTimeout(SubscriptionRef.get(client.state).pipe(Effect.map((value) => value === "connected" ? true : undefined)), "raw collector did not become current")
      const handle = Object.freeze({})
      yield* Queue.offer(rawQueue, { tag: "message_received", payload: textPayload() })
      yield* Queue.offer(rawQueue, { tag: "message_received", payload: textPayload({ name: "jg:file" }) })
      yield* Queue.offer(rawQueue, { tag: "protected_live_observed", handle })
      yield* Queue.offer(rawQueue, { tag: "protected_live_observed", handle: { ...handle } })
      // This later fact in the same raw stream proves all preceding payloads
      // were consumed; no timing assumption stands in for the closed gate.
      yield* Queue.offer(rawQueue, { tag: "state_changed", state: 2 })
      yield* pollWithTimeout(SubscriptionRef.get(client.state).pipe(Effect.map((value) => value === "disconnected" ? true : undefined)), "raw stream did not consume the terminal barrier")
      expect(yield* Ref.get(received)).toEqual([])
      expect(yield* Ref.get(live)).toEqual([])
      expect(client.readLiveObservation?.(handle)).toBeUndefined()
      expect(client.readLiveObservation?.({ ...handle })).toBeUndefined()
    }),
  )

  it.live("fetchHistory normalizes through the same guards", () =>
    Effect.gen(function* () {
      const client = yield* KernelClient.Service
      historyPayloads = [
        textPayload({ messageId: "km_h1", sentTime: 1_700_000_100_000 }),
        textPayload({ name: "jg:file" }),
        textPayload({ messageId: "km_h2", content: { content: 42 } }),
      ]
      const msgs = yield* client.fetchHistory({ conversationType: 1, conversationID: "bob", after: 0, count: 100 })
      expect(msgs.messages.map((msg) => msg.messageID)).toEqual(["km_h1"])
      expect(msgs.messages[0]?.msgTime).toBe(1_700_000_100_000)
    }),
  )
})

describe("KernelClient sendText", () => {
  it.live("injects the 72h lifeTime and resolves the ack messageId", () =>
    Effect.gen(function* () {
      const client = yield* KernelClient.Service
      const result = yield* client.sendText({ conversationType: 1, conversationID: "bob", text: "hi bob", messageID: "local-one", wireID: "wire-one", expiresAt: Date.now() + 259_200_000 })
      expect(result).toEqual({ messageID: "km_ack_1" })
      expect(KernelClient.MESSAGE_TTL_MS).toBe(259_200_000)
      expect(sentMessages).toHaveLength(1)
      expect(sentMessages[0]).toMatchObject({ conversationType: 1, conversationID: "bob", text: "hi bob", messageID: "local-one", wireID: "wire-one" })
      expect(sentMessages[0].lifeTime).toBeGreaterThan(259_199_000)
      expect(sentMessages[0].lifeTime).toBeLessThanOrEqual(259_200_000)
    }),
  )

  it.live("propagates a kernel send failure as KernelError", () =>
    Effect.gen(function* () {
      const client = yield* KernelClient.Service
      sendResult = Effect.fail(
        new KernelSdk.KernelError({ operation: "sendMessage", message: "kernel ack carried no messageId" }),
      )
      const error = yield* Effect.flip(client.sendText({ conversationType: 1, conversationID: "bob", text: "hi", messageID: "local-fail", wireID: "wire-fail", expiresAt: Date.now() + 259_200_000 }))
      expect(error instanceof KernelSdk.KernelError).toBe(true)
      expect(error.operation).toBe("sendMessage")
      expect(sentMessages).toHaveLength(1)
    }),
  )
})
