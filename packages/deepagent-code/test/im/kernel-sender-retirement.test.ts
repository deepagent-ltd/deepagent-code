import { expect, test } from "bun:test"
import { Effect, Layer, SubscriptionRef } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { sql } from "drizzle-orm"
import { access, mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Database } from "@deepagent-code/core/database/database"
import { IMBroadcasterLive } from "@deepagent-code/core/im/broadcaster"
import { IMRepository, IMRepositoryLive } from "@deepagent-code/core/im/repository"
import { KernelDelivery } from "@deepagent-code/core/im/kernel-delivery"
import { KernelReader } from "@deepagent-code/core/im/kernel-reader"
import { KernelClient } from "@/im/kernel/client"
import { KernelConfig } from "@/im/kernel/config"
import { KernelSdk } from "@/im/kernel/sdk"
import { IMKernelReader } from "@/im/kernel/reader"
import { IMKernelExchange } from "@/im/kernel/exchange"
import { ProtectedReaderProtocolFixture } from "./fixture/protected-reader-protocol"

if (process.env.DAC_SENDER_RETIREMENT_CHILD !== "1") test("sender retirement uses one original SDK process and releases its resources", async () => {
  // The upstream SDK keeps module-global initialization state after disconnect.
  // A private child models its production one-client-per-process lifecycle and
  // lets this module coexist with other SDK tests in the same test runner.
  const child = Bun.spawn([process.execPath, "test", import.meta.path], {
    cwd: join(import.meta.dir, "../.."), env: { ...process.env, DAC_SENDER_RETIREMENT_CHILD: "1" },
    stdout: "pipe", stderr: "pipe",
  })
  const timeout = setTimeout(() => child.kill("SIGTERM"), 20_000)
  try {
    const result = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    expect(result[0], result[0] === 0 ? undefined : "Original SDK retirement child did not settle successfully").toBe(0)
    expect(result[2]).toContain("1 pass")
    expect(result[2]).toContain("0 fail")
    console.log(`SENDER_RETIREMENT_CHILD original SDK / HTTP-WS / file DB: 1 pass, ${Number(/(\d+) expect\(\) calls/.exec(result[2])?.[1])} assertions; own scope and resources released`)
  } finally {
    clearTimeout(timeout)
    if (child.exitCode === null) { child.kill("SIGTERM"); await child.exited }
  }
}, 25_000)

