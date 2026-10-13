export * as IMKernelMediaUpload from "./media-upload"

import { Effect } from "effect"
import { createHash } from "node:crypto"
import { AttachmentStorage } from "@deepagent-code/core/im/attachment-storage"
import type { IMAttachment } from "@deepagent-code/core/im/repository"
import { MediaUploadCheckpoint } from "@deepagent-code/core/im/media-upload-checkpoint"
import { MediaUploadCheckpointModel } from "@deepagent-code/core/im/media-upload-checkpoint.model"
import { KernelReader } from "@deepagent-code/core/im/kernel-reader"
import { MediaFiles } from "../media-files"
import { KernelSdk } from "./sdk"

const unavailable = () => new KernelSdk.KernelError({ operation: "media_upload", message: "The original attachment is unavailable" })
const attempt = <A>(run: () => PromiseLike<A>) => Effect.tryPromise({ try: run, catch: unavailable })

// The same no-follow file handle is verified before Begin and after every
// bounded read. Upload identity is stable across explicit retries.
export const upload = (media: KernelSdk.Media, local: IMAttachment, input: { source: unknown; messageID: string; conversationType: 1 | 2; conversationID: string; checkpoint?: {runtime:KernelReader.Runtime; original:MediaUploadCheckpointModel.Record} }) => Effect.gen(function* () {
  if (local.deletedAt !== null || AttachmentStorage.expiresAt(local.createdAt) <= Date.now()) return yield* unavailable()
  const checkpoint = input.checkpoint
  const persist = (update:Parameters<typeof MediaUploadCheckpoint.updateAttempt>[2],release=false) => checkpoint ? MediaUploadCheckpoint.updateAttempt(checkpoint.runtime,checkpoint.original,update,release) : Effect.succeed(undefined)
  return yield* Effect.acquireUseRelease(attempt(() => MediaFiles.open(local)), (opened) => Effect.gen(function* () {
    const file = opened.file
    const check = Effect.gen(function* () {
      yield* attempt(opened.check)
      if (AttachmentStorage.expiresAt(local.createdAt) <= Date.now()) return yield* unavailable()
    })
    const digest = createHash("sha256")
    const buffer = Buffer.alloc(Math.min(262144, Math.max(1, local.sizeBytes)))
    for (let offset = 0; offset < local.sizeBytes;) {
      const chunk = yield* attempt(() => file.read(buffer, 0, Math.min(buffer.length, local.sizeBytes - offset), offset))
      if (chunk.bytesRead === 0) return yield* unavailable()
      if (offset === 0 && AttachmentStorage.isPreviewMime(local.mime) && AttachmentStorage.previewMime(buffer.subarray(0, chunk.bytesRead)) !== local.mime) return yield* unavailable()
      digest.update(buffer.subarray(0, chunk.bytesRead))
      offset += chunk.bytesRead
      yield* check
    }
    if (digest.digest("hex") !== local.checksum) return yield* unavailable()
    yield* check
    yield* persist({bodyVerified:true})
    yield* media.capabilities()
    yield* check
    yield* persist({beginDispatched:true,phase:"unknown_upload",outcome:"unknown_upload"})
    const started = yield* media.begin({ conversationType: input.conversationType, conversationID: input.conversationID, upload: { uploadID: checkpoint?.original.plan?.uploadID ?? `dac_${createHash("sha256").update(JSON.stringify(["im-media-upload-v1", input.source, input.messageID, local.id, local.checksum])).digest("hex")}`, filename: local.filename, sizeBytes: local.sizeBytes, sha256: local.checksum } })
    yield* check
    if (started.filename !== local.filename || started.sizeBytes !== local.sizeBytes || started.sha256 !== local.checksum || started.expiresAt <= Date.now()) return yield* unavailable()
    const identity = (object:typeof started) => ({objectID:object.objectID,uploadID:object.uploadID,filename:object.filename,sizeBytes:object.sizeBytes,sha256:object.sha256,createdAt:object.createdAt,expiresAt:object.expiresAt})
    if (checkpoint && (started.state === "bound" || started.uploadID !== checkpoint.original.plan?.uploadID || checkpoint.original.remote && MediaUploadCheckpointModel.remoteHash(identity(started)) !== checkpoint.original.remoteHash)) return yield* MediaUploadCheckpointModel.conflict()
    if (checkpoint && !["uploading","uploaded_unbound"].includes(started.state)) return yield* MediaUploadCheckpointModel.unknown()
    yield* persist({remote:identity(started),remoteFacts:{state:started.state === "uploading" ? "uploading" : "uploaded_unbound",receivedBytes:started.receivedBytes,receivedChunks:started.receivedChunks,progressHash:null},phase:started.state === "uploading" ? "uploading" : "uploaded",outcome:"confirmed"})
    const descriptor = (object: typeof started) => ({ attachmentID: object.objectID, contentRef: object.objectID, filename: object.filename,
      mime: object.mime, sizeBytes: object.sizeBytes, sha256: object.sha256, createdAt: object.createdAt, expiresAt: object.expiresAt })
    // Begin can reconcile a Finalize whose response was lost. Closed objects
    // must not receive another chunk or acquire a fresh expiry.
    if (["uploaded_unbound", "bound"].includes(started.state)) {
      if (started.receivedBytes !== local.sizeBytes || started.receivedChunks !== Math.ceil(local.sizeBytes / 262144)) return yield* unavailable()
      yield* persist({phase:"uploaded",outcome:"confirmed"},true)
      return descriptor(started)
    }
    if (started.state !== "uploading") return yield* unavailable()
    const committed = new Set<number>()
    if (started.receivedChunks > 0 && media.transferCapabilities && media.uploadProgress) {
      const capability = yield* media.transferCapabilities().pipe(Effect.catch((error) =>
        typeof error.cause === "object" && error.cause !== null &&
        "name" in error.cause && error.cause.name === "DeliveryError" &&
        "operation" in error.cause && error.cause.operation === "media_transfer_capabilities" &&
        "kind" in error.cause && error.cause.kind === "not_found" ? Effect.succeed(undefined) : Effect.fail(error)))
      yield* check
      if (capability) {
        const progress = yield* media.uploadProgress({ objectID: started.objectID })
        yield* check
        if (progress.object.objectID !== started.objectID || progress.object.uploadID !== started.uploadID ||
            progress.object.filename !== started.filename || progress.object.sizeBytes !== started.sizeBytes || progress.object.sha256 !== started.sha256 ||
            progress.object.createdAt !== started.createdAt || progress.object.expiresAt !== started.expiresAt || progress.object.state !== "uploading" ||
            progress.object.receivedBytes < started.receivedBytes || progress.object.receivedChunks < started.receivedChunks) return yield* unavailable()
        yield* persist({remoteFacts:{state:"uploading",receivedBytes:progress.object.receivedBytes,receivedChunks:progress.object.receivedChunks,progressHash:MediaUploadCheckpointModel.hash(progress)}})
        progress.committedIndices.forEach((index) => committed.add(index))
      }
    }
    const uploaded = createHash("sha256")
    for (let offset = 0, index = 0; offset < local.sizeBytes; index++) {
      const bytes = Math.min(262144, local.sizeBytes - offset)
      // A file read can be short. Fill this fixed chunk before dispatching its index.
      for (let filled = 0; filled < bytes;) {
        const chunk = yield* attempt(() => file.read(buffer, filled, bytes - filled, offset + filled))
        if (chunk.bytesRead === 0) return yield* unavailable()
        filled += chunk.bytesRead
      }
      yield* check
      uploaded.update(buffer.subarray(0, bytes))
      if (!committed.has(index)) yield* media.putChunk({ objectID: started.objectID, index, body: buffer.subarray(0, bytes) })
      offset += bytes
    }
    if (uploaded.digest("hex") !== local.checksum) return yield* unavailable()
    yield* check
    const finalized = yield* media.finalize({ objectID: started.objectID })
    yield* check
    if (finalized.filename !== local.filename || finalized.sizeBytes !== local.sizeBytes || finalized.sha256 !== local.checksum || finalized.expiresAt <= Date.now()) return yield* unavailable()
    if (finalized.objectID !== started.objectID || finalized.uploadID !== started.uploadID || finalized.createdAt !== started.createdAt ||
        finalized.expiresAt !== started.expiresAt || !["uploaded_unbound", "bound"].includes(finalized.state)) return yield* unavailable()
    if (checkpoint && finalized.state === "bound") return yield* MediaUploadCheckpointModel.conflict()
    yield* persist({remote:identity(finalized),remoteFacts:{state:"uploaded_unbound",receivedBytes:finalized.receivedBytes,receivedChunks:finalized.receivedChunks,progressHash:null},phase:"uploaded",outcome:"confirmed"},true)
    return descriptor(finalized)
  }), (opened) => attempt(() => opened.file.close()).pipe(Effect.orDie)).pipe(Effect.onError(() => checkpoint ? MediaUploadCheckpoint.abandon(checkpoint.runtime,checkpoint.original).pipe(Effect.ignore) : Effect.void))
})
