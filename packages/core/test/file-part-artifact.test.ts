import { describe, expect } from "bun:test"
import { Context, Effect, Layer } from "effect"
import { eq, sql } from "drizzle-orm"
import { Database } from "@deepagent-code/core/database/database"
import { EventV2 } from "@deepagent-code/core/event"
import {
  EventSequenceTable,
  EventSnapshotRowTable,
  EventSnapshotTable,
  EventSyncSequenceTable,
  EventTable,
} from "@deepagent-code/core/event/sql"
import { FilePartArtifact } from "@deepagent-code/core/file-part-artifact"
import {
  FilePartArtifactBindingTable,
  FilePartArtifactChunkTable,
  FilePartArtifactDiscardTable,
  FilePartArtifactImportTable,
  FilePartArtifactTable,
} from "@deepagent-code/core/file-part-artifact.sql"
import { SessionSchema } from "@deepagent-code/core/session/schema"
import { SessionV1 } from "@deepagent-code/core/v1/session"
import { Hash } from "@deepagent-code/core/util/hash"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { Project } from "@deepagent-code/core/project"
import { ProviderV2 } from "@deepagent-code/core/provider"
import { ModelV2 } from "@deepagent-code/core/model"
import { ProjectTable } from "@deepagent-code/core/project/sql"
import { MessageTable, PartTable, SessionTable } from "@deepagent-code/core/session/sql"
import { SessionProjector } from "@deepagent-code/core/session/projector"
import { testEffect } from "./lib/effect"

const Prelude = EventV2.define({
  type: "test.file-part-prelude",
  sync: { version: 1, aggregate: "sessionID" },
  schema: { sessionID: SessionSchema.ID },
})

const runtime = () => {
  const database = Database.layerFromPath(":memory:")
  return Layer.mergeAll(database, EventV2.layer.pipe(Layer.provide(database)))
}

const projectedRuntime = () => {
  const database = Database.layerFromPath(":memory:")
  const events = EventV2.layer.pipe(Layer.provide(database))
  const projector = SessionProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
  return Layer.mergeAll(database, events, projector)
}

const it = testEffect(Layer.empty)

