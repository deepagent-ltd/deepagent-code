export * as RemoteTaskResultFixture from "./remote-task-result"

import assert from "node:assert/strict"
import { mkdir } from "node:fs/promises"
import { Effect, Layer, Option, Schema, SubscriptionRef } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { sql } from "drizzle-orm"
import { Database } from "@deepagent-code/core/database/database"
import { IMBroadcasterLive } from "@deepagent-code/core/im/broadcaster"
import { CanonicalJson } from "@deepagent-code/core/util/canonical-json"
import { Hash } from "@deepagent-code/core/util/hash"
import { KernelSdk } from "@/im/kernel/sdk"
import { KernelClient } from "@/im/kernel/client"
import { IMReaderRegistry } from "@/im/kernel/reader-registry"
import { IMKernelExchange } from "@/im/kernel/exchange"
import { InstanceStore } from "@/project/instance-store"
import { IMRemoteTaskResult } from "@/im/remote-task-result"
import { ReaderInstanceFixture } from "../reader-instance-fixture"
import { KernelTaskResultFixture } from "./kernel-task-result"

const wait = <A, E, R>(effect: Effect.Effect<A | undefined, E, R>) => Effect.gen(function* () {
  for (const attempt of Array.from({ length: 200 }, (_, index) => index)) {
    const value = yield* effect
    if (value !== undefined) return value
    if (attempt === 199) return yield* Effect.die(new Error("Bounded remote result reader observation timed out"))
    yield* Effect.sleep("20 millis")
  }
  return yield* Effect.die(new Error("Unreachable remote result observation"))
})
const rows = (db: Database.Interface["db"]) => Effect.gen(function* () {
  const tables = yield* db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
  return yield* Effect.forEach(tables, (table) => db.all<Record<string, unknown>>(`SELECT * FROM "${table.name.replaceAll('"', '""')}"`).pipe(
    Effect.map((items) => [table.name, items.map((row) => Hash.sha256(CanonicalJson.stringify(row))).sort()])))
})

/** Controlled terminal B producer remains the original fixture. Only the original
 * successful PUB/ACK/owned-result facts are observed; A receives its actual wire bytes. */
