import { afterEach, beforeEach, describe, expect, mock, spyOn } from "bun:test"
import { Context, Effect, Layer, Schema } from "effect"
import { Flag } from "@deepagent-code/core/flag/flag"
import { SyncPaths, SyncReplayLimits } from "../../src/server/routes/instance/httpapi/groups/sync"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { Session } from "@/session/session"
import { MessageV2 } from "@/session/message-v2"
import { MessageID } from "@/session/schema"
import { ProviderV2 } from "@deepagent-code/core/provider"
import { ModelV2 } from "@deepagent-code/core/model"
import * as Log from "@deepagent-code/core/util/log"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"
import { SyncHistoryLimits } from "@/server/routes/instance/httpapi/handlers/sync"
import { Database } from "@deepagent-code/core/database/database"
import {
  EventSequenceTable,
  EventSnapshotChunkTable,
  EventSnapshotRowTable,
  EventSnapshotTable,
  EventSyncSequenceTable,
  EventTable,
} from "@deepagent-code/core/event/sql"
import { EventV2 } from "@deepagent-code/core/event"
import { eq, sql } from "drizzle-orm"
import { HttpServer } from "effect/unstable/http"
import { SessionV1 } from "@deepagent-code/core/v1/session"
import { SessionTable } from "@deepagent-code/core/session/sql"
import { encodeReplayRequestPrefix } from "@/sync/replay-protocol"
import { WorkspaceV2 } from "@deepagent-code/core/workspace"
import { FilePartArtifact } from "@deepagent-code/core/file-part-artifact"
import { Hash } from "@deepagent-code/core/util/hash"

void Log.init({ print: false })

const originalWorkspaces = Flag.DEEPAGENT_CODE_EXPERIMENTAL_WORKSPACES
const originalWorkspaceID = Flag.DEEPAGENT_CODE_WORKSPACE_ID
const syncWorkspaceID = WorkspaceV2.ID.make("wrk_sync_http_scope")
const context = Context.empty() as Context.Context<unknown>
const it = testEffect(Layer.mergeAll(Session.defaultLayer, Database.defaultLayer, httpApiLayer))

type HistoryItem = {
  readonly kind: "event" | "resync_required"
  readonly id?: string
  readonly aggregate_id: string
  readonly seq?: number
  readonly type?: string
  readonly data?: Record<string, unknown>
}

type HistoryResponse = {
  readonly version: 1
  readonly items: HistoryItem[]
  readonly nextCursor: string
  readonly complete: boolean
}

beforeEach(() => {
  Flag.DEEPAGENT_CODE_WORKSPACE_ID = syncWorkspaceID
})

afterEach(async () => {
  mock.restore()
  Flag.DEEPAGENT_CODE_EXPERIMENTAL_WORKSPACES = originalWorkspaces
  Flag.DEEPAGENT_CODE_WORKSPACE_ID = originalWorkspaceID
  await disposeAllInstances()
  await resetDatabase()
})

