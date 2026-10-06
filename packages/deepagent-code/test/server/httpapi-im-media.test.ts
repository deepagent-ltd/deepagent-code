import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { eq, sql } from "drizzle-orm"
import { HttpClientResponse } from "effect/unstable/http"
import fs from "node:fs/promises"
import path from "node:path"
import { Global } from "@deepagent-code/core/global"
import { Database } from "@deepagent-code/core/database/database"
import { AttachmentTable, GroupTable, MemberTable } from "@deepagent-code/core/im/sql"
import { AttachmentID, GroupID } from "@deepagent-code/core/im/id"
import { IMMentionIntentTable } from "@deepagent-code/core/im/mention-intent.sql"
import { AttachmentStorage } from "@deepagent-code/core/im/attachment-storage"
import { Log } from "@deepagent-code/core/util/log"
import { Workspace } from "../../src/control-plane/workspace"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { Project } from "../../src/project/project"
import { Session } from "@/session/session"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayerWithRuntimeFlags, requestInDirectory } from "./httpapi-layer"

const instance = InstanceStore.defaultLayer.pipe(
  Layer.provide(Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))),
)
const workspace = Workspace.defaultLayer.pipe(
  Layer.provide(InstanceStore.defaultLayer),
  Layer.provide(InstanceBootstrap.defaultLayer),
)
const suite = (enabled: boolean) =>
  testEffect(
    Layer.mergeAll(
      instance,
      workspace,
      Project.defaultLayer,
      Session.defaultLayer,
      Database.defaultLayer,
      httpApiLayerWithRuntimeFlags(RuntimeFlags.layer({ v4FileUploadEnabled: enabled })),
    ),
  )
const on = suite(true)
const off = suite(false)
if (process.env.IM_MEDIA_TEST_DEBUG) await Log.init({ print: true, level: "DEBUG" })
afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

type Attachment = {
  id: string
  filename: string
  sizeBytes: number
  checksum: string
  mime: string
  messageID: string | null
  preview: boolean
  expiresAt: number
}
function json<T>(response: HttpClientResponse.HttpClientResponse) {
  return response.text.pipe(
    Effect.map((text) => {
      expect(response.status, text).toBe(200)
      return JSON.parse(text) as T
    }),
  )
}
const post = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
})
const seed = Effect.gen(function* () {
  const directory = yield* tmpdirScoped({ git: true })
  const group = yield* requestInDirectory(
    "/api/v1/im/groups",
    directory,
    post({ type: "project", name: "Isolated media fixture" }),
  ).pipe(Effect.flatMap(json<{ id: string; workspaceID: string }>))
  return { directory, group }
})
const upload = (
  directory: string,
  groupID: string,
  file = new File(["fixture content"], "@agent.txt", { type: "text/plain" }),
  messageID?: string,
) => {
  const body = new FormData()
  body.append("file", file)
  body.append("groupId", groupID)
  if (messageID) body.append("messageId", messageID)
  return requestInDirectory("/api/v1/im/attachments", directory, { method: "POST", body })
}
const send = (directory: string, groupID: string, attachmentID: string, clientRequestID = "file-request-1") =>
  requestInDirectory(
    `/api/v1/im/groups/${groupID}/messages`,
    directory,
    post({
      senderType: "user",
      type: "file",
      content: "client name is not authoritative",
      attachmentID,
      clientRequestID,
    }),
  )

function storage(workspaceID: string, attachmentID = "ima_fixture") {
  const value = AttachmentStorage.deriveStoragePath({ dataDir: Global.Path.data, workspaceID, attachmentID })
  if (!value.ok) throw new Error("Expected isolated attachment path")
  return value
}

