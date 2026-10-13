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

async function fixture(mode: "partial" | "fresh" | "lost-chunk" | "legacy" | "complete" | "bound" | "denied" | "bad-progress" | "changed-manifest" | "retired" | "expired" | "cancelled") {
  const workspaceID = `resume-http-${randomUUID()}`
  const parent = await MediaFiles.directory(workspaceID, true)
  const derived = AttachmentStorage.deriveStoragePath({ dataDir: Global.Path.data, workspaceID, attachmentID: "ima_resume" })
  if (!derived.ok) throw new Error("Private resume fixture path unavailable")
  const bytes = Buffer.alloc(262144 * 3 + 17)
  bytes.forEach((_, index) => { bytes[index] = index % 251 })
  const local: IMAttachment = { id: "ima_resume", workspaceID, projectID: null, groupID: "private-group", messageID: null,
    uploadedBy: "private-sender", storagePath: derived.storagePath, filename: "private.bin", mime: "application/octet-stream",
    sizeBytes: bytes.length, checksum: createHash("sha256").update(bytes).digest("hex"), createdAt: Date.now(), deletedAt: null }
  await fs.writeFile(local.storagePath, bytes, { flag: "wx", mode: 0o600 })
  const createdAt = Date.now()
  const stored = new Map<number, Buffer>()
  const closed = mode === "complete" || mode === "bound"
  if (mode !== "fresh" && mode !== "lost-chunk") (closed ? [0, 1, 2, 3] : [0, 2]).forEach(index => stored.set(index, bytes.subarray(index * 262144, Math.min(bytes.length, (index + 1) * 262144))))
  const metadata = { objectID: "a".repeat(64), uploadID: "", filename: local.filename, mime: closed ? local.mime : "",
    sizeBytes: bytes.length, sha256: local.checksum, state: closed ? mode === "bound" ? "bound" : "uploaded_unbound" : mode === "cancelled" ? "cancelled" : "uploading",
    receivedBytes: [...stored.values()].reduce((sum, part) => sum + part.length, 0), receivedChunks: stored.size,
    createdAt: mode === "expired" ? createdAt - 86400001 : createdAt, expiresAt: mode === "expired" ? createdAt - 1 : createdAt + 86400000 }
  const wire: string[] = []
  const puts: number[] = []
  const uploadIDs: string[] = []
  const state = { generation: 1, user: "private-http-sender", token: "private-http-token", navigator: "" }
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    expect(request.headers.get("authorization")).toBe("Bearer private-http-token")
    const pathname = new URL(request.url).pathname
    wire.push(`${request.method} ${pathname}`)
    const headers = { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" }
    const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers })
    if (pathname.endsWith("/transfer/capabilities")) {
      if (mode === "legacy" || mode === "denied") return response({}, mode === "legacy" ? 404 : 403)
      return response({ version: 1, protocol: "dac-media-resumable-v1", chunkBytes: 262144, maxChunks: 200, maxFileBytes: 52428800 })
    }
    if (pathname.endsWith("/capabilities")) return response({ version: 1, profile: "mysql-protected-media-v1", capability: "dac:media.v1", readerVersion: 2,
      maxFileBytes: 52428800, maxAttachments: 4, chunkBytes: 262144, ttlMillis: 86400000, authenticatedContent: true })
    if (pathname.endsWith("/objects")) {
      const input = await request.json()
      metadata.uploadID = input.upload.uploadID
      uploadIDs.push(metadata.uploadID)
      return response(metadata)
    }
    if (pathname.endsWith("/upload-progress")) {
      if (mode === "retired") state.generation++
      return response({ version: 1, protocol: "dac-media-resumable-v1", object: mode === "changed-manifest" ? { ...metadata, sha256: "b".repeat(64) } : metadata,
        chunkBytes: 262144, checkpointRevision: 3, committedIndices: mode === "bad-progress" ? [0, 0] : [...stored.keys()].sort((a, b) => a - b) })
    }
    if (request.method === "PUT") {
      expect(closed).toBe(false)
      const index = Number(pathname.split("/").at(-1))
      const part = Buffer.from(await request.arrayBuffer())
      expect(part.equals(bytes.subarray(index * 262144, Math.min(bytes.length, (index + 1) * 262144)))).toBe(true)
      if (stored.has(index)) expect(stored.get(index)?.equals(part)).toBe(true)
      puts.push(index)
      stored.set(index, part)
      metadata.receivedChunks = stored.size
      metadata.receivedBytes = [...stored.values()].reduce((sum, value) => sum + value.length, 0)
      if (mode === "lost-chunk" && puts.length === 1) return new Response("{", { headers })
    }
    if (pathname.endsWith("/finalize")) {
      expect(closed).toBe(false)
      expect(metadata.receivedBytes).toBe(bytes.length)
      expect(createHash("sha256").update(Buffer.concat([0, 1, 2, 3].map(index => stored.get(index)!))).digest("hex")).toBe(local.checksum)
      metadata.state = "uploaded_unbound"
      metadata.mime = local.mime
    }
    return response(metadata)
  } })
  state.navigator = server.url.origin
  const native = MediaClient({ isConnected: () => true, deliveryMediaContext: () => state }, true) as Pick<ReturnType<typeof JuggleIM.init>,
    "getProtectedMediaCapabilities" | "getProtectedMediaTransferCapabilities" | "getProtectedMediaUploadProgress" | "beginProtectedMedia" |
    "putProtectedMediaChunk" | "finalizeProtectedMedia" | "getProtectedMedia" | "cancelProtectedMedia" | "readProtectedMediaRange">
  const media: KernelSdk.Media = {
    capabilities: () => KernelSdk.request("media_capabilities", () => native.getProtectedMediaCapabilities()),
    transferCapabilities: () => KernelSdk.request("media_transfer_capabilities", () => native.getProtectedMediaTransferCapabilities()),
    uploadProgress: input => KernelSdk.request("media_upload_progress", () => native.getProtectedMediaUploadProgress(input)),
    begin: input => KernelSdk.request("media_begin", () => native.beginProtectedMedia(input)),
    putChunk: input => KernelSdk.request("media_chunk", () => native.putProtectedMediaChunk(input)),
    finalize: input => KernelSdk.request("media_finalize", () => native.finalizeProtectedMedia(input)),
    status: input => KernelSdk.request("media_status", () => native.getProtectedMedia(input)),
    cancel: input => KernelSdk.request("media_cancel", () => native.cancelProtectedMedia(input)),
    readRange: input => KernelSdk.request("media_range", () => native.readProtectedMediaRange(input)),
  }
  return { local, metadata, wire, puts, uploadIDs, run: () => Effect.runPromiseExit(IMKernelMediaUpload.upload(media, local, {
    source: { server: "private-http" }, messageID: "original-private-message", conversationType: 1, conversationID: "private-peer",
  }).pipe(Effect.timeout("2 seconds"))), [Symbol.asyncDispose]: async () => { server.stop(true); await fs.rm(parent.path, { recursive: true, force: true }) } }
}

