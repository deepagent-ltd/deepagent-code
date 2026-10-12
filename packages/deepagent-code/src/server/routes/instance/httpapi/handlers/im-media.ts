export * as IMMedia from "./im-media"

import { Effect, Stream, Semaphore, Option } from "effect"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import { constants } from "node:fs"
import { AttachmentStorage } from "@deepagent-code/core/im/attachment-storage"
import type { IMRepositoryInterface, IMAttachment } from "@deepagent-code/core/im/repository"
import {
  IMAttachmentNotFoundError,
  IMFileUploadDisabledError,
  IMValidationFailedError,
  IMFileTooLargeError,
  IMUnsupportedMediaTypeError,
} from "../groups/im"
import { IMFacade } from "@/im/facade"
import { KernelReader } from "@deepagent-code/core/im/kernel-reader"
import type { KernelReaderSchema } from "@deepagent-code/core/im/kernel-reader.schema"
import { MediaFiles } from "@/im/media-files"
import { Log } from "@deepagent-code/core/util/log"

const log = Log.create({ service: "im-media" })

const uploads = Semaphore.makeUnsafe(2)
export const transfer = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  uploads
    .withPermitsIfAvailable(1)(effect)
    .pipe(
      Effect.flatMap((result) => (Option.isSome(result) ? Effect.succeed(result.value) : Effect.fail(unavailable()))),
      Effect.timeoutOrElse({ duration: "120 seconds", orElse: () => Effect.fail(unavailable()) }),
    )

export const unavailable = () =>
  new IMAttachmentNotFoundError({
    name: "ATTACHMENT_UNAVAILABLE",
    data: { message: "Attachment is unavailable." },
  })

export const enabled = (value: boolean) =>
  value
    ? Effect.void
    : Effect.fail(
        new IMFileUploadDisabledError({
          name: "FILE_UPLOAD_DISABLED",
          data: { message: "File and image sharing is disabled." },
        }),
      )

export const group = (
  repo: IMRepositoryInterface,
  input: { groupID: string; workspaceID: string; userID: string },
  lease?: IMFacade.ReaderLease,
) =>
  Effect.gen(function* () {
    const value = yield* repo.getGroup({ groupID: input.groupID, userID: input.userID })
    if (!value || value.workspaceID !== input.workspaceID) return yield* unavailable()
    if (
      (value.kernelConvID || value.reader) &&
      (!lease ||
        lease.workspaceID !== input.workspaceID ||
        lease.userID !== input.userID ||
        KernelReader.readerVersion(lease.reader.runtime) !== 2)
    )
      return yield* new IMValidationFailedError({
        name: "VALIDATION_FAILED",
        data: { message: "Media sharing is available only in local conversations." },
      })
    return value
  })

export const cleanup = (repo: IMRepositoryInterface, workspaceID: string) =>
  Effect.gen(function* () {
    // An unsafe current root is a storage failure, not one old record's GC warning.
    const parent = yield* Effect.tryPromise({
      try: () => MediaFiles.directory(workspaceID, false, true),
      catch: unavailable,
    })
    yield* Effect.tryPromise({ try: parent.check, catch: unavailable })
    const cursor = yield* repo.attachmentCleanupCursor(workspaceID)
    const items = yield* repo.listExpiredAttachments(workspaceID, cursor.after)
    const failed: string[] = []
    for (const item of items) {
      const removed = yield* Effect.tryPromise({
        try: () => MediaFiles.remove(item),
        catch: () => "private_file_cleanup_failed" as const,
      }).pipe(Effect.result)
      yield* Effect.tryPromise({ try: parent.check, catch: unavailable })
      if (removed._tag === "Success") yield* repo.expireAttachment(item.id)
      if (removed._tag === "Failure") failed.push(item.id)
    }
    const last = items.at(-1)
    yield* Effect.tryPromise({ try: parent.check, catch: unavailable })
    if (
      (last || cursor.after) &&
      !(yield* repo.advanceAttachmentCleanupCursor(
        workspaceID,
        cursor,
        items.length === 32 && last ? { id: last.id, createdAt: last.createdAt } : undefined,
      ))
    )
      return yield* new IMValidationFailedError({
        name: "VALIDATION_FAILED",
        data: { message: "Media cleanup changed; retry the current operation explicitly." },
      })
    if (failed.length)
      log.warn("Private media cleanup incomplete", { failedCount: failed.length, scanned: items.length })
    return {
      // A continuation can have skipped failed reservations on earlier pages.
      // Only a fresh, short scan with no failures proves cleanup is complete.
      state: failed.length || items.length === 32 || cursor.after ? ("incomplete" as const) : ("complete" as const),
      scanned: items.length,
      removed: items.length - failed.length,
      failedCount: failed.length,
    }
  })

