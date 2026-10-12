import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { Effect, Layer, Stream, Fiber } from "effect"
import { eq, and } from "drizzle-orm"
import { Database } from "@deepagent-code/core/database/database"
import { IMRepository, IMRepositoryLive } from "@deepagent-code/core/im/repository"
import { AttachmentTable, MemberTable } from "@deepagent-code/core/im/sql"
import { AttachmentID, GroupID } from "@deepagent-code/core/im/id"
import { AttachmentStorage } from "@deepagent-code/core/im/attachment-storage"
import { Global } from "@deepagent-code/core/global"
import { MediaFiles } from "@/im/media-files"
import { IMMedia } from "@/server/routes/instance/httpapi/handlers/im-media"

const root = await fs.realpath(process.argv[2])
const mode = process.argv[3]
const source = path.join(root, "source.bin")
const workspaceID = "private-media-workspace"
const waiting = (predicate: () => Promise<boolean>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      for (let index = 0; index < 100; index++) {
        if (yield* Effect.promise(predicate)) return
        yield* Effect.sleep("10 millis")
      }
      throw new Error("Owned media resource did not close")
    }),
  )

const result = await Effect.runPromise(
  Effect.gen(function* () {
    const repo = yield* IMRepository
    const db = (yield* Database.Service).db
    return yield* Effect.tryPromise(async () => {
      const make = async (id: string, bytes: Buffer, groupID?: string) => {
        const derived = AttachmentStorage.deriveStoragePath({
          dataDir: Global.Path.data,
          workspaceID,
          attachmentID: id,
        })
        assert(derived.ok)
        const value = await Effect.runPromise(
          repo.createAttachment({
            id,
            workspaceID,
            groupID,
            uploadedBy: "server",
            storagePath: derived.storagePath,
            filename: "private.bin",
            mime: "application/octet-stream",
            sizeBytes: bytes.length,
            checksum: AttachmentStorage.sha256Hex(bytes),
          }),
        )
        await fs.writeFile(source, bytes, { mode: 0o600 })
        const staged = await Effect.runPromise(IMMedia.stagedFile({ path: source, mime: "application/octet-stream" }))
        await Effect.runPromise(staged.copy(value))
        return value
      }
      if (mode === "cleanup-first") {
        await fs.writeFile(path.join(root, "unrelated-user-file"), "preserve user bytes")
        for (let index = 0; index < 32; index++)
          await Effect.runPromise(
            repo.createAttachment({
              id: `ima_bad_${String(index).padStart(2, "0")}`,
              workspaceID,
              uploadedBy: "server",
              storagePath: path.join(root, "unrelated-user-file"),
              filename: "expired",
              mime: "text/plain",
              sizeBytes: 1,
              checksum: "a".repeat(64),
            }),
          )
        await make("ima_good_32", Buffer.from("known private bytes"))
        await Effect.runPromise(
          db
            .update(AttachmentTable)
            .set({ created_at: Date.now() - AttachmentStorage.ttlMs() - 1000 })
            .run(),
        )
        assert.deepEqual(await Effect.runPromise(IMMedia.cleanup(repo, workspaceID)), {
          state: "incomplete",
          scanned: 32,
          removed: 0,
          failedCount: 32,
        })
        const cursor = await Effect.runPromise(repo.attachmentCleanupCursor(workspaceID))
        assert.equal(cursor.after?.id, "ima_bad_31")
        assert.equal(await fs.readFile(path.join(root, "unrelated-user-file"), "utf8"), "preserve user bytes")
        assert.equal(
          (await Effect.runPromise(db.select().from(AttachmentTable))).filter((row) => row.deleted_at !== null).length,
          0,
        )
        return { mode, scanned: 32, cursor: cursor.after?.id, userFilePreserved: true, released: 0 }
      }
      if (mode === "cleanup-next") {
        const before = await Effect.runPromise(repo.attachmentCleanupCursor(workspaceID))
        assert.equal(before.after?.id, "ima_bad_31")
        assert.deepEqual(await Effect.runPromise(IMMedia.cleanup(repo, workspaceID)), {
          state: "incomplete",
          scanned: 1,
          removed: 1,
          failedCount: 0,
        })
        assert.equal((await Effect.runPromise(repo.attachmentCleanupCursor(workspaceID))).after, undefined)
        assert.equal(
          (await Effect.runPromise(db.select().from(AttachmentTable))).filter((row) => row.deleted_at !== null).length,
          1,
        )
        assert.equal(await fs.readFile(path.join(root, "unrelated-user-file"), "utf8"), "preserve user bytes")
        return { mode, coldCursorPreserved: true, scanned: 1, tombstones: 1, userFilePreserved: true }
      }
      const group = await Effect.runPromise(
        repo.createGroup({ workspaceID, createdBy: "server", type: "project", name: "Private stream" }),
      )
      const value = await make("ima_stream", Buffer.alloc(3 * 262144 + 19, 88), group.id)
      await Effect.runPromise(
        repo.createMessage({
          groupID: group.id,
          senderID: "server",
          senderType: "user",
          type: "file",
          content: "private.bin",
          clientRequestID: "private-media-first",
          attachment: { id: value.id, workspaceID },
          metadata: { type: "attachment_ref", attachmentID: value.id },
        }),
      )
      const input = { id: value.id, workspaceID, userID: "server" }
      const descriptor = await Effect.runPromise(IMMedia.attachment(repo, input))
      const stat = await fs.lstat(value.storagePath, { bigint: true })
      const descriptors = async () =>
        (
          await Promise.all(
            (await fs.readdir("/dev/fd")).map((name) =>
              fs.stat(`/dev/fd/${name}`, { bigint: true }).then(
                (current) => current.dev === stat.dev && current.ino === stat.ino,
                () => false,
              ),
            ),
          )
        ).filter(Boolean).length
      assert.equal(await descriptors(), 0)
      let chunks = 0
      let revoke = false
      const listener = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          if (request.headers.get("authorization") !== "Basic private-fixture")
            return new Response(null, { status: 401 })
          const current = await Effect.runPromise(IMMedia.attachment(repo, input))
          const body = IMMedia.localStream(repo, input, current).pipe(
            Stream.tap(() =>
              Effect.gen(function* () {
                chunks++
                if (revoke && chunks === 1)
                  yield* db
                    .delete(MemberTable)
                    .where(and(eq(MemberTable.group_id, GroupID.make(group.id)), eq(MemberTable.member_id, "server")))
                    .run()
              }),
            ),
          )
          return new Response(Stream.toReadableStream(body), {
            headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
          })
        },
      })
      try {
        const response = await fetch(listener.url, { headers: { authorization: "Basic private-fixture" } })
        const digest = createHash("sha256")
        let bytes = 0
        const completeReader = response.body!.getReader()
        while (true) {
          const chunk = await completeReader.read()
          if (chunk.done) break
          bytes += chunk.value.length
          digest.update(chunk.value)
        }
        assert.equal(bytes, value.sizeBytes)
        assert.equal(digest.digest("hex"), value.checksum)
        await waiting(async () => (await descriptors()) === 0)
        const canceled = await fetch(listener.url, { headers: { authorization: "Basic private-fixture" } })
        const reader = canceled.body!.getReader()
        await reader.read()
        await reader.cancel()
        await waiting(async () => (await descriptors()) === 0)
        chunks = 0
        revoke = true
        const revoked = await fetch(listener.url, { headers: { authorization: "Basic private-fixture" } })
        let deniedBytes = 0
        const denied = await (async () => {
          const deniedReader = revoked.body!.getReader()
          while (true) {
            const chunk = await deniedReader.read()
            if (chunk.done) break
            deniedBytes += chunk.value.length
          }
        })().then(
          () => false,
          () => true,
        )
        assert(denied)
        assert.equal(chunks, 1)
        assert(deniedBytes <= 262144)
        await waiting(async () => (await descriptors()) === 0)
        await fs.chmod(value.storagePath, 0o644)
        await assert.rejects(
          MediaFiles.open(descriptor),
          (error: unknown) => error instanceof MediaFiles.Error && error.code === "unsafe",
        )
        await fs.chmod(value.storagePath, 0o600)
        const pinned = await MediaFiles.open(descriptor)
        const original = `${value.storagePath}.original`
        try {
          await fs.rename(value.storagePath, original)
          await fs.copyFile(original, value.storagePath)
          await fs.chmod(value.storagePath, 0o600)
          assert.notEqual((await fs.lstat(value.storagePath, { bigint: true })).ino, pinned.identity.ino)
          await assert.rejects(
            pinned.check(),
            (error: unknown) => error instanceof MediaFiles.Error && error.code === "changed",
          )
          assert.equal(AttachmentStorage.sha256Hex(await fs.readFile(original)), value.checksum)
        } finally {
          await pinned.file.close()
          await fs.unlink(value.storagePath)
          await fs.rename(original, value.storagePath)
        }
        await waiting(async () => (await descriptors()) === 0)
        const canceledPath = AttachmentStorage.deriveStoragePath({
          dataDir: Global.Path.data,
          workspaceID,
          attachmentID: "ima_canceled_copy",
        })
        assert(canceledPath.ok)
        const canceledCopy = await Effect.runPromise(
          repo.createAttachment({
          ...value,
          id: "ima_canceled_copy",
          projectID: value.projectID ?? undefined,
            groupID: undefined,
            messageID: undefined,
            storagePath: canceledPath.storagePath,
          }),
        )
        const abort = new AbortController()
        await assert.rejects(
          MediaFiles.write(
            canceledCopy,
            async (output) => {
              await output.write(Buffer.alloc(262144, 88))
              abort.abort()
            },
            abort.signal,
          ),
          (error: unknown) => error instanceof MediaFiles.Error && error.code === "changed",
        )
        assert.equal(
          await fs.lstat(canceledPath.storagePath).then(
            () => true,
            () => false,
          ),
          false,
        )
        assert.equal((await Effect.runPromise(repo.getAttachment(canceledCopy.id)))?.sizeBytes, value.sizeBytes)
        await Effect.runPromise(
          repo.addMember({ groupID: group.id, memberID: "server", memberType: "user", role: "owner" }),
        )
        await Effect.runPromise(IMMedia.attachment(repo, input))
        await Effect.runPromise(
          db
            .update(AttachmentTable)
            .set({ created_at: Date.now() - AttachmentStorage.ttlMs() - 1 })
            .where(eq(AttachmentTable.id, AttachmentID.make(value.id)))
            .run(),
        )
        const expired = await Effect.runPromise(IMMedia.attachment(repo, input).pipe(Effect.exit))
        assert.equal(expired._tag, "Failure")
        const invocation = MediaFiles.windowsPrivateInvocation(
          "C:\\Windows",
          "C:\\private\\quoted;$(unsafe)'file",
          true,
          false,
        )
        assert.equal(invocation.cmd.at(-2), "-EncodedCommand")
        assert(!invocation.cmd.join(" ").includes("quoted"))
        assert.equal(Object.keys(invocation.env).length, 4)
        const release = Promise.withResolvers<void>()
        let active = 0
        const held = IMMedia.transfer(
          Effect.promise(async () => {
            active++
            await release.promise
          }),
        )
        const one = Effect.runFork(held)
        const two = Effect.runFork(held)
        await waiting(async () => active === 2)
        const refused = await Effect.runPromise(
          IMMedia.transfer(
            Effect.sync(() => {
              active++
            }),
          ).pipe(Effect.exit),
        )
        assert.equal(refused._tag, "Failure")
        assert.equal(active, 2)
        release.resolve()
        await Effect.runPromise(Fiber.join(one))
        await Effect.runPromise(Fiber.join(two))
        return {
          mode,
          HTTPSize: bytes,
          hashMatched: true,
          revokeChunks: chunks,
          deniedBytes,
          closedFD: (await descriptors()) === 0,
          unsafeFileRejected: true,
          sourceReplacementRejected: true,
          canceledCopyRemoved: true,
          failedCopyReservationHeld: true,
          expiredRejected: true,
          thirdUploadZeroWork: true,
          windowsCodecOnly: true,
        }
      } finally {
        await listener.stop(true)
      }
    })
  }).pipe(
    Effect.provide(Layer.provideMerge(IMRepositoryLive, Database.layerFromPath(path.join(root, "media.sqlite")))),
  ),
)
console.log(JSON.stringify({ fixture: "media-backend", ...result }))
