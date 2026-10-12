import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Layer } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@deepagent-code/core/database/database"
import { IMRepository, IMRepositoryLive } from "@deepagent-code/core/im/repository"
import { AttachmentTable } from "@deepagent-code/core/im/sql"
import { AttachmentStorage } from "@deepagent-code/core/im/attachment-storage"
import { Global } from "@deepagent-code/core/global"
import { MediaFiles } from "@/im/media-files"
import { IMMedia } from "@/server/routes/instance/httpapi/handlers/im-media"

const root = await fs.realpath(process.argv[2])
const workspaceID = "private-cleanup-status"
const result = await Effect.runPromise(
  Effect.gen(function* () {
    const repo = yield* IMRepository
    const db = (yield* Database.Service).db
    const userFile = path.join(root, "unrelated-user-file")
    yield* Effect.promise(() => fs.writeFile(userFile, "preserve", { mode: 0o600 }))
    for (let index = 0; index < 33; index++) {
      const derived = AttachmentStorage.deriveStoragePath({
        dataDir: Global.Path.data,
        workspaceID,
        attachmentID: `ima_status_${String(index).padStart(2, "0")}`,
      })
      assert(derived.ok)
      yield* repo.createAttachment({
        id: `ima_status_${String(index).padStart(2, "0")}`,
        workspaceID,
        uploadedBy: "server",
        storagePath: index < 32 ? userFile : derived.storagePath,
        filename: "owned.bin",
        mime: "application/octet-stream",
        sizeBytes: 7,
        checksum: AttachmentStorage.sha256Hex(Buffer.from("preserve")),
      })
      if (index === 32) {
        yield* Effect.promise(() => MediaFiles.directory(workspaceID, true))
        yield* Effect.promise(() => fs.writeFile(derived.storagePath, "preserve", { mode: 0o600 }))
      }
    }
    yield* db.update(AttachmentTable).set({ created_at: Date.now() - AttachmentStorage.ttlMs() - 1000 }).run()
    const first = yield* IMMedia.cleanup(repo, workspaceID)
    assert.deepEqual(first, { state: "incomplete", scanned: 32, removed: 0, failedCount: 32 })
    const next = yield* IMMedia.cleanup(repo, workspaceID)
    assert.deepEqual(next, { state: "incomplete", scanned: 1, removed: 1, failedCount: 0 })
    const rows = yield* db.select().from(AttachmentTable)
    assert.equal(rows.filter((row) => row.deleted_at === null).length, 32)
    assert.equal(yield* Effect.promise(() => fs.readFile(userFile, "utf8")), "preserve")
    // Repair only this fixture's derived-path metadata. The retained failed rows
    // become eligible for confirmed absent-file cleanup, without deleting user data.
    for (const row of rows.filter((value) => value.deleted_at === null)) {
      const derived = AttachmentStorage.deriveStoragePath({ dataDir: Global.Path.data, workspaceID, attachmentID: row.id })
      assert(derived.ok)
      yield* db.update(AttachmentTable).set({ storage_path: derived.storagePath }).where(eq(AttachmentTable.id, row.id)).run()
    }
    assert.deepEqual(yield* IMMedia.cleanup(repo, workspaceID), { state: "incomplete", scanned: 32, removed: 32, failedCount: 0 })
    assert.equal((yield* IMMedia.cleanup(repo, workspaceID)).state, "incomplete")
    assert.deepEqual(yield* IMMedia.cleanup(repo, workspaceID), { state: "complete", scanned: 0, removed: 0, failedCount: 0 })
    assert.equal((yield* db.select().from(AttachmentTable)).filter((row) => row.deleted_at === null).length, 0)
    assert.equal(yield* Effect.promise(() => fs.readFile(userFile, "utf8")), "preserve")
    return { fixture: "media-cleanup-status", failedReservationsHeld: 32, tombstones: 33, falseComplete: false, actualFiles: true, physicalUserFilePreserved: true }
  }).pipe(Effect.provide(Layer.provideMerge(IMRepositoryLive, Database.layerFromPath(path.join(root, "media.sqlite"))))),
)
console.log(JSON.stringify(result))
