import { expect, test } from "bun:test"
import { Effect, Exit, Layer, SubscriptionRef } from "effect"
import { sql } from "drizzle-orm"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { Database } from "@deepagent-code/core/database/database"
import { IMBroadcasterLive } from "@deepagent-code/core/im/broadcaster"
import { KernelReaderSchema } from "@deepagent-code/core/im/kernel-reader.schema"
import { KernelClient } from "@/im/kernel/client"
import { KernelSdk } from "@/im/kernel/sdk"
import { IMKernelReader } from "@/im/kernel/reader"
import { KernelLiveFirstSeenFixture } from "./fixture/kernel-live-first-seen"

test("original receiver baseline qualifies the first new projection; cold history and cloned tokens remain refused", async () => {
  const directory = await fs.mkdtemp("/tmp/dac-reader-receiver-baseline-")
  const scopeKey = "a".repeat(64)
  const projectionKey = "b".repeat(64)
  const receivers = new Map<string, { version: number; baselineID: string; subscriberID: string; scopeKey: string;
    receiverID: string; acceptanceSendboxID: string; serverNow: number; expiresAt: number }>()
  const cuts = new Map<string, Record<string, unknown>>()
  const native = KernelLiveFirstSeenFixture.make({ receiverBaseline: (topic, request, receiverID) => {
    const subscriberID = String(request.subscriberID)
    if (topic === "qry_delivery_live_receiver_v1") {
      if (!receivers.has(subscriberID)) receivers.set(subscriberID, { version: 1, baselineID: "c".repeat(32), subscriberID, scopeKey,
        receiverID, acceptanceSendboxID: String(native.messages.length), serverNow: Date.now(), expiresAt: Date.now() + 86_400_000 })
      return { version: 1, baseline: receivers.get(subscriberID) }
    }
    const baseline = receivers.get(subscriberID)!
    if (topic === "qry_delivery_live_cut_v1") {
      if (!cuts.has(subscriberID)) cuts.set(subscriberID, { version: 1, cutID: "d".repeat(32), subscriberID, scopeKey, projectionKey,
        conversationScopeKey: "e".repeat(64), acceptanceRevision: "0", receiverID, serverNow: Date.now(), expiresAt: baseline.expiresAt,
        receiverBaselineID: baseline.baselineID, acceptanceSendboxID: baseline.acceptanceSendboxID })
      return { version: 1, cut: cuts.get(subscriberID) }
    }
    const items = native.messages.filter((item) => BigInt(item.deliveryCursor) > BigInt(String(request.anchorDeliveryCursor ?? "0")))
      .slice(0, Number(request.limit)).map((item) => ({ ...item, messageType: "jg:text" }))
    return { version: 1, cutID: request.cutID, page: { version: 2, scopeKey, projectionKey,
      projectionRevision: request.projectionRevision, direction: "newer", nextDeliveryCursor: items.at(-1)?.deliveryCursor ?? "",
      finished: true, serverNow: Date.now(), items }, proofs: items.filter((item) => BigInt(item.sequence) > BigInt(baseline.acceptanceSendboxID))
      .map((item) => ({ effectKey: item.effectKey, conversationScopeKey: "e".repeat(64), allocationRevision: item.sequence,
        acceptedSendboxID: item.sequence, contentHash: createHash("sha256").update(item.content).digest("hex") })) }
  } })
  const config = { appkey: `private-baseline-${native.server.port}`, navigator: native.server.url.origin,
    token: "private-first-seen-token", userID: "receiver", protectedMedia: false,
    identity: { uuid: "receiver", orgID: 1, name: "Receiver", orgAllGroupID: "unused" } }
  const execute = (name: string, cold: boolean) => Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const client = yield* KernelClient.Service
    for (const attempt of Array.from({ length: 100 }, (_, index) => index)) {
      if ((yield* SubscriptionRef.get(client.state)) === "connected") break
      if (attempt === 99) return yield* Effect.die(new Error("Original receiver SDK did not connect"))
      yield* Effect.sleep("10 millis")
    }
    expect(Exit.isFailure(yield* client.media!.capabilities().pipe(Effect.exit))).toBe(true)
    expect(native.topics.some((topic) => topic.includes("media"))).toBe(false)
    const reader = yield* IMKernelReader.make(config, { workspaceID: path.join(directory, name),
      inspectConversation: (input) => Effect.succeed({ conversation_type: input.conversationType, conversation_id: input.conversationID,
        org_id: 1, name: "Sender", member_uuids: ["receiver", "sender"] }), requestGate: (effect) => effect })
    yield* reader.sync
    if (!cold) {
      expect(native.messages).toEqual([])
      expect(native.topics.indexOf("qry_delivery_live_receiver_v1")).toBeLessThan(native.topics.indexOf("qry_delivery_changes"))
      native.add("first-new-dm", { publish: false })
    }
    for (const attempt of Array.from({ length: 8 }, (_, index) => index)) {
      yield* reader.sync
      if (yield* db.get(sql`SELECT 1 AS present FROM im_kernel_reader_message WHERE message_id='first-new-dm'`)) break
      if (attempt === 7) return yield* Effect.die(new Error("Original first projection was not inserted"))
    }
    const record = yield* db.get<{ metadata: string; immutable_hash: string }>(sql`SELECT metadata,immutable_hash FROM im_kernel_reader_message WHERE message_id='first-new-dm'`)
    expect(KernelReaderSchema.decode(KernelReaderSchema.MessageMetadata, record!.metadata, 2048).firstSeen?.origin).toBe(cold ? "history" : "kernel_live")
    yield* reader.sync
    expect(yield* db.get(sql`SELECT metadata,immutable_hash FROM im_kernel_reader_message WHERE message_id='first-new-dm'`)).toEqual(record)
    const token = yield* client.getDeliveryReceiverBaseline!({ subscriberID: "f".repeat(32), scopeKey })
    expect(client.readReceiverBaseline!(token)).toBe(true)
    expect(client.readReceiverBaseline!({ ...token })).toBe(false)
    expect(Exit.isFailure(yield* client.getDeliveryLiveCut!({ version: 2, subscriberID: "f".repeat(32), scopeKey, projectionKey,
      projectionRevision: String(native.state.revision) }, { ...token }).pipe(Effect.exit))).toBe(true)
    yield* client.disconnect
    expect(client.readReceiverBaseline!(token)).toBe(false)
    expect(yield* db.get(sql`SELECT count(*) n FROM work_execution`)).toEqual({ n: 0 })
  })
  try {
    for (const name of ["fresh", "cold"]) await Effect.runPromise(execute(name, name === "cold").pipe(Effect.provide(
      Layer.mergeAll(Database.layerFromPath(path.join(directory, `${name}.sqlite`)), IMBroadcasterLive,
        KernelClient.layer.pipe(Layer.provide(KernelSdk.liveFromConfig(config)))),
    ), Effect.scoped))
  } finally {
    await native.server.stop(true)
    await fs.rm(directory, { recursive: true, force: true })
  }
}, 15_000)
