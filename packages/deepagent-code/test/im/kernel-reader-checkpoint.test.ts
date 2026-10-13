import { expect, test } from "bun:test"
import { Effect, Fiber, Layer, SubscriptionRef } from "effect"
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

test("original delayed SDK reader checkpoints a bounded slice and refuses a retired owner's late page", async () => {
  const directory = await fs.mkdtemp("/tmp/dac-reader-checkpoint-")
  const latency = { active: false }
  const owner = { current: true }
  const native = KernelLiveFirstSeenFixture.make({ queryDelayMs: (topic) => latency.active ?
    topic === "qry_delivery_reader" ? 600 : topic === "qry_delivery_changes" ? 1000 : 0 : 0 })
  const config = { appkey: `private-checkpoint-${native.server.port}`, navigator: native.server.url.origin,
    token: "private-first-seen-token", userID: "receiver", protectedMedia: false,
    identity: { uuid: "receiver", orgID: 1, name: "Receiver", orgAllGroupID: "unused" } }
  const execute = Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const client = yield* KernelClient.Service
    yield* pollWithTimeout(SubscriptionRef.get(client.state).pipe(Effect.map((value) => value === "connected" ? true : undefined)), "original SDK did not connect")
    const reader = yield* IMKernelReader.make(config, { workspaceID: directory, instanceCurrent: Effect.sync(() => owner.current),
      requestGate: (effect) => effect, inspectConversation: (input) => Effect.succeed({ conversation_type: input.conversationType,
        conversation_id: input.conversationID, org_id: 1, name: "Sender", member_uuids: ["receiver", "sender"] }).pipe(Effect.delay("200 millis")) })
    yield* reader.sync
    const before = (yield* KernelReader.scope(reader.runtime))!
    expect(before.phase).toBe("idle")
    native.add("delayed-checkpoint", { publish: false })
    native.topics.length = 0
    latency.active = true
    yield* reader.syncSlice
    const first = yield* db.get<{ phase: string; completed_after: string; continuation: string }>(sql`SELECT phase,completed_after,continuation FROM im_kernel_reader_scope WHERE reader_key=${before.reader_key}`)
    expect(native.topics).toEqual(["qry_delivery_reader", "qry_delivery_changes"])
    expect(first!.completed_after).toBe(before.completed_after)
    expect(yield* db.get(sql`SELECT count(*) n FROM im_kernel_reader_message WHERE message_id='delayed-checkpoint'`)).toEqual({ n: 0 })
    expect(first!.phase).toBe("partial")
    expect(KernelReaderSchema.decode(KernelReaderSchema.Continuation, first!.continuation, 8192).projections).toHaveLength(1)
    native.topics.length = 0
    yield* reader.syncSlice
    expect(native.topics.length).toBeLessThanOrEqual(4)
    expect(native.topics.slice(0, 2)).toEqual(["qry_delivery_reader", "qry_delivery_messages"])
    expect(yield* db.get(sql`SELECT count(*) n FROM im_kernel_reader_message WHERE message_id='delayed-checkpoint' AND storage_state='present'`)).toEqual({ n: 1 })
    expect((yield* KernelReader.scope(reader.runtime))!.completed_after).toBe(String(native.state.revision))
    expect((yield* SubscriptionRef.get(reader.state)).state).toBe("ready")
    expect(yield* db.get(sql`SELECT count(*) n FROM im_dac_command`)).toEqual({ n: 0 })
    expect(yield* db.get(sql`SELECT count(*) n FROM session_v2_provider_turn_receipt`)).toEqual({ n: 0 })
    const completed = (yield* KernelReader.scope(reader.runtime))!
    native.add("late-retired-checkpoint", { publish: false })
    native.topics.length = 0
    const pass = yield* Effect.forkChild(reader.syncSlice.pipe(Effect.exit))
    yield* pollWithTimeout(Effect.sync(() => native.topics.includes("qry_delivery_changes") ? true : undefined), "changes was not dispatched")
    owner.current = false
    yield* Fiber.join(pass)
    const retired = yield* db.get<{ phase: string; completed_after: string; continuation: string }>(sql`SELECT phase,completed_after,continuation FROM im_kernel_reader_scope WHERE reader_key=${before.reader_key}`)
    expect(native.topics).toEqual(["qry_delivery_reader", "qry_delivery_changes"])
    expect(retired!.phase).toBe("idle")
    expect(retired!.completed_after).toBe(completed.completed_after)
    expect(retired!.continuation).toBe(completed.continuation)
    expect(yield* db.get(sql`SELECT count(*) n FROM im_kernel_reader_message WHERE message_id='late-retired-checkpoint'`)).toEqual({ n: 0 })
    expect((yield* SubscriptionRef.get(reader.state)).state).toBe("unavailable")
  })
  try {
    await Effect.runPromise(execute.pipe(Effect.provide(Layer.mergeAll(Database.layerFromPath(path.join(directory, "reader.sqlite")),
      IMBroadcasterLive, KernelClient.layer.pipe(Layer.provide(KernelSdk.liveFromConfig(config))))), Effect.scoped))
  } finally {
    await native.server.stop(true)
    await fs.rm(directory, { recursive: true, force: true })
  }
}, 15000)
