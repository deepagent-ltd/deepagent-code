import { expect, test } from "bun:test"
import { Effect, Layer, SubscriptionRef } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { sql } from "drizzle-orm"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Database } from "@deepagent-code/core/database/database"
import { IMBroadcasterLive } from "@deepagent-code/core/im/broadcaster"
import { IMRepository, IMRepositoryLive } from "@deepagent-code/core/im/repository"
import { KernelDelivery } from "@deepagent-code/core/im/kernel-delivery"
import { KernelClient } from "@/im/kernel/client"
import { KernelConfig } from "@/im/kernel/config"
import { KernelSdk } from "@/im/kernel/sdk"
import { IMKernelReader } from "@/im/kernel/reader"
import { IMKernelExchange } from "@/im/kernel/exchange"
import { KernelTaskSourceWitnessFixture } from "./fixture/kernel-task-source-witness"

async function isolated(
  body: (native: ReturnType<typeof KernelTaskSourceWitnessFixture.make>, directory: string) => Promise<void>,
) {
  const directory = await mkdtemp(join(tmpdir(), "dac-sender-ttl-live-"))
  const native = KernelTaskSourceWitnessFixture.make()
  try {
    await body(native, directory)
  } finally {
    await native.server.stop(true)
    await rm(directory, { recursive: true, force: true })
  }
}

const fixture = (native: ReturnType<typeof KernelTaskSourceWitnessFixture.make>, directory: string) => {
  const config = {
    appkey: `private-ttl-live-${native.server.port}`,
    navigator: native.server.url.origin,
    token: "private-first-seen-token",
    userID: "receiver",
    identity: { uuid: "receiver", orgID: 1, name: "Receiver", orgAllGroupID: "unused" },
  }
  const database = Database.layerFromPath(join(directory, "reader.sqlite"))
  const services = Layer.mergeAll(
    Layer.provideMerge(IMRepositoryLive, database),
    IMBroadcasterLive,
    KernelClient.layer.pipe(Layer.provide(KernelSdk.liveFromConfig(config))),
  )
  const setup = Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const repo = yield* IMRepository
    const client = yield* KernelClient.Service
    yield* Effect.gen(function* () {
      for (const round of Array.from({ length: 100 }, (_, index) => index)) {
        if ((yield* SubscriptionRef.get(client.state)) === "connected") return
        if (round === 99) return yield* Effect.die(new Error("Original SDK connection timed out"))
        yield* Effect.sleep("10 millis")
      }
    })
    const reader = yield* IMKernelReader.make(config, {
      workspaceID: directory,
      inspectConversation: (request) =>
        IMKernelExchange.inspectConversation({
          ...request,
          facadeURL: native.server.url.origin,
          key: "private-witness-key",
        }).pipe(Effect.provide(FetchHttpClient.layer)),
    })
    native.add("initial-history", { publish: false })
    yield* reader.sync
    expect((yield* SubscriptionRef.get(reader.state)).state).toBe("ready")
    const group = yield* db.get<{ id: string }>(
      sql`SELECT id FROM im_groups WHERE workspace_id=${directory} AND kernel_conv_id LIKE 'kr1:%'`,
    )
    expect(group).toBeDefined()
    const authority = KernelDelivery.runtime(KernelConfig.deliverySource(config))
    yield* Effect.addFinalizer(() => Effect.sync(() => KernelDelivery.close(authority)))
    const create = (requestID: string, createdAt: number) =>
      KernelDelivery.withCreation(
        authority,
        group!.id,
        repo.createMessage({
          groupID: group!.id,
          senderID: "server",
          senderType: "user",
          type: "text",
          content: `Private original ${requestID}`,
          createdAt,
          clientRequestID: requestID,
        }),
      )
    const snapshot = () =>
      Effect.gen(function* () {
        return {
          receipts: yield* db.all(sql`SELECT * FROM im_kernel_delivery ORDER BY message_id`),
          sender: yield* db.all(sql`SELECT * FROM im_messages WHERE sender_id='server' ORDER BY id`),
        }
      })
    return { db, reader, group: group!, create, snapshot }
  })
  return { services, setup }
}