describe("FilePartArtifact", () => {
  it.effect("externalizes one bounded legacy inline file-part batch idempotently", () =>
    Effect.gen(function* () {
      const source = yield* Layer.buildWithScope(Layer.fresh(projectedRuntime()), yield* Effect.scope)
      const events = Context.get(source, EventV2.Service)
      const db = Context.get(source, Database.Service).db
      const sessionID = SessionSchema.ID.make("ses_legacy_file_part")
      yield* events.publish(Prelude, { sessionID })
      const eventID = EventV2.ID.make("evt_legacy_file_part")
      const messageID = SessionV1.MessageID.make("msg_legacy_file_part")
      const partID = SessionV1.PartID.make("prt_legacy_file_part")
      const body = Buffer.alloc(3 * 1024 * 1024 + 1, 0x4c)
      const data = {
        sessionID,
        time: 1,
        part: {
          id: partID,
          sessionID,
          messageID,
          type: "file" as const,
          mime: "application/octet-stream",
          url: `data:application/octet-stream;base64,${body.toString("base64")}`,
        },
      }
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "legacy-file",
          directory: AbsolutePath.make("/project"),
          title: "legacy-file",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(MessageTable)
        .values({
          id: messageID,
          session_id: sessionID,
          time_created: 1,
          data: { role: "user", time: { created: 1 } },
        } as typeof MessageTable.$inferInsert)
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(PartTable)
        .values({
          id: partID,
          message_id: messageID,
          session_id: sessionID,
          time_created: 1,
          // v4.0.4 kept this runtime marker in Part while its FilePart event schema dropped it.
          data: { type: "file", mime: "application/octet-stream", url: data.part.url, synthetic: true },
        } as typeof PartTable.$inferInsert)
        .run()
        .pipe(Effect.orDie)
      expect(Buffer.byteLength(JSON.stringify(data))).toBeGreaterThan(EventV2.MAX_ENCODED_PAYLOAD_BYTES)
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
          id: eventID,
          aggregate_id: sessionID,
          seq: 1,
          type: EventV2.versionedType(SessionV1.Event.PartUpdated.type, 1),
          data,
          sync_seq: sync!.seq,
        })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .update(EventSequenceTable)
        .set({ seq: 1 })
        .where(eq(EventSequenceTable.aggregate_id, sessionID))
        .run()
        .pipe(Effect.orDie)

      const inlineSnapshot = yield* events.checkpoint({
        aggregateID: sessionID,
        throughSeq: EventV2.Cursor.make(1),
        expectedLatest: EventV2.Cursor.make(1),
        codec: "session-projection",
        schemaVersion: 1,
      })
      const inlineRows = yield* events.snapshotRows!({ snapshotID: inlineSnapshot.snapshotID })
      const inlinePartRow = inlineRows.find((row) => row.tableName === "part" && row.rowKey === partID)!
      expect(Buffer.concat((yield* events.snapshotChunks!({ rowHash: inlinePartRow.rowHash })).map((chunk) => chunk.data)).toString())
        .toContain("data:application/octet-stream;base64,")

      const first = yield* FilePartArtifact.canonicalizeLegacy(db, { limit: 1, now: 7 })
      expect(first).toEqual({ processed: 1, next: eventID })
      expect(yield* FilePartArtifact.canonicalizeLegacy(db, { afterID: eventID, limit: 1, now: 8 })).toEqual({
        processed: 0,
        next: undefined,
      })
      const immutable = yield* db.select().from(EventTable).where(eq(EventTable.id, eventID)).get().pipe(Effect.orDie)
      expect(immutable!.data).toEqual(data)
      const binding = yield* db
        .select()
        .from(FilePartArtifactBindingTable)
        .where(eq(FilePartArtifactBindingTable.event_id, eventID))
        .get()
        .pipe(Effect.orDie)
      expect(binding!.original_data_hash).toBe(FilePartArtifact.dataHash(data))
      const descriptor = FilePartArtifact.descriptor(binding!.canonical_data)
      expect(descriptor).toBeDefined()
      if (!descriptor) return
      expect(binding!.canonical_data).toMatchObject({ part: { synthetic: true } })
      expect(Buffer.byteLength(JSON.stringify(binding!.canonical_data))).toBeLessThan(2_000)
      const projected = yield* db.select().from(PartTable).where(eq(PartTable.id, partID)).get().pipe(Effect.orDie)
      expect(Buffer.byteLength(JSON.stringify(projected!.data))).toBeLessThan(1_000)
      expect(projected!.data).toMatchObject({
        url: `artifact:${descriptor.id}`,
        artifact: descriptor,
        synthetic: true,
      })
      expect(
        yield* FilePartArtifact.read({ aggregateID: sessionID, descriptor }).pipe(Effect.provide(source)),
      ).toEqual(body)
      expect(yield* db.select().from(FilePartArtifactBindingTable).all()).toHaveLength(1)
      expect(yield* db.select().from(FilePartArtifactChunkTable).all()).toHaveLength(descriptor.chunks)

      yield* db.run(`
        CREATE TRIGGER test_file_part_dedupe_never_copies_source
        BEFORE INSERT ON event_dedupe
        WHEN NEW.source_data IS NOT NULL
          AND EXISTS (SELECT 1 FROM file_part_artifact_binding WHERE event_id = NEW.event_id)
        BEGIN
          SELECT RAISE(ABORT, 'file_part_dedupe_copied_source');
        END
      `).pipe(Effect.orDie)

      yield* events.replay({
        id: eventID,
        aggregateID: sessionID,
        seq: 1,
        type: EventV2.versionedType(SessionV1.Event.PartUpdated.type, 1),
        data,
      })
      const divergent = yield* events
        .replay({
          id: eventID,
          aggregateID: sessionID,
          seq: 1,
          type: EventV2.versionedType(SessionV1.Event.PartUpdated.type, 1),
          data: { ...data, part: { ...data.part, synthetic: false } },
        })
        .pipe(Effect.exit)
      expect(divergent._tag).toBe("Failure")
      expect(yield* db.select().from(EventTable).where(eq(EventTable.id, eventID)).all()).toHaveLength(1)
      expect((yield* db.select().from(EventTable).where(eq(EventTable.id, eventID)).get())!.data).toEqual(data)

      const metadata = yield* FilePartArtifact.metadata(db, {
        eventID,
        aggregateID: sessionID,
        seq: 1,
        artifactID: descriptor.id,
      })
      const artifactChunks = yield* Effect.forEach(metadata.chunkHashes, (hash, index) =>
        FilePartArtifact.chunk(db, { artifactID: descriptor.id, index, expectedHash: hash }),
      )

      const replayTarget = yield* Layer.buildWithScope(Layer.fresh(projectedRuntime()), yield* Effect.scope)
      const replayDb = Context.get(replayTarget, Database.Service).db
      const replayEvents = Context.get(replayTarget, EventV2.Service)
      yield* replayDb
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* replayDb
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "legacy-replay",
          directory: AbsolutePath.make("/project"),
          title: "legacy-replay",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      yield* replayDb
        .insert(MessageTable)
        .values({ id: messageID, session_id: sessionID, time_created: 1, data: { role: "user", time: { created: 1 } } } as typeof MessageTable.$inferInsert)
        .run()
        .pipe(Effect.orDie)
      yield* replayDb
        .insert(EventSequenceTable)
        .values({ aggregate_id: sessionID, seq: 0 })
        .run()
        .pipe(Effect.orDie)
      yield* Effect.forEach(
        artifactChunks,
        (chunk, index) =>
          FilePartArtifact.importChunk({
            metadata,
            index,
            hash: metadata.chunkHashes[index]!,
            data: chunk,
          }).pipe(Effect.provide(replayTarget)),
        { discard: true },
      )
      yield* FilePartArtifact.stageImport(metadata).pipe(Effect.provide(replayTarget))
      yield* replayEvents.replay({
        id: eventID,
        aggregateID: sessionID,
        seq: 1,
        type: EventV2.versionedType(SessionV1.Event.PartUpdated.type, 1),
        data: binding!.canonical_data,
      })
      expect((yield* replayDb.select().from(PartTable).where(eq(PartTable.id, partID)).get())?.data).toEqual(projected!.data)

      const snapshot = yield* events.checkpoint({
        aggregateID: sessionID,
        throughSeq: EventV2.Cursor.make(1),
        expectedLatest: EventV2.Cursor.make(1),
        codec: "session-projection",
        schemaVersion: 1,
      })
      expect(snapshot.snapshotID).not.toBe(inlineSnapshot.snapshotID)
      expect(yield* db.select({ id: EventSnapshotTable.snapshot_id }).from(EventSnapshotTable).all())
        .toEqual([{ id: snapshot.snapshotID }])
      expect(yield* db.select().from(EventSnapshotRowTable)
        .where(eq(EventSnapshotRowTable.snapshot_id, inlineSnapshot.snapshotID)).all()).toEqual([])
      const snapshotRows = yield* events.snapshotRows!({ snapshotID: snapshot.snapshotID })
      const snapshotTarget = yield* Layer.buildWithScope(Layer.fresh(projectedRuntime()), yield* Effect.scope)
      const snapshotDb = Context.get(snapshotTarget, Database.Service).db
      const snapshotEvents = Context.get(snapshotTarget, EventV2.Service)
      yield* snapshotDb
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* Effect.forEach(
        artifactChunks,
        (chunk, index) =>
          FilePartArtifact.importChunk({
            metadata,
            index,
            hash: metadata.chunkHashes[index]!,
            data: chunk,
          }).pipe(Effect.provide(snapshotTarget)),
        { discard: true },
      )
      yield* FilePartArtifact.stageImport(metadata).pipe(Effect.provide(snapshotTarget))
      yield* snapshotEvents.stageSnapshotRows!(snapshot, snapshotRows)
      yield* Effect.forEach(
        snapshotRows,
        (row) =>
          events.snapshotChunks!({ rowHash: row.rowHash }).pipe(
            Effect.flatMap((chunks) => snapshotEvents.stageSnapshotChunks!(snapshot, row, chunks)),
          ),
        { discard: true },
      )
      yield* snapshotEvents.importSnapshot(snapshot)
      expect((yield* snapshotDb.select().from(PartTable).where(eq(PartTable.id, partID)).get())?.data).toEqual(projected!.data)

      let compacted = { deleted: 0, complete: false }
      while (!compacted.complete)
        compacted = yield* events.compact({ aggregateID: sessionID, throughSeq: EventV2.Cursor.make(1), limit: 1 })
      expect(yield* db.select().from(EventTable).where(eq(EventTable.id, eventID)).all()).toEqual([])
      expect(yield* db.all<{ data_hash: string; source_data: string | null }>(sql`
        SELECT data_hash, source_data FROM event_dedupe WHERE event_id = ${eventID}
      `).pipe(Effect.orDie)).toEqual([{ data_hash: binding!.original_data_hash, source_data: null }])
      yield* events.replay({
        id: eventID,
        aggregateID: sessionID,
        seq: 1,
        type: EventV2.versionedType(SessionV1.Event.PartUpdated.type, 1),
        data,
      })
      const compactedDivergent = yield* events
        .replay({
          id: eventID,
          aggregateID: sessionID,
          seq: 1,
          type: EventV2.versionedType(SessionV1.Event.PartUpdated.type, 1),
          data: {
            ...data,
            part: { ...data.part, url: `data:text/plain;base64,${body.toString("base64")}` },
          },
        })
        .pipe(Effect.catchDefect(Effect.succeed))
      expect(compactedDivergent).toBeInstanceOf(EventV2.InvalidSyncEventError)

      const canonicalSource = {
        ...data,
        part: {
          ...data.part,
          id: SessionV1.PartID.make("prt_legacy_file_part_canonical"),
          url: `data:application/octet-stream;base64,${body.toString("base64")}`,
        },
      }
      const canonicalEventID = EventV2.ID.make("evt_legacy_file_part_canonical")
      const canonicalPrepared = FilePartArtifact.prepare(
        SessionV1.Event.PartUpdated.type,
        canonicalSource,
        Buffer.byteLength(JSON.stringify(canonicalSource)),
        EventV2.MAX_ENCODED_PAYLOAD_BYTES,
      )
      yield* db.insert(EventTable).values({
        id: canonicalEventID,
        aggregate_id: sessionID,
        seq: 2,
        type: EventV2.versionedType(SessionV1.Event.PartUpdated.type, 1),
        data: canonicalSource,
        sync_seq: 3,
      }).run().pipe(Effect.orDie)
      yield* FilePartArtifact.put(db, canonicalPrepared.artifacts[0]!, 9)
      yield* FilePartArtifact.bind(db, {
        eventID: canonicalEventID,
        aggregateID: sessionID,
        seq: 2,
        type: SessionV1.Event.PartUpdated.type,
        data: canonicalPrepared.data,
        originalData: canonicalSource,
        now: 9,
      })
      yield* db.update(EventSequenceTable).set({ seq: 2 })
        .where(eq(EventSequenceTable.aggregate_id, sessionID)).run().pipe(Effect.orDie)
      const canonicalSnapshot = yield* events.checkpoint({
        aggregateID: sessionID,
        throughSeq: EventV2.Cursor.make(2),
        expectedLatest: EventV2.Cursor.make(2),
        codec: "session-projection",
        schemaVersion: 1,
      })
      let canonicalCompacted = { deleted: 0, complete: false }
      while (!canonicalCompacted.complete)
        canonicalCompacted = yield* events.compact({
          aggregateID: sessionID,
          throughSeq: EventV2.Cursor.make(2),
          limit: 1,
        })
      expect(canonicalSnapshot.throughSeq).toBe(2)
      yield* events.replay({
        id: canonicalEventID,
        aggregateID: sessionID,
        seq: 2,
        type: EventV2.versionedType(SessionV1.Event.PartUpdated.type, 1),
        data: canonicalSource,
      })
      const sameDescriptorDifferentSource = yield* events.replay({
        id: canonicalEventID,
        aggregateID: sessionID,
        seq: 2,
        type: EventV2.versionedType(SessionV1.Event.PartUpdated.type, 1),
        data: {
          ...canonicalSource,
          part: { ...canonicalSource.part, url: `data:text/plain;base64,${body.toString("base64")}` },
        },
      }).pipe(Effect.catchDefect(Effect.succeed))
      expect(sameDescriptorDifferentSource).toBeInstanceOf(EventV2.InvalidSyncEventError)
    }),
  )

  it.effect("transfers canonical chunks between databases and fences replay until the exact body is staged", () =>
    Effect.gen(function* () {
      const source = yield* Layer.buildWithScope(Layer.fresh(runtime()), yield* Effect.scope)
      const target = yield* Layer.buildWithScope(Layer.fresh(runtime()), yield* Effect.scope)
      const snapshotTarget = yield* Layer.buildWithScope(Layer.fresh(runtime()), yield* Effect.scope)
      const sourceEvents = Context.get(source, EventV2.Service)
      const targetEvents = Context.get(target, EventV2.Service)
      const sourceDb = Context.get(source, Database.Service).db
      const targetDb = Context.get(target, Database.Service).db
      const snapshotDb = Context.get(snapshotTarget, Database.Service).db
      const sessionID = SessionSchema.ID.make("ses_file_part_two_db")
      const body = Buffer.alloc(FilePartArtifact.CHUNK_BYTES * 2 + 17, 0x5a)
      const prelude = yield* sourceEvents.publish(Prelude, { sessionID })
      const sourceData = {
        sessionID,
        time: 1,
        part: {
          id: SessionV1.PartID.make("prt_file_part_two_db"),
          sessionID,
          messageID: SessionV1.MessageID.make("msg_file_part_two_db"),
          type: "file" as const,
          mime: "application/octet-stream",
          filename: "large.bin",
          url: `data:application/octet-stream;base64,${body.toString("base64")}`,
        },
      }
      const published = yield* sourceEvents.publish(SessionV1.Event.PartUpdated, sourceData)
      yield* sourceEvents.publish(SessionV1.Event.PartUpdated, sourceData, {
        id: published.id,
        idempotent: true,
      })
      const divergentPublish = yield* sourceEvents.publish(SessionV1.Event.PartUpdated, {
        ...sourceData,
        part: { ...sourceData.part, url: `data:text/plain;base64,${body.toString("base64")}` },
      }, { id: published.id, idempotent: true }).pipe(Effect.catchDefect(Effect.succeed))
      expect(divergentPublish).toBeInstanceOf(EventV2.InvalidSyncEventError)
      const descriptor = FilePartArtifact.descriptor(published.data)
      expect(descriptor).toBeDefined()
      if (!descriptor) return
      expect(descriptor).toMatchObject({
        id: `fpart_${Hash.sha256(body)}`,
        hash: Hash.sha256(body),
        bytes: body.byteLength,
        chunkBytes: FilePartArtifact.CHUNK_BYTES,
        chunks: 3,
      })
      expect(Buffer.byteLength(JSON.stringify(published.data))).toBeLessThan(2_000)

      const binding = yield* sourceDb
        .select({ seq: FilePartArtifactBindingTable.seq })
        .from(FilePartArtifactBindingTable)
        .where(eq(FilePartArtifactBindingTable.event_id, published.id))
        .get()
      expect(binding).toEqual({ seq: 1 })
      const metadata = yield* FilePartArtifact.metadata(sourceDb, {
        eventID: published.id,
        aggregateID: sessionID,
        seq: 1,
        artifactID: descriptor.id,
      })
      const chunks = yield* Effect.forEach(metadata.chunkHashes, (hash, index) =>
        FilePartArtifact.chunk(sourceDb, { artifactID: descriptor.id, index, expectedHash: hash }),
      )

      yield* targetEvents.replay({
        id: prelude.id,
        type: EventV2.versionedType(Prelude.type, 1),
        aggregateID: sessionID,
        seq: 0,
        data: prelude.data,
      })
      const corrupt = yield* FilePartArtifact.importChunk({
        metadata,
        index: 0,
        hash: metadata.chunkHashes[0]!,
        data: Buffer.from("corrupt"),
      }).pipe(Effect.provide(target), Effect.catchDefect(Effect.succeed))
      expect(corrupt).toBeInstanceOf(FilePartArtifact.IntegrityError)
      expect(yield* targetDb.select().from(FilePartArtifactTable).all()).toEqual([])
      expect(yield* targetDb.select().from(FilePartArtifactChunkTable).all()).toEqual([])

      expect(
        yield* FilePartArtifact.importChunk({
          metadata,
          index: 0,
          hash: metadata.chunkHashes[0]!,
          data: chunks[0]!,
        }).pipe(Effect.provide(target)),
      ).toBe(false)
      const premature = yield* targetEvents
        .replay({
          id: published.id,
          type: EventV2.versionedType(SessionV1.Event.PartUpdated.type, 1),
          aggregateID: sessionID,
          seq: 1,
          data: published.data,
        })
        .pipe(Effect.catchDefect(Effect.succeed))
      expect(premature).toBeInstanceOf(FilePartArtifact.IntegrityError)
      expect(
        yield* targetDb.select().from(EventSequenceTable).where(eq(EventSequenceTable.aggregate_id, sessionID)).get(),
      ).toMatchObject({ seq: 0 })
      expect(yield* targetDb.select().from(EventTable).where(eq(EventTable.id, published.id)).get()).toBeUndefined()
      expect(yield* targetDb.select().from(FilePartArtifactBindingTable).all()).toEqual([])
      expect(yield* targetDb.select().from(FilePartArtifactImportTable).all()).toHaveLength(1)

      yield* Effect.forEach(
        chunks.slice(1),
        (chunk, offset) =>
          FilePartArtifact.importChunk({
            metadata,
            index: offset + 1,
            hash: metadata.chunkHashes[offset + 1]!,
            data: chunk,
          }).pipe(Effect.provide(target)),
        { discard: true },
      )
      yield* FilePartArtifact.stageImport(metadata).pipe(Effect.provide(target))
      yield* targetEvents.replay({
        id: published.id,
        type: EventV2.versionedType(SessionV1.Event.PartUpdated.type, 1),
        aggregateID: sessionID,
        seq: 1,
        data: published.data,
      })
      yield* targetEvents.replay({
        id: published.id,
        type: EventV2.versionedType(SessionV1.Event.PartUpdated.type, 1),
        aggregateID: sessionID,
        seq: 1,
        data: published.data,
      })

      expect(
        yield* FilePartArtifact.read({ aggregateID: sessionID, descriptor }).pipe(Effect.provide(target)),
      ).toEqual(body)
      expect(yield* targetDb.select().from(FilePartArtifactBindingTable).all()).toHaveLength(1)
      expect(yield* targetDb.select().from(FilePartArtifactImportTable).all()).toEqual([])
      expect(yield* targetDb.select().from(EventTable).where(eq(EventTable.id, published.id)).all()).toHaveLength(1)

      yield* sourceEvents.replay({
        id: published.id,
        type: EventV2.versionedType(SessionV1.Event.PartUpdated.type, 1),
        aggregateID: sessionID,
        seq: 1,
        data: published.data,
      })
      yield* sourceEvents.replay({
        id: published.id,
        type: EventV2.versionedType(SessionV1.Event.PartUpdated.type, 1),
        aggregateID: sessionID,
        seq: 1,
        data: sourceData,
      })
      const differentRawSource = yield* sourceEvents.replay({
        id: published.id,
        type: EventV2.versionedType(SessionV1.Event.PartUpdated.type, 1),
        aggregateID: sessionID,
        seq: 1,
        data: {
          sessionID,
          time: 1,
          part: {
            id: SessionV1.PartID.make("prt_file_part_two_db"),
            sessionID,
            messageID: SessionV1.MessageID.make("msg_file_part_two_db"),
            type: "file",
            mime: "application/octet-stream",
            filename: "large.bin",
            url: `data:text/plain;base64,${body.toString("base64")}`,
          },
        },
      }).pipe(Effect.catchDefect(Effect.succeed))
      expect(differentRawSource).toBeInstanceOf(EventV2.InvalidSyncEventError)

      const snapshotRef = yield* FilePartArtifact.snapshotRef(sourceDb, {
        aggregateID: sessionID,
        partID: SessionV1.PartID.make("prt_file_part_two_db"),
        descriptor,
      })
      yield* Effect.forEach(
        chunks,
        (chunk, index) =>
          FilePartArtifact.importChunk({
            metadata: snapshotRef,
            index,
            hash: snapshotRef.chunkHashes[index]!,
            data: chunk,
          }).pipe(Effect.provide(snapshotTarget)),
        { discard: true },
      )
      const beforeSequence = yield* FilePartArtifact.bindSnapshotRef({
        metadata: snapshotRef,
        partID: SessionV1.PartID.make("prt_file_part_two_db"),
      }).pipe(Effect.provide(snapshotTarget), Effect.exit)
      expect(beforeSequence._tag).toBe("Failure")
      expect(yield* snapshotDb.select().from(FilePartArtifactBindingTable).all()).toEqual([])
      expect(yield* snapshotDb.select().from(FilePartArtifactImportTable).all()).toHaveLength(1)

      yield* snapshotDb
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/snapshot"), sandboxes: [] })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      yield* snapshotDb
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "snapshot-file-part",
          directory: AbsolutePath.make("/snapshot"),
          title: "snapshot-file-part",
          version: "test",
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      const canonicalPart = snapshotRef.canonicalData.part as Record<string, unknown>
      yield* snapshotDb
        .insert(MessageTable)
        .values({
          id: canonicalPart.messageID as SessionV1.MessageID,
          session_id: sessionID,
          time_created: 1,
          data: { role: "user", time: { created: 1 } },
        } as typeof MessageTable.$inferInsert)
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      const projectedPartData = Object.fromEntries(
        Object.entries(canonicalPart).filter(([key]) => key !== "id" && key !== "sessionID" && key !== "messageID"),
      )
      yield* snapshotDb
        .insert(PartTable)
        .values({
          id: SessionV1.PartID.make("prt_file_part_two_db"),
          message_id: canonicalPart.messageID as SessionV1.MessageID,
          session_id: sessionID,
          time_created: 1,
          data: projectedPartData,
        } as typeof PartTable.$inferInsert)
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      yield* snapshotDb
        .update(PartTable)
        .set({ data: { ...projectedPartData, filename: "tampered.bin" } as unknown as typeof PartTable.$inferInsert["data"] })
        .where(eq(PartTable.id, SessionV1.PartID.make("prt_file_part_two_db")))
        .run()
        .pipe(Effect.orDie)
      const mismatchedProjection = yield* FilePartArtifact.bindSnapshotRef({
        metadata: snapshotRef,
        partID: SessionV1.PartID.make("prt_file_part_two_db"),
      }).pipe(Effect.provide(snapshotTarget), Effect.exit)
      expect(mismatchedProjection._tag).toBe("Failure")
      expect(yield* snapshotDb.select().from(FilePartArtifactBindingTable).all()).toEqual([])
      expect(yield* snapshotDb.select().from(FilePartArtifactImportTable).all()).toHaveLength(1)
      yield* snapshotDb
        .update(PartTable)
        .set({ data: projectedPartData as typeof PartTable.$inferInsert["data"] })
        .where(eq(PartTable.id, SessionV1.PartID.make("prt_file_part_two_db")))
        .run()
        .pipe(Effect.orDie)
      yield* snapshotDb
        .insert(EventSequenceTable)
        .values({ aggregate_id: sessionID, seq: 1 })
        .run()
        .pipe(Effect.orDie)
      yield* FilePartArtifact.bindSnapshotRef({
        metadata: snapshotRef,
        partID: SessionV1.PartID.make("prt_file_part_two_db"),
      }).pipe(Effect.provide(snapshotTarget))
      expect(
        yield* FilePartArtifact.read({ aggregateID: sessionID, descriptor }).pipe(Effect.provide(snapshotTarget)),
      ).toEqual(body)
      expect(yield* snapshotDb.select().from(FilePartArtifactImportTable).all()).toEqual([])
    }),
  )

  it.effect("discards abandoned imports and reclaims artifact bodies after the last aggregate binding", () =>
    Effect.gen(function* () {
      const runtimeLayer = yield* Layer.buildWithScope(Layer.fresh(runtime()), yield* Effect.scope)
      const events = Context.get(runtimeLayer, EventV2.Service)
      const db = Context.get(runtimeLayer, Database.Service).db
      const sessionID = SessionSchema.ID.make("ses_file_part_cleanup")
      const body = Buffer.alloc(FilePartArtifact.CHUNK_BYTES + 1, 0x41)
      const descriptor = FilePartArtifact.Descriptor.make({
        codec: FilePartArtifact.CODEC,
        id: FilePartArtifact.ID.make(`fpart_${Hash.sha256(body)}`),
        hash: Hash.sha256(body),
        bytes: body.length,
        chunkBytes: FilePartArtifact.CHUNK_BYTES,
        chunks: 2,
      })
      const canonicalData = {
        sessionID,
        time: 1,
        part: {
          id: SessionV1.PartID.make("prt_file_part_cleanup"),
          messageID: SessionV1.MessageID.make("msg_file_part_cleanup"),
          sessionID,
          type: "file",
          mime: "application/octet-stream",
          url: `event-artifact:${descriptor.id}`,
          artifact: descriptor,
        },
      }
      const metadata = FilePartArtifact.Metadata.make({
        eventID: EventV2.ID.create(),
        aggregateID: sessionID,
        seq: 0,
        originalDataHash: Hash.sha256("original"),
        canonicalDataHash: FilePartArtifact.dataHash(canonicalData),
        canonicalData,
        descriptor,
        chunkHashes: [Hash.sha256(body.subarray(0, FilePartArtifact.CHUNK_BYTES)), Hash.sha256(body.subarray(FilePartArtifact.CHUNK_BYTES))],
      })
      yield* FilePartArtifact.importChunk({
        metadata,
        index: 0,
        hash: metadata.chunkHashes[0]!,
        data: body.subarray(0, FilePartArtifact.CHUNK_BYTES),
      }).pipe(Effect.provide(runtimeLayer))
      yield* FilePartArtifact.importChunk({
        metadata,
        index: 1,
        hash: metadata.chunkHashes[1]!,
        data: body.subarray(FilePartArtifact.CHUNK_BYTES),
      }).pipe(Effect.provide(runtimeLayer))
      expect(yield* db.select().from(FilePartArtifactImportTable).all()).toHaveLength(1)
      expect(yield* FilePartArtifact.discardImport({
        eventID: metadata.eventID as EventV2.ID,
        aggregateID: sessionID,
        artifactID: descriptor.id,
      }).pipe(Effect.provide(runtimeLayer))).toBe(true)
      expect(yield* db.select().from(FilePartArtifactImportTable).all()).toEqual([])
      expect(yield* db.select().from(FilePartArtifactDiscardTable).all()).toEqual([])
      expect(yield* db.select().from(FilePartArtifactTable).all()).toEqual([])
      expect(yield* db.select().from(FilePartArtifactChunkTable).all()).toEqual([])

      const projected = yield* Layer.buildWithScope(Layer.fresh(projectedRuntime()), yield* Effect.scope)
      const projectedEvents = Context.get(projected, EventV2.Service)
      const projectedDb = Context.get(projected, Database.Service).db
      yield* projectedDb.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make("/cleanup"), sandboxes: [] }).run().pipe(Effect.orDie)
      yield* projectedEvents.publish(SessionV1.Event.Created, {
        sessionID,
        info: SessionV1.SessionInfo.make({ id: sessionID, slug: "cleanup", version: "test", projectID: Project.ID.global,
          directory: "/cleanup", title: "cleanup", cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 1, updated: 1 } }),
      })
      yield* projectedEvents.publish(SessionV1.Event.MessageUpdated, { sessionID, info: { id: SessionV1.MessageID.make("msg_file_part_cleanup"), sessionID,
        role: "user", time: { created: 1 }, agent: "build",
        model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") } } })
      yield* projectedEvents.publish(SessionV1.Event.PartUpdated, {
        sessionID,
        time: 1,
        part: { id: SessionV1.PartID.make("prt_file_part_cleanup"), messageID: SessionV1.MessageID.make("msg_file_part_cleanup"), sessionID,
          type: "file", mime: "application/octet-stream", url: `data:application/octet-stream;base64,${body.toString("base64")}` },
      })
      expect(yield* projectedDb.select().from(FilePartArtifactBindingTable).all()).toHaveLength(1)
      expect(yield* projectedDb.select().from(FilePartArtifactTable).all()).toHaveLength(1)
      yield* projectedEvents.remove(sessionID)
      expect(yield* projectedDb.select().from(FilePartArtifactBindingTable).all()).toEqual([])
      expect(yield* projectedDb.select().from(FilePartArtifactTable).all()).toEqual([])
      expect(yield* projectedDb.select().from(FilePartArtifactChunkTable).all()).toEqual([])
    }),
  )
})