export const localStream = (
  repo: IMRepositoryInterface,
  input: { id: string; workspaceID: string; userID: string },
  descriptor: IMAttachment,
) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const opened = yield* Effect.acquireRelease(
        Effect.tryPromise({ try: () => MediaFiles.open(descriptor), catch: unavailable }),
        (value) => Effect.promise(() => value.file.close()),
      )
      const digest = createHash("sha256")
      const count = Math.max(1, Math.ceil(descriptor.sizeBytes / 262144))
      const check = attachment(repo, input).pipe(
        Effect.flatMap((current) =>
          JSON.stringify(current) === JSON.stringify(descriptor)
            ? Effect.tryPromise({ try: opened.check, catch: unavailable })
            : Effect.fail(unavailable()),
        ),
      )
      return Stream.fromIterable(Array.from({ length: count }, (_, index) => index)).pipe(
        Stream.mapEffect((index) =>
          Effect.gen(function* () {
            yield* check
            const offset = index * 262144
            const bytes = Buffer.alloc(Math.max(0, Math.min(262144, descriptor.sizeBytes - offset)))
            for (let filled = 0; filled < bytes.length; ) {
              const chunk = yield* Effect.tryPromise({
                try: () => opened.file.read(bytes, filled, bytes.length - filled, offset + filled),
                catch: unavailable,
              })
              if (!chunk.bytesRead) return yield* unavailable()
              filled += chunk.bytesRead
            }
            yield* check
            if (
              index === 0 &&
              AttachmentStorage.isPreviewMime(descriptor.mime) &&
              AttachmentStorage.previewMime(bytes) !== descriptor.mime
            )
              return yield* unavailable()
            digest.update(bytes)
            if (index === count - 1 && digest.digest("hex") !== descriptor.checksum) return yield* unavailable()
            return bytes
          }),
        ),
        Stream.interruptWhen(Effect.sleep("120 seconds").pipe(Effect.andThen(Effect.fail(unavailable())))),
      )
    }),
  )

export const attachment = (
  repo: IMRepositoryInterface,
  input: {
    id: string
    workspaceID: string
    userID: string
    bound?: boolean
  },
  lease?: IMFacade.ReaderLease,
) =>
  Effect.gen(function* () {
    const value = yield* repo.getAttachment(input.id)
    if (
      !value ||
      value.workspaceID !== input.workspaceID ||
      !value.groupID ||
      AttachmentStorage.expiresAt(value.createdAt) <= Date.now()
    )
      return yield* unavailable()
    yield* group(repo, { ...input, groupID: value.groupID }, lease)
    if (input.bound === false) {
      if (value.uploadedBy !== input.userID) return yield* unavailable()
      return value
    }
    const message = value.messageID ? yield* repo.getMessage(value.messageID) : undefined
    if (
      !message ||
      message.groupID !== value.groupID ||
      message.type !== "file" ||
      !(Array.isArray(message.metadata)
        ? message.metadata.length >= 1 && message.metadata.length <= 4 && new Set(message.metadata.map((item) => item?.attachmentID)).size === message.metadata.length && message.metadata.every((item) => item !== null && typeof item === "object" && item.type === "attachment_ref" && item.batch === true && typeof item.attachmentID === "string") && message.metadata.some((item) => item.attachmentID === value.id)
        : message.metadata !== null && typeof message.metadata === "object" && "type" in message.metadata && message.metadata.type === "attachment_ref" && "attachmentID" in message.metadata && message.metadata.attachmentID === value.id && !("batch" in message.metadata))
    )
      return yield* unavailable()
    return value
  })

