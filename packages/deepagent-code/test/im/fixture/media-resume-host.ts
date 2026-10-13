import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Exit, Layer, Schema, SubscriptionRef } from "effect"
import { sql } from "drizzle-orm"
import { KernelReader } from "@deepagent-code/core/im/kernel-reader"
import { Database } from "@deepagent-code/core/database/database"
import { clientMessageID, IMRepository, IMRepositoryLive } from "@deepagent-code/core/im/repository"
import { IMBroadcasterLive } from "@deepagent-code/core/im/broadcaster"
import { AttachmentStorage } from "@deepagent-code/core/im/attachment-storage"
import { Global } from "@deepagent-code/core/global"
import { InstanceStore } from "@/project/instance-store"
import { KernelSdk } from "@/im/kernel/sdk"
import { KernelClient } from "@/im/kernel/client"
import { IMKernelSync } from "@/im/kernel/sync"
import { MediaFiles } from "@/im/media-files"
import { ReaderInstanceFixture } from "../reader-instance-fixture"
import { MediaFileTrace } from "./kernel-media-file-trace"

const input = Schema.decodeUnknownSync(
  Schema.Struct({
    root: Schema.String,
    navigator: Schema.String,
    mode: Schema.Literals(["first", "resume"]),
    rotateIdentity: Schema.Boolean,
    checksum: Schema.String,
    sizeBytes: Schema.Number,
    negative: Schema.optional(Schema.Literals(["no-origin", "changed-request"])),
  }),
)(await Bun.file(process.argv[2]!).json())
const config = {
  appkey: "private-resume-caller",
  navigator: input.navigator,
  token: input.rotateIdentity && input.mode === "resume" ? "private-cold-successor-token" : "private-first-seen-token",
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
const inspections = { value: 0 }
const engine = IMKernelSync.layer(config, {
  inspectConversation: (value) =>
    Effect.sync(() => {
      inspections.value++
      return {
        conversation_type: value.conversationType,
        conversation_id: value.conversationID,
        org_id: 1,
        name: "Sender",
        member_uuids: ["receiver", "sender"],
      }
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
    yield* KernelReader.ensureScope(lease.reader.runtime)
    const groupID =
      input.mode === "first"
        ? yield* lease.reader.pending({ conversationType: 1, conversationID: "sender", name: "Sender" })
        : (yield* db.get<{ id: string }>(
            sql`SELECT id FROM im_groups WHERE workspace_id=${instance.directory} AND kernel_conv_id IS NOT NULL`,
          ))!.id
    const attachment =
      input.mode === "resume"
        ? yield* repo.getAttachment("ima_cold_resume")
        : yield* lease.reader.withOutput(
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
                  const value = yield* (
                    input.negative === "no-origin" ? repo.createAttachment : lease.engine.createAttachment!
                  )({
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
    inspections.value = 0
    const files = yield* Effect.promise(async () => MediaFileTrace.install(await fs.realpath(Global.Path.data)))
    const requestedContent =
      input.negative === "changed-request" && input.mode === "resume"
        ? "Changed original cold request"
        : "Original cold resume file"
    const outcome = yield* Effect.exit(
      lease.engine.prepareMediaContinuation!({
        messageID: clientMessageID("server", "original-cold-resume"),
        clientRequestID: "original-cold-resume",
        groupID,
        senderID: "server",
        content: requestedContent,
        attachmentIDs: [attachment.id],
        batch: true,
      }).pipe(
        Effect.andThen(
          lease.reader.withOutput(
            { workspaceID: instance.directory, userID: "server", groupIDs: [groupID] },
            lease.engine.createMessage({
              groupID,
              clientRequestID: "original-cold-resume",
              senderID: "server",
              senderType: "user",
              type: "file",
              content: "Original cold resume file",
              attachments: [{ id: attachment.id, workspaceID: instance.directory, expected: attachment }],
              metadata: [{ type: "attachment_ref", attachmentID: attachment.id, batch: true }],
            }),
          ),
        ),
        Effect.timeout("3 seconds"),
        Effect.ensuring(Effect.sync(files.restore)),
      ),
    )
    const copies = yield* db.get<{ messages: number; receipts: number }>(sql`SELECT
    (SELECT count(*) FROM im_messages WHERE client_request_id='original-cold-resume') messages,
    (SELECT count(*) FROM im_kernel_delivery) receipts`)
    const checkpoints = yield* db.get<{ records: number; bytes: number; rows: number }>(
      sql`SELECT used_records records,used_bytes bytes,(SELECT count(*) FROM im_media_upload_checkpoint) rows FROM im_media_upload_meter WHERE meter_id=1`,
    )
    return {
      checkpoints,
      inspectionCalls: inspections.value,
      fileOpens: files.counts["open:start"] ?? 0,
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