test(
  "old sender maintenance refusal does not starve current SDK history; late member loss still refuses",
  () =>
    isolated(async (native, directory) => {
      const original = fixture(native, directory)
      await Effect.runPromise(
        Effect.gen(function* () {
          const s = yield* original.setup
          const old = Date.now() - KernelDelivery.TTL - 10_000
          yield* s.create("valid-old", old - 1)
          const bad = yield* s.create("bad-old", old)
          const originalReceipt = yield* s.db.get<{ binding_hash: string }>(
            sql`SELECT binding_hash FROM im_kernel_delivery WHERE message_id=${bad.id}`,
          )
          yield* s.db.run(sql`UPDATE im_messages SET content='changed old sender body' WHERE id=${bad.id}`)
          const before = yield* s.snapshot()
          native.add("fresh-current-history", { publish: false })
          const previousQueries = native.queries.length
          yield* s.reader.sync
          expect((yield* SubscriptionRef.get(s.reader.state)).state).toBe("ready")
          expect(yield* s.snapshot()).toEqual(before)
          yield* s.db.run(sql`UPDATE im_kernel_delivery SET binding_hash=${"f".repeat(64)} WHERE message_id=${bad.id}`)
          const beforeBindingRefusal = yield* s.snapshot()
          yield* s.reader.sync
          expect((yield* SubscriptionRef.get(s.reader.state)).state).toBe("ready")
          expect(yield* s.snapshot()).toEqual(beforeBindingRefusal)
          expect(
            yield* s.db.get(
              sql`SELECT count(*) n FROM im_kernel_reader_message WHERE message_id='fresh-current-history'`,
            ),
          ).toEqual({ n: 1 })
          expect(native.queries.slice(previousQueries).some((item) => item.topic === "qry_delivery_messages")).toBe(
            true,
          )
          yield* s.reader.sync
          expect((yield* SubscriptionRef.get(s.reader.state)).state).toBe("ready")
          expect(yield* s.snapshot()).toEqual(beforeBindingRefusal)
          expect(native.queries.some((item) => item.topic === "qry_delivery_mark_read")).toBe(false)
          expect(yield* s.db.get(sql`SELECT count(*) n FROM session_input`)).toEqual({ n: 0 })
          expect(yield* s.db.get(sql`SELECT count(*) n FROM work_execution`)).toEqual({ n: 0 })
          // The second phase restores only the deliberately corrupted fixture bytes,
          // then withdraws real membership during the original cleanup transaction.
          yield* s.db.run(sql`UPDATE im_messages SET content=${bad.content} WHERE id=${bad.id}`)
          yield* s.db.run(
            sql`UPDATE im_kernel_delivery SET binding_hash=${originalReceipt!.binding_hash} WHERE message_id=${bad.id}`,
          )
          yield* s.create("late-member", Date.now() - KernelDelivery.TTL - 10_000)
          const beforeWithdrawal = yield* s.snapshot()
          yield* s.db.run(
            "CREATE TEMP TRIGGER private_ttl_withdraw AFTER UPDATE OF content ON im_messages WHEN NEW.sender_id='server' AND NEW.content='' BEGIN DELETE FROM im_members WHERE group_id=NEW.group_id AND member_id='server'; END",
          )
          native.add("forbidden-late-history", { publish: false })
          const previousWithdrawalQueries = native.queries.length
          yield* s.reader.sync
          expect((yield* SubscriptionRef.get(s.reader.state)).state).toBe("unavailable")
          expect(yield* s.snapshot()).toEqual(beforeWithdrawal)
          expect(native.queries.slice(previousWithdrawalQueries).map((item) => item.topic)).toEqual([
            "qry_delivery_reader",
          ])
          expect(
            yield* s.db.get(
              sql`SELECT count(*) n FROM im_kernel_reader_message WHERE message_id='forbidden-late-history'`,
            ),
          ).toEqual({ n: 0 })
          expect(
            yield* s.db.get(sql`SELECT count(*) n FROM im_members WHERE group_id=${s.group.id} AND member_id='server'`),
          ).toEqual({ n: 1 })
        }).pipe(Effect.provide(original.services), Effect.scoped),
      )
    }),
  15_000,
)
