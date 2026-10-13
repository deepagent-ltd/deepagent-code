import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Layer, Stream, SubscriptionRef } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { IMRepository, IMRepositoryLive, clientMessageID } from "@deepagent-code/core/im/repository"
import { IMBroadcasterLive } from "@deepagent-code/core/im/broadcaster"
import { KernelDelivery } from "@deepagent-code/core/im/kernel-delivery"
import { InstanceStore } from "@/project/instance-store"
import { KernelClient } from "@/im/kernel/client"
import { KernelConfig } from "@/im/kernel/config"
import { IMKernelSync } from "@/im/kernel/sync"
import { ReaderInstanceFixture } from "./reader-instance-fixture"

test("the actual fixed Host engine rejects retired identity before attachment lookup or any upload/send port", async () => {
  const directory = await fs.mkdtemp("/tmp/dac-host-media-retired-preflight-")
  const clock = { value: Date.now() }
  const calls = { attachment: 0, begin: 0, finalize: 0, send: 0, otherMedia: 0 }
  const config = { appkey: "private-retired-preflight", navigator: "http://127.0.0.1:9", token: "private-controlled-port",
    userID: "receiver", identity: { uuid: "receiver", orgID: 1, name: "Receiver", orgAllGroupID: "unused" }, protectedMedia: true }
  const database = Database.layerFromPath(path.join(directory, "private.sqlite"))
  const repository = Layer.effect(IMRepository, Effect.gen(function* () {
    const actual = yield* IMRepository
    return { ...actual, getAttachment: (id: string) => Effect.sync(() => { calls.attachment++ }).pipe(Effect.andThen(actual.getAttachment(id))) }
  })).pipe(Layer.provide(IMRepositoryLive.pipe(Layer.provide(database))))
  // Controlled SDK ports provide the original observations to the production
  // Host reader. There is no socket, Native service, provider or upload file.
  const client = Layer.effect(KernelClient.Service, Effect.gen(function* () {
    const mediaTrap = () => Effect.sync(() => { calls.otherMedia++ }).pipe(Effect.andThen(Effect.die("Unexpected media I/O")))
    const sendTrap = () => Effect.sync(() => { calls.send++ }).pipe(Effect.andThen(Effect.die("Unexpected message send")))
    return {
      state: yield* SubscriptionRef.make<KernelClient.ConnectionState>("connected"), messages: Stream.empty,
      sendText: sendTrap, sendMedia: sendTrap, disconnect: Effect.void,
      fetchHistory: () => Effect.die("Legacy history is out of scope"), fetchConversations: () => Effect.die("Legacy conversations are out of scope"),
      getDeliveryReader: () => Effect.succeed({ version: 2 as const, scopeKey: "a".repeat(64), currentCursor: "0", serverNow: clock.value,
        maxPageItems: 32, maxChangeBytes: 65536, maxMessageBytes: 4194304, maxWindowPages: 100000 }),
      getDeliveryChanges: (input: Parameters<KernelClient.Interface["getDeliveryChanges"]>[0]) => Effect.succeed({ version: 2 as const,
        scopeKey: input.scopeKey, after: input.after, upper: "0", scanCursor: "0", scanProjectionKey: "", pageToken: "", windowComplete: true,
        caughtUp: true, serverNow: clock.value, items: [] }),
      getDeliveryMessages: () => Effect.die("Historical messages are out of scope"), getDeliveryReadCut: () => Effect.die("Read-cut is out of scope"),
      markDeliveryRead: () => Effect.die("Read mutation is out of scope"),
      media: { capabilities: mediaTrap, begin: () => Effect.sync(() => { calls.begin++ }).pipe(Effect.andThen(Effect.die("Unexpected Begin"))),
        putChunk: mediaTrap, finalize: () => Effect.sync(() => { calls.finalize++ }).pipe(Effect.andThen(Effect.die("Unexpected Finalize"))),
        status: mediaTrap, cancel: mediaTrap, readRange: mediaTrap },
    }
  }))
  const services = Layer.mergeAll(database, repository, client, IMBroadcasterLive, ReaderInstanceFixture.layer, ReaderInstanceFixture.registry)
  const engine = IMKernelSync.layer(config, { inspectConversation: (input) => Effect.succeed({ conversation_type: input.conversationType,
    conversation_id: input.conversationID, org_id: 1, name: "Sender", member_uuids: ["receiver", "sender"] }) }).pipe(Layer.provide(services))
  try {
    await Effect.runPromise(Effect.gen(function* () {
      const store = yield* InstanceStore.Service
      const repo = yield* IMRepository
      const db = (yield* Database.Service).db
      const instance = yield* store.load({ directory })
      const lease = yield* (yield* IMKernelSync.Service).acquireReader!({ instance, workspaceID: instance.directory, userID: "server",
        instanceCurrent: store.peek(instance.directory).pipe(Effect.map((current) => current === instance)) })
      const groupID = yield* lease.reader.pending({ conversationType: 1, conversationID: "sender", name: "Sender" })
      const local = yield* repo.createAttachment({ workspaceID: instance.directory, groupID, uploadedBy: "server", storagePath: "/private/never-opened-retired-media",
        filename: "original-private.txt", mime: "text/plain", sizeBytes: 0, checksum: KernelDelivery.hash("zero-byte-object") })
      const remote = { attachmentID: "c".repeat(64), contentRef: "c".repeat(64), filename: local.filename, mime: local.mime, sizeBytes: 0,
        sha256: local.checksum!, createdAt: clock.value - 1000, expiresAt: clock.value - 1000 + 86_400_000 }
      const input = { groupID, clientRequestID: "original-retired-host", senderID: "server", senderType: "user" as const, type: "file" as const,
        content: "Original private caption", attachments: [{ id: local.id, workspaceID: instance.directory }],
        metadata: [{ type: "attachment_ref" as const, attachmentID: local.id, batch: true as const }] }
      const authority = KernelDelivery.runtime(KernelConfig.deliverySource(config))
      yield* Effect.addFinalizer(() => Effect.sync(() => KernelDelivery.close(authority)))
      const message = yield* KernelDelivery.withMediaCreation(authority, { messageID: clientMessageID(input.senderID, input.clientRequestID),
        groupID, senderID: input.senderID, content: input.content, attachments: [{ local, remote }] }, repo.createMessage(input))
      const dispatch = yield* KernelDelivery.withVerification(authority, { conversationType: 1, conversationID: "sender", orgID: 1,
        memberIDs: ["receiver", "sender"] }, repo.claimKernelDelivery(authority, message.id))
      expect(dispatch).toBeDefined()
      expect(yield* repo.acknowledgeKernelDelivery(authority, dispatch!, "original-kernel-ack")).toBe(true)
      clock.value = remote.expiresAt
      yield* lease.reader.sync
      yield* lease.reader.sync
      expect(yield* SubscriptionRef.get(lease.reader.state)).toMatchObject({ state: "ready" })
      expect((yield* KernelDelivery.history(db, message.id)).kind).toBe("retired")
      calls.attachment = 0
      const rows = yield* db.all("SELECT * FROM im_kernel_media_body")
      expect(yield* lease.engine.createMessage(input).pipe(Effect.flip)).toMatchObject({ code: "message_identity_conflict" })
      expect(calls).toEqual({ attachment: 0, begin: 0, finalize: 0, send: 0, otherMedia: 0 })
      expect(yield* db.all("SELECT * FROM im_kernel_media_body")).toEqual(rows)
      expect(yield* Effect.promise(() => Bun.file(local.storagePath).exists())).toBe(false)
    }).pipe(Effect.provide(Layer.mergeAll(services, engine)), Effect.scoped))
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
    expect(await Bun.file(path.join(directory, "private.sqlite")).exists()).toBe(false)
  }
}, 10000)
