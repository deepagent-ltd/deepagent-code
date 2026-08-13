import { describe, expect } from "bun:test"
import { Context, Effect, Layer } from "effect"
import { eq, sql } from "drizzle-orm"
import { Database } from "@deepagent-code/core/database/database"
import { EventV2 } from "@deepagent-code/core/event"
import { EventSequenceTable, EventSyncSequenceTable, EventTable } from "@deepagent-code/core/event/sql"
import { FilePartArtifact } from "@deepagent-code/core/file-part-artifact"
import {
  FilePartArtifactBindingTable,
  FilePartArtifactChunkTable,
  FilePartArtifactImportTable,
  FilePartArtifactTable,
} from "@deepagent-code/core/file-part-artifact.sql"
import { SessionSchema } from "@deepagent-code/core/session/schema"
import { SessionV1 } from "@deepagent-code/core/v1/session"
import { Hash } from "@deepagent-code/core/util/hash"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { Project } from "@deepagent-code/core/project"
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
      const published = yield* sourceEvents.publish(SessionV1.Event.PartUpdated, {
        sessionID,
        time: 1,
        part: {
          id: SessionV1.PartID.make("prt_file_part_two_db"),
          sessionID,
          messageID: SessionV1.MessageID.make("msg_file_part_two_db"),
          type: "file",
          mime: "application/octet-stream",
          filename: "large.bin",
          url: `data:application/octet-stream;base64,${body.toString("base64")}`,
        },
      })
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
      expect(yield* targetDb.select().from(FilePartArtifactImportTable).all()).toEqual([])

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
})
