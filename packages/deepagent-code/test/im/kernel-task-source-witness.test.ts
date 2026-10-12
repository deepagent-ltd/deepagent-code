import { expect, test } from "bun:test"
import { Effect, Fiber, Layer, SubscriptionRef } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
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
import { KernelClient } from "@/im/kernel/client"
import { IMKernelExchange } from "@/im/kernel/exchange"
import { IMReaderRegistry } from "@/im/kernel/reader-registry"
import { ReaderInstanceFixture } from "./reader-instance-fixture"
import { KernelTaskSourceWitnessFixture } from "./fixture/kernel-task-source-witness"

const wait = <A, E, R>(effect: Effect.Effect<A | undefined, E, R>) =>
  Effect.gen(function* () {
    for (const attempt of Array.from({ length: 200 }, (_, index) => index)) {
      const value = yield* effect
      if (value !== undefined) return value
      if (attempt === 199) return yield* Effect.die(new Error("bounded task-source observation timed out"))
      yield* Effect.sleep("20 millis")
    }
    return yield* Effect.die(new Error("unreachable task-source wait"))
  })

test("same original Entry captures native exact tuple and fresh HTTP members without execution or cursor writes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dac-kernel-task-source-witness-"))
  const native = KernelTaskSourceWitnessFixture.make()
  const config = {
    appkey: `private-task-source-${native.server.port}`,
    navigator: native.server.url.origin,
    token: "private-first-seen-token",
    userID: "receiver",
    identity: { uuid: "receiver", orgID: 1, name: "Receiver", orgAllGroupID: "unused" },
  }
  const client = KernelClient.layer.pipe(Layer.provide(KernelSdk.liveFromConfig(config)))
  const services = Layer.mergeAll(
    Database.layerFromPath(join(directory, "reader.sqlite")),
    ReaderInstanceFixture.layer,
    ReaderInstanceFixture.registry,
    IMBroadcasterLive,
    client,
  )
  const stage = { value: "connecting" }
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const database = yield* Database.Service
        const store = yield* InstanceStore.Service
        const client = yield* KernelClient.Service
        yield* wait(
          SubscriptionRef.get(client.state).pipe(Effect.map((value) => (value === "connected" ? true : undefined))),
        )
        const inspectConversation = (request: IMKernelExchange.InspectConversationInput) =>
          IMKernelExchange.inspectConversation({
            ...request,
            facadeURL: native.server.url.origin,
            key: "private-witness-key",
          }).pipe(Effect.provide(FetchHttpClient.layer))
        const registry = yield* IMReaderRegistry.make(config, { inspectConversation })
        const workspace = join(directory, "workspace")
        yield* Effect.promise(() => mkdir(workspace))
        const instance = yield* store.load({ directory: workspace })
        const entry = yield* registry.acquire({
          instance,
          workspaceID: workspace,
          userID: "server",
          instanceCurrent: store.peek(workspace).pipe(Effect.map((value) => value === instance)),
        })
        yield* wait(
          Effect.sync(() =>
            entry.lifetime.native === 0 && !entry.lifetime.running && !entry.lifetime.queued ? true : undefined,
          ),
        )
        const row = (id: string) =>
          database.db.get<{ local_message_id: string; metadata: string; immutable_hash: string }>(
            sql`SELECT local_message_id,metadata,immutable_hash FROM im_kernel_reader_message WHERE message_id=${id}`,
          )
        stage.value = "original-live-commit"
        native.add("current-source")
        const retained = yield* wait(row("current-source"))
        expect(
          KernelReaderSchema.decode(KernelReaderSchema.MessageMetadata, retained.metadata, 2048).firstSeen?.origin,
        ).toBe("kernel_live")
        yield* wait(
          Effect.sync(() =>
            entry.lifetime.native === 0 && !entry.lifetime.running && !entry.lifetime.queued ? true : undefined,
          ),
        )
        const snapshot = () =>
          Effect.gen(function* () {
            return {
              scope: yield* database.db.all(sql`SELECT * FROM im_kernel_reader_scope ORDER BY reader_key`),
              projections: yield* database.db.all(sql`SELECT * FROM im_kernel_reader_projection ORDER BY binding_key`),
              messages: yield* database.db.all(sql`SELECT * FROM im_kernel_reader_message ORDER BY effect_key`),
              meter: yield* database.db.all(sql`SELECT * FROM im_kernel_reader_meter`),
            }
          })
        const before = yield* snapshot()
        stage.value = "current-native-capture"
        const handle = yield* registry.withTaskSource(
          { workspaceID: workspace, localUserID: "server", messageID: retained.local_message_id },
          (source) =>
            Effect.gen(function* () {
              yield* source.assertCurrent
              const value = source.reader.readTaskSource(source.handle)!
              expect(String(value.descriptor.localMessageID)).toBe(retained.local_message_id)
              expect(value.descriptor.senderID).toBe("sender")
              expect(value.descriptor.receiverID).toBe("receiver")
              expect(value.descriptor.rawContent).toBe(native.messages[0].content)
              expect(value.descriptor.immutableHash).toBe(retained.immutable_hash)
              expect(value.receiverID).toBe("receiver")
              expect(value.senderID).toBe("sender")
              expect(value.nativeMessageHash).toBe(KernelReader.hash(native.messages[0]))
              expect(Object.keys(source.handle)).toEqual([])
              expect(Object.isFrozen(value)).toBe(true)
              expect(Object.isFrozen(value.descriptor.firstSeen)).toBe(true)
              expect(source.reader.readTaskSource({ ...source.handle })).toBeUndefined()
              return source.handle
            }),
        )
        expect(yield* snapshot()).toEqual(before)
        expect(native.queries.filter((value) => value.topic === "qry_delivery_read_cut")).toHaveLength(1)
        expect(
          native.queries.find((value) => value.topic === "qry_delivery_messages" && value.request.limit === 1)?.request,
        ).toMatchObject({ anchorDeliveryCursor: "0", projectionRevision: String(native.state.revision), limit: 1 })
        expect(native.inspected.at(-1)).toEqual({
          conversation_type: 1,
          conversation_id: "sender",
          sender_uuid: "sender",
        })
        const count = native.queries.length
        expect(
          yield* registry
            .withTaskSource(
              { workspaceID: "missing-workspace", localUserID: "server", messageID: retained.local_message_id },
              () => Effect.void,
            )
            .pipe(Effect.flip),
        ).toMatchObject({ code: "reader_unavailable" })
        expect(registry.statistics().entries).toBe(1)
        expect(native.queries).toHaveLength(count)
        stage.value = "fixed-deadline"
        yield* Effect.sleep("1010 millis")
        expect(entry.reader.readTaskSource(handle)).toBeUndefined()
        expect(yield* entry.reader.assertTaskSource(handle).pipe(Effect.flip)).toMatchObject({
          code: "reader_unavailable",
        })
        stage.value = "native-member-revocation"
        native.faults.members = ["receiver"]
        expect(yield* entry.reader.captureTaskSource(retained.local_message_id).pipe(Effect.flip)).toMatchObject({
          code: "reader_scope_mismatch",
          operation: "task-source-members",
        })
        native.faults.members = ["receiver", "sender"]
        stage.value = "native-tuple-mismatch"
        native.faults.tupleMismatch = true
        expect(yield* entry.reader.captureTaskSource(retained.local_message_id).pipe(Effect.flip)).toMatchObject({
          code: "reader_mapping_conflict",
          operation: "task-source-tuple",
        })
        native.faults.tupleMismatch = false
        stage.value = "native-clock-expired"
        native.faults.expiry = true
        expect(yield* entry.reader.captureTaskSource(retained.local_message_id).pipe(Effect.flip)).toMatchObject({
          code: "reader_unavailable",
          operation: "task-source-witness",
        })
        native.faults.expiry = false
        stage.value = "native-deadline-custody"
        native.state.slow = true
        const delayed = yield* entry.reader
          .captureTaskSource(retained.local_message_id)
          .pipe(Effect.flip, Effect.forkChild)
        yield* wait(Effect.sync(() => (!native.state.slow && entry.lifetime.native > 0 ? true : undefined)))
        expect(registry.statistics().native).toBe(1)
        expect(yield* Fiber.join(delayed)).toMatchObject({ code: "reader_stale", operation: "task-source-probe" })
        expect(registry.statistics().native).toBe(0)
        stage.value = "history-has-no-current-source"
        native.add("historical-source", { publish: false })
        yield* entry.reader.sync
        const history = yield* wait(row("historical-source"))
        const historyCount = native.queries.length
        expect(yield* entry.reader.captureTaskSource(history.local_message_id).pipe(Effect.flip)).toMatchObject({
          code: "reader_unavailable",
          operation: "task-source",
        })
        expect(native.queries).toHaveLength(historyCount)
        stage.value = "retired-original-entry"
        const latest = yield* entry.reader.captureTaskSource(retained.local_message_id)
        expect(entry.reader.readTaskSource(latest)).toBeDefined()
        entry.reader.revoke()
        expect(entry.reader.readTaskSource(latest)).toBeUndefined()
        expect(yield* entry.reader.assertTaskSource(latest).pipe(Effect.flip)).toMatchObject({
          code: "reader_unavailable",
        })
        expect(client.readCurrentLink?.(client.captureCurrentLink?.()!)).toBeDefined()
        const originalLink = client.captureCurrentLink?.()!
        yield* client.disconnect
        expect(client.readCurrentLink?.(originalLink)).toBeUndefined()
        expect(yield* row("current-source")).toEqual(retained)
        for (const name of [
          "session",
          "session_input",
          "work_execution",
          "session_provider_attempt",
          "work_count_acquisition",
        ] as const)
          expect(yield* database.db.get(sql`SELECT count(*) AS n FROM ${sql.identifier(name)}`)).toEqual({ n: 0 })
        expect(registry.statistics().native).toBe(0)
      }).pipe(
        Effect.onError(() => Effect.sync(() => console.error({ stage: stage.value, topics: native.topics }))),
        Effect.provide(services),
        Effect.scoped,
      ),
    )
    expect(native.state.disconnected).toBeGreaterThanOrEqual(1)
  } finally {
    native.server.stop(true)
    await rm(directory, { recursive: true, force: true })
  }
}, 30_000)