export async function run(root: string) {
  const resultMessage = { current: undefined as { expiresAt: number; content: string } | undefined }
  const fact = { locator: false, lookup: false, readonly: false, rejected: 0 }
  await KernelTaskResultFixture.run(root, {
    identity: { token: "private-remote-reader-token", userID: "sender" },
    response(topic, request, original) {
      if (topic === "qry_user_info") return original
      const scopeKey = "c".repeat(64)
      const projectionKey = "d".repeat(64)
      const message = resultMessage.current
      if (topic === "qry_delivery_reader") return { name: "DeliveryReaderInfo", value: {
        version: 1, scopeKey, currentCursor: "1", serverNow: Date.now(), maxPageItems: 32,
        maxChangeBytes: 65536, maxMessageBytes: 4194304, maxWindowPages: 100000 } }
      if (topic === "qry_delivery_changes") return { name: "DeliveryChangesResult", value: {
        version: 1, scopeKey, after: request.after || "0", upper: "1", scanCursor: "1",
        scanProjectionKey: request.after === "1" ? "" : projectionKey, pageToken: "", windowComplete: true, caughtUp: true,
        serverNow: Date.now(), items: request.after === "1" ? [] : [{ visibility: "visible", projectionKey,
          revision: "1", cursor: "1", conversationType: 1, targetId: "receiver", readOrdinal: "0", admittedOrdinal: "1",
          liveUnread: "1", storedUnread: "1", latestMessageId: "native-original-result", latestSequence: "2",
          latestMessageTime: 1, nextExpiryAt: message?.expiresAt }] } }
      if (topic === "qry_delivery_messages") {
        assert.ok(message, "Only a real acknowledged publication supplies A's incoming message")
        return { name: "DeliveryMessagesResult", value: { version: 1, scopeKey, projectionKey,
          projectionRevision: request.projectionRevision, direction: request.direction,
          nextDeliveryCursor: "1", finished: true, serverNow: Date.now(), items: [{
            effectKey: Hash.sha256("A-native-original-result"), messageId: "native-original-result", sequence: "2",
            deliveryCursor: "1", messageTime: 1, expiresAt: message.expiresAt, senderId: "receiver", targetId: "receiver",
            conversationType: 1, content: message.content, isSend: false, isRead: false }] } }
      }
      if (topic === "qry_delivery_read_cut") return { name: "DeliveryReadCutResult", value: {
        version: 1, scopeKey, projectionKey, projectionRevision: request.projectionRevision,
        throughOrdinal: "0", targetAdmittedOrdinal: "1", readOrdinal: "0", liveUnread: "1", storedUnread: "1",
        complete: false, serverNow: Date.now() } }
      return original
    },
    observe(input) { return Effect.gen(function* () {
      assert.equal(input.wire.length, 1)
      assert.ok(input.wire[0].message.msgContent instanceof Uint8Array)
      resultMessage.current = { content: new TextDecoder().decode(input.wire[0].message.msgContent),
        expiresAt: Number(String(input.wire[0].message.deliveryExpiresAt)) }
      const child = Bun.spawn([process.execPath, import.meta.path], { cwd: process.cwd(),
        env: { ...process.env, DAC_REMOTE_TASK_READER: JSON.stringify({ root, appkey: input.source.appkey, navigator: input.origin }), DAC_REMOTE_TASK_RESULT_ROOT: undefined },
        stdout: "pipe", stderr: "pipe" })
      const output = yield* Effect.promise(() => Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])).pipe(
        Effect.ensuring(Effect.sync(() => { child.kill() })))
      yield* Effect.promise(() => Bun.write(`${root}/reader-a.log`, output[1] + output[2]))
      assert.equal(output[0], 0, output[1] + output[2])
      const locator = Schema.decodeUnknownSync(IMRemoteTaskResult.Locator)(yield* Effect.promise(() => Bun.file(`${root}/reader-a-locator.json`).json()), { onExcessProperty: "error" })
      assert.equal(locator.state, "available")
      if (locator.state !== "available") throw new Error("A did not return a real current-reader locator")
      assert.deepEqual(locator.tuple, { version: 1, realm: input.source.realm, appkey: input.source.appkey,
        orgID: "1", kernelMessageID: "native-original-result", senderID: "receiver", receiverID: "sender",
        conversationType: 1, conversationID: "receiver" })
      fact.locator = true
        const lookup = (tuple: IMRemoteTaskResult.Tuple, changes: Partial<typeof input.context> = {}) =>
          input.lease.reader.withOutput({ workspaceID: input.context.workspaceID, userID: input.context.userID,
            groupIDs: [input.result.groupID] }, Effect.gen(function* () {
              const before = yield* rows(input.db)
              const result = yield* IMRemoteTaskResult.lookup(input.db, { ...input.context, ...changes, tuple })
              assert.deepEqual(yield* rows(input.db), before)
              return result
            }))
        assert.deepEqual(yield* lookup(locator.tuple), input.result)
        fact.lookup = true
        assert.equal((yield* IMRemoteTaskResult.lookup(input.db, { ...input.context, tuple: locator.tuple })).state, "unavailable")
        for (const changed of [{ kernelMessageID: "missing" }, { realm: "https://other.invalid/" },
          { appkey: "other" }, { orgID: "9007199254740993" }, { senderID: "foreign" },
          { receiverID: "foreign" }] ) {
          assert.deepEqual(yield* lookup({ ...locator.tuple, ...changed }), { version: 1, state: "unavailable", code: "remote_result_unlinked" })
          fact.rejected++
        }
        assert.equal((yield* lookup(locator.tuple, { workspaceID: "/foreign" })).state, "unavailable")
        assert.equal((yield* lookup(locator.tuple, { userID: "foreign" })).state, "unavailable")
        fact.rejected += 2
      fact.readonly = true

    }) },
  })
  await Bun.write(`${root}/remote-result.json`, JSON.stringify({ ...fact, providers: 0, counts: 0, wire: 1, acknowledged: true }))
}

