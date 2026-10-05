import { beforeEach, describe, expect, test } from "bun:test"
import { Effect, Layer, Queue, Ref, Stream, SubscriptionRef } from "effect"
import { KernelClient } from "@/im/kernel/client"
import { KernelSdk } from "@/im/kernel/sdk"
import { pollWithTimeout, testEffect } from "../lib/effect"

// KernelClient over a fake KernelSdk (queue-driven raw events + recorded sends). Covers the state
// machine mapping, the jg:text normalization guards, the 72h lifeTime injection on send, and the
// history normalization. The real SDK (shims/connect) is exercised only by the manual live script —
// never here, so the process-wide singleton guard and the network stay out of the test suite.

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
        fetchHistory: () => Effect.suspend(() => Effect.succeed(historyPayloads)),
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

  test("falls back to local time when the payload carries no sentTime", () => {
    const before = Date.now()
    const msg = KernelClient.normalizeTextMessage(textPayload({ sentTime: undefined }))
    expect(msg?.msgTime).toBeGreaterThanOrEqual(before)
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
  it.live("publishes normalized jg:text messages and drops other payloads", () =>
    Effect.gen(function* () {
      const client = yield* KernelClient.Service
      const scope = yield* Effect.scope
      // A long-lived collector: PubSub drops pre-subscription publishes, so the subscription is
      // proven live with a warm-up offer (republished until seen) before the real sequence fires.
      const received = yield* Ref.make<Array<KernelClient.KernelTextMessage>>([])
      yield* Stream.runForEach(client.messages, (msg) => Ref.update(received, (arr) => [...arr, msg])).pipe(
        Effect.forkIn(scope),
      )
      const countOf = (messageID: string) =>
        Effect.gen(function* () {
          const arr = yield* Ref.get(received)
          return arr.filter((msg) => msg.messageID === messageID).length
        })
      yield* pollWithTimeout(
        Effect.gen(function* () {
          yield* Queue.offer(rawQueue, { tag: "message_received", payload: textPayload({ messageId: "km_warm" }) })
          const count = yield* countOf("km_warm")
          return count >= 1 ? (true as const) : undefined
        }),
        "messages subscription never went live",
      )

      yield* Queue.offer(rawQueue, { tag: "message_received", payload: textPayload({ name: "jg:file" }) })
      yield* Queue.offer(rawQueue, { tag: "message_received", payload: textPayload({ messageId: 42 }) })
      yield* Queue.offer(rawQueue, { tag: "message_received", payload: textPayload() })
      yield* pollWithTimeout(
        Effect.gen(function* () {
          const count = yield* countOf("km_1")
          return count === 1 ? (true as const) : undefined
        }),
        "normalized message never arrived",
      )

      const arr = yield* Ref.get(received)
      expect(arr.filter((msg) => msg.messageID === "km_1")).toEqual([
        {
          messageID: "km_1",
          conversationType: 1,
          conversationID: "bob",
          senderID: "bob",
          text: "hello",
          msgTime: 1_700_000_000_000,
        },
      ])
      expect(arr.every((msg) => msg.messageID === "km_warm" || msg.messageID === "km_1")).toBe(true)
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
      const msgs = yield* client.fetchHistory({ conversationType: 1, conversationID: "bob" })
      expect(msgs.map((msg) => msg.messageID)).toEqual(["km_h1"])
      expect(msgs[0]?.msgTime).toBe(1_700_000_100_000)
    }),
  )
})

describe("KernelClient sendText", () => {
  it.live("injects the 72h lifeTime and resolves the ack messageId", () =>
    Effect.gen(function* () {
      const client = yield* KernelClient.Service
      const result = yield* client.sendText({ conversationType: 1, conversationID: "bob", text: "hi bob" })
      expect(result).toEqual({ messageID: "km_ack_1" })
      expect(KernelClient.MESSAGE_TTL_MS).toBe(259_200_000)
      expect(sentMessages).toEqual([
        { conversationType: 1, conversationID: "bob", text: "hi bob", lifeTime: 259_200_000 },
      ])
    }),
  )

  it.live("propagates a kernel send failure as KernelError", () =>
    Effect.gen(function* () {
      const client = yield* KernelClient.Service
      sendResult = Effect.fail(
        new KernelSdk.KernelError({ operation: "sendMessage", message: "kernel ack carried no messageId" }),
      )
      const error = yield* Effect.flip(client.sendText({ conversationType: 1, conversationID: "bob", text: "hi" }))
      expect(error instanceof KernelSdk.KernelError).toBe(true)
      expect(error.operation).toBe("sendMessage")
      expect(sentMessages).toHaveLength(1)
    }),
  )
})
