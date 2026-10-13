import { expect, test } from "bun:test"
import { Effect, Layer, SubscriptionRef } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@deepagent-code/core/database/database"
import { KernelReader } from "@deepagent-code/core/im/kernel-reader"
import { KernelReaderSchema } from "@deepagent-code/core/im/kernel-reader.schema"
import { KernelSdk } from "@/im/kernel/sdk"
import { KernelClient } from "@/im/kernel/client"
import { KernelConfig } from "@/im/kernel/config"
import { KernelLiveFirstSeenFixture } from "./fixture/kernel-live-first-seen"
import fs from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "node:os"

// V1 has no combined authorization capability. A multi-row page must not
// silently recreate the independent scalar proofs that can age each other.
test("legacy mixed output refuses before native or inspection fanout and preserves existing durable rows", async () => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "dac-reader-legacy-mixed-output-"))
  const calls = { phase: "seed", inspect: 0, scalar: 0, batch: 0 }
  const native = KernelLiveFirstSeenFixture.make({ fetch(request) {
    if (new URL(request.url).pathname !== "/inspect") return undefined
    if (request.headers.get("authorization") !== "Bearer private-first-seen-token") return Response.json({}, { status: 403 })
    if (calls.phase === "output") calls.inspect++
    return Response.json({ name: "Authenticated legacy group" })
  } })
  const config = { appkey: `private-legacy-mixed-${native.server.port}`, navigator: native.server.url.origin, token: "private-first-seen-token", userID: "receiver",
    identity: { uuid: "receiver", orgID: 1, name: "Receiver", orgAllGroupID: "unused" } }
  try {
    await Effect.runPromise(Effect.gen(function* () {
      const connection = yield* KernelClient.Service
      const sdk = yield* KernelSdk.Service
      for (const round of Array.from({ length: 200 }, (_, index) => index)) {
        if ((yield* SubscriptionRef.get(connection.state)) === "connected") break
        if (round === 199) return yield* Effect.die("ACTUAL_LEGACY_SDK_NOT_CONNECTED")
        yield* Effect.sleep("10 millis")
      }
      const info = yield* sdk.getDeliveryReader()
      expect(info.version).toBe(1)
      const db = (yield* Database.Service).db
      const runtime = KernelReader.attach({ db, workspaceID: "legacy-workspace", userID: "server", source: KernelConfig.deliverySource(config),
        current: () => SubscriptionRef.get(connection.state).pipe(Effect.map(state => state === "connected")),
        inspect: () => Effect.tryPromise({ try: async () => {
          const response = await fetch(native.server.url.origin + "/inspect", { headers: { Authorization: "Bearer private-first-seen-token" } })
          if (response.status !== 200) throw new Error("authenticated inspect refused")
          return await response.json() as { name: string }
        }, catch: () => KernelReaderSchema.failure("reader_scope_mismatch", "inspect") }),
        readCut: request => Effect.gen(function* () { calls.scalar++; return yield* sdk.getDeliveryReadCut(request).pipe(Effect.mapError(() => KernelReaderSchema.failure("reader_unavailable", "getDeliveryReadCut"))) }),
        outputProof: request => Effect.gen(function* () { calls.batch++; if (!sdk.getDeliveryOutputProof) return yield* Effect.fail(KernelReaderSchema.failure("reader_upgrade_required", "getDeliveryOutputProof")); return yield* sdk.getDeliveryOutputProof(request).pipe(Effect.mapError(() => KernelReaderSchema.failure("reader_unavailable", "getDeliveryOutputProof"))) }),
      })
      yield* Effect.addFinalizer(() => Effect.sync(() => KernelReader.close(runtime)))
      yield* KernelReader.bind(runtime, info.scopeKey)
      yield* KernelReader.ensureScope(runtime)
      const now = Date.now()
      yield* KernelReader.applyChanges(runtime, { version: 1, scopeKey: info.scopeKey, after: "0", upper: "1", scanCursor: "1", scanProjectionKey: "b".repeat(64), pageToken: "", windowComplete: true, caughtUp: true, serverNow: now,
        items: [{ visibility: "visible", projectionKey: "b".repeat(64), revision: "1", cursor: "1", conversationType: 1, targetId: "sender", readOrdinal: "0", admittedOrdinal: "1", liveUnread: "1", storedUnread: "1", latestMessageId: "legacy-message", latestSequence: "1", latestMessageTime: now, nextExpiryAt: now + 60000 }] })
      const visible = (yield* KernelReader.projection(runtime, "b".repeat(64)))!.local_group_id!
      const pending = yield* KernelReader.pending(runtime, { conversationType: 2, conversationID: "empty-owned", name: "Authenticated legacy group" })
      const before = yield* db.all(sql`SELECT * FROM im_kernel_reader_projection ORDER BY binding_key`)
      yield* db.run(sql`CREATE TABLE legacy_output_probe (id INTEGER PRIMARY KEY)`)
      calls.phase = "output"
      native.topics.length = 0
      const rejected = yield* KernelReader.withOutput(runtime, { workspaceID: "legacy-workspace", userID: "server", groupIDs: [visible, pending] }, db.run(sql`INSERT INTO legacy_output_probe DEFAULT VALUES`)).pipe(Effect.flip)
      expect(rejected).toMatchObject({ code: "reader_upgrade_required", operation: "output-proof" })
      expect(calls).toEqual({ phase: "output", inspect: 0, scalar: 0, batch: 0 })
      expect(native.topics).toEqual([])
      expect(yield* db.get(sql`SELECT count(*) count FROM legacy_output_probe`)).toEqual({ count: 0 })
      expect(yield* db.all(sql`SELECT * FROM im_kernel_reader_projection ORDER BY binding_key`)).toEqual(before)
    }).pipe(Effect.provide(Layer.mergeAll(Database.layerFromPath(path.join(directory, "legacy.sqlite")), Layer.provideMerge(KernelClient.layer, KernelSdk.liveFromConfig(config)))), Effect.scoped))
  } finally {
    native.server.stop(true)
    await fs.rm(directory, { recursive: true, force: true })
  }
}, 15000)
