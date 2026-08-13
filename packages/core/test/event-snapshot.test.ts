import { describe, expect } from "bun:test"
import path from "node:path"
import { Effect, Layer } from "effect"
import { asc, eq } from "drizzle-orm"
import { Database } from "@deepagent-code/core/database/database"
import { EventV2 } from "@deepagent-code/core/event"
import {
  EventArtifactChunkTable,
  EventArtifactTable,
  EventCompactionReceiptTable,
  EventDedupeTable,
  EventSequenceTable,
  EventSnapshotTable,
  EventTable,
} from "@deepagent-code/core/event/sql"
import { ProjectV2 } from "@deepagent-code/core/project"
import { ProjectTable } from "@deepagent-code/core/project/sql"
import { ProviderV2 } from "@deepagent-code/core/provider"
import { ModelV2 } from "@deepagent-code/core/model"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { SessionV2 } from "@deepagent-code/core/session"
import { MessageTable, PartTable, SessionInputTable, SessionHistoryStateTable, SessionTable } from "@deepagent-code/core/session/sql"
import { SessionMessage } from "@deepagent-code/core/session/message"
import { SessionProjector } from "@deepagent-code/core/session/projector"
import { SessionV1 } from "@deepagent-code/core/v1/session"
import { Hash } from "@deepagent-code/core/util/hash"
import { testEffect } from "./lib/effect"
import { tmpdir } from "./fixture/tmpdir"

const sourceDatabase = Database.layerFromPath(":memory:")
const sourceEvents = EventV2.layer.pipe(Layer.provide(sourceDatabase))
const sourceProjector = SessionProjector.layer.pipe(Layer.provide(sourceEvents), Layer.provide(sourceDatabase))
const it = testEffect(Layer.mergeAll(sourceDatabase, sourceEvents, sourceProjector))
const sessionID = SessionV2.ID.make("ses_snapshot_two_database")
const projectID = ProjectV2.ID.global

const message = (id: string, text: string) => ({
  sessionID,
  info: {
    id: SessionV1.MessageID.make(id),
    sessionID,
    role: "user" as const,
    time: { created: 1 },
    agent: "build",
    model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
    system: text,
  },
})

const artifact = (input: { id: string; eventID: EventV2.ID; seq: number; messageID: string; label: string }) => {
  const canonicalData = {
    sessionID,
    info: {
      id: input.messageID,
      sessionID,
      role: "user",
      time: { created: 1 },
      agent: "build",
      model: { providerID: "test", modelID: "test" },
      system: input.label,
      summary: {
        diffs: [],
        diffArtifact: {
          id: input.id,
          hash: Hash.sha256(`body-${input.label}`),
          codec: "legacy-message-diff.v2",
          fileCount: 300,
          previewFileCount: 200,
          previewTruncated: true,
        },
      },
    },
  }
  return {
    artifact_id: input.id,
    event_id: input.eventID,
    aggregate_id: sessionID,
    seq: input.seq,
    kind: "legacy_message_diff" as const,
    original_data_hash: Hash.sha256(`source-${input.label}`),
    canonical_data_hash: Hash.sha256(JSON.stringify(canonicalData)),
    canonical_data: canonicalData,
    body_hash: Hash.sha256(`body-${input.label}`),
    body_bytes: 0,
    chunk_count: 1,
    codec_version: 2,
    created_at: input.seq,
  }
}

