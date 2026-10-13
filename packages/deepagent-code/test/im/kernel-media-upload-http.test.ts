import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import { createHash, randomUUID } from "node:crypto"
import { Effect } from "effect"
import type JuggleIM from "@deepagent-code/im-kernel-sdk"
import { AttachmentStorage } from "@deepagent-code/core/im/attachment-storage"
import { Global } from "@deepagent-code/core/global"
import type { IMAttachment } from "@deepagent-code/core/im/repository"
import { MediaFiles } from "@/im/media-files"
import { IMKernelMediaUpload } from "@/im/kernel/media-upload"
import { KernelSdk } from "@/im/kernel/sdk"
import MediaClient from "../../../im-kernel-sdk/upstream/src/delivery/media-client"

test("private uploader reaches every official MediaClient HTTP chunk after an empty-MIME Begin response", async () => {
  const workspaceID = `upload-http-${randomUUID()}`
  const parent = await MediaFiles.directory(workspaceID, true)
  const derived = AttachmentStorage.deriveStoragePath({ dataDir: Global.Path.data, workspaceID, attachmentID: "ima_http" })
  if (!derived.ok) throw new Error("Private HTTP fixture path unavailable")
  const bytes = Buffer.alloc(262144 * 2 + 17, 77)
  const local: IMAttachment = {
    id: "ima_http", workspaceID, projectID: null, groupID: "private-group", messageID: null,
    uploadedBy: "private-sender", storagePath: derived.storagePath, filename: "private.bin",
    mime: "application/octet-stream", sizeBytes: bytes.length, checksum: createHash("sha256").update(bytes).digest("hex"), createdAt: Date.now(), deletedAt: null,
  }
  const metadata = {
    objectID: "a".repeat(64), uploadID: "", filename: local.filename, mime: "", sizeBytes: bytes.length,
    sha256: local.checksum, state: "uploading", receivedBytes: 0, receivedChunks: 0,
    createdAt: Date.now(), expiresAt: Date.now() + 86400000,
  }
  const wire: string[] = []
  const received = createHash("sha256")
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    expect(request.headers.get("authorization")).toBe("Bearer private-http-token")
    const pathname = new URL(request.url).pathname
    wire.push(`${request.method} ${pathname}`)
    const value = pathname.endsWith("/capabilities") ? {
      version: 1, profile: "mysql-protected-media-v1", capability: "dac:media.v1", readerVersion: 2,
      maxFileBytes: 52428800, maxAttachments: 4, chunkBytes: 262144, ttlMillis: 86400000, authenticatedContent: true,
    } : metadata
    if (request.method === "POST" && pathname.endsWith("/objects")) {
      const input = await request.json()
      metadata.uploadID = input.upload.uploadID
      expect(input.upload).toMatchObject({ filename: local.filename, sizeBytes: local.sizeBytes, sha256: local.checksum })
    }
    if (request.method === "PUT") {
      const chunk = new Uint8Array(await request.arrayBuffer())
      expect(Number(pathname.split("/").at(-1))).toBe(metadata.receivedChunks)
      expect(chunk.byteLength).toBe(Math.min(262144, local.sizeBytes - metadata.receivedBytes))
      received.update(chunk)
      metadata.receivedBytes += chunk.byteLength
      metadata.receivedChunks++
    }
    if (pathname.endsWith("/finalize")) {
      expect(metadata.receivedBytes).toBe(local.sizeBytes)
      metadata.state = "uploaded_unbound"
      metadata.mime = local.mime
    }
    return new Response(JSON.stringify(value), { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" } })
  } })
  try {
    await fs.writeFile(local.storagePath, bytes, { flag: "wx", mode: 0o600 })
    const invalidators = new Set<() => void>()
    const native = MediaClient({ isConnected: () => true, deliveryMediaContext: () => ({
      generation: 1, user: "private-http-sender", token: "private-http-token", navigator: server.url.origin,
    }), onDeliveryInvalidation: (callback: () => void) => { invalidators.add(callback); return () => invalidators.delete(callback) } }, true) as unknown as Pick<ReturnType<typeof JuggleIM.init>,
      "getProtectedMediaCapabilities" | "beginProtectedMedia" | "putProtectedMediaChunk" | "finalizeProtectedMedia" | "getProtectedMedia" | "cancelProtectedMedia" | "readProtectedMediaRange">
    const media: KernelSdk.Media = {
      capabilities: () => KernelSdk.request("media_capabilities", () => native.getProtectedMediaCapabilities()),
      begin: (input) => KernelSdk.request("media_begin", () => native.beginProtectedMedia(input)),
      putChunk: (input) => KernelSdk.request("media_chunk", () => native.putProtectedMediaChunk(input)),
      finalize: (input) => KernelSdk.request("media_finalize", () => native.finalizeProtectedMedia(input)),
      status: (input) => KernelSdk.request("media_status", () => native.getProtectedMedia(input)),
      cancel: (input) => KernelSdk.request("media_cancel", () => native.cancelProtectedMedia(input)),
      readRange: (input) => KernelSdk.request("media_range", () => native.readProtectedMediaRange(input)),
    }
    const result = await Effect.runPromise(IMKernelMediaUpload.upload(media, local, {
      source: { server: "private-http" }, messageID: "private-message", conversationType: 1, conversationID: "private-peer",
    }).pipe(Effect.timeout("2 seconds")))
    expect(result).toMatchObject({ sizeBytes: local.sizeBytes, sha256: local.checksum, mime: local.mime })
    expect(received.digest("hex")).toBe(local.checksum)
    expect(wire.map((value) => value.split(" ")[0])).toEqual(["GET", "POST", "PUT", "PUT", "PUT", "POST"])
    expect(metadata.receivedChunks).toBe(3)
    expect(invalidators.size).toBe(0)
  } finally {
    server.stop(true)
    await fs.rm(parent.path, { recursive: true, force: true })
  }
}, 5000)
