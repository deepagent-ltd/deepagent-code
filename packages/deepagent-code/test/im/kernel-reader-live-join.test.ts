import { expect, test } from "bun:test"
import { Deferred, Effect, Fiber, Layer, Stream, SubscriptionRef } from "effect"
import { sql } from "drizzle-orm"
import fs from "node:fs/promises"
import path from "node:path"
import { Database } from "@deepagent-code/core/database/database"
import { IMBroadcasterLive } from "@deepagent-code/core/im/broadcaster"
import { KernelReaderSchema } from "@deepagent-code/core/im/kernel-reader.schema"
import { KernelClient } from "@/im/kernel/client"
import { KernelSdk } from "@/im/kernel/sdk"
import { IMKernelReader } from "@/im/kernel/reader"
import { KernelLiveFirstSeenFixture } from "./fixture/kernel-live-first-seen"

const wait = <A, E, R>(effect: Effect.Effect<A | undefined, E, R>) => Effect.gen(function* () {
  for (const attempt of Array.from({ length: 100 }, (_, index) => index)) {
    const value = yield* effect
    if (value !== undefined) return value
    if (attempt === 99) return yield* Effect.die(new Error("Private live join observation timed out"))
    yield* Effect.sleep("10 millis")
  }
  return yield* Effect.die(new Error("Unreachable private observation"))
})

test("real WS observations join the in-flight page before first INSERT; history remains immutable", async () => {
  const directory = await fs.mkdtemp("/tmp/dac-reader-live-join-")
  const native = KernelLiveFirstSeenFixture.make()
  const config = { appkey: `private-first-seen-${native.server.port}`, navigator: native.server.url.origin,
    token: "private-first-seen-token", userID: "receiver", identity: { uuid: "receiver", orgID: 1, name: "Receiver", orgAllGroupID: "unused" } }
  const sdk = KernelSdk.liveFromConfig(config)
  const services = Layer.mergeAll(Database.layerFromPath(path.join(directory, "reader.sqlite")), IMBroadcasterLive,
    KernelClient.layer.pipe(Layer.provide(sdk)))
  try {
    await Effect.runPromise(Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const client = yield* KernelClient.Service
      yield* wait(SubscriptionRef.get(client.state).pipe(Effect.map((state) => state === "connected" ? true : undefined)))
      const pageObserved = yield* Deferred.make<void>()
      const releasePage = yield* Deferred.make<void>()
      const candidatesObserved = yield* Deferred.make<void>()
      const handles = new Map<string, object>()
      const joined = new Set<object>()
      const reads = new Map<object, number>()
      const gate = { armed: false, held: false }
      // Transparent readiness probe: all observation facts still come from the original SDK.
      const observedClient = { ...client, readLiveObservation: (handle: object) => {
        const original = client.readLiveObservation?.(handle)
        if (original && gate.held) {
          reads.set(handle, (reads.get(handle) ?? 0) + 1)
          // The second original read occurs inside the selected pass after its Ref.modify;
          // candidate insertion continues synchronously before awaiting that pass.
          if (reads.get(handle) === 2) joined.add(handle)
          if (joined.size === 2) queueMicrotask(() => Effect.runSync(Deferred.succeed(candidatesObserved, undefined)))
        }
        return original
      } }
      const reader = yield* IMKernelReader.make(config, { workspaceID: directory, inspectConversation: (input) => Effect.succeed({ conversation_type: input.conversationType,
        conversation_id: input.conversationID, org_id: 1, name: "Sender", member_uuids: ["receiver", "sender"] }), requestGate: (effect) => Effect.gen(function* () {
        const value = yield* effect
        if (gate.armed && !gate.held && typeof value === "object" && value !== null && "items" in value &&
          Array.isArray(value.items) && value.items.some((item: unknown) => typeof item === "object" && item !== null &&
            "messageId" in item && item.messageId === "joined-one")) {
          gate.held = true
          yield* Deferred.succeed(pageObserved, undefined)
          yield* Deferred.await(releasePage)
        }
        return value
      }) }).pipe(Effect.provideService(KernelClient.Service, observedClient))
      yield* reader.sync
      yield* Stream.runForEach(client.liveObservations!, (handle) => Effect.sync(() => {
        const value = client.readLiveObservation?.(handle)
        if (value) handles.set(value.observation.messageID, handle)
      })).pipe(Effect.forkScoped)
      const row = (id: string) => db.get<{ metadata: string; immutable_hash: string }>(sql`
        SELECT metadata,immutable_hash FROM im_kernel_reader_message WHERE message_id=${id}`)
      const one = native.add("joined-one", { publish: false })
      const two = native.add("joined-two", { publish: false })
      gate.armed = true
      const syncing = yield* reader.sync.pipe(Effect.forkScoped)
      yield* Deferred.await(pageObserved).pipe(Effect.timeout("2 seconds"))
      expect(yield* row(one.messageId)).toBeUndefined()
      expect(yield* row(two.messageId)).toBeUndefined()
      native.publish(one)
      native.publish(two)
      yield* wait(Effect.sync(() => handles.has(one.messageId) && handles.has(two.messageId) ? true : undefined))
      const joining = yield* Effect.all([reader.observeLive(handles.get(one.messageId)!), reader.observeLive(handles.get(two.messageId)!)],
        { concurrency: 2 }).pipe(Effect.forkScoped)
      yield* Deferred.await(candidatesObserved).pipe(Effect.timeout("2 seconds"))
      yield* Deferred.succeed(releasePage, undefined)
      yield* Fiber.join(syncing)
      yield* Fiber.join(joining)
      const first = yield* row(one.messageId)
      const second = yield* row(two.messageId)
      expect(first).toBeDefined()
      expect(second).toBeDefined()
      expect(KernelReaderSchema.decode(KernelReaderSchema.MessageMetadata, first!.metadata, 2048).firstSeen)
        .toMatchObject({ version: 1, origin: "kernel_live", receiverID: "receiver", transportGeneration: 1 })
      expect(KernelReaderSchema.decode(KernelReaderSchema.MessageMetadata, second!.metadata, 2048).firstSeen)
        .toMatchObject({ version: 1, origin: "kernel_live", receiverID: "receiver", transportGeneration: 1 })
      expect(joined.size).toBe(2)
      gate.armed = false
      gate.held = false
      const historical = native.add("already-history", { publish: false })
      yield* reader.sync
      const before = yield* row(historical.messageId)
      expect(KernelReaderSchema.decode(KernelReaderSchema.MessageMetadata, before!.metadata, 2048).firstSeen)
        .toEqual({ version: 1, origin: "history" })
      native.publish(historical)
      const handle = yield* wait(Effect.sync(() => handles.get(historical.messageId)))
      yield* reader.observeLive(handle)
      expect(yield* row(historical.messageId)).toEqual(before)
      expect(yield* db.get("SELECT count(*) n FROM work_execution")).toEqual({ n: 0 })
    }).pipe(Effect.provide(services), Effect.scoped))
  } finally {
    await native.server.stop(true)
    await fs.rm(directory, { recursive: true, force: true })
  }
}, 15000)
