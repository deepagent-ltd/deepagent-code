import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { Effect, Exit, Fiber, Layer, SubscriptionRef } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { IMRepository, IMRepositoryLive, clientMessageID } from "@deepagent-code/core/im/repository"
import { IMBroadcasterLive } from "@deepagent-code/core/im/broadcaster"
import { AttachmentStorage } from "@deepagent-code/core/im/attachment-storage"
import { Global } from "@deepagent-code/core/global"
import { InstanceStore } from "@/project/instance-store"
import { KernelSdk } from "@/im/kernel/sdk"
import { KernelClient } from "@/im/kernel/client"
import { IMKernelSync } from "@/im/kernel/sync"
import { MediaFiles } from "@/im/media-files"
import { KernelLiveFirstSeenFixture } from "./fixture/kernel-live-first-seen"
import { pollWithTimeout } from "../lib/effect"
import { ReaderInstanceFixture } from "./reader-instance-fixture"

test("continuation admission bounds concurrent original producers, joins exact bodies and retains uncertain native uploads", async () => {
  const directory = await fs.mkdtemp("/tmp/dac-im-media-fixed-engine-")
  const bytes = Buffer.alloc(262144 * 2 + 17, 77)
  const checksum = createHash("sha256").update(bytes).digest("hex")
  const metadata = { objectID: "c".repeat(64), uploadID: "", filename: "private.bin", mime: "",
    sizeBytes: bytes.length, sha256: checksum, state: "uploading", receivedBytes: 0, receivedChunks: 0,
    createdAt: Date.now(), expiresAt: Date.now() + 86400000 }
  const calls: string[] = []
  const boundary = { blocked: false, entered: 0, release: Promise.withResolvers<void>(), uncertain: false }
  const received = createHash("sha256")
  const native = KernelLiveFirstSeenFixture.make({
    fetch(request) {
      const pathname = new URL(request.url).pathname
      if (!pathname.startsWith("/navigator/protected-media/v1/")) return undefined
      return (async () => {
      expect(request.headers.get("authorization")).toBe("Bearer private-first-seen-token")
      calls.push(`${request.method} ${pathname}`)
      const value = pathname.endsWith("/capabilities") ? { version: 1, profile: "mysql-protected-media-v1", capability: "dac:media.v1", readerVersion: 2,
        maxFileBytes: 10485760, maxAttachments: 4, chunkBytes: 262144, ttlMillis: 86400000, authenticatedContent: true } : metadata
      if (request.method === "POST" && pathname.endsWith("/objects")) {
        metadata.uploadID = (await request.json()).upload.uploadID
        if (boundary.uncertain) return new Response("truncated native response", { status: 200,
          headers: { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" } })
      }
      if (request.method === "PUT") {
        expect(Number(pathname.split("/").at(-1))).toBe(metadata.receivedChunks)
        const chunk = new Uint8Array(await request.arrayBuffer())
        received.update(chunk)
        metadata.receivedBytes += chunk.byteLength
        metadata.receivedChunks++
      }
      if (pathname.endsWith("/finalize")) { metadata.mime = "application/octet-stream"; metadata.state = "uploaded_unbound" }
      return new Response(JSON.stringify(value), { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" } })
      })()
    },
    response(topic, request, original) {
      if (!original || !topic.startsWith("qry_delivery_")) return original
      return { ...original, value: { ...original.value, version: 2,
        ...(topic === "qry_delivery_changes" ? { items: [], scanProjectionKey: "" } : {}),
      } }
    },
  })
  const config = { appkey: `private-media-fixed-${native.server.port}`, navigator: native.server.url.origin, token: "private-first-seen-token",
    userID: "receiver", identity: { uuid: "receiver", orgID: 1, name: "Receiver", orgAllGroupID: "unused" }, protectedMedia: true }
  const database = Database.layerFromPath(path.join(directory, "private.sqlite"))
  const repository = Layer.effect(IMRepository, Effect.gen(function* () {
    const original = yield* IMRepository
    return { ...original, getGroupByID: (id: string) => Effect.gen(function* () {
      if (boundary.blocked) {
        boundary.entered++
        yield* Effect.promise(() => boundary.release.promise)
      }
      return yield* original.getGroupByID(id)
    }) }
  })).pipe(Layer.provide(IMRepositoryLive.pipe(Layer.provide(database))))
  const client = KernelClient.layer.pipe(Layer.provide(KernelSdk.liveFromConfig(config)))
  const services = Layer.mergeAll(database, repository, client, IMBroadcasterLive, ReaderInstanceFixture.layer, ReaderInstanceFixture.registry)
  const engine = IMKernelSync.layer(config, { inspectConversation: (input) => Effect.succeed({
    conversation_type: input.conversationType, conversation_id: input.conversationID, org_id: 1, name: "Sender", member_uuids: ["receiver", "sender"],
  }) }).pipe(Layer.provide(services))
  try {
    await Effect.runPromise(Effect.gen(function* () {
      const store = yield* InstanceStore.Service
      const actualClient = yield* KernelClient.Service
      for (const attempt of Array.from({ length: 200 }, (_, index) => index)) {
        if ((yield* SubscriptionRef.get(actualClient.state)) === "connected") break
        if (attempt === 199) return yield* Effect.die(new Error("Private SDK connection not ready"))
        yield* Effect.sleep("10 millis")
      }
      const sync = yield* IMKernelSync.Service
      const repo = yield* IMRepository
      const instance = yield* store.load({ directory })
      const lease = yield* sync.acquireReader!({ instance, workspaceID: instance.directory, userID: "server",
        instanceCurrent: store.peek(instance.directory).pipe(Effect.map((current) => current === instance)) })
      const groupID = yield* lease.reader.pending({ conversationType: 1, conversationID: "sender", name: "Sender" })
      const parent = yield* Effect.promise(() => MediaFiles.directory(instance.directory, true))
      yield* Effect.addFinalizer(() => Effect.promise(() => fs.rm(parent.path, { recursive: true, force: true })))
      const derived = AttachmentStorage.deriveStoragePath({ dataDir: Global.Path.data, workspaceID: instance.directory, attachmentID: "ima_fixed" })
      if (!derived.ok) return yield* Effect.die(new Error("Private media path unavailable"))
      const request = (ordinal: string, attachmentID = "ima_missing") => ({ messageID: clientMessageID("server", ordinal),
        clientRequestID: ordinal, groupID, senderID: "server", content: "original private file", attachmentIDs: [attachmentID], batch: true })
      boundary.blocked = true
      const pending = yield* Effect.forEach(Array.from({ length: 128 }, (_, index) => request(`bounded-${index}`)),
        (input) => lease.engine.prepareMediaContinuation!(input).pipe(Effect.exit, Effect.forkScoped))
      yield* pollWithTimeout(Effect.sync(() => boundary.entered === 128 ? true : undefined), "128 original reservations did not reach the boundary")
      const joined = yield* lease.engine.prepareMediaContinuation!(request("bounded-0")).pipe(Effect.exit, Effect.forkScoped)
      expect(yield* lease.engine.prepareMediaContinuation!({ ...request("bounded-0"), content: "foreign body" }).pipe(Effect.flip))
        .toMatchObject({ code: "message_identity_conflict" })
      expect(yield* lease.engine.prepareMediaContinuation!(request("bounded-129")).pipe(Effect.flip))
        .toMatchObject({ message: "Upload continuation capacity is exhausted" })
      expect(boundary.entered).toBe(128)
      boundary.blocked = false
      boundary.release.resolve()
      expect((yield* Effect.forEach(pending, Fiber.join)).every(Exit.isFailure)).toBe(true)
      expect(Exit.isFailure(yield* Fiber.join(joined))).toBe(true)
      expect(yield* lease.engine.prepareMediaContinuation!(request("known-release")).pipe(Effect.flip))
        .toMatchObject({ message: "The original file has no durable upload origin; upload the file again" })
      const attachment = yield* lease.reader.withOutput({ workspaceID: instance.directory, userID: "server", groupIDs: [groupID] }, lease.engine.createAttachment!({
        id: "ima_fixed", workspaceID: instance.directory, groupID, uploadedBy: "server", storagePath: derived.storagePath,
        filename: "private.bin", mime: "application/octet-stream", sizeBytes: bytes.length, checksum,
      }))
      yield* Effect.promise(() => fs.writeFile(attachment.storagePath, bytes, { flag: "wx", mode: 0o600 }))
      yield* lease.engine.prepareMediaContinuation!(request("private-original-media", attachment.id))
      const message = yield* lease.reader.withOutput({ workspaceID: instance.directory, userID: "server", groupIDs: [groupID] },
        lease.engine.createMessage({ groupID, clientRequestID: "private-original-media", senderID: "server", senderType: "user", type: "file", content: "original private file",
          attachments: [{ id: attachment.id, workspaceID: instance.directory, expected: attachment }],
          metadata: [{ type: "attachment_ref", attachmentID: attachment.id, batch: true }],
        }))
      expect(message.type).toBe("file")
      expect(metadata.receivedChunks).toBe(3)
      expect(received.digest("hex")).toBe(checksum)
      expect(calls.map((value) => value.split(" ")[0])).toEqual(["GET", "POST", "PUT", "PUT", "PUT", "POST"])
      expect(native.topics).toContain("qry_delivery_reader")
      const uncertainPath = AttachmentStorage.deriveStoragePath({ dataDir: Global.Path.data, workspaceID: instance.directory, attachmentID: "ima_uncertain" })
      if (!uncertainPath.ok) return yield* Effect.die(new Error("Private uncertain media path unavailable"))
      const uncertain = yield* lease.reader.withOutput({ workspaceID: instance.directory, userID: "server", groupIDs: [groupID] }, lease.engine.createAttachment!({
        id: "ima_uncertain", workspaceID: instance.directory, groupID, uploadedBy: "server", storagePath: uncertainPath.storagePath,
        filename: "private.bin", mime: "application/octet-stream", sizeBytes: bytes.length, checksum,
      }))
      yield* Effect.promise(() => fs.writeFile(uncertain.storagePath, bytes, { flag: "wx", mode: 0o600 }))
      boundary.uncertain = true
      const before = calls.length
      expect(Exit.isFailure(yield* lease.engine.prepareMediaContinuation!(request("uncertain-original", uncertain.id)).pipe(Effect.exit))).toBe(true)
      expect(calls.slice(before).map((value) => value.split(" ")[0])).toEqual(["GET", "POST"])
      const after = calls.length
      expect(yield* lease.engine.prepareMediaContinuation!(request("uncertain-original", uncertain.id)).pipe(Effect.flip))
        .toMatchObject({ message: "The original upload outcome is not settled" })
      expect(calls.length).toBe(after)
      boundary.release = Promise.withResolvers<void>()
      boundary.entered = 0
      boundary.blocked = true
      const remaining = yield* Effect.forEach(Array.from({ length: 127 }, (_, index) => request(`retained-${index}`)),
        (input) => lease.engine.prepareMediaContinuation!(input).pipe(Effect.exit, Effect.forkScoped))
      yield* pollWithTimeout(Effect.sync(() => boundary.entered === 127 ? true : undefined), "unknown slot was not retained")
      expect(yield* lease.engine.prepareMediaContinuation!(request("retained-overflow")).pipe(Effect.flip))
        .toMatchObject({ message: "Upload continuation capacity is exhausted" })
      boundary.blocked = false
      boundary.release.resolve()
      expect((yield* Effect.forEach(remaining, Fiber.join)).every(Exit.isFailure)).toBe(true)
      expect(calls.length).toBe(after)
      const db = (yield* Database.Service).db
      expect((yield* db.all("SELECT id FROM im_messages WHERE client_request_id='private-original-media'")).length).toBe(1)
      expect((yield* db.all("SELECT record FROM im_media_upload_checkpoint WHERE attachment_id='ima_uncertain'")).length).toBe(1)

    }).pipe(Effect.provide(Layer.mergeAll(services, engine)), Effect.scoped))
  } finally {
    native.server.stop(true)
    await fs.rm(directory, { recursive: true, force: true })
  }
}, 30000)
