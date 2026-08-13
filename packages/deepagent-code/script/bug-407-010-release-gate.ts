#!/usr/bin/env bun

import { Database } from "@deepagent-code/core/database/database"
import { EventV2 } from "@deepagent-code/core/event"
import {
  EventArtifactTable,
  EventCompactionReceiptTable,
  EventSequenceTable,
  EventSnapshotTable,
  EventSnapshotChunkTable,
  EventSnapshotRowTable,
  EventSyncBackfillTable,
  EventSyncIndexTable,
  EventTable,
} from "@deepagent-code/core/event/sql"
import { FilePartArtifact } from "@deepagent-code/core/file-part-artifact"
import { FilePartArtifactBindingTable } from "@deepagent-code/core/file-part-artifact.sql"
import { SessionProjector } from "@deepagent-code/core/session/projector"
import { MessageTable, SessionTable } from "@deepagent-code/core/session/sql"
import { Hash } from "@deepagent-code/core/util/hash"
import { Cause, Effect, Exit, Layer, Option, Schema } from "effect"
import { and, asc, eq, sql } from "drizzle-orm"
import path from "node:path"
import { parseArgs } from "node:util"
import { SessionDiffArtifact } from "@/session/diff-artifact"
import { SessionDiffMigrationReceiptTable } from "@/session/diff-artifact.sql"
import { SessionID } from "@/session/schema"

const args = parseArgs({
  args: process.argv.slice(2),
  options: {
    database: { type: "string" },
    session: { type: "string", multiple: true },
  },
  strict: true,
})
const filename = args.values.database ? path.resolve(args.values.database) : undefined
const sessions = (args.values.session ?? []).map((sessionID) => SessionID.make(sessionID))

if (!filename || !path.basename(filename).includes("release-gate"))
  throw new Error("--database must name an explicit release-gate copy")
if (!(await Bun.file(filename).exists())) throw new Error(`Release-gate database does not exist: ${filename}`)
if (sessions.length === 0) throw new Error("At least one --session is required")

const databaseLayer = Database.layerFromPath(filename)
const eventLayer = EventV2.layer.pipe(Layer.provide(databaseLayer))
const projectorLayer = SessionProjector.layer.pipe(Layer.provide(eventLayer), Layer.provide(databaseLayer))
const runtime = Layer.mergeAll(databaseLayer, eventLayer, projectorLayer)

const stage = Effect.fn("Bug407010ReleaseGate.stage")(function* <A, E, R>(
  name: string,
  effect: Effect.Effect<A, E, R>,
) {
  const started = Bun.nanoseconds()
  const result = yield* effect
  const { db } = yield* Database.Service
  yield* db.run("PRAGMA shrink_memory").pipe(Effect.orDie)
  yield* Effect.sync(() => Bun.gc(true))
  console.log(JSON.stringify({
    stage: name,
    elapsedMs: Math.round((Bun.nanoseconds() - started) / 1_000_000),
    rssBytes: process.memoryUsage.rss(),
    result,
  }))
  return result
})

