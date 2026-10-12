import { expect, test } from "bun:test"
import { createHash, randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import type { ProtectedMediaMetadata } from "@deepagent-code/im-kernel-sdk"
import { AttachmentStorage } from "@deepagent-code/core/im/attachment-storage"
import { Global } from "@deepagent-code/core/global"
import type { IMAttachment } from "@deepagent-code/core/im/repository"
import { MediaFiles } from "@/im/media-files"
import { IMKernelMediaUpload } from "@/im/kernel/media-upload"
import type { KernelSdk } from "@/im/kernel/sdk"

async function fixture(size = 786451) {
  const workspaceID = `upload-private-${randomUUID()}`
  const parent = await MediaFiles.directory(workspaceID, true)
  const derived = AttachmentStorage.deriveStoragePath({ dataDir: Global.Path.data, workspaceID, attachmentID: "ima_private" })
  if (!derived.ok) throw new Error("Private upload fixture path unavailable")
  const file = await fs.open(derived.storagePath, "wx", 0o600)
  const hash = createHash("sha256")
  const block = Buffer.alloc(Math.min(262144, Math.max(1, size)), 77)
  try {
    for (let written = 0; written < size;) {
      const bytes = block.subarray(0, Math.min(block.length, size - written))
      const result = await file.write(bytes)
      hash.update(bytes.subarray(0, result.bytesWritten))
      written += result.bytesWritten
    }
  } finally {
    await file.close()
  }
  const local: IMAttachment = {
    id: "ima_private", workspaceID, projectID: null, groupID: "private-group", messageID: null,
    uploadedBy: "private-sender", storagePath: derived.storagePath, filename: "private.bin",
    mime: "application/octet-stream", sizeBytes: size, checksum: hash.digest("hex"), createdAt: Date.now(), deletedAt: null,
  }
  const calls: string[] = []
  const chunks: number[] = []
  const received = createHash("sha256")
  const metadata: ProtectedMediaMetadata = {
    objectID: "private-object", uploadID: "private-upload", filename: local.filename, mime: local.mime,
    sizeBytes: size, sha256: local.checksum, state: "uploading", receivedBytes: 0, receivedChunks: 0,
    createdAt: Date.now(), expiresAt: Date.now() + AttachmentStorage.ttlMs(),
  }
  const callbacks = { before: async (_method: string) => {} }
  const operation = (method: string) => Effect.promise(async () => { calls.push(method); await callbacks.before(method) })
  const media: KernelSdk.Media = {
    capabilities: () => operation("capabilities").pipe(Effect.as({ version: 1, profile: "mysql-protected-media-v1", capability: "dac:media.v1", readerVersion: 2, maxFileBytes: 10485760, maxAttachments: 4, chunkBytes: 262144, ttlMillis: 86400000, authenticatedContent: true })),
    begin: () => operation("begin").pipe(Effect.as(metadata)),
    putChunk: (input) => operation("chunk").pipe(Effect.andThen(Effect.sync(() => {
      expect(input.index).toBe(chunks.length)
      chunks.push(input.body.length)
      received.update(input.body)
      return metadata
    }))),
    finalize: () => operation("finalize").pipe(Effect.as({ ...metadata, state: "uploaded_unbound" })),
    status: () => operation("status").pipe(Effect.as(metadata)),
    cancel: () => operation("cancel").pipe(Effect.as(metadata)),
    readRange: () => operation("range").pipe(Effect.as(new Uint8Array())),
  }
  return {
    local, parent, media, calls, chunks, received, callbacks,
    run: (input = local) => Effect.runPromiseExit(IMKernelMediaUpload.upload(media, input, { source: { server: "private" }, messageID: "private-message", conversationType: 1, conversationID: "private-peer" })),
    [Symbol.asyncDispose]: () => fs.rm(parent.path, { recursive: true, force: true }),
  }
}

test.skipIf(process.platform === "win32")("kernel uploader refuses a wide-permission source before any transport operation", async () => {
  await using value = await fixture()
  await fs.chmod(value.local.storagePath, 0o644)
  const result = await value.run()
  expect(result._tag).toBe("Failure")
  expect(value.calls).toEqual([])
})

test.skipIf(process.platform === "win32")("kernel uploader refuses an unsafe parent and a hard-linked file before any transport operation", async () => {
  await using parent = await fixture()
  await fs.chmod(parent.parent.path, 0o755)
  expect((await parent.run())._tag).toBe("Failure")
  expect(parent.calls).toEqual([])
  await using linked = await fixture()
  await fs.link(linked.local.storagePath, path.join(linked.parent.path, "private-hardlink"))
  expect((await linked.run())._tag).toBe("Failure")
  expect(linked.calls).toEqual([])
})

test("kernel uploader retains exact 10MiB bytes in 40 bounded chunks and closes its original FD", async () => {
  await using value = await fixture(AttachmentStorage.hardMaxBytes)
  const identity = await fs.stat(value.local.storagePath, { bigint: true })
  const result = await value.run()
  expect(result._tag).toBe("Success")
  if (result._tag !== "Success") throw new Error("Private 10MiB upload failed")
  expect(result.value).toMatchObject({ sizeBytes: AttachmentStorage.hardMaxBytes, sha256: value.local.checksum })
  expect(value.chunks).toHaveLength(40)
  expect(value.chunks.every((bytes) => bytes === 262144)).toBe(true)
  expect(value.received.digest("hex")).toBe(value.local.checksum)
  expect(value.calls.filter((method) => method === "begin")).toHaveLength(1)
  expect(value.calls.filter((method) => method === "finalize")).toHaveLength(1)
  if (process.platform === "win32") return
  const retained = await Promise.all((await fs.readdir("/dev/fd")).map((descriptor) => fs.stat(`/dev/fd/${descriptor}`, { bigint: true }).then((stat) => stat.dev === identity.dev && stat.ino === identity.ino, () => false)))
  expect(retained.some(Boolean)).toBe(false)
}, 15000)

test("kernel uploader accepts an exact empty file and refuses a physical over-limit file before transport", async () => {
  await using empty = await fixture(0)
  expect((await empty.run())._tag).toBe("Success")
  expect(empty.chunks).toEqual([])
  expect(empty.calls).toEqual(["capabilities", "begin", "finalize"])
  await using oversized = await fixture(1)
  await fs.truncate(oversized.local.storagePath, AttachmentStorage.hardMaxBytes + 1)
  expect((await oversized.run({ ...oversized.local, sizeBytes: AttachmentStorage.hardMaxBytes + 1 }))._tag).toBe("Failure")
  expect(oversized.calls).toEqual([])
})

test.skipIf(process.platform === "win32")("kernel uploader rechecks private storage after an asynchronous capabilities reply before begin", async () => {
  await using value = await fixture()
  value.callbacks.before = async (method) => {
    if (method === "capabilities") await fs.chmod(value.local.storagePath, 0o644)
  }
  expect((await value.run())._tag).toBe("Failure")
  expect(value.calls).toEqual(["capabilities"])
})

test.skipIf(process.platform === "win32")("kernel uploader rejects a changed source after the first chunk without dispatching the remainder or finalize", async () => {
  await using value = await fixture()
  value.callbacks.before = async (method) => {
    if (method === "chunk") await fs.chmod(value.local.storagePath, 0o644)
  }
  expect((await value.run())._tag).toBe("Failure")
  expect(value.chunks).toEqual([262144])
  expect(value.calls).toEqual(["capabilities", "begin", "chunk"])
})
