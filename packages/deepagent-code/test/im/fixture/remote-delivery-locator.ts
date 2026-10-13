import assert from "node:assert/strict"
import { Effect, Layer } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@deepagent-code/core/database/database"
import { IMRepository, IMRepositoryLive } from "@deepagent-code/core/im/repository"
import { KernelDelivery } from "@deepagent-code/core/im/kernel-delivery"
import { CanonicalJson } from "@deepagent-code/core/util/canonical-json"
import { Hash } from "@deepagent-code/core/util/hash"
import { IMRemoteDeliveryLocator } from "@/im/remote-delivery-locator"
import { IMRemoteTaskResult } from "@/im/remote-task-result"

// Original Core prepare/claim/ACK are exercised with a controlled transport ACK.
// No task terminal, Native authority, SDK publication, or status notice is invented.
const root = process.env.DAC_REMOTE_STATUS_RECEIPT_ROOT
if (!root) throw new Error("Private receipt fixture root required")
const database = Database.layerFromPath(`${root}/receipt.sqlite`)
await Effect.runPromise(Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const repository = yield* IMRepository
    const group = yield* repository.createGroup({ workspaceID: root, type: "direct", name: "Receipt module", createdBy: "server" })
    yield* repository.bindKernelConversation({ groupID: group.id, kernelConvID: "k:1:sender" })
    const runtime = KernelDelivery.runtime({ realm: "http://127.0.0.1:9/", appkey: "receipt-module",
      orgID: 1, senderID: "receiver", credentialFingerprint: "a".repeat(64) })
    yield* Effect.addFinalizer(() => Effect.sync(() => KernelDelivery.close(runtime)))
    const create = (clientRequestID: string) => KernelDelivery.withCreation(runtime, group.id,
      repository.createMessage({ groupID: group.id, clientRequestID, senderID: "server", senderType: "user",
        type: "text", content: "Bounded original receipt" }))
    const acknowledge = (messageID: string) => Effect.gen(function* () {
      const dispatch = yield* KernelDelivery.withVerification(runtime, { conversationType: 1, conversationID: "sender",
        orgID: 1, memberIDs: ["receiver", "sender"] }, repository.claimKernelDelivery(runtime, messageID))
      assert.ok(dispatch)
      assert.equal(yield* repository.acknowledgeKernelDelivery(runtime, dispatch, "native-original-result"), true)
    })
    const message = yield* create("original")
    const tuple: IMRemoteTaskResult.Tuple = { version: 1, realm: runtime.source.realm, appkey: runtime.source.appkey,
      orgID: "1", kernelMessageID: "native-original-result", senderID: "receiver", receiverID: "sender",
      conversationType: 1, conversationID: "receiver" }
    const rows = () => Effect.gen(function* () {
      const tables = yield* db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      return yield* Effect.forEach(tables, (table) => db.all<Record<string, unknown>>(`SELECT * FROM "${table.name.replaceAll('"', '""')}"`).pipe(
        Effect.map((items) => [table.name, items.map((row) => Hash.sha256(CanonicalJson.stringify(row))).sort()])))
    })
    const resolve = (value: IMRemoteTaskResult.Tuple, workspaceID = root) =>
      IMRemoteDeliveryLocator.resolveMessage(db, { workspaceID, tuple: value })
    assert.equal(yield* resolve(tuple), undefined)
    yield* acknowledge(message.id)
    const before = yield* rows()
    assert.equal(yield* resolve(tuple), message.id)
    assert.equal(yield* resolve(tuple), message.id)
    const changed = [{ kernelMessageID: "missing" }, { realm: "https://foreign.invalid/" }, { appkey: "foreign" },
      { orgID: "9007199254740993" }, { senderID: "foreign" }, { receiverID: "foreign" },
      { conversationID: "foreign" }, { conversationType: 2 as const }]
    for (const value of changed) assert.equal(yield* resolve({ ...tuple, ...value }), undefined)
    assert.equal(yield* resolve(tuple, "/foreign"), undefined)
    assert.equal(yield* resolve({ ...tuple, orgID: "01" }), undefined)
    assert.equal(yield* resolve({ ...tuple, url: "http://127.0.0.1:9/" } as IMRemoteTaskResult.Tuple), undefined)
    assert.deepEqual(yield* rows(), before)
    const duplicate = yield* create("duplicate-ack")
    yield* KernelDelivery.withVerification(runtime, { conversationType: 1, conversationID: "sender",
      orgID: 1, memberIDs: ["receiver", "sender"] }, repository.claimKernelDelivery(runtime, duplicate.id))
    // Adversarial index damage is storage-only. The real legacy message index
    // forbids a second ACK; never label these injected bytes a transport fact.
    yield* db.run(sql`UPDATE im_kernel_delivery SET state='acknowledged',kernel_message_id='native-original-result',
      acknowledged_at=${Date.now()},updated_at=${Date.now()} WHERE message_id=${duplicate.id}`)
    assert.equal(yield* resolve(tuple), undefined)
    yield* db.run(sql`UPDATE im_kernel_delivery SET kernel_message_id='another' WHERE message_id=${duplicate.id}`)
    yield* db.run(sql`UPDATE im_kernel_delivery SET binding=json_set(binding,'$.source.senderID','foreign') WHERE message_id=${message.id}`)
    assert.equal((yield* resolve(tuple).pipe(Effect.flip)).code, "remote_delivery_unavailable")
    assert.equal((yield* db.get<{ n: number }>("SELECT count(*) n FROM session_input"))?.n, 0)
    assert.equal((yield* db.get<{ n: number }>("SELECT count(*) n FROM session_provider_attempt"))?.n, 0)
    yield* Effect.promise(() => Bun.write(`${root}/receipt.json`, JSON.stringify({ originalReceipt: true,
      readonly: true, rejected: 11, ambiguous: true, corrupted: true, wire: 0, providers: 0, counts: 0 })))
  }).pipe(Effect.provide(Layer.merge(database, IMRepositoryLive.pipe(Layer.provide(database)))), Effect.scoped))
