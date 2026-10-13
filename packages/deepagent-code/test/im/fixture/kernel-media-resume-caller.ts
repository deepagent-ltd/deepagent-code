import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Exit, Layer, Schema, SubscriptionRef } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@deepagent-code/core/database/database"
import { IMRepository, IMRepositoryLive } from "@deepagent-code/core/im/repository"
import { IMBroadcasterLive } from "@deepagent-code/core/im/broadcaster"
import { AttachmentStorage } from "@deepagent-code/core/im/attachment-storage"
import { Global } from "@deepagent-code/core/global"
import { InstanceStore } from "@/project/instance-store"
import { KernelSdk } from "@/im/kernel/sdk"
import { KernelClient } from "@/im/kernel/client"
import { IMKernelSync } from "@/im/kernel/sync"
import { MediaFiles } from "@/im/media-files"
import { ReaderInstanceFixture } from "../reader-instance-fixture"

const input = Schema.decodeUnknownSync(
  Schema.Struct({
    root: Schema.String,
    navigator: Schema.String,
    mode: Schema.Literals(["first", "resume"]),
    checksum: Schema.String,
    sizeBytes: Schema.Number,
  }),
)(await Bun.file(process.argv[2]!).json())
const config = {
  appkey: "private-resume-caller",
  navigator: input.navigator,
  token: "private-first-seen-token",
  userID: "receiver",
  identity: { uuid: "receiver", orgID: 1, name: "Receiver", orgAllGroupID: "unused" },
  protectedMedia: true,
}
const database = Database.layerFromPath(path.join(input.root, "host.sqlite"))
const services = Layer.mergeAll(
  database,
  IMRepositoryLive.pipe(Layer.provide(database)),
  KernelClient.layer.pipe(Layer.provide(KernelSdk.liveFromConfig(config))),
  IMBroadcasterLive,
  ReaderInstanceFixture.layer,
  ReaderInstanceFixture.registry,
)
const engine = IMKernelSync.layer(config, {
  inspectConversation: (value) =>
    Effect.succeed({
      conversation_type: value.conversationType,
      conversation_id: value.conversationID,
      org_id: 1,
      name: "Sender",
      member_uuids: ["receiver", "sender"],
    }),
}).pipe(Layer.provide(services))
const result = await Effect.runPromise(
  Effect.gen(function* () {
    const store = yield* InstanceStore.Service
    const actualClient = yield* KernelClient.Service
    for (const attempt of Array.from({ length: 200 }, (_, index) => index)) {
      if ((yield* SubscriptionRef.get(actualClient.state)) === "connected") break
      if (attempt === 199) return yield* Effect.die(new Error("Private SDK connection not ready"))
      yield* Effect.sleep("10 millis")
    }
    const sync = yield* IMKernelSync.Service
    const repo = yield* IMRepository
    const db = (yield* Database.Service).db
    const instance = yield* store.load({ directory: input.root })
    const lease = yield* sync.acquireReader!({
      instance,
      workspaceID: instance.directory,
      userID: "server",
      instanceCurrent: store.peek(instance.directory).pipe(Effect.map((current) => current === instance)),
    })
    const groupID = yield* lease.reader.pending({ conversationType: 1, conversationID: "sender", name: "Sender" })
    const attachment = yield* lease.reader.withOutput(
      { workspaceID: instance.directory, userID: "server", groupIDs: [groupID] },
      input.mode === "first"
        ? Effect.gen(function* () {
            yield* Effect.promise(() => MediaFiles.directory(instance.directory, true))
            const derived = AttachmentStorage.deriveStoragePath({
              dataDir: Global.Path.data,
              workspaceID: instance.directory,
              attachmentID: "ima_cold_resume",
            })
            if (!derived.ok) return yield* Effect.die(new Error("Private attachment path unavailable"))
            const value = yield* repo.createAttachment({
              id: "ima_cold_resume",
              workspaceID: instance.directory,
              groupID,
              uploadedBy: "server",
              storagePath: derived.storagePath,
              filename: "private.bin",
              mime: "application/octet-stream",
              sizeBytes: input.sizeBytes,
              checksum: input.checksum,
            })
            yield* Effect.promise(() => fs.copyFile(path.join(input.root, "source.bin"), value.storagePath))
            yield* Effect.promise(() => fs.chmod(value.storagePath, 0o600))
            return value
          })
        : repo.getAttachment("ima_cold_resume"),
    )
    if (!attachment) return yield* Effect.die(new Error("Original attachment unavailable after cold reopen"))
    const outcome = yield* Effect.exit(
      lease.engine
        .createMessage({
          groupID,
          clientRequestID: "original-cold-resume",
          senderID: "server",
          senderType: "user",
          type: "file",
          content: "Original cold resume file",
          attachments: [{ id: attachment.id, workspaceID: instance.directory, expected: attachment }],
          metadata: [{ type: "attachment_ref", attachmentID: attachment.id, batch: true }],
        })
        .pipe(Effect.timeout("3 seconds")),
    )
    const copies = yield* db.get<{ messages: number; receipts: number }>(sql`SELECT
    (SELECT count(*) FROM im_messages WHERE client_request_id='original-cold-resume') messages,
    (SELECT count(*) FROM im_kernel_delivery) receipts`)
    return {
      pid: process.pid,
      mode: input.mode,
      outcome: outcome._tag,
      messageID: Exit.isSuccess(outcome) ? outcome.value.id : null,
      replayed: Exit.isSuccess(outcome) ? (outcome.value.replayed ?? false) : false,
      localAttachmentID: attachment.id,
      localCreatedAt: attachment.createdAt,
      hasTransferCapabilities: typeof lease.engine.media?.transferCapabilities === "function",
      hasUploadProgress: typeof lease.engine.media?.uploadProgress === "function",
      copies,
    }
  }).pipe(Effect.provide(Layer.mergeAll(services, engine)), Effect.scoped),
)
await Bun.write(path.join(input.root, `${input.mode}-result.json`), JSON.stringify(result))
