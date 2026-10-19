import { expect, test } from "bun:test"
import { Effect, Layer, SubscriptionRef } from "effect"
import { sql } from "drizzle-orm"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { Database } from "@deepagent-code/core/database/database"
import { IMBroadcasterLive } from "@deepagent-code/core/im/broadcaster"
import { IMRepository, IMRepositoryLive } from "@deepagent-code/core/im/repository"
import { KernelDelivery } from "@deepagent-code/core/im/kernel-delivery"
import { KernelReader } from "@deepagent-code/core/im/kernel-reader"
import { KernelClient } from "@/im/kernel/client"
import { KernelConfig } from "@/im/kernel/config"
import { KernelSdk } from "@/im/kernel/sdk"
import { IMKernelReader } from "@/im/kernel/reader"
import { KernelLiveFirstSeenFixture } from "./fixture/kernel-live-first-seen"
import { pollWithTimeout } from "../lib/effect"

const cases = ["v2-fairness", "slow-budget", "body-mismatch", "stale-revision"] as const
const selected = process.env.DEEPAGENT_CODE_TEST_NATIVE_SENDER_RECOVERY_CASE
// The actual SDK owns one process-global connection. Each case uses its normal fresh process.
if (!selected) for (const scenario of cases) test(`isolated actual V2 sender recovery: ${scenario}`, async () => {
  const child = Bun.spawn([process.execPath, "test", import.meta.path], { cwd: path.resolve(import.meta.dir, "../.."), env: { ...process.env, DEEPAGENT_CODE_TEST_NATIVE_SENDER_RECOVERY_CASE: scenario }, stdout: "pipe", stderr: "pipe" })
  const result = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  expect(result[0], `${result[1]}\n${result[2]}`).toBe(0)
  expect(result[2]).toContain("1 pass")
  expect(result[2]).toContain("0 fail")
}, 30000)
for (const scenario of cases) {
  if (selected !== scenario) continue
  test(`actual V2 SDK sender recovery: ${scenario}`, async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dac-reader-sender-recovery-"))
    const scopeKey = "a".repeat(64)
    const projectionKey = "b".repeat(64)
    const control = { armed: false }
    const baselines = new Map<string, { baselineID: string; subscriberID: string; acceptanceSendboxID: string; expiresAt: number }>()
    const cuts = new Map<string, Record<string, unknown>>()
    const recoveryRequests: { limit: number; anchor: string }[] = []
    // Same real protobuf/private capability producer as the receiver-baseline fixture.
    // Original SDK code creates and checks every opaque receiver/cut handle.
    const native = KernelLiveFirstSeenFixture.make({
      queryDelayMs: (topic) => control.armed && scenario === "slow-budget" && topic === "qry_delivery_changes" ? 1100 : 0,
      receiverBaseline: (topic, request, receiverID) => {
        const subscriberID = String(request.subscriberID)
        if (topic === "qry_delivery_live_receiver_v1") {
          if (!baselines.has(subscriberID)) baselines.set(subscriberID, { baselineID: "c".repeat(32), subscriberID, acceptanceSendboxID: String(native.messages.length), expiresAt: Date.now() + 86_400_000 })
          return { version: 1, baseline: { version: 1, ...baselines.get(subscriberID)!, scopeKey, receiverID, serverNow: Date.now() } }
        }
        const baseline = baselines.get(subscriberID)!
        if (topic === "qry_delivery_live_cut_v1") {
          if (!cuts.has(subscriberID)) cuts.set(subscriberID, { version: 1, cutID: "d".repeat(32), subscriberID, scopeKey, projectionKey, conversationScopeKey: "e".repeat(64), acceptanceRevision: "0", receiverID, serverNow: Date.now(), expiresAt: baseline.expiresAt, receiverBaselineID: baseline.baselineID, acceptanceSendboxID: baseline.acceptanceSendboxID })
          return { version: 1, cut: cuts.get(subscriberID) }
        }
        const rows = native.messages.filter((item) => BigInt(item.deliveryCursor) > BigInt(String(request.anchorDeliveryCursor ?? "0")))
        const items = rows.slice(0, Number(request.limit)).map((item) => ({ ...item, messageType: "jg:text" }))
        return { version: 1, cutID: request.cutID, page: { version: 2, scopeKey, projectionKey, projectionRevision: request.projectionRevision, direction: "newer", nextDeliveryCursor: items.at(-1)?.deliveryCursor ?? "", finished: items.length === rows.length, serverNow: Date.now(), items }, proofs: items.filter((item) => BigInt(item.sequence) > BigInt(baseline.acceptanceSendboxID)).map((item) => ({ effectKey: item.effectKey, conversationScopeKey: "e".repeat(64), allocationRevision: item.sequence, acceptedSendboxID: item.sequence, contentHash: createHash("sha256").update(item.content).digest("hex") })) }
      },
      response: (topic, request, original) => {
        if (!control.armed || topic !== "qry_delivery_messages" || !original) return original
        recoveryRequests.push({ limit: Number(request.limit), anchor: String(request.anchorDeliveryCursor ?? "0") })
        if (scenario === "body-mismatch") return { ...original, value: { ...original.value, items: (original.value.items as Record<string, unknown>[]).map((item, index) => index === 0 ? { ...item, content: '{"content":"different current echo"}' } : item) } }
        if (scenario === "stale-revision") return { ...original, value: { ...original.value, projectionRevision: (BigInt(String(request.projectionRevision)) + 1n).toString() } }
        return original
      },
    })
    const config = { appkey: `private-sender-recovery-${native.server.port}`, navigator: native.server.url.origin, token: "private-first-seen-token", userID: "receiver", protectedMedia: false, identity: { uuid: "receiver", orgID: 1, name: "Receiver", orgAllGroupID: "unused" } }
    const execute = Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const repo = yield* IMRepository
      const client = yield* KernelClient.Service
      yield* pollWithTimeout(SubscriptionRef.get(client.state).pipe(Effect.map((value) => value === "connected" ? true : undefined)), "original SDK did not connect")
      // Historical custody is seeded through existing production issuers, never SQL inserts
      // or mocked senderRecovery. It is not evidence of a new Native send authorization.
      const oldSource = { ...KernelConfig.deliverySource(config), credentialFingerprint: "f".repeat(64) }
      const old = KernelReader.attach({ db, workspaceID: directory, userID: "server", source: oldSource, current: () => Effect.succeed(true), inspect: () => Effect.succeed({ name: "Sender" }), readCut: (request) => Effect.succeed({ ...request, throughOrdinal: "0", targetAdmittedOrdinal: "0", readOrdinal: "0", liveUnread: "0", storedUnread: "0", serverNow: Date.now(), complete: true }) })
      const authority = KernelDelivery.runtime(oldSource)
      yield* Effect.addFinalizer(() => Effect.sync(() => { KernelReader.close(old); KernelDelivery.close(authority) }))
      yield* KernelReader.bind(old, scopeKey, 2)
      yield* KernelReader.ensureScope(old)
      const change = () => ({ visibility: "visible" as const, projectionKey, revision: String(native.state.revision), cursor: String(native.state.revision), conversationType: 1 as const, targetId: "sender", readOrdinal: "0", admittedOrdinal: String(native.messages.length), liveUnread: "0", storedUnread: "0", latestMessageId: native.messages.at(-1)?.messageId ?? "", latestSequence: native.messages.at(-1)?.sequence ?? "", latestMessageTime: native.messages.at(-1)?.messageTime ?? 0, nextExpiryAt: native.messages.at(-1)?.expiresAt ?? 0 })
      const changes = (after: string) => ({ version: 2 as const, scopeKey, after, upper: String(native.state.revision), scanCursor: String(native.state.revision), scanProjectionKey: projectionKey, pageToken: "", windowComplete: true, caughtUp: true, serverNow: Date.now(), items: [change()] })
      yield* KernelReader.applyChanges(old, changes("0"))
      const groupID = (yield* KernelReader.projection(old, projectionKey))!.local_group_id!
      const count = scenario === "v2-fairness" ? 33 : 32
      for (const index of Array.from({ length: count }, (_, value) => value)) {
        const content = `original owned sender ${index}`
        const message = yield* KernelDelivery.withCreation(authority, groupID, repo.createMessage({ groupID, senderID: "server", senderType: "user", type: "text", content, clientRequestID: `original-owned-${index}` }))
        const dispatch = yield* KernelDelivery.withVerification(authority, { conversationType: 1, conversationID: "sender", orgID: 1, memberIDs: ["receiver", "sender"] }, repo.claimKernelDelivery(authority, message.id))
        if (!dispatch) return yield* Effect.die(new Error("Original historical dispatch was not admitted"))
        yield* repo.acknowledgeKernelDelivery(authority, dispatch, `original-owned-${index}`)
        Object.assign(native.add(`original-owned-${index}`, { publish: false }), { senderId: "receiver", isSend: true, expiresAt: dispatch.binding.expiresAt, content: JSON.stringify({ content }) })
      }
      const page = { version: 2 as const, scopeKey, projectionKey, projectionRevision: "1", direction: "newer" as const, nextDeliveryCursor: "", finished: true, serverNow: Date.now(), items: [] }
      for (let start = 0; start < native.messages.length; start += 32) {
        const items = native.messages.slice(start, start + 32).map((item) => ({ ...item, messageType: "jg:text" as const }))
        yield* KernelReader.applyMessages(old, { ...page, nextDeliveryCursor: items.at(-1)!.deliveryCursor, items })
      }
      yield* KernelReader.applyMessages(old, { ...page, direction: "older" })
      yield* KernelReader.checkpoint(old, [projectionKey], true)
      const beforeReceipts = yield* db.all(sql`SELECT message_id,binding,binding_hash,state,kernel_message_id FROM im_kernel_delivery ORDER BY message_id`)
      native.add("new-current-received", { publish: false })
      yield* KernelReader.applyChanges(old, changes("1"))
      KernelReader.close(old)
      KernelDelivery.close(authority)
      const reader = yield* IMKernelReader.make(config, { workspaceID: directory, requestGate: (effect) => effect, inspectConversation: (input) => Effect.succeed({ conversation_type: input.conversationType, conversation_id: input.conversationID, org_id: 1, name: "Sender", member_uuids: ["receiver", "sender"] }) })
      const pending = () => db.get<{ count: number }>(sql`SELECT count(*) count FROM im_kernel_reader_message WHERE owns_message=0 AND storage_state='present'`)
      native.topics.length = 0
      yield* reader.syncSlice
      // A pending recovery queue must not steal the fourth slot needed by private V2.
      expect(native.topics).toEqual(["qry_delivery_reader", "qry_delivery_live_receiver_v1", "qry_delivery_live_cut_v1", "qry_delivery_live_page_v1"])
      expect((yield* pending())?.count).toBe(count)
      expect(yield* db.get(sql`SELECT count(*) count FROM im_kernel_reader_message WHERE message_id='new-current-received'`)).toEqual({ count: 1 })
      const before = (yield* KernelReader.projection(reader.runtime, projectionKey))!
      const beforeContinuation = (yield* KernelReader.scope(reader.runtime))!.continuation
      native.topics.length = 0
      control.armed = true
      const started = performance.now()
      yield* reader.syncSlice
      expect(native.topics.length).toBeLessThanOrEqual(4)
      expect(native.topics[0]).toBe("qry_delivery_reader")
      expect(native.topics.indexOf("qry_delivery_changes")).toBeLessThan(native.topics.indexOf("qry_delivery_messages"))
      expect(recoveryRequests).toHaveLength(1)
      expect(recoveryRequests[0]!.limit).toBe(32)
      if (scenario === "slow-budget") expect(performance.now() - started).toBeGreaterThanOrEqual(1100)
      const after = (yield* KernelReader.projection(reader.runtime, projectionKey))!
      expect([after.newer_after, after.older_before, after.history_complete]).toEqual([before.newer_after, before.older_before, before.history_complete])
      expect((yield* KernelReader.scope(reader.runtime))!.continuation).toBe(beforeContinuation)
      expect(yield* db.all(sql`SELECT message_id,binding,binding_hash,state,kernel_message_id FROM im_kernel_delivery ORDER BY message_id`)).toEqual(beforeReceipts)
      if (scenario === "body-mismatch" || scenario === "stale-revision") {
        expect((yield* SubscriptionRef.get(reader.state)).state).toBe("unavailable")
        expect((yield* pending())?.count).toBe(count)
      } else {
        const remaining = (yield* pending())!.count
        expect(remaining).toBeLessThan(count)
        expect(count - remaining).toBeLessThanOrEqual(32)
        if (scenario === "slow-budget") expect(remaining).toBe(0)
        if (scenario === "v2-fairness") {
          native.add("new-current-received-after-recovery", { publish: false })
          native.topics.length = 0
          yield* reader.syncSlice
          expect(native.topics.length).toBeLessThanOrEqual(4)
          expect(native.topics).toContain("qry_delivery_changes")
          expect(native.topics).toContain("qry_delivery_live_page_v1")
          expect(yield* db.get(sql`SELECT count(*) count FROM im_kernel_reader_message WHERE message_id='new-current-received-after-recovery'`)).toEqual({ count: 1 })
        }
        // Repeat only the remaining real work; every slice remains within the original budget.
        for (const round of [0, 1]) {
          if (!(yield* pending())!.count) break
          native.topics.length = 0
          yield* reader.syncSlice
          expect(native.topics.length).toBeLessThanOrEqual(4)
        }
        expect((yield* pending())?.count).toBe(0)
      }
      expect(yield* db.get(sql`SELECT count(*) count FROM session_v2_provider_turn_receipt`)).toEqual({ count: 0 })
      expect(yield* db.get(sql`SELECT count(*) count FROM work_execution`)).toEqual({ count: 0 })
    })
    const database = Database.layerFromPath(path.join(directory, "reader.sqlite"))
    try {
      await Effect.runPromise(execute.pipe(Effect.provide(Layer.mergeAll(Layer.provideMerge(IMRepositoryLive, database), IMBroadcasterLive, KernelClient.layer.pipe(Layer.provide(KernelSdk.liveFromConfig(config))))), Effect.scoped))
    } finally {
      await native.server.stop(true)
      await fs.rm(directory, { recursive: true, force: true })
    }
  }, 20000)
}
