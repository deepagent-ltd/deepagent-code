import { expect, test } from "bun:test"
import { Effect, Layer, SubscriptionRef } from "effect"
import { sql } from "drizzle-orm"
import fs from "node:fs/promises"
import path from "node:path"
import { Database } from "@deepagent-code/core/database/database"
import { IMBroadcasterLive } from "@deepagent-code/core/im/broadcaster"
import { KernelReader } from "@deepagent-code/core/im/kernel-reader"
import { KernelClient } from "@/im/kernel/client"
import { KernelSdk } from "@/im/kernel/sdk"
import { IMKernelReader } from "@/im/kernel/reader"
import { KernelLiveFirstSeenFixture } from "./fixture/kernel-live-first-seen"
import { pollWithTimeout } from "../lib/effect"


test("a slow mandatory SDK header cannot starve bounded background discovery", async () => {
  const directory = await fs.mkdtemp("/tmp/dac-reader-header-progress-")
  const latency = { active: false }
  const native = KernelLiveFirstSeenFixture.make({ queryDelayMs: (topic) => latency.active && topic === "qry_delivery_reader" ? 1100 : 0 })
  const config = { appkey: `private-header-progress-${native.server.port}`, navigator: native.server.url.origin,
    token: "private-first-seen-token", userID: "receiver", protectedMedia: false,
    identity: { uuid: "receiver", orgID: 1, name: "Receiver", orgAllGroupID: "unused" } }
  const execute = Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const client = yield* KernelClient.Service
    yield* pollWithTimeout(SubscriptionRef.get(client.state).pipe(Effect.map((value) => value === "connected" ? true : undefined)), "original SDK did not connect")
    const reader = yield* IMKernelReader.make(config, { workspaceID: directory, requestGate: (effect) => effect,
      inspectConversation: (input) => Effect.succeed({ conversation_type: input.conversationType,
        conversation_id: input.conversationID, org_id: 1, name: "Sender", member_uuids: ["receiver", "sender"] }) })
    yield* reader.sync
    const before = (yield* KernelReader.scope(reader.runtime))!
    native.add("slow-header-progress", { publish: false })
    latency.active = true
    native.topics.length = 0
    yield* reader.syncSlice
    expect(native.topics).toContain("qry_delivery_changes")
    expect(native.topics.length).toBeLessThanOrEqual(4)
    native.topics.length = 0
    yield* reader.syncSlice
    expect(native.topics.length).toBeLessThanOrEqual(4)
    expect((yield* KernelReader.scope(reader.runtime))!.completed_after).toBe(String(native.state.revision))
    expect((yield* KernelReader.scope(reader.runtime))!.completed_after).not.toBe(before.completed_after)
    expect(yield* db.get(sql`SELECT count(*) n FROM im_kernel_reader_message WHERE message_id='slow-header-progress' AND storage_state='present'`)).toEqual({ n: 1 })
    expect(yield* db.get(sql`SELECT count(*) n FROM session_v2_provider_turn_receipt`)).toEqual({ n: 0 })
    expect(yield* db.get(sql`SELECT count(*) n FROM im_dac_command`)).toEqual({ n: 0 })
  })
  try {
    await Effect.runPromise(execute.pipe(Effect.provide(Layer.mergeAll(Database.layerFromPath(path.join(directory, "reader.sqlite")),
      IMBroadcasterLive, KernelClient.layer.pipe(Layer.provide(KernelSdk.liveFromConfig(config))))), Effect.scoped))
  } finally {
    await native.server.stop(true)
    await fs.rm(directory, { recursive: true, force: true })
  }
}, 15000)
