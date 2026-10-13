import { afterAll, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { sql } from "drizzle-orm"
import fs from "node:fs/promises"
import { Global } from "@deepagent-code/core/global"
import { Database } from "@deepagent-code/core/database/database"
import { AttachmentStorage } from "@deepagent-code/core/im/attachment-storage"
import { AttachmentTable, MessageTable } from "@deepagent-code/core/im/sql"
import { Workspace } from "@/control-plane/workspace"
import { InstanceBootstrap } from "@/project/bootstrap"
import { InstanceStore } from "@/project/instance-store"
import { Project } from "@/project/project"
import { Session } from "@/session/session"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { resetDatabase } from "../fixture/db"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayerWithRuntimeFlags, requestInDirectory } from "./httpapi-layer"

afterAll(async () => {
  await resetDatabase()
})
const instance = InstanceStore.defaultLayer.pipe(
  Layer.provide(Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))),
)
const workspace = Workspace.defaultLayer.pipe(
  Layer.provide(InstanceStore.defaultLayer),
  Layer.provide(InstanceBootstrap.defaultLayer),
)
const it = testEffect(
  Layer.mergeAll(
    instance,
    workspace,
    Project.defaultLayer,
    Session.defaultLayer,
    Database.defaultLayer,
    httpApiLayerWithRuntimeFlags(RuntimeFlags.layer({ v4FileUploadEnabled: true }), {
      DEEPAGENT_CODE_SERVER_USERNAME: "private-media",
      DEEPAGENT_CODE_SERVER_PASSWORD: "private-media-module-only",
    }),
  ),
)
const authorization = `Basic ${btoa("private-media:private-media-module-only")}`
const post = (body: unknown) => ({
  method: "POST",
  headers: { authorization, "content-type": "application/json" },
  body: JSON.stringify(body),
})
const parse = <A>(response: Awaited<Effect.Success<ReturnType<typeof requestInDirectory>>>) =>
  response.text.pipe(
    Effect.map((text) => {
      expect(response.status, text).toBe(200)
      return JSON.parse(text) as A
    }),
  )
type Attachment = { id: string; filename: string; checksum: string; sizeBytes: number }

it.live(
  "formal auth HTTP binds four actual uploaded files in one atomic caption message, preserves exact retries and exposes readonly media v2",
  () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped({ git: true })
      const group = yield* requestInDirectory(
        "/api/v1/im/groups",
        directory,
        post({ type: "project", name: "Private four-file batch" }),
      ).pipe(Effect.flatMap(parse<{ id: string; workspaceID: string }>))
      const captured = [] as string[]
      yield* Effect.addFinalizer(() =>
        Effect.promise(() =>
          Promise.all(captured.map((target) => fs.rm(target, { force: true }))).then(() => undefined),
        ),
      )
      const attachments = yield* Effect.forEach([0, 1, 2, 3], (index) =>
        Effect.gen(function* () {
          const body = new FormData()
          body.append("file", new File([`private actual bytes ${index}`], `file-${index}.txt`, { type: "text/plain" }))
          body.append("groupId", group.id)
          const value = yield* requestInDirectory("/api/v1/im/attachments", directory, {
            method: "POST",
            headers: { authorization },
            body,
          }).pipe(Effect.flatMap(parse<Attachment>))
          const location = AttachmentStorage.deriveStoragePath({
            dataDir: Global.Path.data,
            workspaceID: group.workspaceID,
            attachmentID: value.id,
          })
          if (!location.ok) throw new Error("Expected private server-derived attachment")
          captured.push(location.storagePath)
          return value
        }),
      )
      const payload = {
        senderType: "user",
        type: "file",
        attachmentIDs: attachments.map((item) => item.id),
        clientRequestID: "private-four-file-message",
        content: "@agent actual caption",
      }
      const endpoint = `/api/v1/im/groups/${group.id}/messages`
      const first = yield* requestInDirectory(endpoint, directory, post(payload)).pipe(
        Effect.flatMap(parse<{ id: string; content: string; metadata: unknown }>),
      )
      expect(first.content).toBe(payload.content)
      expect(first.metadata).toEqual(
        attachments.map((item) => ({ type: "attachment_ref", attachmentID: item.id, batch: true })),
      )
      const db = (yield* Database.Service).db
      const before = yield* db.select().from(AttachmentTable)
      expect(before).toHaveLength(4)
      expect(before.every((row) => row.message_id === first.id)).toBe(true)
      expect(
        (yield* requestInDirectory(endpoint, directory, post(payload)).pipe(Effect.flatMap(parse<{ id: string }>))).id,
      ).toBe(first.id)
      for (const altered of [
        { ...payload, attachmentIDs: [...payload.attachmentIDs].reverse() },
        { ...payload, content: "changed caption" },
      ])
        expect((yield* requestInDirectory(endpoint, directory, post(altered))).status).toBe(409)
      for (const [index, item] of attachments.entries()) {
        const response = yield* requestInDirectory(`/api/v1/im/attachments/${item.id}/content`, directory, {
          headers: { authorization },
        })
        expect(response.status).toBe(200)
        const bytes = new Uint8Array(yield* response.arrayBuffer)
        expect(new TextDecoder().decode(bytes)).toBe(`private actual bytes ${index}`)
        expect(AttachmentStorage.sha256Hex(bytes)).toBe(item.checksum)
      }
      const counts = yield* db.get(
        sql`SELECT (SELECT count(*) FROM session_input) inputs,(SELECT count(*) FROM session_v2_provider_turn_receipt) providers`,
      )
      expect(counts).toEqual({ inputs: 0, providers: 0 })
      expect(yield* db.select().from(MessageTable)).toHaveLength(1)
      const status = yield* requestInDirectory("/api/v1/im/status", directory, { headers: { authorization } }).pipe(
        Effect.flatMap(parse<{ media: unknown }>),
      )
      expect(status.media).toEqual({
        version: 2,
        enabled: true,
        multipleAttachments: true,
        maxAttachments: 4,
        maxAttachmentBytes: 50 * 1024 * 1024,
        ttlMs: 86400000,
      })
      expect(yield* db.select().from(AttachmentTable)).toEqual(before)
      expect(
        yield* db.get(
          sql`SELECT (SELECT count(*) FROM session_input) inputs,(SELECT count(*) FROM session_v2_provider_turn_receipt) providers`,
        ),
      ).toEqual(counts)
    }),
  30_000,
)