test("original uploader resumes an authenticated sparse checkpoint using only missing bytes and one progress GET", async () => {
  await using value = await fixture("partial")
  const expiry = value.metadata.expiresAt
  const result = await value.run()
  expect(result._tag).toBe("Success")
  if (result._tag !== "Success") throw new Error("Original resume failed")
  expect(result.value).toMatchObject({ attachmentID: value.metadata.objectID, sha256: value.local.checksum, expiresAt: expiry })
  expect(value.puts).toEqual([1, 3])
  expect(value.wire.map(item => item.split(" ")[0])).toEqual(["GET", "POST", "GET", "GET", "PUT", "PUT", "POST"])
  expect(value.metadata.uploadID.startsWith("dac_")).toBe(true)
  expect(value.metadata.expiresAt).toBe(expiry)
})

test("fresh uploads add no negotiation GET and completed original objects never repeat PUT or Finalize", async () => {
  await using fresh = await fixture("fresh")
  expect((await fresh.run())._tag).toBe("Success")
  expect(fresh.puts).toEqual([0, 1, 2, 3])
  expect(fresh.wire.map(item => item.split(" ")[0])).toEqual(["GET", "POST", "PUT", "PUT", "PUT", "PUT", "POST"])
  for (const mode of ["complete", "bound"] as const) {
    await using value = await fixture(mode)
    expect((await value.run())._tag).toBe("Success")
    expect(value.puts).toEqual([])
    expect(value.wire.map(item => item.split(" ")[0])).toEqual(["GET", "POST"])
  }
})

test("a chunk whose ACK body is lost remains unknown until an explicit same-ID retry resumes without rewriting it", async () => {
  await using value = await fixture("lost-chunk")
  const expiry = value.metadata.expiresAt
  expect((await value.run())._tag).toBe("Failure")
  expect(value.puts).toEqual([0])
  expect(value.wire.some(item => item.endsWith("/upload-progress") || item.endsWith("/finalize"))).toBe(false)
  expect((await value.run())._tag).toBe("Success")
  expect(value.puts).toEqual([0, 1, 2, 3])
  expect(value.uploadIDs).toHaveLength(2)
  expect(new Set(value.uploadIDs).size).toBe(1)
  expect(value.metadata.expiresAt).toBe(expiry)
  expect(value.wire.filter(item => item.endsWith("/upload-progress"))).toHaveLength(1)
  expect(value.wire.filter(item => item.endsWith("/finalize"))).toHaveLength(1)
})

test("only a missing transfer capability permits the original exact chunk retry path", async () => {
  await using legacy = await fixture("legacy")
  expect((await legacy.run())._tag).toBe("Success")
  expect(legacy.puts).toEqual([0, 1, 2, 3])
  expect(legacy.wire.some(item => item.endsWith("/upload-progress"))).toBe(false)
  await using denied = await fixture("denied")
  expect((await denied.run())._tag).toBe("Failure")
  expect(denied.puts).toEqual([])
  expect(denied.wire.some(item => item.endsWith("/finalize"))).toBe(false)
})

test("malformed or conflicting checkpoints, old-generation replies and terminal objects never dispatch chunks", async () => {
  for (const mode of ["bad-progress", "changed-manifest", "retired", "expired", "cancelled"] as const) {
    await using value = await fixture(mode)
    expect((await value.run())._tag).toBe("Failure")
    expect(value.puts).toEqual([])
    expect(value.wire.some(item => item.endsWith("/finalize"))).toBe(false)
  }
})