if (process.env.DAC_SENDER_RETIREMENT_CHILD === "1") test("the original SDK clock retires the old kr1 canonical body; corrupt maintenance stays live and late current membership rolls back", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dac-sender-retirement-sdk-"))
  const native = ProtectedReaderProtocolFixture.make()
  const config = { appkey: `private-retirement-${native.server.port}`, navigator: native.server.url.origin,
    token: "private-first-seen-token", userID: "receiver",
    identity: { uuid: "receiver", orgID: 1, name: "Receiver", orgAllGroupID: "unused" } }
  const database = Database.layerFromPath(join(directory, "reader.sqlite"))
  const services = Layer.mergeAll(Layer.provideMerge(IMRepositoryLive, database), IMBroadcasterLive,
    KernelClient.layer.pipe(Layer.provide(KernelSdk.liveFromConfig(config))))
  try {
    const original = await Effect.runPromise(Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const repo = yield* IMRepository
      const client = yield* KernelClient.Service
      for (const round of Array.from({ length: 100 }, (_, index) => index)) {
        if ((yield* SubscriptionRef.get(client.state)) === "connected") break
        if (round === 99) return yield* Effect.die(new Error("Original SDK connection timed out"))
        yield* Effect.sleep("10 millis")
      }
      const reader = yield* IMKernelReader.make(config, { workspaceID: directory,
        inspectConversation: (request) => IMKernelExchange.inspectConversation({ ...request,
          facadeURL: native.server.url.origin, key: "private-witness-key" }).pipe(Effect.provide(FetchHttpClient.layer)) })
      // Only the persisted old canonical rows are seeded through the original
      // Core API. The retirement clock and current conversation come from the
      // one real authenticated SDK; no second SDK or cloned Host witness exists.
      const previousSource = KernelConfig.deliverySource({ ...config, token: "private-retired-token" })
      const previous = KernelReader.attach({ db, workspaceID: directory, userID: "server", source: previousSource,
        current: () => Effect.succeed(true), inspect: () => Effect.succeed({ name: "Original previous group" }),
        readCut: () => Effect.die(new Error("Old receipt fixture cannot authorize reads")) })
      const authority = KernelDelivery.runtime(previousSource)
      yield* Effect.addFinalizer(() => Effect.sync(() => { KernelReader.close(previous); KernelDelivery.close(authority) }))
      yield* KernelReader.bind(previous, "d".repeat(64))
      yield* KernelReader.ensureScope(previous)
      const oldGroup = yield* KernelReader.pending(previous, { conversationType: 1, conversationID: "sender", name: "Old canonical" })
      const create = (id: string, createdAt = Date.now() - KernelDelivery.TTL - 10_000) => KernelDelivery.withCreation(authority,
        oldGroup, repo.createMessage({ groupID: oldGroup, senderID: "server", senderType: "user", type: "text",
          content: `Original old ${id} 中文`, clientRequestID: id, createdAt }))
      const originals = yield* Effect.forEach(Array.from({ length: 33 }, (_, index) => index), (index) => create(`old-${index}`))
      const recent = yield* create("recent", Date.now())
      const receipts = yield* db.all(sql`SELECT * FROM im_kernel_delivery ORDER BY message_id`)
      native.add("initial-current", { publish: false })
      yield* reader.sync
      expect((yield* SubscriptionRef.get(reader.state)).state).toBe("ready")
      expect(yield* db.get(sql`SELECT count(*) n FROM im_messages WHERE group_id=${oldGroup} AND content='' AND deleted_at IS NOT NULL`)).toEqual({ n: 0 })
      const currentGroup = yield* db.get<{ id: string }>(sql`SELECT id FROM im_groups WHERE workspace_id=${directory} AND kernel_conv_id LIKE 'kr1:%' AND id<>${oldGroup}`)
      expect(currentGroup).toBeDefined()
      expect(oldGroup).not.toBe(currentGroup!.id)
      expect(yield* db.get(sql`SELECT count(*) n FROM im_kernel_reader_message WHERE message_id='initial-current'`)).toEqual({ n: 1 })
      const previousQueries = native.queries.length
      yield* reader.sync
      expect((yield* SubscriptionRef.get(reader.state)).state).toBe("ready")
      expect(yield* db.get(sql`SELECT count(*) n FROM im_messages WHERE group_id=${oldGroup} AND content='' AND deleted_at IS NOT NULL`)).toEqual({ n: 32 })
      expect(yield* db.all(sql`SELECT * FROM im_kernel_delivery ORDER BY message_id`)).toEqual(receipts)
      yield* reader.sync
      expect((yield* SubscriptionRef.get(reader.state)).state).toBe("ready")
      expect(yield* db.get(sql`SELECT count(*) n FROM im_messages WHERE group_id=${oldGroup} AND content='' AND deleted_at IS NOT NULL`)).toEqual({ n: 33 })
      expect(yield* db.get(sql`SELECT content,deleted_at FROM im_messages WHERE id=${recent.id}`)).toEqual({ content: recent.content, deleted_at: null })
      expect(yield* db.all(sql`SELECT * FROM im_kernel_delivery ORDER BY message_id`)).toEqual(receipts)
      for (const message of originals) {
        const receipt = yield* KernelDelivery.read(db, message.id)
        expect(yield* db.get(sql`SELECT content,deleted_at FROM im_messages WHERE id=${message.id}`))
          .toEqual({ content: "", deleted_at: receipt!.binding.expiresAt })
      }
      expect(native.queries.slice(previousQueries).filter((item) => item.topic === "qry_delivery_reader")).toHaveLength(2)
      const valid = yield* create("maintenance-valid", Date.now() - KernelDelivery.TTL - 20_000)
      const bad = yield* create("maintenance-bad")
      yield* db.run(sql`UPDATE im_messages SET content='changed old canonical' WHERE id=${bad.id}`)
      const damaged = yield* db.all(sql`SELECT * FROM im_messages WHERE sender_id='server' ORDER BY id`)
      const damagedReceipts = yield* db.all(sql`SELECT * FROM im_kernel_delivery ORDER BY message_id`)
      native.add("allowed-current-history", { publish: false })
      yield* reader.sync
      expect((yield* SubscriptionRef.get(reader.state)).state).toBe("ready")
      expect(yield* db.all(sql`SELECT * FROM im_messages WHERE sender_id='server' ORDER BY id`)).toEqual(damaged)
      expect(yield* db.all(sql`SELECT * FROM im_kernel_delivery ORDER BY message_id`)).toEqual(damagedReceipts)
      expect(yield* db.get(sql`SELECT count(*) n FROM im_kernel_reader_message WHERE message_id='allowed-current-history'`)).toEqual({ n: 1 })
      yield* db.run(sql`UPDATE im_messages SET content=${bad.content} WHERE id=${bad.id}`)
      const beforeLate = yield* db.all(sql`SELECT * FROM im_messages WHERE sender_id='server' ORDER BY id`)
      yield* db.run(`CREATE TEMP TRIGGER private_retirement_withdraw AFTER UPDATE OF content ON im_messages WHEN NEW.group_id='${oldGroup}' AND NEW.content='' BEGIN DELETE FROM im_members WHERE group_id='${currentGroup!.id}' AND member_id='server'; END`)
      native.add("forbidden-late-history", { publish: false })
      const beforeLateQueries = native.queries.length
      yield* reader.sync
      expect((yield* SubscriptionRef.get(reader.state)).state).toBe("unavailable")
      expect(yield* db.all(sql`SELECT * FROM im_messages WHERE sender_id='server' ORDER BY id`)).toEqual(beforeLate)
      expect(yield* db.all(sql`SELECT * FROM im_kernel_delivery ORDER BY message_id`)).toEqual(damagedReceipts)
      expect(native.queries.slice(beforeLateQueries).map((item) => item.topic)).toEqual(["qry_delivery_reader"])
      expect(yield* db.get(sql`SELECT count(*) n FROM im_kernel_reader_message WHERE message_id='forbidden-late-history'`)).toEqual({ n: 0 })
      expect(yield* db.get(sql`SELECT count(*) n FROM im_members WHERE group_id=${currentGroup!.id} AND member_id='server'`)).toEqual({ n: 1 })
      expect(native.queries.some((item) => item.topic === "qry_delivery_mark_read")).toBe(false)
      expect(native.topics.some((item) => item.startsWith("msg") || item === "send_msg")).toBe(false)
      expect(yield* db.get(sql`SELECT count(*) n FROM session_input`)).toEqual({ n: 0 })
      expect(yield* db.get(sql`SELECT count(*) n FROM work_execution`)).toEqual({ n: 0 })
      expect(yield* db.get(sql`SELECT count(*) n FROM im_reply_outbox`)).toEqual({ n: 0 })
      expect(yield* db.get(sql`SELECT count(*) n FROM im_attachments`)).toEqual({ n: 0 })
      return { originals: originals.map((message) => message.id), receipts: damagedReceipts, validID: valid.id }
    }).pipe(Effect.provide(services), Effect.scoped))
    await Effect.runPromise(Effect.gen(function* () {
      const db = (yield* Database.Service).db
      expect(yield* db.all(sql`SELECT * FROM im_kernel_delivery ORDER BY message_id`)).toEqual(original.receipts)
      expect(yield* db.get(sql`SELECT count(*) n FROM im_messages WHERE content='' AND deleted_at IS NOT NULL`)).toEqual({ n: original.originals.length })
      expect((yield* db.get<{ content: string }>(sql`SELECT content FROM im_messages WHERE id=${original.validID}`))!.content.length).toBeGreaterThan(0)
    }).pipe(Effect.provide(database), Effect.scoped))
    expect(native.state.disconnected).toBe(1)
  } finally {
    await native.server.stop(true)
    await rm(directory, { recursive: true, force: true })
  }
  expect(await access(directory).then(() => true, () => false)).toBe(false)
  expect(native.server.pendingRequests).toBe(0)
  expect(native.server.pendingWebSockets).toBe(0)
}, 15_000)
