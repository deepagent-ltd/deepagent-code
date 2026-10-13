import { expect, test } from "bun:test"
import { Effect, Layer, Schema, Stream, SubscriptionRef } from "effect"
import { sql } from "drizzle-orm"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "@deepagent-code/core/database/database"
import { IMBroadcasterLive } from "@deepagent-code/core/im/broadcaster"
import { KernelReader } from "@deepagent-code/core/im/kernel-reader"
import { KernelReaderSchema } from "@deepagent-code/core/im/kernel-reader.schema"
import { InstanceStore } from "@/project/instance-store"
import { KernelSdk } from "@/im/kernel/sdk"
import { KernelConfig } from "@/im/kernel/config"
import { KernelClient } from "@/im/kernel/client"
import { IMReaderRegistry } from "@/im/kernel/reader-registry"
import { ReaderInstanceFixture } from "./reader-instance-fixture"
import { KernelLiveFirstSeenFixture } from "./fixture/kernel-live-first-seen"

const wait = <A, E, R>(effect: Effect.Effect<A | undefined, E, R>) => Effect.gen(function* () {
  for (const attempt of Array.from({ length: 200 }, (_, index) => index)) {
    const value = yield* effect
    if (value !== undefined) return value
    if (attempt === 199) return yield* Effect.die(new Error("bounded first-seen observation timed out"))
    yield* Effect.sleep("20 millis")
  }
  return yield* Effect.die(new Error("unreachable first-seen wait"))
})

test("original SDK WS → current Entry → native protocol query → immutable file DB first-seen, with zero execution", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dac-kernel-live-first-seen-"))
  const native = KernelLiveFirstSeenFixture.make()
  const config = { appkey: `private-first-seen-${native.server.port}`, navigator: native.server.url.origin, token: "private-first-seen-token", userID: "receiver", identity: { uuid: "receiver", orgID: 1, name: "Receiver", orgAllGroupID: "unused" } }
  const sdk = KernelSdk.liveFromConfig(config)
  const client = KernelClient.layer.pipe(Layer.provide(sdk))
  const stage = { value: "connecting" }
  const services = Layer.mergeAll(Database.layerFromPath(join(directory, "reader.sqlite")), ReaderInstanceFixture.layer, ReaderInstanceFixture.registry, IMBroadcasterLive, client)
  try {
    await Effect.runPromise(Effect.gen(function* () {
      const database = yield* Database.Service
      const store = yield* InstanceStore.Service
      const client = yield* KernelClient.Service
      yield* wait(SubscriptionRef.get(client.state).pipe(Effect.map((state) => state === "connected" ? true : undefined)))
      stage.value = "acquire-current-entry"
      const registry = yield* IMReaderRegistry.make(config, { inspectConversation: (input) => Effect.succeed({ conversation_type: input.conversationType, conversation_id: input.conversationID, org_id: 1, name: "Sender", member_uuids: ["receiver", "sender"] }) })
      const workspace = join(directory, "workspace")
      yield* Effect.promise(() => mkdir(workspace))
      const instance = yield* store.load({ directory: workspace })
      const entry = yield* registry.acquire({ instance, workspaceID: workspace, userID: "server", instanceCurrent: store.peek(workspace).pipe(Effect.map((current) => current === instance)) })
      stage.value = "entry-idle"
      yield* wait(Effect.sync(() => entry.lifetime.native === 0 && !entry.lifetime.running && !entry.lifetime.queued ? true : undefined))
      const handles: object[] = []
      yield* Stream.runForEach(client.liveObservations!, (handle) => Effect.sync(() => { handles.push(handle) })).pipe(Effect.forkScoped)
      const row = (id: string) => database.db.get<{ metadata: string; immutable_hash: string; storage_state: string }>(sql`SELECT metadata, immutable_hash, storage_state FROM im_kernel_reader_message WHERE message_id=${id}`)
      const firstSeen = (value: { metadata: string }) => KernelReaderSchema.decode(KernelReaderSchema.MessageMetadata, value.metadata, 2048).firstSeen
      stage.value = "first-live"
      native.add("first-live")
      const first = yield* wait(row("first-live"))
      expect(firstSeen(first)).toMatchObject({ version: 1, origin: "kernel_live", receiverID: "receiver", transportGeneration: 1, sourceHash: KernelReader.hash(KernelConfig.deliverySource(config)) })
      const provenance = firstSeen(first)
      expect(provenance?.origin === "kernel_live" && provenance.sourceExpiresAt).toBe(native.messages[0].expiresAt)
      expect(handles).toHaveLength(1)
      expect(Object.keys(handles[0])).toEqual([])
      expect(client.readLiveObservation?.({ ...handles[0] })).toBeUndefined()
      expect(native.topics).toContain("qry_delivery_reader")
      expect(native.topics).toContain("qry_delivery_changes")
      expect(native.topics).toContain("qry_delivery_messages")
      native.publish(native.messages[0])
      yield* wait(Effect.sync(() => handles.length === 2 ? true : undefined))
      yield* entry.reader.observeLive(handles[1])
      expect(yield* row("first-live")).toEqual(first)
      native.add("history-first", { publish: false })
      yield* entry.reader.sync
      const history = yield* row("history-first")
      expect(firstSeen(history!)).toEqual({ version: 1, origin: "history" })
      native.publish(native.messages[1])
      yield* wait(Effect.sync(() => handles.length === 3 ? true : undefined))
      yield* entry.reader.observeLive(handles[2])
      expect(yield* row("history-first")).toEqual(history)
      native.add("tuple-mismatch", { mismatch: true })
      expect(firstSeen(yield* wait(row("tuple-mismatch")))).toEqual({ version: 1, origin: "history" })
      native.state.slow = true
      native.add("native-window-expired")
      expect(firstSeen(yield* wait(row("native-window-expired")))).toEqual({ version: 1, origin: "history" })
      const reference = native.add("reference-ineligible", { hasReference: true })
      yield* wait(Effect.sync(() => handles.length === 6 ? true : undefined))
      yield* entry.reader.sync
      expect(firstSeen(yield* wait(row(reference.messageId)))).toEqual({ version: 1, origin: "history" })
      expect(yield* database.db.get(sql`SELECT count(*) AS n FROM session`)).toEqual({ n: 0 })
      expect(yield* database.db.get(sql`SELECT count(*) AS n FROM session_input`)).toEqual({ n: 0 })
      expect(yield* database.db.get(sql`SELECT count(*) AS n FROM work_execution`)).toEqual({ n: 0 })
      expect(yield* database.db.get(sql`SELECT count(*) AS n FROM session_provider_attempt`)).toEqual({ n: 0 })
      expect(yield* database.db.get(sql`SELECT count(*) AS n FROM work_count_acquisition`)).toEqual({ n: 0 })
      expect((yield* KernelReader.scope(entry.reader.runtime))!.completed_after).toBe(String(native.state.revision))
      expect(registry.statistics().native).toBe(0)
      expect(Schema.is(KernelReaderSchema.FirstSeen)(firstSeen(first))).toBe(true)
    }).pipe(Effect.onError(() => Effect.sync(() => console.error({ stage: stage.value, topics: native.topics, messages: native.messages.map((message) => message.messageId) }))), Effect.provide(services), Effect.scoped))
    expect(native.state.disconnected).toBeGreaterThanOrEqual(1)
  } finally {
    native.server.stop(true)
    await rm(directory, { recursive: true, force: true })
  }
}, 30_000)