export const remoteAttachment = (
  repo: IMRepositoryInterface,
  lease: IMFacade.ReaderLease,
  input: { workspaceID: string; userID: string; groupID: string; messageID: string; attachmentID: string },
) =>
  lease.reader.withOutput(
    { workspaceID: input.workspaceID, userID: input.userID, groupIDs: [input.groupID] },
    Effect.gen(function* () {
      yield* lease.assertCurrent
      const current = yield* repo.getGroup({
        groupID: input.groupID,
        workspaceID: input.workspaceID,
        userID: input.userID,
      })
      const message = current?.kernelConvID ? yield* repo.getMessage(input.messageID) : undefined
      const descriptor =
        message?.groupID === input.groupID
          ? message.remoteAttachments?.find((item) => item.attachmentID === input.attachmentID)
          : undefined
      if (
        !descriptor ||
        descriptor.expiresAt <= Date.now() ||
        !lease.engine.media ||
        KernelReader.readerVersion(lease.reader.runtime) !== 2
      )
        return yield* unavailable()
      return descriptor
    }),
  )

// Retain a fixed lease for the body stream. Each native range is admitted with
// fresh current message permission, then checked again before yielding bytes.
export const remoteStream = (
  repo: IMRepositoryInterface,
  lease: IMFacade.ReaderLease,
  input: Parameters<typeof remoteAttachment>[2],
  descriptor: KernelReaderSchema.RemoteAttachment,
  signal: AbortSignal,
) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const digest = createHash("sha256")
      const count = Math.max(1, Math.ceil(descriptor.sizeBytes / 262144))
      const check = remoteAttachment(repo, lease, input).pipe(
        Effect.flatMap((current) =>
          JSON.stringify(current) === JSON.stringify(descriptor) ? Effect.void : Effect.fail(unavailable()),
        ),
      )
      return Stream.fromIterable(Array.from({ length: count }, (_, index) => index)).pipe(
        Stream.mapEffect((index) =>
          Effect.gen(function* () {
            yield* check
            const { profile: _profile, ...attachment } = descriptor
            const bytes = yield* lease.engine
              .media!.readRange({
                attachment,
                start: index * 262144,
                end: descriptor.sizeBytes === 0 ? 0 : Math.min(descriptor.sizeBytes - 1, (index + 1) * 262144 - 1),
                signal,
              })
              .pipe(Effect.mapError(unavailable))
            yield* check
            if (
              index === 0 &&
              AttachmentStorage.isPreviewMime(descriptor.mime) &&
              AttachmentStorage.previewMime(bytes) !== descriptor.mime
            )
              return yield* unavailable()
            digest.update(bytes)
            // Verify before yielding the final chunk, so a failed hash has no valid EOF.
            if (index === count - 1 && digest.digest("hex") !== descriptor.sha256) return yield* unavailable()
            return bytes
          }),
        ),
      )
    }),
  )

export const read = (value: IMAttachment) =>
  Effect.acquireUseRelease(
    Effect.tryPromise({ try: () => MediaFiles.open(value), catch: unavailable }),
    (opened) =>
      Effect.gen(function* () {
        const bytes = Buffer.alloc(value.sizeBytes)
        for (let offset = 0; offset < bytes.length; ) {
          const part = yield* Effect.tryPromise({
            try: () => opened.file.read(bytes, offset, Math.min(262144, bytes.length - offset), offset),
            catch: unavailable,
          })
          if (!part.bytesRead) return yield* unavailable()
          offset += part.bytesRead
        }
        yield* Effect.tryPromise({ try: opened.check, catch: unavailable })
        if (
          AttachmentStorage.sha256Hex(bytes) !== value.checksum ||
          (AttachmentStorage.isPreviewMime(value.mime) && AttachmentStorage.previewMime(bytes) !== value.mime) ||
          AttachmentStorage.expiresAt(value.createdAt) <= Date.now()
        )
          return yield* unavailable()
        return bytes
      }),
    (opened) => Effect.promise(() => opened.file.close()),
  )

/** Multipart has already persisted a bounded temporary file. Hash and copy it
 * through one chunk buffer rather than retaining the whole attachment. */
