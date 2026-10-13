import { describe, expect, it } from "bun:test"
import { Effect, Layer } from "effect"
import { eq, sql } from "drizzle-orm"
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
    checksum: AttachmentStorage.sha256Hex(Buffer.from("hello")),
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
  it("binds four ordered attachments in one message and rejects changed retry/body or a batch borrowed from legacy", async () => {
    await run(
      Effect.gen(function* () {
        const s = yield* seed
        const attachments = [
          s.attachment,
          ...(yield* Effect.forEach([1, 2, 3], (index) =>
            s.repo.createAttachment({
              ...s.attachment,
              id: `ima_batch_${index}`,
              projectID: undefined,
              groupID: s.group.id,
              messageID: undefined,
              storagePath: `/fixture/ima_batch_${index}`,
            }),
          )),
        ]
        const input = {
          ...s.input,
          attachment: undefined,
          attachments: attachments.map((item) => ({ id: item.id, workspaceID: s.group.workspaceID, expected: item })),
          content: "",
          metadata: attachments.map((item) => ({
            type: "attachment_ref" as const,
            attachmentID: item.id,
            batch: true as const,
          })),
        }
        const original = yield* s.repo.createMessage(input)
        expect(original.content).toBe("")
        expect(original.metadata).toEqual(input.metadata)
        const db = (yield* Database.Service).db
        const changes = yield* db.get(sql`SELECT total_changes() count`)
        expect((yield* s.repo.createMessage(input)).replayed).toBe(true)
        expect(yield* db.get(sql`SELECT total_changes() count`)).toEqual(changes)
        expect((yield* db.select().from(AttachmentTable)).every((item) => item.message_id === original.id)).toBe(true)
        expect(
          (yield* s.repo
            .createMessage({
              ...input,
              attachments: [...input.attachments].reverse(),
              metadata: [...input.metadata].reverse(),
            })
            .pipe(Effect.exit))._tag,
        ).toBe("Failure")
        expect((yield* s.repo.createMessage({ ...input, content: "changed caption" }).pipe(Effect.exit))._tag).toBe(
          "Failure",
        )
        expect((yield* s.repo.createMessage(s.input).pipe(Effect.exit))._tag).toBe("Failure")
        expect(yield* db.select().from(MessageTable)).toHaveLength(1)
      }),
    )
  })

  it("searches legacy and batch attachment metadata once while preserving membership", async () => {
    await run(Effect.gen(function* () {
      const s = yield* seed
      if (!s.group) throw new Error("The original group fixture was not created")
      const legacy = yield* s.repo.createMessage(s.input)
      const attachment = yield* s.repo.createAttachment({ ...s.attachment, groupID: s.group.id, id: "ima_search_batch",
        projectID: undefined, messageID: undefined })
      const batch = yield* s.repo.createMessage({ ...s.input, clientRequestID: "request-batch-search",
        attachment: undefined, attachments: [{ id: attachment.id, workspaceID: s.group.workspaceID, expected: attachment }],
        metadata: [{ type: "attachment_ref", attachmentID: attachment.id, batch: true }] })
      const query = { workspaceID: s.group.workspaceID, userID: "server", query: "agent", metadataType: "attachment_ref", limit: 10 }
      expect((yield* s.repo.searchMessages(query)).messages.map((item) => item.id).sort()).toEqual([legacy.id, batch.id].sort())
      expect((yield* s.repo.searchMessages({ ...query, userID: "other-user" })).messages).toHaveLength(0)
    }))
  })

  it("rejects a bad later attachment and duplicate/oversized batches without any partial binding", async () => {
    await run(
      Effect.gen(function* () {
        const s = yield* seed
        const next = yield* s.repo.createAttachment({
          ...s.attachment,
          id: "ima_second",
          projectID: undefined,
          groupID: s.group.id,
          messageID: undefined,
          storagePath: "/fixture/ima_second",
        })
        const input = {
          ...s.input,
          attachment: undefined,
          attachments: [s.attachment, next].map((item) => ({
            id: item.id,
            workspaceID: s.group.workspaceID,
            expected: item,
          })),
          metadata: [s.attachment, next].map((item) => ({
            type: "attachment_ref" as const,
            attachmentID: item.id,
            batch: true as const,
          })),
        }
        const db = (yield* Database.Service).db
        yield* db
          .update(AttachmentTable)
          .set({ created_at: Date.now() - AttachmentStorage.ttlMs() - 1 })
          .where(eq(AttachmentTable.id, AttachmentID.make(next.id)))
          .run()
        expect((yield* s.repo.createMessage(input).pipe(Effect.exit))._tag).toBe("Failure")
        expect((yield* db.select().from(AttachmentTable)).every((item) => item.message_id === null)).toBe(true)
        yield* db
          .update(AttachmentTable)
          .set({ created_at: next.createdAt, checksum: "b".repeat(64) })
          .where(eq(AttachmentTable.id, AttachmentID.make(next.id)))
          .run()
        expect((yield* s.repo.createMessage(input).pipe(Effect.exit))._tag).toBe("Failure")
        expect((yield* db.select().from(AttachmentTable)).every((item) => item.message_id === null)).toBe(true)
        for (const ids of [
          [input.attachments[0], input.attachments[0]],
          Array.from({ length: 5 }, () => input.attachments[0]),
        ]) {
          expect(
            (yield* s.repo
              .createMessage({
                ...input,
                attachments: ids,
                metadata: ids.map((item) => ({
                  type: "attachment_ref" as const,
                  attachmentID: item.id,
                  batch: true as const,
                })),
              })
              .pipe(Effect.exit))._tag,
          ).toBe("Failure")
        }
        expect(yield* db.select().from(MessageTable)).toHaveLength(0)
      }),
    )
  })

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
        expect(
          (yield* repo
            .createMessage({
              ...input,
              attachment: undefined,
              attachments: [input.attachment],
              metadata: [{ ...input.metadata, batch: true }],
            })
            .pipe(Effect.exit))._tag,
        ).toBe("Failure")
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