describe("IM media real loopback HTTP", () => {
  on.live(
    "one list request cleans at most 32 expired records even with multiple live bound attachments",
    () =>
      Effect.gen(function* () {
        const { directory, group } = yield* seed
        const baseDir = storage(group.workspaceID).baseDir
        yield* Effect.addFinalizer(() => Effect.promise(() => fs.rm(baseDir, { recursive: true, force: true })))
        const live = []
        for (const requestID of ["live-1", "live-2"]) {
          const attachment = yield* upload(directory, group.id).pipe(Effect.flatMap(json<Attachment>))
          yield* send(directory, group.id, attachment.id, requestID).pipe(Effect.flatMap(json))
          live.push(attachment.id)
        }
        const { db } = yield* Database.Service
        const expired = Array.from({ length: 65 }, (_, index) => ({
          id: AttachmentID.make(`ima_expired_${index}`),
          workspace_id: group.workspaceID,
          group_id: GroupID.make(group.id),
          uploaded_by: "server",
          filename: "expired.txt",
          mime: "text/plain",
          size_bytes: 7,
          checksum: AttachmentStorage.sha256Hex(new TextEncoder().encode("expired")),
          storage_path: storage(group.workspaceID, `ima_expired_${index}`).storagePath,
          created_at: Date.now() - AttachmentStorage.ttlMs() - 1000,
        }))
        yield* db.insert(AttachmentTable).values(expired).run()
        yield* Effect.forEach(expired, (item) => Effect.promise(() => fs.writeFile(item.storage_path, "expired")))
        const response = yield* requestInDirectory(`/api/v1/im/attachments?groupId=${group.id}`, directory).pipe(
          Effect.flatMap(json<Attachment[]>),
        )
        expect(response.map((item) => item.id).sort()).toEqual(live.sort())
        const rows = yield* db.select().from(AttachmentTable).all()
        expect(rows.filter((item) => item.deleted_at !== null)).toHaveLength(32)
        expect(rows.filter((item) => item.id.startsWith("ima_expired_") && item.deleted_at === null)).toHaveLength(33)
        const files = yield* Effect.promise(() => fs.readdir(baseDir))
        expect(files.filter((name) => name.startsWith("ima_expired_"))).toHaveLength(33)
      }),
    20_000,
  )

  on.live(
    "a real SQL insert rejection leaves no persistent attachment bytes",
    () =>
      Effect.gen(function* () {
        const { directory, group } = yield* seed
        const { db } = yield* Database.Service
        yield* db.run(
          sql`CREATE TRIGGER im_media_reject_insert BEFORE INSERT ON im_attachments BEGIN SELECT RAISE(ABORT, 'isolated insert rejection'); END`,
        )
        yield* Effect.addFinalizer(() => db.run(sql`DROP TRIGGER IF EXISTS im_media_reject_insert`).pipe(Effect.orDie))
        expect((yield* upload(directory, group.id)).status).toBe(500)
        expect(yield* db.select().from(AttachmentTable).all()).toHaveLength(0)
        expect(
          yield* Effect.promise(() =>
            fs.stat(storage(group.workspaceID).baseDir).then(
              () => true,
              () => false,
            ),
          ),
        ).toBe(false)
      }),
    20_000,
  )

  on.live(
    "a real filesystem failure retains an unbound owner record that can be cleaned at TTL",
    () =>
      Effect.gen(function* () {
        const { directory, group } = yield* seed
        const baseDir = storage(group.workspaceID).baseDir
        yield* Effect.addFinalizer(() => Effect.promise(() => fs.rm(baseDir, { recursive: true, force: true })))
        yield* Effect.promise(async () => {
          await fs.mkdir(path.dirname(baseDir), { recursive: true })
          await fs.writeFile(baseDir, "isolated directory obstruction")
        })
        expect((yield* upload(directory, group.id)).status).toBe(500)
        const { db } = yield* Database.Service
        const rows = yield* db.select().from(AttachmentTable).all()
        expect(rows).toHaveLength(1)
        expect(rows[0].message_id).toBeNull()
        expect(rows[0].deleted_at).toBeNull()
        expect((yield* send(directory, group.id, rows[0].id)).status).toBe(404)
        expect((yield* requestInDirectory(`/api/v1/im/attachments/${rows[0].id}/content`, directory)).status).toBe(404)
        yield* Effect.promise(() => fs.rm(baseDir))
        yield* db
          .update(AttachmentTable)
          .set({ created_at: Date.now() - AttachmentStorage.ttlMs() - 1000 })
          .where(eq(AttachmentTable.id, rows[0].id))
          .run()
        expect(
          yield* requestInDirectory(`/api/v1/im/attachments?groupId=${group.id}`, directory).pipe(
            Effect.flatMap(json<Attachment[]>),
          ),
        ).toEqual([])
        expect(
          (yield* db.select().from(AttachmentTable).where(eq(AttachmentTable.id, rows[0].id)).get())?.deleted_at,
        ).not.toBeNull()
      }),
    20_000,
  )

  on.live(
    "multipart upload binds one message, survives retry, and downloads verified bytes without Agent intents",
    () =>
      Effect.gen(function* () {
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            const previous = process.env.DEEPAGENT_IM_AGENT_RESPONDER
            process.env.DEEPAGENT_IM_AGENT_RESPONDER = "on"
            return previous
          }),
          (previous) =>
            Effect.sync(() => {
              if (previous === undefined) delete process.env.DEEPAGENT_IM_AGENT_RESPONDER
              else process.env.DEEPAGENT_IM_AGENT_RESPONDER = previous
            }),
        )
        const { directory, group } = yield* seed
        const attachment = yield* upload(directory, group.id).pipe(Effect.flatMap(json<Attachment>))
        expect(attachment.messageID).toBeNull()
        expect((yield* requestInDirectory(`/api/v1/im/attachments/${attachment.id}/content`, directory)).status).toBe(
          404,
        )
        const first = yield* send(directory, group.id, attachment.id).pipe(
          Effect.flatMap(json<{ id: string; content: string; metadata: unknown }>),
        )
        const second = yield* send(directory, group.id, attachment.id).pipe(Effect.flatMap(json<{ id: string }>))
        expect(second.id).toBe(first.id)
        expect(first.content).toBe("@agent.txt")
        expect(first.metadata).toEqual({ type: "attachment_ref", attachmentID: attachment.id })
        expect((yield* send(directory, group.id, attachment.id, "different-message")).status).toBe(404)
        const descriptor = yield* requestInDirectory(`/api/v1/im/attachments/${attachment.id}`, directory).pipe(
          Effect.flatMap(json<Attachment>),
        )
        expect(descriptor.messageID).toBe(first.id)
        const response = yield* requestInDirectory(`/api/v1/im/attachments/${attachment.id}/content`, directory)
        expect(response.status).toBe(200)
        expect(response.headers["cache-control"]).toBe("no-store")
        expect(response.headers["x-content-type-options"]).toBe("nosniff")
        expect(response.headers["content-disposition"]).toContain("attachment;")
        const bytes = new Uint8Array(yield* response.arrayBuffer)
        expect(new TextDecoder().decode(bytes)).toBe("fixture content")
        expect(AttachmentStorage.sha256Hex(bytes)).toBe(attachment.checksum)
        const { db } = yield* Database.Service
        const row = yield* db
          .select()
          .from(AttachmentTable)
          .where(eq(AttachmentTable.id, AttachmentID.make(attachment.id)))
          .get()
        expect(row?.storage_path.endsWith(`/${attachment.id}`)).toBe(true)
        expect(yield* db.select().from(IMMentionIntentTable).all()).toHaveLength(0)
        if (row) yield* Effect.promise(() => fs.rm(row.storage_path, { force: true }))
      }),
    20_000,
  )

  off.live(
    "OFF refuses upload, file message, descriptors, list and download while text remains available",
    () =>
      Effect.gen(function* () {
        const { directory, group } = yield* seed
        expect((yield* upload(directory, group.id)).status).toBe(404)
        expect((yield* send(directory, group.id, "ima_unknown")).status).toBe(404)
        for (const endpoint of [
          "/api/v1/im/attachments",
          "/api/v1/im/attachments/ima_unknown",
          "/api/v1/im/attachments/ima_unknown/content",
        ])
          expect((yield* requestInDirectory(endpoint, directory)).status).toBe(404)
        expect(
          (yield* requestInDirectory(
            `/api/v1/im/groups/${group.id}/messages`,
            directory,
            post({ senderType: "user", type: "text", content: "ordinary chat" }),
          )).status,
        ).toBe(200)
        expect(yield* (yield* Database.Service).db.select().from(AttachmentTable).all()).toHaveLength(0)
      }),
    20_000,
  )

  on.live(
    "real PNG bytes select image preview while SVG stays a download and forged PNG is rejected",
    () =>
      Effect.gen(function* () {
        const { directory, group } = yield* seed
        const bytes = Uint8Array.from(
          Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1EAAAAASUVORK5CYII=",
            "base64",
          ),
        )
        const png = yield* upload(
          directory,
          group.id,
          new File([bytes], "fixture.png", { type: "application/octet-stream" }),
        ).pipe(Effect.flatMap(json<Attachment>))
        expect(png.mime).toBe("image/png")
        expect(png.preview).toBe(true)
        yield* send(directory, group.id, png.id, "png-message").pipe(Effect.flatMap(json))
        const image = yield* requestInDirectory(`/api/v1/im/attachments/${png.id}/content`, directory)
        expect(image.headers["content-type"]).toBe("image/png")
        expect(new Uint8Array(yield* image.arrayBuffer)).toEqual(bytes)
        const svg = yield* upload(
          directory,
          group.id,
          new File(["<svg onload='alert(1)'/>"], "fixture.svg", { type: "image/svg+xml" }),
        ).pipe(Effect.flatMap(json<Attachment>))
        expect(svg.preview).toBe(false)
        yield* send(directory, group.id, svg.id, "svg-message").pipe(Effect.flatMap(json))
        const download = yield* requestInDirectory(`/api/v1/im/attachments/${svg.id}/content`, directory)
        expect(download.headers["content-type"]).toBe("application/octet-stream")
        expect(download.headers["content-disposition"]).toContain("attachment;")
        expect(
          (yield* upload(
            directory,
            group.id,
            new File(["<html>forged image</html>"], "fake.png", { type: "image/png" }),
          )).status,
        ).toBe(415)
        const { db } = yield* Database.Service
        for (const id of [png.id, svg.id]) {
          const row = yield* db
            .select()
            .from(AttachmentTable)
            .where(eq(AttachmentTable.id, AttachmentID.make(id)))
            .get()
          if (row) yield* Effect.promise(() => fs.rm(row.storage_path, { force: true }))
        }
      }),
    20_000,
  )

  on.live(
    "multipart size overflow is an explicit 413 and leaves no durable attachment",
    () =>
      Effect.gen(function* () {
        const { directory, group } = yield* seed
        yield* Effect.acquireUseRelease(
          Effect.sync(() => {
            const previous = process.env.IM_MAX_ATTACHMENT_BYTES
            process.env.IM_MAX_ATTACHMENT_BYTES = "8"
            return previous
          }),
          () =>
            Effect.gen(function* () {
              const response = yield* upload(
                directory,
                group.id,
                new File(["0123456789"], "large.txt", { type: "text/plain" }),
              )
              expect(response.status).toBe(413)
              expect(yield* response.json).toMatchObject({ name: "FILE_TOO_LARGE" })
              expect(yield* (yield* Database.Service).db.select().from(AttachmentTable).all()).toHaveLength(0)
            }),
          (previous) =>
            Effect.sync(() => {
              if (previous === undefined) delete process.env.IM_MAX_ATTACHMENT_BYTES
              else process.env.IM_MAX_ATTACHMENT_BYTES = previous
            }),
        )
      }),
    20_000,
  )

  on.live(
    "rejects workspace/member/kernel boundaries, arbitrary message binding, corrupt bytes and TTL expiry",
    () =>
      Effect.gen(function* () {
        const { directory, group } = yield* seed
        const other = yield* tmpdirScoped({ git: true })
        expect((yield* upload(directory, group.id, undefined, "imsg_arbitrary")).status).toBe(400)
        expect((yield* requestInDirectory("/api/v1/im/attachments", directory)).status).toBe(400)
        const attachment = yield* upload(directory, group.id).pipe(Effect.flatMap(json<Attachment>))
        yield* send(directory, group.id, attachment.id).pipe(Effect.flatMap(json))
        const endpoint = `/api/v1/im/attachments/${attachment.id}/content`
        expect((yield* requestInDirectory(endpoint, other)).status).toBe(404)
        const { db } = yield* Database.Service
        const row = yield* db
          .select()
          .from(AttachmentTable)
          .where(eq(AttachmentTable.id, AttachmentID.make(attachment.id)))
          .get()
        if (!row) return yield* Effect.die("Expected fixture attachment")
        yield* Effect.promise(() => fs.writeFile(row.storage_path, "corrupted"))
        expect((yield* requestInDirectory(endpoint, directory)).status).toBe(404)
        yield* db
          .update(AttachmentTable)
          .set({ created_at: Date.now() - AttachmentStorage.ttlMs() - 1000 })
          .where(eq(AttachmentTable.id, row.id))
          .run()
        expect((yield* requestInDirectory(endpoint, directory)).status).toBe(404)
        expect(yield* Effect.promise(() => Bun.file(row.storage_path).exists())).toBe(false)
        expect(
          (yield* db.select().from(AttachmentTable).where(eq(AttachmentTable.id, row.id)).get())?.deleted_at,
        ).not.toBeNull()
        yield* db
          .update(GroupTable)
          .set({ kernel_conv_id: "k:2:isolated-never-contacted" })
          .where(eq(GroupTable.id, GroupID.make(group.id)))
          .run()
        expect((yield* upload(directory, group.id)).status).toBe(400)
        yield* db
          .delete(MemberTable)
          .where(eq(MemberTable.group_id, GroupID.make(group.id)))
          .run()
        expect((yield* upload(directory, group.id)).status).toBe(404)
      }),
    20_000,
  )
})