export const stagedFile = (input: { path: string; mime: string }) =>
  Effect.gen(function* () {
    const mime = AttachmentStorage.normalizeMime(input.mime)
    if (!AttachmentStorage.isAllowedMime(mime, AttachmentStorage.allowedMimeSet()))
      return yield* new IMUnsupportedMediaTypeError({
        name: "UNSUPPORTED_MEDIA_TYPE",
        data: { message: `Unsupported media type: ${mime}` },
      })
    const expected = yield* Effect.tryPromise({ try: () => fs.lstat(input.path), catch: unavailable })
    if (!expected.isFile()) return yield* unavailable()
    if (expected.size > AttachmentStorage.maxAttachmentBytes())
      return yield* new IMFileTooLargeError({
        name: "FILE_TOO_LARGE",
        data: { message: "Attachment exceeds the upload limit", maxBytes: AttachmentStorage.maxAttachmentBytes() },
      })
    const inspect = async (output?: Awaited<ReturnType<typeof fs.open>>, signal?: AbortSignal) => {
      const source = await fs.open(input.path, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const opened = await source.stat()
        if (
          !opened.isFile() ||
          opened.dev !== expected.dev ||
          opened.ino !== expected.ino ||
          opened.size !== expected.size ||
          opened.mtimeMs !== expected.mtimeMs ||
          opened.ctimeMs !== expected.ctimeMs
        )
          throw unavailable()
        const digest = createHash("sha256")
        const detected = { mime }
        const buffer = Buffer.alloc(Math.min(262144, Math.max(24, expected.size)))
        for (let offset = 0; offset < expected.size; ) {
          if (signal?.aborted) throw unavailable()
          const bytes = Math.min(buffer.length, expected.size - offset)
          for (let filled = 0; filled < bytes; ) {
            const chunk = await source.read(buffer, filled, bytes - filled, offset + filled)
            if (!chunk.bytesRead) throw unavailable()
            filled += chunk.bytesRead
          }
          if (offset === 0) {
            const validated = AttachmentStorage.validateUpload({ contentType: mime, bytes: buffer.subarray(0, bytes) })
            if (!validated.ok)
              throw new IMUnsupportedMediaTypeError({
                name: "UNSUPPORTED_MEDIA_TYPE",
                data: { message: `Unsupported media type: ${mime}` },
              })
            detected.mime = validated.mime
          }
          digest.update(buffer.subarray(0, bytes))
          if (signal?.aborted) throw unavailable()
          if (output)
            for (let written = 0; written < bytes; ) {
              const part = await output.write(buffer, written, bytes - written, offset + written)
              if (!part.bytesWritten) throw unavailable()
              written += part.bytesWritten
            }
          offset += bytes
        }
        const after = await source.stat()
        const current = await fs.lstat(input.path)
        if (
          !current.isFile() ||
          current.dev !== opened.dev ||
          current.ino !== opened.ino ||
          current.size !== opened.size ||
          current.mtimeMs !== opened.mtimeMs ||
          current.ctimeMs !== opened.ctimeMs ||
          after.size !== opened.size ||
          after.mtimeMs !== opened.mtimeMs ||
          after.ctimeMs !== opened.ctimeMs
        )
          throw unavailable()
        if (expected.size === 0 && AttachmentStorage.isPreviewMime(mime))
          throw new IMUnsupportedMediaTypeError({
            name: "UNSUPPORTED_MEDIA_TYPE",
            data: { message: `Unsupported media type: ${mime}` },
          })
        return { checksum: digest.digest("hex"), mime: detected.mime }
      } finally {
        await source.close()
      }
    }
    const pending = { finished: Promise.resolve() }
    const settled = <A>(run: (signal: AbortSignal) => Promise<A>) =>
      Effect.tryPromise({
        try: (signal) => {
          const result = run(signal)
          pending.finished = result.then(
            () => undefined,
            () => undefined,
          )
          return result
        },
        catch: (error) =>
          error instanceof IMUnsupportedMediaTypeError
            ? error
            : error instanceof MediaFiles.Error && error.code === "cleanup"
              ? new IMValidationFailedError({
                  name: "VALIDATION_FAILED",
                  data: { message: "Private media copy cleanup is unconfirmed; its capacity remains reserved." },
                })
              : unavailable(),
      }).pipe(Effect.ensuring(Effect.promise(() => pending.finished)))
    const inspected = yield* settled((signal) => inspect(undefined, signal))
    return {
      mime: inspected.mime,
      sizeBytes: expected.size,
      checksum: inspected.checksum,
      copy: (value: IMAttachment) =>
        settled((signal) =>
          MediaFiles.write(
            value,
            async (output) => {
              const copied = await inspect(output, signal)
              if (copied.checksum !== inspected.checksum || copied.mime !== inspected.mime || signal.aborted)
                throw unavailable()
            },
            signal,
          ),
        ),
    }
  })
