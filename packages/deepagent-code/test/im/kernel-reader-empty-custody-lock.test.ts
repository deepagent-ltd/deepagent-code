import { afterAll, expect, test } from "bun:test"
import { Deferred, Effect, Fiber, Layer, SubscriptionRef } from "effect"
import { sql } from "drizzle-orm"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { Database } from "@deepagent-code/core/database/database"
import { IMBroadcasterLive } from "@deepagent-code/core/im/broadcaster"
import { KernelDelivery } from "@deepagent-code/core/im/kernel-delivery"
import { KernelReader } from "@deepagent-code/core/im/kernel-reader"
import { KernelClient } from "@/im/kernel/client"
import { KernelSdk } from "@/im/kernel/sdk"
import { IMKernelReader } from "@/im/kernel/reader"
import { makeNativeV2Peer } from "./fixture/kernel-native-v2-peer"
import { pollWithTimeout } from "../lib/effect"

const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "kernel-empty-custody-lock-")))
const selected = process.env.DEEPAGENT_CODE_TEST_EMPTY_CUSTODY_LOCK
const scenarios = ["current", "owner-withdrawn", "source-withdrawn"]
afterAll(() => fs.rm(root, { recursive: true, force: true }))

// The published SDK is process-global. Each scenario gets its normal original
// connection, file database and scope instead of replacing native handles.
if (!selected) {
  for (const scenario of scenarios) test(`isolated empty sender custody and output lock: ${scenario}`, async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      cwd: path.resolve(import.meta.dir, "../.."),
      env: { ...process.env, DEEPAGENT_CODE_TEST_EMPTY_CUSTODY_LOCK: scenario },
      stdout: "pipe", stderr: "pipe",
    })
    const result = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    expect(result[0], `${result[1]}\n${result[2]}`).toBe(0)
    expect(result[2]).toContain("1 pass")
    expect(result[2]).toContain("0 fail")
  }, 30000)
}

if (selected) test("empty custody survives a real protected output lock past one second without losing current owner fences", async () => {
  const directory = await fs.mkdtemp(path.join(root, "case-"))
  const native = makeNativeV2Peer()
  native.addMessage("initial-current")
  const owner = { current: true }
  try {
    await Effect.runPromise(Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const client = yield* KernelClient.Service
      yield* pollWithTimeout(SubscriptionRef.get(client.state).pipe(Effect.map((value) => value === "connected" ? true : undefined)), "actual native SDK did not connect")
      const reader = yield* IMKernelReader.make(native.config, { workspaceID: directory,
        ownerCurrent: () => owner.current,
        inspectConversation: (input) => Effect.succeed({ conversation_type: input.conversationType,
          conversation_id: input.conversationID, org_id: 1, name: "Sender", member_uuids: ["receiver", "sender"] }) })
      yield* reader.sync
      const projection = yield* KernelReader.projection(reader.runtime, native.projectionKey)
      if (!projection?.local_group_id) return yield* Effect.die("ACTUAL_PROJECTION_REQUIRED")
      expect(yield* KernelDelivery.hasSenderCustody(reader.runtime)).toBe(false)
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const syncStarted = yield* Deferred.make<void>()
      const output = yield* Effect.forkChild(reader.withOutput({ workspaceID: directory, userID: "server", groupIDs: [projection.local_group_id] },
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))).pipe(Effect.result))
      yield* Deferred.await(entered)
      native.addMessage("after-contended-lock")
      native.requests.length = 0
      const sync = yield* Effect.forkChild(Deferred.succeed(syncStarted, undefined).pipe(Effect.andThen(reader.syncSlice)))
      yield* Deferred.await(syncStarted)
      // This is the regression's actual lock duration, not a readiness sleep.
      yield* Effect.sleep("1200 millis")
      expect(native.requests.filter((request) => request.topic === "qry_delivery_reader")).toHaveLength(0)
      if (selected === "owner-withdrawn") owner.current = false
      if (selected === "source-withdrawn") native.config.token = "withdrawn-current-credential"
      yield* Deferred.succeed(release, undefined)
      const previousOutput = yield* Fiber.join(output)
      expect(previousOutput._tag).toBe("Failure")
      yield* Fiber.join(sync)
      if (selected === "current") {
        expect(native.requests.filter((request) => request.topic === "qry_delivery_reader")).toHaveLength(1)
        expect(native.requests.length).toBeLessThanOrEqual(4)
        expect((yield* SubscriptionRef.get(reader.state)).state).toBe("ready")
        expect((yield* KernelReader.scope(reader.runtime))?.completed_after).toBe(native.state.cursor)
        expect(yield* db.get(sql`SELECT count(*) count FROM im_kernel_reader_message WHERE message_id='after-contended-lock' AND storage_state='present'`)).toEqual({ count: 1 })
        expect(yield* KernelDelivery.hasSenderCustody(reader.runtime)).toBe(false)
      }
      if (selected !== "current") {
        expect((yield* SubscriptionRef.get(reader.state)).state).toBe("unavailable")
        expect(native.requests).toHaveLength(0)
        expect(yield* db.get(sql`SELECT count(*) count FROM im_kernel_reader_message WHERE message_id='after-contended-lock'`)).toEqual({ count: 0 })
        expect((yield* KernelDelivery.hasSenderCustody(reader.runtime).pipe(Effect.result))._tag).toBe("Failure")
      }
      expect(native.errors).toEqual([])
      expect(yield* db.get(sql`SELECT count(*) count FROM im_kernel_delivery`)).toEqual({ count: 0 })
      expect(yield* db.get(sql`SELECT count(*) count FROM im_kernel_media_body`)).toEqual({ count: 0 })
      expect(yield* db.get(sql`SELECT count(*) count FROM im_reply_body`)).toEqual({ count: 0 })
      expect(yield* db.get(sql`SELECT count(*) count FROM im_reply_outbox`)).toEqual({ count: 0 })
      expect(yield* db.get(sql`SELECT count(*) count FROM session_v2_provider_turn_receipt`)).toEqual({ count: 0 })
    }).pipe(Effect.provide(Layer.mergeAll(Database.layerFromPath(path.join(directory, "case.sqlite")), IMBroadcasterLive,
      KernelClient.layer.pipe(Layer.provide(KernelSdk.liveFromConfig(native.config))))), Effect.scoped))
  } finally {
    await native.stop()
  }
  expect(native.state.disconnected).toBe(1)
  expect(native.server.pendingRequests).toBe(0)
  expect(native.server.pendingWebSockets).toBe(0)
}, 15000)