describe("EventV2 canonical projection snapshots", () => {
  it.effect("stages bounded checkpoints, imports atomically into a fresh database, and continues at the next event", () =>
    Effect.gen(function* () {
      const source = yield* EventV2.Service
      const sourceDb = (yield* Database.Service).db
      yield* sourceDb.insert(ProjectTable).values({ id: projectID, worktree: AbsolutePath.make("/project"), sandboxes: [] }).run().pipe(Effect.orDie)
      const info = SessionV1.SessionInfo.make({
        id: sessionID,
        slug: "snapshot",
        version: "test",
        projectID,
        directory: "/project",
        title: "snapshot",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: 1, updated: 1 },
      })
      yield* source.publish(SessionV1.Event.Created, { sessionID, info })
      yield* source.publish(SessionV1.Event.MessageUpdated, message("msg_snapshot_one", "one"))
      yield* sourceDb.insert(SessionInputTable).values({
        id: SessionMessage.ID.make("msg_snapshot_pending"),
        session_id: sessionID,
        prompt: { text: "must not transfer" },
        delivery: "queue",
        admitted_seq: 100,
        time_created: 1,
      }).run().pipe(Effect.orDie)

      const stale = yield* source.prepareCheckpoint!({
        aggregateID: sessionID,
        throughSeq: EventV2.Cursor.make(1),
        expectedLatest: EventV2.Cursor.make(1),
        codec: "session-projection",
        schemaVersion: 1,
      })
      let staged = stale
      while (staged.hasMore) staged = yield* source.stageCheckpoint!({ snapshotID: staged.snapshotID, limit: 1 })
      expect((yield* sourceDb.select().from(EventSequenceTable).where(eq(EventSequenceTable.aggregate_id, sessionID)).get().pipe(Effect.orDie))?.retention_floor_seq).toBeNull()

      yield* source.publish(SessionV1.Event.MessageUpdated, message("msg_snapshot_two", "two"))
      const staleFinalize = yield* source.finalizeCheckpoint!({ snapshotID: staged.snapshotID }).pipe(Effect.catchDefect(Effect.succeed))
      expect(staleFinalize).toBeInstanceOf(EventV2.InvalidSyncEventError)
      expect(yield* source.snapshot(sessionID)).toBeUndefined()

      const active = yield* source.checkpoint({
        aggregateID: sessionID,
        throughSeq: EventV2.Cursor.make(2),
        expectedLatest: EventV2.Cursor.make(2),
        codec: "session-projection",
        schemaVersion: 1,
      })
      expect((yield* sourceDb.select().from(EventSequenceTable).where(eq(EventSequenceTable.aggregate_id, sessionID)).get().pipe(Effect.orDie))?.retention_floor_seq).toBe(2)
      expect(active.body).toMatchObject({ format: "chunked-rows.v1", tables: { session: 1, message: 2 } })
      expect((active.body.tables as Record<string, number>).session_input).toBeUndefined()

      yield* source.publish(SessionV1.Event.MessageUpdated, message("msg_snapshot_tail", "tail"))
      const tail = yield* sourceDb.select().from(EventTable)
        .where(eq(EventTable.aggregate_id, sessionID)).orderBy(asc(EventTable.seq)).all().pipe(Effect.orDie)
      const rows = [] as EventV2.SerializedSnapshotRow[]
      let rowAfter = -1
      while (true) {
        const page = yield* source.snapshotRows!({ snapshotID: active.snapshotID, after: rowAfter, limit: 2 })
        if (page.length === 0) break
        rows.push(...page)
        rowAfter = page.at(-1)!.rowIndex
      }
      const chunks = new Map<string, EventV2.SerializedSnapshotChunk[]>()
      for (const row of rows) {
        const output = [] as EventV2.SerializedSnapshotChunk[]
        let chunkAfter = -1
        while (true) {
          const page = yield* source.snapshotChunks!({ rowHash: row.rowHash, after: chunkAfter })
          if (page.length === 0) break
          output.push(...page)
          chunkAfter = page.at(-1)!.chunkIndex
        }
        chunks.set(row.rowHash, output)
      }

      const tmp = yield* Effect.acquireRelease(Effect.promise(() => tmpdir()), (value) => Effect.promise(() => value[Symbol.asyncDispose]()))
      const targetDatabase = Database.layerFromPath(path.join(tmp.path, "target.sqlite"))
      const targetEvents = EventV2.layer.pipe(Layer.provide(targetDatabase))
      const targetProjector = SessionProjector.layer.pipe(Layer.provide(targetEvents), Layer.provide(targetDatabase))
      yield* Effect.gen(function* () {
        const target = yield* EventV2.Service
        const targetDb = (yield* Database.Service).db
        yield* targetDb.insert(ProjectTable).values({ id: projectID, worktree: AbsolutePath.make("/project"), sandboxes: [] }).run().pipe(Effect.orDie)
        yield* targetDb.insert(SessionTable).values({
          id: sessionID,
          project_id: projectID,
          slug: "target",
          directory: "/project",
          title: "target",
          version: "test",
        }).run().pipe(Effect.orDie)
        yield* targetDb.insert(SessionInputTable).values({
          id: SessionMessage.ID.make("msg_target_pending"),
          session_id: sessionID,
          prompt: { text: "local pending" },
          delivery: "queue",
          admitted_seq: 200,
          time_created: 1,
        }).run().pipe(Effect.orDie)
        yield* targetDb.insert(SessionHistoryStateTable).values({
          session_id: sessionID,
          state: "provisioning",
          time_created: 1,
          time_updated: 1,
        }).run().pipe(Effect.orDie)
        yield* targetDb.insert(MessageTable).values({ id: SessionV1.MessageID.make("msg_target_stale"), session_id: sessionID,
          time_created: 1, data: { role: "user", time: { created: 1 }, agent: "build", model: { providerID: "test", modelID: "test" } } as typeof MessageTable.$inferInsert["data"] }).run().pipe(Effect.orDie)
        yield* targetDb.insert(PartTable).values({ id: SessionV1.PartID.make("prt_target_stale"), message_id: SessionV1.MessageID.make("msg_target_stale"),
          session_id: sessionID, time_created: 1, data: { type: "text", text: "stale" } as typeof PartTable.$inferInsert["data"] }).run().pipe(Effect.orDie)

        yield* target.stageSnapshotRows!(active, rows)
        yield* target.stageSnapshotRows!(active, rows)
        for (const row of rows) {
          yield* target.stageSnapshotChunks!(active, row, chunks.get(row.rowHash)!)
          yield* target.stageSnapshotChunks!(active, row, chunks.get(row.rowHash)!)
        }
        yield* target.importSnapshot(active)
        yield* target.importSnapshot(active)
        expect(yield* targetDb.select().from(SessionInputTable).where(eq(SessionInputTable.id, SessionMessage.ID.make("msg_target_pending"))).get().pipe(Effect.orDie)).toBeDefined()
        expect(yield* targetDb.select().from(SessionInputTable).where(eq(SessionInputTable.id, SessionMessage.ID.make("msg_snapshot_pending"))).get().pipe(Effect.orDie)).toBeUndefined()
        expect(yield* targetDb.select().from(SessionHistoryStateTable).where(eq(SessionHistoryStateTable.session_id, sessionID)).get().pipe(Effect.orDie)).toMatchObject({ state: "provisioning" })
        expect(yield* targetDb.select().from(MessageTable).where(eq(MessageTable.id, SessionV1.MessageID.make("msg_target_stale"))).get().pipe(Effect.orDie)).toBeUndefined()
        expect(yield* targetDb.select().from(PartTable).where(eq(PartTable.id, SessionV1.PartID.make("prt_target_stale"))).get().pipe(Effect.orDie)).toBeUndefined()
        expect(yield* targetDb.select().from(EventSequenceTable).where(eq(EventSequenceTable.aggregate_id, sessionID)).get().pipe(Effect.orDie)).toMatchObject({ seq: 2, retention_floor_seq: 2, snapshot_id: active.snapshotID })
        expect((yield* target.snapshot(sessionID))?.syncSeq).not.toBe(active.syncSeq)

        const next = tail.find((event) => event.seq === 3)!
        yield* target.replay({ id: next.id, aggregateID: next.aggregate_id, seq: next.seq, type: next.type, data: next.data })
        expect((yield* targetDb.select().from(EventSequenceTable).where(eq(EventSequenceTable.aggregate_id, sessionID)).get().pipe(Effect.orDie))?.seq).toBe(3)
      }).pipe(Effect.provide(Layer.fresh(Layer.mergeAll(targetDatabase, targetEvents, targetProjector))))

      let compacted = { deleted: 0, complete: false }
      let total = 0
      while (!compacted.complete) {
        compacted = yield* source.compact({ aggregateID: sessionID, throughSeq: EventV2.Cursor.make(2), limit: 1 })
        total += compacted.deleted
      }
      expect(total).toBe(3)
      const dedupe = yield* sourceDb.select().from(EventDedupeTable).where(eq(EventDedupeTable.aggregate_id, sessionID)).all().pipe(Effect.orDie)
      expect(dedupe).toHaveLength(3)
      expect(dedupe.every((row) => row.source_data === null)).toBe(true)
      expect(yield* sourceDb.select().from(EventCompactionReceiptTable).where(eq(EventCompactionReceiptTable.aggregate_id, sessionID)).get().pipe(Effect.orDie)).toMatchObject({ state: "complete", cursor_seq: 2 })
    }),
  )

  it.effect("checkpoints the newest diff artifact when one Message has multiple historical artifacts", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const db = (yield* Database.Service).db
      yield* db
        .insert(ProjectTable)
        .values({ id: projectID, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      const info = SessionV1.SessionInfo.make({
        id: sessionID,
        slug: "snapshot-artifact-authority",
        version: "test",
        projectID,
        directory: "/project",
        title: "snapshot-artifact-authority",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: 1, updated: 1 },
      })
      const messageID = SessionV1.MessageID.make("msg_snapshot_artifact_authority")
      yield* events.publish(SessionV1.Event.Created, { sessionID, info })
      yield* events.publish(SessionV1.Event.MessageUpdated, message(messageID, "physical"))
      const sourceEvents = yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, sessionID))
        .orderBy(asc(EventTable.seq))
        .all()
        .pipe(Effect.orDie)
      const old = artifact({
        id: "evtart_old",
        eventID: sourceEvents[0]!.id,
        seq: sourceEvents[0]!.seq,
        messageID,
        label: "old",
      })
      const latest = artifact({
        id: "evtart_latest",
        eventID: sourceEvents[1]!.id,
        seq: sourceEvents[1]!.seq,
        messageID,
        label: "latest",
      })
      yield* db.insert(EventArtifactTable).values([old, latest]).run().pipe(Effect.orDie)
      yield* db
        .insert(EventArtifactChunkTable)
        .values([
          { artifact_id: old.artifact_id, chunk_index: 0, data: Buffer.alloc(0), chunk_hash: Hash.sha256(Buffer.alloc(0)) },
          { artifact_id: latest.artifact_id, chunk_index: 0, data: Buffer.alloc(0), chunk_hash: Hash.sha256(Buffer.alloc(0)) },
        ])
        .run()
        .pipe(Effect.orDie)
      yield* db
        .update(MessageTable)
        .set({ data: latest.canonical_data.info as typeof MessageTable.$inferInsert.data })
        .where(eq(MessageTable.id, messageID))
        .run()
        .pipe(Effect.orDie)
      yield* db.run(`
        INSERT INTO session_diff_migration_receipt (
          message_id, session_id, artifact_id, source_event_id,
          expected_message_data_hash, committed_message_data_hash,
          expected_session_summary_hash, committed_session_summary_hash,
          canonicalizer_version, canonicalization_version, epoch_hashes,
          state, created_at, updated_at, committed_at
        ) VALUES (
          '${messageID}', '${sessionID}', '${latest.artifact_id}', '${latest.event_id}',
          '${Hash.sha256("expected-message")}', '${Hash.sha256("committed-message")}',
          '${Hash.sha256("expected-session")}', '${Hash.sha256("null")}',
          2, 1, '[]', 'committed', 1, 1, 1
        )
      `).pipe(Effect.orDie)

      const snapshot = yield* events.checkpoint({
        aggregateID: sessionID,
        throughSeq: EventV2.Cursor.make(1),
        expectedLatest: EventV2.Cursor.make(1),
        codec: "session-projection",
        schemaVersion: 1,
      })
      const rows = yield* events.snapshotRows!({ snapshotID: snapshot.snapshotID, after: -1, limit: 100 })
      const row = rows.find((candidate) => candidate.tableName === "message" && candidate.rowKey === messageID)!
      const chunks = yield* events.snapshotChunks!({ rowHash: row.rowHash, after: -1 })
      const value = JSON.parse(Buffer.concat(chunks.map((chunk) => chunk.data)).toString()) as {
        data: { summary?: { diffArtifact?: { id: string; previewFileCount: number; previewTruncated: boolean } } }
      }
      expect(value.data.summary?.diffArtifact).toEqual(
        expect.objectContaining({ id: latest.artifact_id, previewFileCount: 200, previewTruncated: true }),
      )
      expect(JSON.stringify(value)).not.toContain(old.artifact_id)

      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (value) => Effect.promise(() => value[Symbol.asyncDispose]()),
      )
      const targetDatabase = Database.layerFromPath(path.join(tmp.path, "artifact-target.sqlite"))
      const targetEvents = EventV2.layer.pipe(Layer.provide(targetDatabase))
      const targetProjector = SessionProjector.layer.pipe(Layer.provide(targetEvents), Layer.provide(targetDatabase))
      yield* Effect.gen(function* () {
        const target = yield* EventV2.Service
        const targetDb = (yield* Database.Service).db
        yield* targetDb
          .insert(ProjectTable)
          .values({ id: projectID, worktree: AbsolutePath.make("/project"), sandboxes: [] })
          .run()
          .pipe(Effect.orDie)
        yield* target.stageSnapshotRows!(snapshot, rows)
        for (const snapshotRow of rows)
          yield* target.stageSnapshotChunks!(
            snapshot,
            snapshotRow,
            yield* events.snapshotChunks!({ rowHash: snapshotRow.rowHash, after: -1 }),
          )
        yield* target.importSnapshot(snapshot)
        const imported = yield* targetDb
          .select({ data: MessageTable.data })
          .from(MessageTable)
          .where(eq(MessageTable.id, messageID))
          .get()
          .pipe(Effect.orDie)
        expect(
          imported?.data.role === "user" && imported.data.summary && typeof imported.data.summary === "object"
            ? imported.data.summary.diffArtifact?.id
            : undefined,
        ).toBe(latest.artifact_id)
        expect(JSON.stringify(imported)).not.toContain('"patch"')
      }).pipe(Effect.provide(Layer.fresh(Layer.mergeAll(targetDatabase, targetEvents, targetProjector))))
    }),
  )
})