async function reader(value: string) {
  const input = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ root: Schema.String, appkey: Schema.String, navigator: Schema.String })))(value)
  const config = { appkey: input.appkey, navigator: input.navigator, token: "private-remote-reader-token", userID: "sender",
    identity: { uuid: "sender", orgID: 1, name: "Sender", orgAllGroupID: "unused" } }
  await mkdir(`${input.root}/reader-a`, { mode: 0o700 })
  const client = KernelClient.layer.pipe(Layer.provide(KernelSdk.liveFromConfig(config)))
  const services = Layer.mergeAll(Database.layerFromPath(`${input.root}/reader-a.sqlite`), ReaderInstanceFixture.layer,
    ReaderInstanceFixture.registry, IMBroadcasterLive, client)
  await Effect.runPromise(Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const client = yield* KernelClient.Service
    yield* wait(SubscriptionRef.get(client.state).pipe(Effect.map((state) => state === "connected" ? true : undefined)))
    const store = yield* InstanceStore.Service
    const instance = yield* store.load({ directory: `${input.root}/reader-a` })
    const registry = yield* IMReaderRegistry.make(config, { inspectConversation: (request) =>
      IMKernelExchange.inspectConversation({ ...request, facadeURL: input.navigator, key: "private-witness-key" }).pipe(Effect.provide(FetchHttpClient.layer)) })
    const entry = yield* registry.acquire({ instance, workspaceID: instance.directory, userID: "server",
      instanceCurrent: store.peek(instance.directory).pipe(Effect.map((current) => current === instance)) })
    yield* wait(Effect.sync(() => entry.lifetime.native === 0 && !entry.lifetime.running && !entry.lifetime.queued ? true : undefined))
    const original = yield* db.get<{ local_message_id: string; group_id: string }>(sql`SELECT r.local_message_id,m.group_id FROM im_kernel_reader_message r JOIN im_messages m ON m.id=r.local_message_id WHERE r.message_id='native-original-result'`)
    assert.ok(original)
    const scope = { messageID: original.local_message_id, workspaceID: instance.directory, directory: instance.directory,
      instanceID: "reader-a-private", userID: "server" }
    assert.equal((yield* IMRemoteTaskResult.locator(db, scope))?.state, "unavailable")
    const before = yield* rows(db)
    const locator = yield* entry.reader.withOutput({ workspaceID: scope.workspaceID, userID: scope.userID,
      groupIDs: [original.group_id] }, IMRemoteTaskResult.locator(db, scope))
    assert.equal(locator?.state, "available", JSON.stringify(locator))
    if (locator?.state !== "available") throw new Error("Original reader did not return a remote result locator")
    assert.equal(Schema.is(IMRemoteTaskResult.Tuple)({ ...locator.tuple, orgID: "01" }), false)
    assert.equal(Option.isNone(Schema.decodeUnknownOption(IMRemoteTaskResult.Tuple, { onExcessProperty: "error" })({ ...locator.tuple, url: input.navigator })), true)
    assert.deepEqual(yield* rows(db), before)
    assert.equal((yield* db.get<{ n: number }>(sql`SELECT count(*) n FROM session`))?.n, 0)
    assert.equal((yield* db.get<{ n: number }>(sql`SELECT count(*) n FROM work_execution`))?.n, 0)
    yield* Effect.promise(() => Bun.write(`${input.root}/reader-a-locator.json`, JSON.stringify(locator)))
  }).pipe(Effect.provide(services), Effect.scoped))
}

if (process.env.DAC_REMOTE_TASK_READER) await reader(process.env.DAC_REMOTE_TASK_READER)
if (process.env.DAC_REMOTE_TASK_RESULT_ROOT) await run(process.env.DAC_REMOTE_TASK_RESULT_ROOT)
