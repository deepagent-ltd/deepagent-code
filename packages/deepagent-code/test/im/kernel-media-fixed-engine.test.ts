import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { Effect, Layer, SubscriptionRef } from "effect"
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
import { KernelLiveFirstSeenFixture } from "./fixture/kernel-live-first-seen"
import { ReaderInstanceFixture } from "./reader-instance-fixture"

test("fixed engine serially completes private media through the official lib, reader request and native SDK slots", async () => {
  const directory = await fs.mkdtemp("/tmp/dac-im-media-fixed-engine-")
  const bytes = Buffer.alloc(262144 * 2 + 17, 77)
  const checksum = createHash("sha256").update(bytes).digest("hex")
  const metadata = { objectID: "c".repeat(64), uploadID: "", filename: "private.bin", mime: "",
    sizeBytes: bytes.length, sha256: checksum, state: "uploading", receivedBytes: 0, receivedChunks: 0,
    createdAt: Date.now(), expiresAt: Date.now() + 86400000 }
  const calls: string[] = []
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
      if (request.method === "POST" && pathname.endsWith("/objects")) metadata.uploadID = (await request.json()).upload.uploadID
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
  const repository = IMRepositoryLive.pipe(Layer.provide(database))
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
      const attachment = yield* lease.reader.withOutput({ workspaceID: instance.directory, userID: "server", groupIDs: [groupID] }, lease.engine.createAttachment!({
        id: "ima_fixed", workspaceID: instance.directory, groupID, uploadedBy: "server", storagePath: derived.storagePath,
        filename: "private.bin", mime: "application/octet-stream", sizeBytes: bytes.length, checksum,
      }))
      yield* Effect.promise(() => fs.writeFile(attachment.storagePath, bytes, { flag: "wx", mode: 0o600 }))
      const message = yield* lease.engine.createMessage({ groupID, clientRequestID: "private-original-media", senderID: "server", senderType: "user", type: "file", content: "one original private file",
        attachments: [{ id: attachment.id, workspaceID: instance.directory, expected: attachment }],
        metadata: [{ type: "attachment_ref", attachmentID: attachment.id, batch: true }],
      }).pipe(Effect.timeout("2 seconds"))
      expect(message.type).toBe("file")
      expect(metadata.receivedChunks).toBe(3)
      expect(received.digest("hex")).toBe(checksum)
      expect(calls.map((value) => value.split(" ")[0])).toEqual(["GET", "POST", "PUT", "PUT", "PUT", "POST"])
      expect(native.topics).toContain("qry_delivery_reader")
    }).pipe(Effect.provide(Layer.mergeAll(services, engine)), Effect.scoped))
  } finally {
    native.server.stop(true)
    await fs.rm(directory, { recursive: true, force: true })
  }
}, 10000)
