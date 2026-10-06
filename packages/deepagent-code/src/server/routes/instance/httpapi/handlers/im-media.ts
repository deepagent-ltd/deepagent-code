export * as IMMedia from "./im-media"

import { Effect } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { Global } from "@deepagent-code/core/global"
import { AttachmentStorage } from "@deepagent-code/core/im/attachment-storage"
import type { IMRepositoryInterface, IMAttachment } from "@deepagent-code/core/im/repository"
import { IMAttachmentNotFoundError, IMFileUploadDisabledError, IMValidationFailedError } from "../groups/im"

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

export const group = (repo: IMRepositoryInterface, input: { groupID: string; workspaceID: string; userID: string }) =>
  Effect.gen(function* () {
    const value = yield* repo.getGroup({ groupID: input.groupID, userID: input.userID })
    if (!value || value.workspaceID !== input.workspaceID) return yield* unavailable()
    if (value.kernelConvID)
      return yield* new IMValidationFailedError({
        name: "VALIDATION_FAILED",
        data: { message: "Media sharing is available only in local conversations." },
      })
    return value
  })

export const cleanup = (repo: IMRepositoryInterface, workspaceID: string) =>
  Effect.gen(function* () {
    for (const item of yield* repo.listExpiredAttachments(workspaceID)) {
      const derived = AttachmentStorage.deriveStoragePath({
        dataDir: Global.Path.data,
        workspaceID,
        attachmentID: item.id,
      })
      // Legacy records used a second generated filename; permit only a direct ima_ child of this workspace.
      if (
        !derived.ok ||
        path.dirname(item.storagePath) !== derived.baseDir ||
        !/^ima_[A-Za-z0-9_-]+$/.test(path.basename(item.storagePath))
      )
        continue
      const removed = yield* Effect.tryPromise(() => fs.rm(item.storagePath, { force: true })).pipe(
        Effect.as(true),
        Effect.catch(() => Effect.succeed(false)),
      )
      if (removed) yield* repo.expireAttachment(item.id)
    }
  })

export const attachment = (
  repo: IMRepositoryInterface,
  input: {
    id: string
    workspaceID: string
    userID: string
    bound?: boolean
  },
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
    yield* group(repo, { ...input, groupID: value.groupID })
    if (input.bound === false) {
      if (value.uploadedBy !== input.userID) return yield* unavailable()
      return value
    }
    const message = value.messageID ? yield* repo.getMessage(value.messageID) : undefined
    if (
      !message ||
      message.groupID !== value.groupID ||
      message.type !== "file" ||
      typeof message.metadata !== "object" ||
      message.metadata === null ||
      !("type" in message.metadata) ||
      message.metadata.type !== "attachment_ref" ||
      !("attachmentID" in message.metadata) ||
      message.metadata.attachmentID !== value.id
    )
      return yield* unavailable()
    return value
  })

export const read = (value: IMAttachment) =>
  Effect.gen(function* () {
    const derived = AttachmentStorage.deriveStoragePath({
      dataDir: Global.Path.data,
      workspaceID: value.workspaceID,
      attachmentID: value.id,
    })
    if (!derived.ok || derived.storagePath !== value.storagePath) return yield* unavailable()
    const bytes = yield* Effect.tryPromise({ try: () => fs.readFile(derived.storagePath), catch: unavailable })
    if (
      bytes.byteLength !== value.sizeBytes ||
      AttachmentStorage.sha256Hex(bytes) !== value.checksum ||
      (AttachmentStorage.isPreviewMime(value.mime) && AttachmentStorage.previewMime(bytes) !== value.mime) ||
      AttachmentStorage.expiresAt(value.createdAt) <= Date.now()
    )
      return yield* unavailable()
    return bytes
  })
