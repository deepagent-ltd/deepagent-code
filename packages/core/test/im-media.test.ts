import { describe, expect, it } from "bun:test"
import { Effect, Layer } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "../src/database/database"
import { IMRepository, IMRepositoryLive } from "../src/im/repository"
import { AttachmentStorage } from "../src/im/attachment-storage"
import { AttachmentTable, MessageTable } from "../src/im/sql"
import { AttachmentID } from "../src/im/id"

const run = <A>(program: Effect.Effect<A, unknown, IMRepository | Database.Service>) =>
  Effect.runPromise(
    program.pipe(Effect.provide(Layer.provideMerge(IMRepositoryLive, Database.layerFromPath(":memory:")))),
  )
const seed = Effect.gen(function* () {
  const repo = yield* IMRepository
  const group = yield* repo.createGroup({
    workspaceID: "media-workspace",
    type: "project",
    name: "Isolated media",
    createdBy: "server",
  })
  const attachment = yield* repo.createAttachment({
    id: "ima_fixed",
    workspaceID: group.workspaceID,
    groupID: group.id,
    uploadedBy: "server",
    storagePath: "/fixture/ima_fixed",
    filename: "@agent.txt",
    mime: "text/plain",
    sizeBytes: 5,
    checksum: "fixture",
  })
  const input = {
    groupID: group.id,
    senderID: "server",
    senderType: "user" as const,
    type: "file" as const,
    content: attachment.filename,
    clientRequestID: "request-1",
    attachment: { id: attachment.id, workspaceID: group.workspaceID },
    metadata: { type: "attachment_ref" as const, attachmentID: attachment.id },
  }
  return { repo, group, attachment, input }
})

describe("IM media transaction", () => {
  it("allows cleanup to tombstone a failed unbound upload before TTL", async () => {
    await run(
      Effect.gen(function* () {
        const { repo, attachment } = yield* seed
        yield* repo.expireAttachment(attachment.id)
        expect(yield* repo.getAttachment(attachment.id)).toBeUndefined()
        const row = yield* (yield* Database.Service).db
          .select()
          .from(AttachmentTable)
          .where(eq(AttachmentTable.id, AttachmentID.make(attachment.id)))
          .get()
        expect(row?.deleted_at).not.toBeNull()
      }),
    )
  })

  it("preserves a bound live attachment and permits tombstoning only after TTL", async () => {
    await run(
      Effect.gen(function* () {
        const { repo, attachment, input } = yield* seed
        yield* repo.createMessage(input)
        yield* repo.expireAttachment(attachment.id)
        expect(yield* repo.getAttachment(attachment.id)).toBeDefined()
        yield* (yield* Database.Service).db
          .update(AttachmentTable)
          .set({ created_at: Date.now() - AttachmentStorage.ttlMs() - 1000 })
          .where(eq(AttachmentTable.id, AttachmentID.make(attachment.id)))
          .run()
        yield* repo.expireAttachment(attachment.id)
        expect(yield* repo.getAttachment(attachment.id)).toBeUndefined()
      }),
    )
  })

  it("preserves the supplied storage ID and binds one exact-retry message", async () => {
    await run(
      Effect.gen(function* () {
        const { repo, attachment, input } = yield* seed
        expect(attachment.id).toBe("ima_fixed")
        const first = yield* repo.createMessage(input)
        const retry = yield* repo.createMessage(input)
        expect(first.id).toBe(retry.id)
        expect(retry.replayed).toBe(true)
        expect((yield* repo.getAttachment(attachment.id))?.messageID).toBe(first.id)
        expect(yield* (yield* Database.Service).db.select().from(MessageTable).all()).toHaveLength(1)
      }),
    )
  })

  it("rejects rebinding and rolls back the conflicting message insert", async () => {
    await run(
      Effect.gen(function* () {
        const { repo, input, attachment } = yield* seed
        const first = yield* repo.createMessage(input)
        const result = yield* repo.createMessage({ ...input, clientRequestID: "request-2" }).pipe(Effect.result)
        expect(result._tag).toBe("Failure")
        expect((yield* repo.getAttachment(attachment.id))?.messageID).toBe(first.id)
        expect(yield* (yield* Database.Service).db.select().from(MessageTable).all()).toHaveLength(1)
      }),
    )
  })

  it.each(["workspace", "uploader", "kernel", "expired"])(
    "rejects the %s boundary without binding or inserting",
    async (boundary) => {
      await run(
        Effect.gen(function* () {
          const { repo, group, input, attachment } = yield* seed
          const { db } = yield* Database.Service
          if (boundary === "kernel")
            yield* repo.bindKernelConversation({ groupID: group.id, kernelConvID: "k:2:fixture" })
          if (boundary === "expired")
            yield* db
              .update(AttachmentTable)
              .set({ created_at: Date.now() - AttachmentStorage.ttlMs() - 1000 })
              .where(eq(AttachmentTable.id, AttachmentID.make(attachment.id)))
              .run()
          const result = yield* repo
            .createMessage({
              ...input,
              ...(boundary === "workspace"
                ? { attachment: { id: attachment.id, workspaceID: "other-workspace" } }
                : {}),
              ...(boundary === "uploader" ? { senderID: "other-user" } : {}),
            })
            .pipe(Effect.result)
          expect(result._tag).toBe("Failure")
          expect((yield* repo.getAttachment(attachment.id))?.messageID).toBeNull()
          expect(yield* db.select().from(MessageTable).all()).toHaveLength(0)
        }),
      )
    },
  )
})
