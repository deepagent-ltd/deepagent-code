import { expect, test } from "bun:test"
import { Effect, Layer, SubscriptionRef } from "effect"
import { sql } from "drizzle-orm"
import fs from "node:fs/promises"
import path from "node:path"
import { Database } from "@deepagent-code/core/database/database"
import { IMBroadcasterLive } from "@deepagent-code/core/im/broadcaster"
import { KernelReader } from "@deepagent-code/core/im/kernel-reader"
import { KernelReaderSchema } from "@deepagent-code/core/im/kernel-reader.schema"
import { KernelClient } from "@/im/kernel/client"
import { KernelSdk } from "@/im/kernel/sdk"
import { IMKernelReader } from "@/im/kernel/reader"
import { KernelLiveFirstSeenFixture } from "./fixture/kernel-live-first-seen"
import { pollWithTimeout } from "../lib/effect"

test("a slow original SDK newer page persists older work and lets the next projection finish", async () => {
  const directory = await fs.mkdtemp("/tmp/dac-reader-continuation-phase-")
  const alphaKey = "b".repeat(64)
  const gammaKey = "c".repeat(64)
  const latency = { alphaNewer: false }
  const requests: { projectionKey: string; direction: string; anchor: string }[] = []
  const slices: number[] = []
  const native = KernelLiveFirstSeenFixture.make({
    queryDelayMs: (topic) => topic === "qry_delivery_messages" && latency.alphaNewer ? 1100 : 0,
    response: (topic, request, original) => {
      if (!original) return original
      if (topic === "qry_delivery_changes") return { name: original.name, value: { ...original.value,
        scanProjectionKey: Number(request.after || 0) < native.state.revision ? gammaKey : "",
        items: Number(request.after || 0) < native.state.revision ? projections : [] } }
      if (topic !== "qry_delivery_messages") return original
      const projectionKey = String(request.projectionKey)
      const direction = String(request.direction)
      const anchor = String(request.anchorDeliveryCursor || "0")
      if (projectionKey !== alphaKey && projectionKey !== gammaKey) throw new Error("Unexpected fixture projection")
      requests.push({ projectionKey, direction, anchor })
      latency.alphaNewer = projectionKey === alphaKey && direction === "newer"
      const message = projectionKey === alphaKey ? alpha : gamma
      const selected = direction === "older" ? anchor === "0" || BigInt(message.deliveryCursor) < BigInt(anchor)
        : BigInt(message.deliveryCursor) > BigInt(anchor)
      return { name: original.name, value: { ...original.value, projectionKey,
        nextDeliveryCursor: selected ? message.deliveryCursor : "", items: selected ? [message] : [] } }
    },
  })
  const alpha = native.add("continuation-alpha", { publish: false })
  const gamma = { ...native.add("continuation-gamma", { publish: false }), senderId: "gamma-sender", targetId: "gamma-sender" }
  const projections = [alpha, gamma].map((message, index) => ({ visibility: "visible", projectionKey: index === 0 ? alphaKey : gammaKey,
    revision: String(index + 2), cursor: String(index + 2), conversationType: 1, targetId: message.targetId,
    readOrdinal: "0", admittedOrdinal: "1", liveUnread: "1", storedUnread: "1", latestMessageId: message.messageId,
    latestSequence: message.sequence, latestMessageTime: message.messageTime, nextExpiryAt: message.expiresAt }))
  const config = { appkey: `private-continuation-phase-${native.server.port}`, navigator: native.server.url.origin,
    token: "private-first-seen-token", userID: "receiver", protectedMedia: false,
    identity: { uuid: "receiver", orgID: 1, name: "Receiver", orgAllGroupID: "unused" } }
  const execute = Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const client = yield* KernelClient.Service
    yield* pollWithTimeout(SubscriptionRef.get(client.state).pipe(Effect.map((value) => value === "connected" ? true : undefined)), "original SDK did not connect")
    const reader = yield* IMKernelReader.make(config, { workspaceID: directory, requestGate: (effect) => effect,
      inspectConversation: (input) => Effect.succeed({ conversation_type: input.conversationType,
        conversation_id: input.conversationID, org_id: 1, name: input.conversationID,
        member_uuids: ["receiver", input.conversationID] }) })
    native.topics.length = 0
    const started = performance.now()
    yield* reader.syncSlice
    expect(performance.now() - started).toBeGreaterThanOrEqual(1100)
    expect(native.topics).toEqual(["qry_delivery_reader", "qry_delivery_changes", "qry_delivery_messages"])
    slices.push(native.topics.length)
    const stored = yield* KernelReader.scope(reader.runtime)
    if (!stored) return yield* Effect.die(new Error("The original reader did not bind a scope"))
    const first = yield* db.get<{ phase: string; completed_after: string; window_upper: string; continuation: string }>(
      sql`SELECT phase,completed_after,window_upper,continuation FROM im_kernel_reader_scope WHERE reader_key=${stored.reader_key}`)
    if (!first) return yield* Effect.die(new Error("The original reader did not persist a scope"))
    const firstWork = KernelReaderSchema.decode(KernelReaderSchema.Continuation, first.continuation, 8192)
    expect(first.phase).toBe("partial")
    expect(first.completed_after).toBe("0")
    expect(first.window_upper).toBe(String(native.state.revision))
    expect(firstWork.projections).toHaveLength(2)
    expect((yield* KernelReader.projection(reader.runtime, alphaKey))?.newer_after).toBe(alpha.deliveryCursor)
    expect(yield* db.get(sql`SELECT count(*) n FROM im_kernel_reader_message WHERE message_id='continuation-alpha'`)).toEqual({ n: 1 })
    // The RPC has settled and advanced its real projection before the soft
    // budget stops dispatch. Later slices must resume the durable older phase.
    yield* Effect.forEach([0, 1], () => Effect.gen(function* () {
      native.topics.length = 0
      yield* reader.syncSlice
      expect(native.topics.length).toBeLessThanOrEqual(4)
      slices.push(native.topics.length)
    }), { discard: true })
    console.info("continuation-phase-native-summary", JSON.stringify({ slices,
      requests: requests.map((request) => ({ projection: request.projectionKey === alphaKey ? "alpha" : "gamma", direction: request.direction, anchor: request.anchor })),
      persisted: firstWork.projections.map((work) => ({ projection: work.projectionKey === alphaKey ? "alpha" : "gamma", direction: work.direction, anchor: work.anchor })) }))
    expect(firstWork.projections.find((work) => work.projectionKey === alphaKey)?.direction).toBe("older")
    expect(firstWork.projections.find((work) => work.projectionKey === alphaKey)?.phase).toBe("pending")
    expect(requests.filter((request) => request.projectionKey === alphaKey).map((request) => request.direction)).toEqual(["newer", "older"])
    expect(requests.filter((request) => request.projectionKey === gammaKey).map((request) => request.direction)).toEqual(["newer", "older"])
    const finished = yield* KernelReader.scope(reader.runtime)
    if (!finished) return yield* Effect.die(new Error("The original reader lost its scope"))
    expect(finished.phase).toBe("idle")
    expect(finished.completed_after).toBe(String(native.state.revision))
    expect(finished.window_upper).toBeNull()
    expect(KernelReaderSchema.decode(KernelReaderSchema.Continuation, finished.continuation, 8192).projections).toHaveLength(0)
    expect((yield* KernelReader.projection(reader.runtime, alphaKey))?.history_complete).toBe(1)
    expect((yield* KernelReader.projection(reader.runtime, gammaKey))?.history_complete).toBe(1)
    expect((yield* KernelReader.projection(reader.runtime, gammaKey))?.newer_after).toBe(gamma.deliveryCursor)
    expect((yield* SubscriptionRef.get(reader.state)).state).toBe("ready")
    expect(yield* db.get(sql`SELECT count(*) n FROM im_kernel_reader_message WHERE message_id IN ('continuation-alpha','continuation-gamma') AND storage_state='present'`)).toEqual({ n: 2 })
    expect(yield* db.get(sql`SELECT count(*) n FROM im_dac_command`)).toEqual({ n: 0 })
    expect(yield* db.get(sql`SELECT count(*) n FROM work_execution`)).toEqual({ n: 0 })
    expect(yield* db.get(sql`SELECT count(*) n FROM session_v2_provider_turn_receipt`)).toEqual({ n: 0 })
  })
  try {
    await Effect.runPromise(execute.pipe(Effect.provide(Layer.mergeAll(Database.layerFromPath(path.join(directory, "reader.sqlite")),
      IMBroadcasterLive, KernelClient.layer.pipe(Layer.provide(KernelSdk.liveFromConfig(config))))), Effect.scoped))
  } finally {
    await native.server.stop(true)
    await fs.rm(directory, { recursive: true, force: true })
  }
}, 20_000)