const program = Effect.gen(function* () {
  const { db } = yield* Database.Service
  const events = yield* EventV2.Service

  const before = yield* db.all<{
    events: number
    eventBytes: number
    maximumEventBytes: number
    sessions: number
  }>(`
    SELECT
      (SELECT count(*) FROM event) AS events,
      (SELECT coalesce(sum(length(data)), 0) FROM event) AS eventBytes,
      (SELECT coalesce(max(length(data)), 0) FROM event) AS maximumEventBytes,
      (SELECT count(*) FROM session) AS sessions
  `).pipe(Effect.orDie)
  console.log(JSON.stringify({ stage: "before", database: filename, ...before[0], rssBytes: process.memoryUsage.rss() }))

  yield* stage("event-index", Effect.gen(function* () {
    let batches = 0
    let processed = 0
    while (true) {
      const result = yield* events.backfillSyncIndex!({ limit: 5000 })
      batches += 1
      processed += result.processed
      if (result.complete) return { batches, processed }
    }
  }))

  yield* stage("legacy-message-artifacts", Effect.gen(function* () {
    let batches = 0
    let processed = 0
    let cursor: EventV2.ID | undefined
    while (true) {
      const result = yield* events.canonicalizeLegacyArtifacts({ ...(cursor ? { afterID: cursor } : {}), limit: 1 })
      batches += 1
      processed += result.processed
      if (!result.next) return { batches, processed }
      cursor = result.next
      if (batches % 8 === 0) {
        yield* db.run("PRAGMA shrink_memory").pipe(Effect.orDie)
        yield* Effect.sync(() => Bun.gc(true))
      }
    }
  }))

  yield* stage("legacy-file-artifacts", Effect.gen(function* () {
    let batches = 0
    let processed = 0
    let cursor: EventV2.ID | undefined
    while (true) {
      const result = yield* FilePartArtifact.canonicalizeLegacy(db, { ...(cursor ? { afterID: cursor } : {}), limit: 1 })
      batches += 1
      processed += result.processed
      if (!result.next) return { batches, processed }
      cursor = result.next
    }
  }))

  const artifactSessions = yield* db
    .selectDistinct({ id: EventArtifactTable.aggregate_id })
    .from(EventArtifactTable)
    .where(eq(EventArtifactTable.kind, "legacy_message_diff"))
    .all()
    .pipe(Effect.orDie)
  const diffMigration = yield* stage("legacy-session-diffs", Effect.gen(function* () {
    let processed = 0
    let committed = 0
    let failed = 0
    for (const row of artifactSessions) {
      while (true) {
        const result = yield* SessionDiffArtifact.migrate({ sessionID: SessionID.make(row.id), limit: 1 })
        processed += result.processed
        committed += result.committed
        failed += result.failed
        if (result.processed === 0) break
        yield* db.run("PRAGMA shrink_memory").pipe(Effect.orDie)
        yield* Effect.sync(() => Bun.gc(true))
      }
    }
    return { sessions: artifactSessions.length, processed, committed, failed }
  }))
  if (diffMigration.failed > 0)
    return yield* Effect.die(new Error(`Legacy Session diff migration failed: ${JSON.stringify(diffMigration)}`))

  const checkpointSessions = [...new Set([
    ...sessions,
    ...artifactSessions.map((row) => SessionID.make(row.id)),
  ])]

  const validateSnapshotDiffAuthority = Effect.fn("Bug407010ReleaseGate.validateSnapshotDiffAuthority")(
    function* (input: { sessionID: SessionID; snapshotID: string }) {
      const receipts = yield* db
        .select({
          messageID: SessionDiffMigrationReceiptTable.message_id,
          artifactID: SessionDiffMigrationReceiptTable.artifact_id,
          messageData: MessageTable.data,
        })
        .from(SessionDiffMigrationReceiptTable)
        .innerJoin(MessageTable, eq(MessageTable.id, SessionDiffMigrationReceiptTable.message_id))
        .where(and(
          eq(SessionDiffMigrationReceiptTable.session_id, input.sessionID),
          eq(SessionDiffMigrationReceiptTable.state, "committed"),
        ))
        .all()
        .pipe(Effect.orDie)
      for (const receipt of receipts) {
        const row = yield* db
          .select()
          .from(EventSnapshotRowTable)
          .where(and(
            eq(EventSnapshotRowTable.snapshot_id, input.snapshotID),
            eq(EventSnapshotRowTable.table_name, "message"),
            eq(EventSnapshotRowTable.row_key, receipt.messageID),
          ))
          .get()
          .pipe(Effect.orDie)
        if (!row)
          return yield* Effect.die(new Error(`Snapshot ${input.snapshotID} is missing Message ${receipt.messageID}`))
        const chunks = yield* db
          .select()
          .from(EventSnapshotChunkTable)
          .where(eq(EventSnapshotChunkTable.row_hash, row.row_hash))
          .orderBy(asc(EventSnapshotChunkTable.chunk_index))
          .all()
          .pipe(Effect.orDie)
        if (
          chunks.length !== row.chunk_count ||
          chunks.some((chunk, index) => chunk.chunk_index !== index || Hash.sha256(chunk.data) !== chunk.chunk_hash)
        )
          return yield* Effect.die(new Error(`Snapshot ${input.snapshotID} has invalid chunks for Message ${receipt.messageID}`))
        const body = Buffer.concat(chunks.map((chunk) => chunk.data))
        if (body.length !== row.row_bytes || Hash.sha256(body) !== row.row_hash)
          return yield* Effect.die(new Error(`Snapshot ${input.snapshotID} has an invalid row hash for Message ${receipt.messageID}`))
        const decoded = Option.getOrUndefined(Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(body.toString()))
        const snapshotData = record(decoded) && record(decoded.data) ? decoded.data : undefined
        const physicalDescriptor = diffArtifactDescriptor(receipt.messageData)
        const snapshotDescriptor = diffArtifactDescriptor(snapshotData)
        if (
          !physicalDescriptor ||
          !snapshotDescriptor ||
          physicalDescriptor.id !== receipt.artifactID ||
          snapshotDescriptor.id !== receipt.artifactID ||
          snapshotDescriptor.fileCount !== physicalDescriptor.fileCount ||
          snapshotDescriptor.previewFileCount !== physicalDescriptor.previewFileCount ||
          snapshotDescriptor.previewTruncated !== physicalDescriptor.previewTruncated
        )
          return yield* Effect.die(
            new Error(`Snapshot ${input.snapshotID} does not match committed diff authority for Message ${receipt.messageID}`),
          )
        if (JSON.stringify(snapshotData).includes('"patch"'))
          return yield* Effect.die(new Error(`Snapshot ${input.snapshotID} retained an inline patch for Message ${receipt.messageID}`))
      }
      return { receipts: receipts.length }
    },
  )

  yield* stage("checkpoint-and-compact", Effect.forEach(checkpointSessions, (sessionID) => Effect.gen(function* () {
    const session = yield* db
      .select({ id: SessionTable.id })
      .from(SessionTable)
      .where(eq(SessionTable.id, sessionID))
      .get()
      .pipe(Effect.orDie)
    if (!session) return yield* Effect.die(new Error(`Session not found: ${sessionID}`))
    const sequence = yield* db
      .select({ seq: EventSequenceTable.seq, ownerID: EventSequenceTable.owner_id })
      .from(EventSequenceTable)
      .where(eq(EventSequenceTable.aggregate_id, sessionID))
      .get()
      .pipe(Effect.orDie)
    if (!sequence) return yield* Effect.die(new Error(`Event sequence not found: ${sessionID}`))
    const current = yield* events.snapshot(sessionID)
    const snapshot = current?.throughSeq === sequence.seq
      ? current
      : yield* Effect.gen(function* () {
          let attempt = yield* events.prepareCheckpoint!({
            aggregateID: sessionID,
            throughSeq: EventV2.Cursor.make(sequence.seq),
            expectedLatest: EventV2.Cursor.make(sequence.seq),
            codec: "session-projection",
            schemaVersion: 1,
            ...(sequence.ownerID ? { ownerID: sequence.ownerID } : {}),
          })
          while (attempt.state === "prepared")
            attempt = yield* events.stageCheckpoint!({ snapshotID: attempt.snapshotID })
          if (attempt.state === "complete") {
            const active = yield* events.snapshot(sessionID)
            if (active?.snapshotID === attempt.snapshotID) return active
            return yield* Effect.die(new Error(`Completed snapshot is not active: ${attempt.snapshotID}`))
          }
          return yield* events.finalizeCheckpoint!({ snapshotID: attempt.snapshotID })
        })
    const authority = yield* validateSnapshotDiffAuthority({ sessionID, snapshotID: snapshot.snapshotID })
    let compacted = { deleted: 0, complete: false }
    let deleted = 0
    let batches = 0
    while (!compacted.complete) {
      compacted = yield* events.compact({
        aggregateID: sessionID,
        throughSeq: EventV2.Cursor.make(snapshot.throughSeq),
        limit: 100,
      })
      deleted += compacted.deleted
      batches += 1
    }
    yield* db.run("PRAGMA shrink_memory").pipe(Effect.orDie)
    yield* Effect.sync(() => Bun.gc(true))
    return { sessionID, snapshotID: snapshot.snapshotID, throughSeq: snapshot.throughSeq, deleted, batches, authority }
  }), { concurrency: 1 }))

  const after = yield* db.all<{
    events: number
    eventBytes: number
    maximumEventBytes: number
    syncIndex: number
    snapshots: number
    eventArtifacts: number
    fileArtifacts: number
    diffReceipts: number
    compactions: number
  }>(`
    SELECT
      (SELECT count(*) FROM event) AS events,
      (SELECT coalesce(sum(length(data)), 0) FROM event) AS eventBytes,
      (SELECT coalesce(max(length(data)), 0) FROM event) AS maximumEventBytes,
      (SELECT count(*) FROM event_sync_index) AS syncIndex,
      (SELECT count(*) FROM event_snapshot) AS snapshots,
      (SELECT count(*) FROM event_artifact) AS eventArtifacts,
      (SELECT count(*) FROM file_part_artifact_binding) AS fileArtifacts,
      (SELECT count(*) FROM session_diff_migration_receipt WHERE state = 'committed') AS diffReceipts,
      (SELECT count(*) FROM event_compaction_receipt WHERE state = 'complete') AS compactions
  `).pipe(Effect.orDie)
  const backfill = yield* db.select().from(EventSyncBackfillTable).where(eq(EventSyncBackfillTable.id, 1)).get().pipe(Effect.orDie)
  const quickCheck = yield* db.all<{ quick_check: string }>("PRAGMA quick_check").pipe(Effect.orDie)
  const foreignKeys = yield* db.all<Record<string, unknown>>("PRAGMA foreign_key_check").pipe(Effect.orDie)
  const indexed = yield* db.select({ count: sql<number>`count(*)` }).from(EventSyncIndexTable).get().pipe(Effect.orDie)
  const activeSnapshots = yield* db.select({ count: sql<number>`count(*)` }).from(EventSnapshotTable).get().pipe(Effect.orDie)
  const compactions = yield* db.select({ count: sql<number>`count(*)` }).from(EventCompactionReceiptTable).get().pipe(Effect.orDie)
  const diffReceipts = yield* db.select({ count: sql<number>`count(*)` }).from(SessionDiffMigrationReceiptTable).get().pipe(Effect.orDie)
  const failedDiffReceipts = yield* db
    .select({ count: sql<number>`count(*)` })
    .from(SessionDiffMigrationReceiptTable)
    .where(eq(SessionDiffMigrationReceiptTable.state, "migration_validation_failed"))
    .get()
    .pipe(Effect.orDie)
  const fileArtifacts = yield* db.select({ count: sql<number>`count(*)` }).from(FilePartArtifactBindingTable).get().pipe(Effect.orDie)
  const result = {
    ...after[0],
    indexed: indexed?.count ?? 0,
    activeSnapshots: activeSnapshots?.count ?? 0,
    compactionReceipts: compactions?.count ?? 0,
    diffMigrationReceipts: diffReceipts?.count ?? 0,
    failedDiffMigrationReceipts: failedDiffReceipts?.count ?? 0,
    fileArtifactBindings: fileArtifacts?.count ?? 0,
    backfill,
    quickCheck: quickCheck.map((row) => row.quick_check),
    foreignKeyViolations: foreignKeys.length,
    rssBytes: process.memoryUsage.rss(),
  }
  if (
    backfill?.state !== "complete" ||
    quickCheck.some((row) => row.quick_check !== "ok") ||
    foreignKeys.length > 0 ||
    result.failedDiffMigrationReceipts > 0
  )
    return yield* Effect.die(new Error(`Release gate failed: ${JSON.stringify(result)}`))
  console.log(JSON.stringify({ stage: "after", ...result }))
})

const exit = await Effect.runPromiseExit(program.pipe(Effect.provide(runtime), Effect.scoped))
if (Exit.isFailure(exit)) {
  for (const error of Cause.prettyErrors(exit.cause)) console.error(error)
  process.exit(1)
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function diffArtifactDescriptor(value: unknown) {
  if (!record(value) || !record(value.summary) || !record(value.summary.diffArtifact)) return
  const descriptor = value.summary.diffArtifact
  if (
    typeof descriptor.id !== "string" ||
    typeof descriptor.fileCount !== "number" ||
    typeof descriptor.previewFileCount !== "number" ||
    typeof descriptor.previewTruncated !== "boolean" ||
    descriptor.previewTruncated !== (descriptor.previewFileCount < descriptor.fileCount)
  )
    return
  return {
    id: descriptor.id,
    fileCount: descriptor.fileCount,
    previewFileCount: descriptor.previewFileCount,
    previewTruncated: descriptor.previewTruncated,
  }
}