describe("sync HttpApi", () => {
  it.instance(
    "creates, exposes, and compacts a canonical checkpoint through bounded maintenance routes",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const headers = { "x-deepagent-code-directory": tmp.directory, "content-type": "application/json" }
        const session = yield* Session.use.create({ title: "maintenance checkpoint", workspaceID: syncWorkspaceID })
        const sibling = yield* Session.use.create({ title: "interleaved event", workspaceID: syncWorkspaceID })

        const prepared = yield* requestInDirectory(SyncPaths.checkpointPrepare, tmp.directory, {
          method: "POST",
          headers,
          body: JSON.stringify({ aggregateID: session.id }),
        })
        expect(prepared.status, yield* prepared.text).toBe(200)
        const attempt = Schema.decodeUnknownSync(
          Schema.Struct({ snapshotID: Schema.String, state: Schema.String, hasMore: Schema.Boolean }),
        )(yield* prepared.json)
        expect(attempt.state).toBe("prepared")

        let state = attempt.state
        while (state === "prepared") {
          const staged = yield* requestInDirectory(SyncPaths.checkpointStage, tmp.directory, {
            method: "POST",
            headers,
            body: JSON.stringify({ snapshotID: attempt.snapshotID, limit: 1 }),
          })
          expect(staged.status, yield* staged.text).toBe(200)
          state = String(((yield* staged.json) as Record<string, unknown>).state)
        }
        expect(state).toBe("staged")

        const finalized = yield* requestInDirectory(SyncPaths.checkpointFinalize, tmp.directory, {
          method: "POST",
          headers,
          body: JSON.stringify({ snapshotID: attempt.snapshotID }),
        })
        expect(finalized.status, yield* finalized.text).toBe(200)
        const snapshot = (yield* finalized.json) as unknown as EventV2.SerializedSnapshot

        const history = yield* requestInDirectory(SyncPaths.history, tmp.directory, {
          method: "POST",
          headers,
          body: JSON.stringify({ version: 1 }),
        })
        expect(history.status, yield* history.text).toBe(200)
        const firstPage = (yield* history.json) as {
          items: { kind: string; aggregate_id?: string; snapshot?: { snapshotID: string } }[]
          nextCursor: string
        }
        expect(firstPage.items).toEqual([
          expect.objectContaining({ kind: "event", aggregate_id: sibling.id }),
        ])

        const resync = yield* requestInDirectory(SyncPaths.history, tmp.directory, {
          method: "POST",
          headers,
          body: JSON.stringify({ version: 1, cursor: firstPage.nextCursor }),
        })
        expect(resync.status, yield* resync.text).toBe(200)
        const resyncPage = (yield* resync.json) as {
          items: { kind: string; snapshot?: { snapshotID: string } }[]
          nextCursor: string
        }
        expect(resyncPage.items).toEqual([
          { kind: "resync_required", snapshot: expect.objectContaining({ snapshotID: snapshot.snapshotID }) },
        ])

        const { db } = yield* Database.Service
        yield* db.update(SessionTable).set({ mutation_epoch: sql`${SessionTable.mutation_epoch} + 1` })
          .where(eq(SessionTable.id, session.id)).run().pipe(Effect.orDie)
        const replacementPrepared = yield* requestInDirectory(SyncPaths.checkpointPrepare, tmp.directory, {
          method: "POST",
          headers,
          body: JSON.stringify({ aggregateID: session.id }),
        })
        expect(replacementPrepared.status, yield* replacementPrepared.text).toBe(200)
        const replacementAttempt = Schema.decodeUnknownSync(
          Schema.Struct({ snapshotID: Schema.String, state: Schema.String, hasMore: Schema.Boolean }),
        )(yield* replacementPrepared.json)
        expect(replacementAttempt.snapshotID).not.toBe(snapshot.snapshotID)
        let replacementState = replacementAttempt.state
        while (replacementState === "prepared") {
          const staged = yield* requestInDirectory(SyncPaths.checkpointStage, tmp.directory, {
            method: "POST",
            headers,
            body: JSON.stringify({ snapshotID: replacementAttempt.snapshotID, limit: 1 }),
          })
          expect(staged.status, yield* staged.text).toBe(200)
          replacementState = String(((yield* staged.json) as Record<string, unknown>).state)
        }
        const replacementFinalized = yield* requestInDirectory(SyncPaths.checkpointFinalize, tmp.directory, {
          method: "POST",
          headers,
          body: JSON.stringify({ snapshotID: replacementAttempt.snapshotID }),
        })
        expect(replacementFinalized.status, yield* replacementFinalized.text).toBe(200)
        const later = yield* Session.use.create({ title: "event after replacement snapshot", workspaceID: syncWorkspaceID })

        const replacementHistory = yield* requestInDirectory(SyncPaths.history, tmp.directory, {
          method: "POST",
          headers,
          body: JSON.stringify({
            version: 1,
            cursor: resyncPage.nextCursor,
            known: { [session.id]: snapshot.throughSeq },
          }),
        })
        expect(replacementHistory.status, yield* replacementHistory.text).toBe(200)
        const replacementPage = (yield* replacementHistory.json) as {
          items: { kind: string; snapshot?: { snapshotID: string } }[]
          nextCursor: string
          complete: boolean
        }
        expect(replacementPage.items).toEqual([
          { kind: "resync_required", snapshot: expect.objectContaining({ snapshotID: replacementAttempt.snapshotID }) },
        ])
        expect(replacementPage.complete).toBe(false)
        const afterReplacement = yield* requestInDirectory(SyncPaths.history, tmp.directory, {
          method: "POST",
          headers,
          body: JSON.stringify({ version: 1, cursor: replacementPage.nextCursor }),
        })
        expect(afterReplacement.status, yield* afterReplacement.text).toBe(200)
        expect(((yield* afterReplacement.json) as HistoryResponse).items).toEqual([
          expect.objectContaining({ kind: "event", aggregate_id: later.id }),
        ])

        let compacted = false
        while (!compacted) {
          const response = yield* requestInDirectory(SyncPaths.checkpointCompact, tmp.directory, {
            method: "POST",
            headers,
            body: JSON.stringify({ aggregateID: session.id, limit: 1 }),
          })
          expect(response.status, yield* response.text).toBe(200)
          compacted = Boolean(((yield* response.json) as { complete: boolean }).complete)
        }
        expect(
          yield* db
            .select({ count: sql<number>`count(*)` })
            .from(EventTable)
            .where(eq(EventTable.aggregate_id, session.id))
            .get()
            .pipe(Effect.orDie, Effect.map((row) => row?.count)),
        ).toBe(0)
      }),
    { git: true, config: { formatter: false, lsp: false } },
    30_000,
  )

  it.instance(
    "returns a scoped bounded snapshot before retained event history",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const headers = { "x-deepagent-code-directory": tmp.directory, "content-type": "application/json" }
        const session = yield* Session.use.create({ title: "snapshot resync", workspaceID: syncWorkspaceID })
        const { db } = yield* Database.Service
        const sequence = yield* db
          .select({ seq: EventSequenceTable.seq })
          .from(EventSequenceTable)
          .where(eq(EventSequenceTable.aggregate_id, session.id))
          .get()
          .pipe(Effect.orDie)
        const sync = yield* db
          .update(EventSyncSequenceTable)
          .set({ seq: sql`${EventSyncSequenceTable.seq} + 1` })
          .where(eq(EventSyncSequenceTable.id, 1))
          .returning({ seq: EventSyncSequenceTable.seq })
          .get()
          .pipe(Effect.orDie)
        const snapshot = {
          snapshotID: "snapshot_sync_http",
          aggregateID: session.id,
          throughSeq: sequence!.seq,
          syncSeq: sync!.seq,
          codec: "session-projection",
          schemaVersion: 1,
          snapshotHash: "1".repeat(64),
          body: { format: "chunked-rows.v1" },
          ownerID: syncWorkspaceID,
          createdAt: 1,
        }
        const rowHash = Hash.sha256("{}")
        yield* db
          .insert(EventSnapshotTable)
          .values({
            snapshot_id: snapshot.snapshotID,
            aggregate_id: snapshot.aggregateID,
            through_seq: snapshot.throughSeq,
            sync_seq: snapshot.syncSeq,
            codec: snapshot.codec,
            schema_version: snapshot.schemaVersion,
            snapshot_hash: snapshot.snapshotHash,
            body: snapshot.body,
            owner_id: snapshot.ownerID,
            created_at: snapshot.createdAt,
          })
          .run()
          .pipe(Effect.orDie)
        yield* db
          .insert(EventSnapshotRowTable)
          .values({ snapshot_id: snapshot.snapshotID, aggregate_id: snapshot.aggregateID, row_index: 0, table_name: "session", row_key: session.id, row_hash: rowHash, row_bytes: 2, chunk_count: 1, chain_hash: "2".repeat(64) })
          .run()
          .pipe(Effect.orDie)
        yield* db
          .insert(EventSnapshotChunkTable)
          .values({ row_hash: rowHash, chunk_index: 0, data: Buffer.from("{}"), chunk_hash: rowHash })
          .run()
          .pipe(Effect.orDie)
        yield* db
          .update(EventSequenceTable)
          .set({ snapshot_id: snapshot.snapshotID, retention_floor_seq: snapshot.throughSeq })
          .where(eq(EventSequenceTable.aggregate_id, session.id))
          .run()
          .pipe(Effect.orDie)
        const history = yield* requestInDirectory(SyncPaths.history, tmp.directory, {
          method: "POST",
          headers,
          body: JSON.stringify({ version: 1 }),
        })
        expect(history.status, yield* history.text).toBe(200)
        const envelope = (yield* history.json) as { items: { kind: string; snapshot: EventV2.SerializedSnapshot }[] }
        expect(envelope.items).toHaveLength(1)
        expect(envelope.items[0]).toMatchObject({ kind: "resync_required", snapshot: { snapshotID: snapshot.snapshotID } })

        const rows = yield* requestInDirectory(SyncPaths.snapshotRows, tmp.directory, {
          method: "POST",
          headers,
          body: JSON.stringify({
            aggregateID: session.id,
            snapshotID: snapshot.snapshotID,
            snapshotHash: snapshot.snapshotHash,
            limit: 1,
          }),
        })
        expect(rows.status, yield* rows.text).toBe(200)
        const page = Schema.decodeUnknownSync(
          Schema.Struct({ rows: Schema.Array(Schema.Struct({ rowHash: Schema.String })), complete: Schema.Boolean }),
        )(yield* rows.json)
        expect(page.rows).toHaveLength(1)
        const chunks = yield* requestInDirectory(SyncPaths.snapshotChunks, tmp.directory, {
          method: "POST",
          headers,
          body: JSON.stringify({
            aggregateID: session.id,
            snapshotID: snapshot.snapshotID,
            snapshotHash: snapshot.snapshotHash,
            rowHash: page.rows[0]!.rowHash,
            limit: 1,
          }),
        })
        expect(chunks.status, yield* chunks.text).toBe(200)
        const wrongScope = yield* requestInDirectory(SyncPaths.snapshotChunks, tmp.directory, {
          method: "POST",
          headers,
          body: JSON.stringify({
            aggregateID: session.id,
            snapshotID: snapshot.snapshotID,
            snapshotHash: "0".repeat(64),
            rowHash: page.rows[0]!.rowHash,
            limit: 1,
          }),
        })
        expect(wrongScope.status).toBe(404)
      }),
    { git: true, config: { formatter: false, lsp: false } },
    20_000,
  )

  it.instance(
    "serves file artifacts only through the exact workspace event binding",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const headers = { "x-deepagent-code-directory": tmp.directory, "content-type": "application/json" }
        const session = yield* Session.use.create({ title: "file artifact", workspaceID: syncWorkspaceID })
        const messageID = MessageID.ascending()
        yield* Session.use.updateMessage({
          id: messageID,
          sessionID: session.id,
          role: "user",
          time: { created: Date.now() },
          agent: "build",
          model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("model") },
        })
        yield* Session.use.updatePart({
          id: SessionV1.PartID.ascending(),
          sessionID: session.id,
          messageID,
          type: "file",
          mime: "application/octet-stream",
          url: `data:application/octet-stream;base64,${Buffer.alloc(FilePartArtifact.CHUNK_BYTES + 7, 0x63).toString("base64")}`,
        })
        const { db } = yield* Database.Service
        const event = yield* db
          .select()
          .from(EventTable)
          .where(eq(EventTable.aggregate_id, session.id))
          .all()
          .pipe(Effect.orDie, Effect.map((rows) => rows.find((row) => row.type === "message.part.updated.1")))
        expect(event).toBeDefined()
        if (!event) return
        const descriptor = FilePartArtifact.descriptor(event.data)
        expect(descriptor).toBeDefined()
        if (!descriptor) return
        const scope = { eventID: event.id, aggregateID: session.id, seq: event.seq, artifactID: descriptor.id }
        const metadataResponse = yield* requestInDirectory(SyncPaths.fileArtifactMetadata, tmp.directory, {
          method: "POST",
          headers,
          body: JSON.stringify(scope),
        })
        expect(metadataResponse.status).toBe(200)
        const metadata = Schema.decodeUnknownSync(FilePartArtifact.Metadata)(yield* metadataResponse.json)
        expect(metadata.chunkHashes).toHaveLength(2)
        const chunkResponse = yield* requestInDirectory(SyncPaths.fileArtifactChunk, tmp.directory, {
          method: "POST",
          headers,
          body: JSON.stringify({ ...scope, index: 0, hash: metadata.chunkHashes[0] }),
        })
        expect(chunkResponse.status).toBe(200)
        const chunk = Schema.decodeUnknownSync(Schema.Struct({ data: Schema.String }))(yield* chunkResponse.json)
        expect(chunk.data).toHaveLength(4 * Math.ceil(FilePartArtifact.CHUNK_BYTES / 3))

        const wrongEvent = yield* requestInDirectory(SyncPaths.fileArtifactChunk, tmp.directory, {
          method: "POST",
          headers,
          body: JSON.stringify({ ...scope, eventID: EventV2.ID.create(), index: 0, hash: metadata.chunkHashes[0] }),
        })
        expect(wrongEvent.status).toBe(404)
        const wrongSequence = yield* requestInDirectory(SyncPaths.fileArtifactChunk, tmp.directory, {
          method: "POST",
          headers,
          body: JSON.stringify({ ...scope, seq: event.seq + 1, index: 0, hash: metadata.chunkHashes[0] }),
        })
        expect(wrongSequence.status).toBe(404)
        const wrongHash = yield* requestInDirectory(SyncPaths.fileArtifactChunk, tmp.directory, {
          method: "POST",
          headers,
          body: JSON.stringify({ ...scope, index: 0, hash: "0".repeat(64) }),
        })
        expect(wrongHash.status).toBe(404)

        Flag.DEEPAGENT_CODE_WORKSPACE_ID = WorkspaceV2.ID.make("wrk_other_scope")
        const crossed = yield* requestInDirectory(SyncPaths.fileArtifactMetadata, tmp.directory, {
          method: "POST",
          headers,
          body: JSON.stringify(scope),
        })
        expect(crossed.status).toBe(404)
      }),
    { git: true, config: { formatter: false, lsp: false } },
    30_000,
  )

  it.instance(
    "fails closed when history has no routed workspace scope",
    () =>
      Effect.gen(function* () {
        Flag.DEEPAGENT_CODE_WORKSPACE_ID = undefined
        const tmp = yield* TestInstance
        const response = yield* requestInDirectory(SyncPaths.history, tmp.directory, {
          method: "POST",
          headers: { "x-deepagent-code-directory": tmp.directory, "content-type": "application/json" },
          body: JSON.stringify({ version: 1 }),
        })
        expect(response.status).toBe(400)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "rejects fresh replay without workspace scope before writing durable state",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const session = yield* Session.use.create({ title: "unscoped replay", workspaceID: syncWorkspaceID })
        const { db } = yield* Database.Service
        const created = yield* db
          .select()
          .from(EventTable)
          .where(eq(EventTable.aggregate_id, session.id))
          .get()
          .pipe(Effect.orDie)
        yield* db.delete(EventSequenceTable).where(eq(EventSequenceTable.aggregate_id, session.id)).run().pipe(Effect.orDie)
        yield* db.delete(SessionTable).where(eq(SessionTable.id, session.id)).run().pipe(Effect.orDie)
        Flag.DEEPAGENT_CODE_WORKSPACE_ID = undefined
        const response = yield* requestInDirectory(SyncPaths.replay, tmp.directory, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            directory: tmp.directory,
            events: [
              {
                id: created!.id,
                aggregateID: session.id,
                seq: 0,
                type: created!.type,
                data: created!.data,
              },
            ],
          }),
        })

        expect(response.status).toBe(400)
        expect(yield* db.select().from(SessionTable).where(eq(SessionTable.id, session.id)).get()).toBeUndefined()
        expect(
          yield* db.select().from(EventSequenceTable).where(eq(EventSequenceTable.aggregate_id, session.id)).get(),
        ).toBeUndefined()
        expect(yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, session.id)).all()).toEqual([])
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )
  it.instance(
    "serves sync routes",
    () =>
      Effect.gen(function* () {
        Flag.DEEPAGENT_CODE_EXPERIMENTAL_WORKSPACES = true
        const tmp = yield* TestInstance
        const headers = { "x-deepagent-code-directory": tmp.directory, "content-type": "application/json" }
        const info = spyOn(Log.create({ service: "server.sync" }), "info")
        const session = yield* Session.use.create({ title: "sync", workspaceID: syncWorkspaceID })
        yield* Session.use.setTitle({ sessionID: session.id, title: "sync-updated" })

        const started = yield* requestInDirectory(SyncPaths.start, tmp.directory, { method: "POST", headers })
        expect(started.status).toBe(200)
        expect(yield* started.json).toBe(true)

        const history = yield* requestInDirectory(SyncPaths.history, tmp.directory, {
          method: "POST",
          headers,
          body: JSON.stringify({}),
        })
        expect(history.status).toBe(200)
        const historyBody = (yield* history.json) as HistoryResponse
        expect(historyBody.version).toBe(1)
        expect(historyBody.nextCursor).toBeTruthy()
        expect(historyBody.items.map((row) => row.aggregate_id)).toContain(session.id)

        const { db } = yield* Database.Service
        yield* db.delete(EventSequenceTable).where(eq(EventSequenceTable.aggregate_id, session.id)).run().pipe(Effect.orDie)
        yield* db.delete(SessionTable).where(eq(SessionTable.id, session.id)).run().pipe(Effect.orDie)

        const replayed = yield* requestInDirectory(SyncPaths.replay, tmp.directory, {
          method: "POST",
          headers,
          body: JSON.stringify({
            directory: tmp.directory,
            events: historyBody.items
              .filter((row) => row.kind === "event")
              .filter((row) => row.aggregate_id === session.id)
              .map((row) => ({
                id: row.id!,
                aggregateID: row.aggregate_id,
                seq: row.seq!,
                type: row.type!,
                data: row.data!,
              })),
          }),
        })
        const replayBody = yield* replayed.text
        expect(replayed.status, replayBody).toBe(200)
        expect(JSON.parse(replayBody)).toEqual({ sessionID: session.id })
        expect((yield* Session.use.get(session.id)).title).toBe("sync-updated")
        expect(info.mock.calls.some(([message]) => message === "sync replay requested")).toBe(true)
        expect(info.mock.calls.some(([message]) => message === "sync replay complete")).toBe(true)

        const tampered = `${historyBody.nextCursor.slice(0, -1)}${historyBody.nextCursor.endsWith("a") ? "b" : "a"}`
        const invalid = yield* requestInDirectory(SyncPaths.history, tmp.directory, {
          method: "POST",
          headers,
          body: JSON.stringify({ version: 1, cursor: tampered }),
        })
        expect(invalid.status).toBe(409)

        Flag.DEEPAGENT_CODE_WORKSPACE_ID = "wrk_sync_other_scope"
        const crossed = yield* requestInDirectory(SyncPaths.history, tmp.directory, {
          method: "POST",
          headers,
          body: JSON.stringify({ version: 1, cursor: historyBody.nextCursor }),
        })
        expect(crossed.status).toBe(409)
        Flag.DEEPAGENT_CODE_WORKSPACE_ID = syncWorkspaceID
      }),
    { git: true, config: { formatter: false, lsp: false } },
    15_000,
  )

  it.instance(
    "advances an empty workspace cursor to high-water and returns only later scoped events",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const headers = { "x-deepagent-code-directory": tmp.directory, "content-type": "application/json" }
        yield* Session.use.create({ title: "unrelated-local" })
        const first = yield* requestInDirectory(SyncPaths.history, tmp.directory, {
          method: "POST",
          headers,
          body: JSON.stringify({ version: 1 }),
        })
        const firstBody = (yield* first.json) as HistoryResponse
        expect(firstBody.items).toEqual([])
        expect(firstBody.complete).toBe(true)

        const scoped = yield* Session.use.create({ title: "later-scoped", workspaceID: syncWorkspaceID })
        const second = yield* requestInDirectory(SyncPaths.history, tmp.directory, {
          method: "POST",
          headers,
          body: JSON.stringify({ version: 1, cursor: firstBody.nextCursor }),
        })
        const secondBody = (yield* second.json) as HistoryResponse
        expect(secondBody.items.map((item) => item.aggregate_id)).toEqual([scoped.id])
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "rejects oversized known maps in legacy and versioned history payloads",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const headers = { "x-deepagent-code-directory": tmp.directory, "content-type": "application/json" }
        const known = Object.fromEntries(
          Array.from({ length: SyncHistoryLimits.legacyKnownAggregates + 1 }, (_, index) => [`ses_known_${index}`, 0]),
        )
        const legacy = yield* requestInDirectory(SyncPaths.history, tmp.directory, {
          method: "POST",
          headers,
          body: JSON.stringify(known),
        })
        const versioned = yield* requestInDirectory(SyncPaths.history, tmp.directory, {
          method: "POST",
          headers,
          body: JSON.stringify({ version: 1, known }),
        })

        expect(legacy.status).toBe(400)
        expect(versioned.status).toBe(400)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "rejects Session identity and placement replay without committing partial state",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const headers = { "x-deepagent-code-directory": tmp.directory, "content-type": "application/json" }
        const session = yield* Session.use.create({ title: "sync-placement-guard", workspaceID: syncWorkspaceID })
        const { db } = yield* Database.Service
        const beforeSession = yield* db
          .select()
          .from(SessionTable)
          .where(eq(SessionTable.id, session.id))
          .get()
          .pipe(Effect.orDie)
        const beforeSequence = yield* db
          .select()
          .from(EventSequenceTable)
          .where(eq(EventSequenceTable.aggregate_id, session.id))
          .get()
          .pipe(Effect.orDie)
        const beforeEvents = yield* db
          .select()
          .from(EventTable)
          .where(eq(EventTable.aggregate_id, session.id))
          .all()
          .pipe(Effect.orDie)
        const created = beforeEvents.find(
          (event) => event.type === EventV2.versionedType(SessionV1.Event.Created.type, 1),
        )
        expect(created).toBeDefined()
        expect(beforeSession).toBeDefined()
        expect(beforeSequence).toBeDefined()
        const data = created!.data as { sessionID: string; info: Record<string, unknown> }

        const response = yield* requestInDirectory(SyncPaths.replay, tmp.directory, {
          method: "POST",
          headers,
          body: JSON.stringify({
            directory: tmp.directory,
            events: [
              {
                id: EventV2.ID.make("evt_http_replay_project_change"),
                aggregateID: session.id,
                seq: beforeSequence!.seq + 1,
                type: EventV2.versionedType(SessionV1.Event.Updated.type, 1),
                data: { ...data, info: { ...data.info, projectID: "project_replay_other" } },
              },
            ],
          }),
        })

        expect(response.status, yield* response.text).toBe(409)
        expect(
          yield* db.select().from(SessionTable).where(eq(SessionTable.id, session.id)).get().pipe(Effect.orDie),
        ).toEqual(beforeSession)
        expect(
          yield* db
            .select()
            .from(EventSequenceTable)
            .where(eq(EventSequenceTable.aggregate_id, session.id))
            .get()
            .pipe(Effect.orDie),
        ).toEqual(beforeSequence)
        expect(
          yield* db
            .select()
            .from(EventTable)
            .where(eq(EventTable.aggregate_id, session.id))
            .all()
            .pipe(Effect.orDie),
        ).toEqual(beforeEvents)
      }),
    { git: true, config: { formatter: false, lsp: false } },
    15_000,
  )

  it.instance(
    "rejects fresh replay placement that is self-consistent but outside the routed instance",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const headers = { "x-deepagent-code-directory": tmp.directory, "content-type": "application/json" }
        const session = yield* Session.use.create({ title: "routed replay authority", workspaceID: syncWorkspaceID })
        const { db } = yield* Database.Service
        const created = yield* db
          .select()
          .from(EventTable)
          .where(eq(EventTable.aggregate_id, session.id))
          .get()
          .pipe(Effect.orDie)
        const otherDirectory = `${tmp.directory}-other`
        const otherProjectID = session.projectID
        yield* db.delete(EventSequenceTable).where(eq(EventSequenceTable.aggregate_id, session.id)).run().pipe(Effect.orDie)
        yield* db.delete(SessionTable).where(eq(SessionTable.id, session.id)).run().pipe(Effect.orDie)
        const data = created!.data as { sessionID: string; info: Record<string, unknown> }
        const response = yield* requestInDirectory(SyncPaths.replay, tmp.directory, {
          method: "POST",
          headers,
          body: JSON.stringify({
            directory: otherDirectory,
            events: [
              {
                id: created!.id,
                aggregateID: session.id,
                seq: 0,
                type: created!.type,
                data: {
                  ...data,
                  info: { ...data.info, projectID: otherProjectID, directory: otherDirectory },
                },
              },
            ],
          }),
        })

        expect(response.status).toBe(409)
        expect(yield* db.select().from(SessionTable).where(eq(SessionTable.id, session.id)).get()).toBeUndefined()
        expect(
          yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, session.id)).all(),
        ).toEqual([])
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "bounds legacy message.updated rows in sync history",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const headers = { "x-deepagent-code-directory": tmp.directory, "content-type": "application/json" }
        const session = yield* Session.use.create({ title: "sync-legacy-diff", workspaceID: syncWorkspaceID })
        yield* Session.use.updateMessage({
          id: MessageID.ascending(),
          sessionID: session.id,
          role: "user",
          time: { created: Date.now() },
          agent: "build",
          model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("model") },
          summary: {
            diffs: Array.from({ length: MessageV2.ClientDiffLimits.files + 5 }, (_, index) => ({
              file: `legacy-${index}.ts`,
              patch: "x",
              additions: 1,
              deletions: 0,
              status: "modified" as const,
            })),
          },
        })

        const response = yield* requestInDirectory(SyncPaths.history, tmp.directory, {
          method: "POST",
          headers,
          body: JSON.stringify({}),
        })
        const body = (yield* response.json) as HistoryResponse
        const event = body.items.find((row) => row.kind === "event" && row.type === "message.updated.1")
        const info = event?.data?.info as { summary?: { diffs?: Array<{ patch?: string }> } } | undefined
        expect(info?.summary?.diffs).toHaveLength(MessageV2.ClientDiffLimits.files)
        expect(info?.summary?.diffs?.every((item) => item.patch === undefined)).toBe(true)
      }),
    { git: true, config: { formatter: false, lsp: false } },
    15_000,
  )

  it.instance(
    "pages bounded sync history until the aggregate cursor catches up",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const headers = { "x-deepagent-code-directory": tmp.directory, "content-type": "application/json" }
        const session = yield* Session.use.create({ title: "sync-pages", workspaceID: syncWorkspaceID })
        const extra = SyncHistoryLimits.events + 5
        yield* Effect.forEach(
          Array.from({ length: extra }, (_, index) => index),
          (index) =>
            Session.use.updateMessage({
              id: MessageID.ascending(),
              sessionID: session.id,
              role: "user",
              time: { created: Date.now() + index },
              agent: "build",
              model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("model") },
            }),
          { discard: true },
        )

        const first = yield* requestInDirectory(SyncPaths.history, tmp.directory, {
          method: "POST",
          headers,
          body: JSON.stringify({}),
        })
        const firstBody = (yield* first.json) as HistoryResponse
        const firstRows = firstBody.items.filter((row): row is HistoryItem & { id: string; seq: number } => row.kind === "event")
        expect(firstRows).toHaveLength(SyncHistoryLimits.events)
        expect(firstBody.complete).toBe(false)
        const state = Object.fromEntries(firstRows.map((row) => [row.aggregate_id, row.seq]))
        const second = yield* requestInDirectory(SyncPaths.history, tmp.directory, {
          method: "POST",
          headers,
          body: JSON.stringify(state),
        })
        const secondBody = (yield* second.json) as HistoryResponse
        const secondRows = secondBody.items.filter((row): row is HistoryItem & { id: string; seq: number } => row.kind === "event")
        expect(secondRows.length).toBeGreaterThan(0)
        expect(secondRows.length).toBeLessThanOrEqual(SyncHistoryLimits.events)
        expect(new Set([...firstRows, ...secondRows].map((row) => row.id)).size).toBe(
          firstRows.length + secondRows.length,
        )
        secondRows.forEach((row) => (state[row.aggregate_id] = row.seq))
        const done = yield* requestInDirectory(SyncPaths.history, tmp.directory, {
          method: "POST",
          headers,
          body: JSON.stringify(state),
        })
        const doneBody = (yield* done.json) as HistoryResponse
        expect(doneBody.items).toEqual([])
        expect(doneBody.complete).toBe(true)
      }),
    { git: true, config: { formatter: false, lsp: false } },
    15_000,
  )

  it.instance(
    "fails closed before decoding an oversized legacy sync event",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const headers = { "x-deepagent-code-directory": tmp.directory, "content-type": "application/json" }
        const session = yield* Session.use.create({ title: "sync-legacy-oversized", workspaceID: syncWorkspaceID })
        const { db } = yield* Database.Service
        const sequence = yield* db
          .select({ seq: EventSequenceTable.seq })
          .from(EventSequenceTable)
          .where(eq(EventSequenceTable.aggregate_id, session.id))
          .get()
          .pipe(Effect.orDie)
        const sync = yield* db
          .update(EventSyncSequenceTable)
          .set({ seq: sql`${EventSyncSequenceTable.seq} + 1` })
          .where(eq(EventSyncSequenceTable.id, 1))
          .returning({ seq: EventSyncSequenceTable.seq })
          .get()
          .pipe(Effect.orDie)
        yield* db
          .insert(EventTable)
          .values({
            id: EventV2.ID.make("evt_sync_legacy_oversized"),
            aggregate_id: session.id,
            seq: sequence!.seq + 1,
            type: "sync.legacy.1",
            data: { value: "x".repeat(SyncHistoryLimits.dataBytes + 1) },
            sync_seq: sync!.seq,
          })
          .run()
          .pipe(Effect.orDie)

        const response = yield* requestInDirectory(SyncPaths.history, tmp.directory, {
          method: "POST",
          headers,
          body: JSON.stringify({ [session.id]: sequence!.seq }),
        })
        const body = yield* response.text
        expect(response.status, body).toBe(503)
        expect(body).toContain("requires artifact migration")
      }),
    { git: true, config: { formatter: false, lsp: false } },
    15_000,
  )

  it.instance(
    "returns a contiguous prefix before an oversized legacy sync event",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const headers = { "x-deepagent-code-directory": tmp.directory, "content-type": "application/json" }
        const session = yield* Session.use.create({ title: "sync-prefix", workspaceID: syncWorkspaceID })
        const { db } = yield* Database.Service
        const sequence = yield* db
          .select({ seq: EventSequenceTable.seq })
          .from(EventSequenceTable)
          .where(eq(EventSequenceTable.aggregate_id, session.id))
          .get()
          .pipe(Effect.orDie)
        const sync = yield* db
          .update(EventSyncSequenceTable)
          .set({ seq: sql`${EventSyncSequenceTable.seq} + 1` })
          .where(eq(EventSyncSequenceTable.id, 1))
          .returning({ seq: EventSyncSequenceTable.seq })
          .get()
          .pipe(Effect.orDie)
        yield* db
          .insert(EventTable)
          .values({
            id: EventV2.ID.make("evt_sync_legacy_oversized_after_prefix"),
            aggregate_id: session.id,
            seq: sequence!.seq + 1,
            type: "sync.legacy.1",
            data: { value: "x".repeat(SyncHistoryLimits.dataBytes + 1) },
            sync_seq: sync!.seq,
          })
          .run()
          .pipe(Effect.orDie)

        const first = yield* requestInDirectory(SyncPaths.history, tmp.directory, {
          method: "POST",
          headers,
          body: JSON.stringify({}),
        })
        const firstBody = (yield* first.json) as HistoryResponse
        const rows = firstBody.items.filter((row): row is HistoryItem & { seq: number } => row.kind === "event")
        expect(first.status).toBe(200)
        expect(rows).toHaveLength(1)
        expect(rows[0]?.aggregate_id).toBe(session.id)

        const blocked = yield* requestInDirectory(SyncPaths.history, tmp.directory, {
          method: "POST",
          headers,
          body: JSON.stringify({ [session.id]: rows[0]!.seq }),
        })
        const body = yield* blocked.text
        expect(blocked.status, body).toBe(503)
        expect(body).toContain("requires artifact migration")
      }),
    { git: true, config: { formatter: false, lsp: false } },
    15_000,
  )

  it.instance(
    "carries a maximum data-budget UTF-8 event inside the larger wire envelope",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const headers = { "x-deepagent-code-directory": tmp.directory, "content-type": "application/json" }
        const session = yield* Session.use.create({ title: "sync-wire-prefix", workspaceID: syncWorkspaceID })
        const { db } = yield* Database.Service
        const sequence = yield* db
          .select({ seq: EventSequenceTable.seq })
          .from(EventSequenceTable)
          .where(eq(EventSequenceTable.aggregate_id, session.id))
          .get()
          .pipe(Effect.orDie)
        expect(sequence).toBeDefined()
        const target = SyncHistoryLimits.dataBytes - 100
        const overhead = Buffer.byteLength(JSON.stringify({ value: "" }))
        const available = target - overhead
        const unicode = "界".repeat(Math.floor(available / 3)) + "x".repeat(available % 3)
        const middle = { value: unicode }
        expect(Buffer.byteLength(JSON.stringify(middle))).toBe(target)
        const sync = yield* db
          .update(EventSyncSequenceTable)
          .set({ seq: sql`${EventSyncSequenceTable.seq} + 3` })
          .where(eq(EventSyncSequenceTable.id, 1))
          .returning({ seq: EventSyncSequenceTable.seq })
          .get()
          .pipe(Effect.orDie)
        yield* db
          .insert(EventTable)
          .values([
            {
              id: EventV2.ID.make("evt_sync_wire_small_before"),
              aggregate_id: session.id,
              seq: sequence!.seq + 1,
              type: "sync.test.1",
              data: { value: "before" },
              sync_seq: sync!.seq - 2,
            },
            {
              id: EventV2.ID.make("evt_sync_wire_middle"),
              aggregate_id: session.id,
              seq: sequence!.seq + 2,
              type: "sync.test.1",
              data: middle,
              sync_seq: sync!.seq - 1,
            },
            {
              id: EventV2.ID.make("evt_sync_wire_small_after"),
              aggregate_id: session.id,
              seq: sequence!.seq + 3,
              type: "sync.test.1",
              data: { value: "after" },
              sync_seq: sync!.seq,
            },
          ])
          .run()
          .pipe(Effect.orDie)
        yield* db
          .update(EventSequenceTable)
          .set({ seq: sequence!.seq + 3 })
          .where(eq(EventSequenceTable.aggregate_id, session.id))
          .run()
          .pipe(Effect.orDie)

        const first = yield* requestInDirectory(SyncPaths.history, tmp.directory, {
          method: "POST",
          headers,
          body: JSON.stringify({ [session.id]: sequence!.seq }),
        })
        const firstBody = (yield* first.json) as HistoryResponse
        const rows = firstBody.items.filter((row): row is HistoryItem & { id: string; seq: number } => row.kind === "event")
        expect(first.status).toBe(200)
        expect(rows.map((row) => row.id)).toEqual([
          "evt_sync_wire_small_before",
          "evt_sync_wire_middle",
          "evt_sync_wire_small_after",
        ])
        expect(Buffer.byteLength(JSON.stringify(firstBody))).toBeLessThanOrEqual(SyncHistoryLimits.wireBytes)
      }),
    { git: true, config: { formatter: false, lsp: false } },
    20_000,
  )

  it.instance(
    "rejects replay batches above the event and byte budgets before replay",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const headers = { "x-deepagent-code-directory": tmp.directory, "content-type": "application/json" }
        const event = (index: number, data: Record<string, unknown> = {}) => ({
          id: EventV2.ID.make(`evt_sync_replay_limit_${index}`),
          aggregateID: "aggregate-sync-replay-limit",
          seq: index,
          type: "sync.replay.limit.1",
          data,
        })

        const tooMany = yield* requestInDirectory(SyncPaths.replay, tmp.directory, {
          method: "POST",
          headers,
          body: JSON.stringify({
            directory: tmp.directory,
            events: Array.from({ length: SyncReplayLimits.events + 1 }, (_, index) => event(index)),
          }),
        })
        expect(tooMany.status).toBe(400)

        const before = yield* Database.Service.use(({ db }) =>
          db.select().from(EventTable).where(eq(EventTable.aggregate_id, "aggregate-sync-replay-limit")).all(),
        )
        const semanticOversized = yield* requestInDirectory(SyncPaths.replay, tmp.directory, {
          method: "POST",
          headers,
          body: JSON.stringify({
            directory: tmp.directory,
            events: [event(0, { value: "x".repeat(SyncReplayLimits.eventDataBytes) })],
          }),
        })
        expect(semanticOversized.status).toBe(400)

        const rawOversized = yield* requestInDirectory(SyncPaths.replay, tmp.directory, {
          method: "POST",
          headers,
          body: JSON.stringify({
            directory: tmp.directory,
            events: [event(0, { value: "x".repeat(SyncReplayLimits.requestBytes) })],
          }),
        })
        expect(rawOversized.status).toBe(413)
        expect(
          yield* Database.Service.use(({ db }) =>
            db.select().from(EventTable).where(eq(EventTable.aggregate_id, "aggregate-sync-replay-limit")).all(),
          ),
        ).toEqual(before)
      }),
    { git: true, config: { formatter: false, lsp: false } },
    15_000,
  )

  it.instance(
    "replays a maximum admitted event through Web and the real Node listener",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const session = yield* Session.use.create({ title: "sync-max-replay", workspaceID: syncWorkspaceID })
        const event = (aggregateID: string, id: EventV2.ID, seq: number) => {
          const base = {
            sessionID: aggregateID,
            info: {
              id: MessageID.ascending(),
              sessionID: aggregateID,
              role: "user" as const,
              time: { created: Date.now() },
              agent: "build",
              model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("model") },
              system: "",
            },
          }
          const remaining = EventV2.MAX_ENCODED_PAYLOAD_BYTES - Buffer.byteLength(JSON.stringify(base))
          const data = { ...base, info: { ...base.info, system: "x".repeat(remaining) } }
          expect(Buffer.byteLength(JSON.stringify(data))).toBe(EventV2.MAX_ENCODED_PAYLOAD_BYTES)
          return {
            id,
            aggregateID,
            seq,
            type: EventV2.versionedType(SessionV1.Event.MessageUpdated.type, 1),
            data,
          }
        }
        const { db } = yield* Database.Service
        const webSequence = yield* db
          .select({ seq: EventSequenceTable.seq })
          .from(EventSequenceTable)
          .where(eq(EventSequenceTable.aggregate_id, session.id))
          .get()
          .pipe(Effect.orDie)
        const webEvent = event(session.id, EventV2.ID.make("evt_sync_max_web"), webSequence!.seq + 1)
        const webBody = encodeReplayRequestPrefix(tmp.directory, [webEvent])
        expect(webBody.complete).toBe(true)
        expect(webBody.dataBytes).toBe(SyncReplayLimits.eventDataBytes)
        expect(webBody.requestBytes).toBeGreaterThan(SyncReplayLimits.eventDataBytes)
        expect(webBody.requestBytes).toBeLessThanOrEqual(SyncReplayLimits.requestBytes)
        const web = yield* requestInDirectory(SyncPaths.replay, tmp.directory, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: webBody.json,
        })
        expect(web.status, yield* web.text).toBe(200)

        const nodeSession = yield* Session.use.create({ title: "sync-max-node", workspaceID: syncWorkspaceID })
        const nodeSequence = yield* db
          .select({ seq: EventSequenceTable.seq })
          .from(EventSequenceTable)
          .where(eq(EventSequenceTable.aggregate_id, nodeSession.id))
          .get()
          .pipe(Effect.orDie)
        const nodeEvent = event(nodeSession.id, EventV2.ID.make("evt_sync_max_node"), nodeSequence!.seq + 1)
        const nodeBody = encodeReplayRequestPrefix(tmp.directory, [nodeEvent])
        const server = yield* HttpServer.HttpServer
        const node = yield* Effect.promise(() =>
          fetch(`${HttpServer.formatAddress(server.address)}${SyncPaths.replay}`, {
            method: "POST",
            headers: {
              "x-deepagent-code-directory": tmp.directory,
              "content-type": "application/json",
            },
            body: nodeBody.json,
          }),
        )
        expect(node.status, yield* Effect.promise(() => node.text())).toBe(200)
      }),
    { git: true, config: { formatter: false, lsp: false } },
    30_000,
  )

  it.instance(
    "publishes a maximum admitted event through paged history into a fresh projection",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const headers = { "x-deepagent-code-directory": tmp.directory, "content-type": "application/json" }
        const session = yield* Session.use.create({ title: "sync-max-history", workspaceID: syncWorkspaceID })
        const messageID = MessageID.ascending()
        const base = {
          sessionID: session.id,
          info: {
            id: messageID,
            sessionID: session.id,
            role: "user" as const,
            time: { created: Date.now() },
            agent: "build",
            model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("model") },
            system: "",
          },
        }
        const remaining = EventV2.MAX_ENCODED_PAYLOAD_BYTES - Buffer.byteLength(JSON.stringify(base))
        const message = { ...base.info, system: "x".repeat(remaining) }
        expect(Buffer.byteLength(JSON.stringify({ sessionID: session.id, info: message }))).toBe(
          EventV2.MAX_ENCODED_PAYLOAD_BYTES,
        )
        yield* Session.use.updateMessage(message)

        const pages = new Array<HistoryResponse>()
        let cursor: string | undefined
        while (true) {
          const response = yield* requestInDirectory(SyncPaths.history, tmp.directory, {
            method: "POST",
            headers,
            body: JSON.stringify({ version: 1, ...(cursor ? { cursor } : {}) }),
          })
          const text = yield* response.text
          expect(response.status, text).toBe(200)
          const page = JSON.parse(text) as HistoryResponse
          expect(Buffer.byteLength(text)).toBeLessThanOrEqual(SyncHistoryLimits.wireBytes)
          pages.push(page)
          cursor = page.nextCursor
          if (page.complete) break
        }
        const history = pages.flatMap((page) => page.items).filter((item) => item.aggregate_id === session.id)
        expect(history.map((item) => item.type)).toEqual(["session.created.1", "message.updated.1"])
        expect(Buffer.byteLength(JSON.stringify(history[1]!.data))).toBe(EventV2.MAX_ENCODED_PAYLOAD_BYTES)

        const { db } = yield* Database.Service
        yield* db.delete(EventSequenceTable).where(eq(EventSequenceTable.aggregate_id, session.id)).run().pipe(Effect.orDie)
        yield* db.delete(SessionTable).where(eq(SessionTable.id, session.id)).run().pipe(Effect.orDie)
        for (const page of pages) {
          const events = page.items
            .filter((item) => item.aggregate_id === session.id)
            .map((item) => ({
              id: item.id!,
              aggregateID: item.aggregate_id,
              seq: item.seq!,
              type: item.type!,
              data: item.data!,
            }))
          if (events.length === 0) continue
          const replay = yield* requestInDirectory(SyncPaths.replay, tmp.directory, {
            method: "POST",
            headers,
            body: JSON.stringify({ directory: tmp.directory, events }),
          })
          expect(replay.status, yield* replay.text).toBe(200)
        }

        expect((yield* Session.use.get(session.id)).title).toBe("sync-max-history")
        expect((yield* Session.use.getClientMessage({ sessionID: session.id, messageID })).info).toMatchObject({
          id: messageID,
          system: message.system,
        })
      }),
    { git: true, config: { formatter: false, lsp: false } },
    30_000,
  )

  it.instance(
    "rejects an unbounded replay stream before reading or decoding the full body",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const { db } = yield* Database.Service
        const before = yield* db.select({ id: EventTable.id }).from(EventTable).all().pipe(Effect.orDie)
        const chunk = new TextEncoder().encode("x".repeat(256 * 1024))
        let pulls = 0
        let cancelled = false
        const body = new ReadableStream<Uint8Array>({
          pull(controller) {
            pulls++
            if (pulls > 1024) return controller.close()
            controller.enqueue(chunk)
          },
          cancel() {
            cancelled = true
          },
        })
        const response = yield* Effect.promise(() =>
          HttpApiApp.webHandler().handler(
            new Request(`http://localhost${SyncPaths.replay}`, {
              method: "POST",
              headers: {
                "x-deepagent-code-directory": tmp.directory,
                "content-type": "application/json",
              },
              body,
              duplex: "half",
            } as RequestInit),
            context,
          ),
        )

        expect(response.status).toBe(413)
        expect(pulls).toBeLessThan(64)
        expect(cancelled).toBe(true)
        expect(yield* db.select({ id: EventTable.id }).from(EventTable).all().pipe(Effect.orDie)).toEqual(before)
      }),
    { git: true, config: { formatter: false, lsp: false } },
    15_000,
  )

  it.instance(
    "enforces the replay stream budget on the real Node listener without content-length",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const { db } = yield* Database.Service
        const before = yield* db.select({ id: EventTable.id }).from(EventTable).all().pipe(Effect.orDie)
        const chunk = new TextEncoder().encode("x".repeat(256 * 1024))
        let pulls = 0
        const body = new ReadableStream<Uint8Array>({
          pull(controller) {
            pulls++
            if (pulls > 1024) return controller.close()
            controller.enqueue(chunk)
          },
        })
        const server = yield* HttpServer.HttpServer
        const response = yield* Effect.promise(() =>
          fetch(`${HttpServer.formatAddress(server.address)}${SyncPaths.replay}`, {
            method: "POST",
            headers: {
              "x-deepagent-code-directory": tmp.directory,
              "content-type": "application/json",
            },
            body,
            duplex: "half",
          } as RequestInit),
        )

        expect(response.status).toBe(413)
        expect(pulls).toBeLessThan(64)
        expect(yield* db.select({ id: EventTable.id }).from(EventTable).all().pipe(Effect.orDie)).toEqual(before)
      }),
    { git: true, config: { formatter: false, lsp: false } },
    15_000,
  )

  it.instance(
    "validates seq values",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const headers = { "x-deepagent-code-directory": tmp.directory, "content-type": "application/json" }
        const cases = [
          {
            path: SyncPaths.history,
            body: { aggregate: -1 },
          },
          {
            path: SyncPaths.history,
            body: { aggregate: 1.5 },
          },
          {
            path: SyncPaths.replay,
            body: {
              directory: tmp.directory,
              events: [{ id: "event", aggregateID: "session", seq: -1, type: "session.created", data: {} }],
            },
          },
          {
            path: SyncPaths.replay,
            body: {
              directory: tmp.directory,
              events: [{ id: "event", aggregateID: "session", seq: 1.5, type: "session.created", data: {} }],
            },
          },
          {
            path: SyncPaths.replay,
            body: {
              directory: tmp.directory,
              events: [{ id: "event", aggregateID: "session", seq: 0, type: "session.created", data: {} }],
            },
          },
        ]

        for (const item of cases) {
          const response = yield* requestInDirectory(item.path, tmp.directory, {
            method: "POST",
            headers,
            body: JSON.stringify(item.body),
          })
          expect(response.status).toBe(400)
        }
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance.skip(
    "returns structured validation errors",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const response = yield* Effect.promise(() =>
          HttpApiApp.webHandler().handler(
            new Request(`http://localhost${SyncPaths.history}`, {
              method: "POST",
              headers: { "x-deepagent-code-directory": tmp.directory, "content-type": "application/json" },
              body: JSON.stringify({ aggregate: -1 }),
            }),
            context,
          ),
        )

        expect(response.status).toBe(400)
        expect(response.headers.get("content-type") ?? "").toContain("application/json")
        const body = (yield* Effect.promise(() => response.json())) as Record<string, unknown>
        expect(body.success).toBe(false)
        expect(Array.isArray(body.error) || Array.isArray(body.errors)).toBe(true)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )
})
