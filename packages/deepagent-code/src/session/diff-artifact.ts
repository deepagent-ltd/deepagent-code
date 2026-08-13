import { Database } from "@deepagent-code/core/database/database"
import { EventArtifactChunkTable, EventArtifactTable } from "@deepagent-code/core/event/sql"
import { MessageTable, SessionPromptEpochMessageTable, SessionTable } from "@deepagent-code/core/session/sql"
import { CanonicalJson } from "@deepagent-code/core/util/canonical-json"
import { Hash } from "@deepagent-code/core/util/hash"
import { SessionV1 } from "@deepagent-code/core/v1/session"
import { MessageID, SessionID } from "./schema"
import { MessageV2 } from "./message-v2"
import { HistoryAuthority } from "./history-authority"
import { SessionPromptEpochTable } from "./prompt-epoch.sql"
import {
  SessionDiffArtifactFileChunkTable,
  SessionDiffArtifactFileTable,
  SessionDiffMigrationReceiptTable,
} from "./diff-artifact.sql"
import { and, asc, eq, gt, sql } from "drizzle-orm"
import { createHash } from "node:crypto"
import { Data, Effect, Schema } from "effect"
import { Descriptor, File, Limits, Manifest, ManifestFile } from "./diff-artifact-schema"

export { Descriptor, File, Limits, Manifest, ManifestFile } from "./diff-artifact-schema"

const FILE_CHUNK_BYTES = 256 * 1024
const MAX_MIGRATION_FILES = 10_000
const MAX_MIGRATION_BODY_BYTES = 64 * 1024 * 1024
const MAX_PATH_BYTES = 4096
const NULL_SUMMARY_HASH = Hash.sha256("null")

export class Invalid extends Data.TaggedError("SessionDiffArtifact.Invalid")<{
  readonly message: string
}> {}

export class NotFound extends Data.TaggedError("SessionDiffArtifact.NotFound")<{
  readonly message: string
}> {}

class RewriteCasLost extends Data.TaggedError("SessionDiffArtifact.RewriteCasLost")<{
  readonly message: string
  readonly expectedMessageDataHash: string
  readonly expectedSessionSummaryHash: string
}> {}

type CanonicalArtifact = {
  id: string
  hash: string
  codec: "legacy-message-diff.v1" | "legacy-message-diff.v2"
  fileCount: number
}

type Candidate = {
  artifactID: string
  sourceEventID: string
  sourceSeq: number
  sessionID: SessionID
  messageID: MessageID
  originalDataHash: string
  canonicalDataHash: string
  canonicalDataText: string
  bodyHash: string
  bodyBytes: number
  chunkCount: number
  codecVersion: number
  canonicalData: Record<string, unknown>
}

export const migrate = Effect.fn("SessionDiffArtifact.migrate")(function* (input: {
  sessionID: SessionID
  limit?: number
  now?: number
}) {
  const { db } = yield* Database.Service
  const limit = Math.min(Math.max(input.limit ?? Limits.batch, 1), Limits.batch)
  const candidates = yield* db
    .select({
      artifactID: EventArtifactTable.artifact_id,
      sourceEventID: EventArtifactTable.event_id,
      sourceSeq: EventArtifactTable.seq,
      sessionID: EventArtifactTable.aggregate_id,
      messageID: sql<MessageID>`json_extract(${EventArtifactTable.canonical_data}, '$.info.id')`,
      originalDataHash: EventArtifactTable.original_data_hash,
      canonicalDataHash: EventArtifactTable.canonical_data_hash,
      canonicalDataText: sql<string>`CAST(${EventArtifactTable.canonical_data} AS TEXT)`,
      bodyHash: EventArtifactTable.body_hash,
      bodyBytes: EventArtifactTable.body_bytes,
      chunkCount: EventArtifactTable.chunk_count,
      codecVersion: EventArtifactTable.codec_version,
      canonicalData: EventArtifactTable.canonical_data,
    })
    .from(EventArtifactTable)
    .innerJoin(
      MessageTable,
      and(
        eq(MessageTable.session_id, EventArtifactTable.aggregate_id),
        sql`${MessageTable.id} = json_extract(${EventArtifactTable.canonical_data}, '$.info.id')`,
      ),
    )
    .leftJoin(
      SessionDiffMigrationReceiptTable,
      eq(SessionDiffMigrationReceiptTable.message_id, MessageTable.id),
    )
    .where(
      and(
        eq(EventArtifactTable.aggregate_id, input.sessionID),
        eq(EventArtifactTable.kind, "legacy_message_diff"),
        sql`json_extract(${MessageTable.data}, '$.role') = 'user'`,
        sql`json_type(${MessageTable.data}, '$.summary.diffs') = 'array'`,
        sql`${SessionDiffMigrationReceiptTable.message_id} is null`,
      ),
    )
    .orderBy(asc(EventArtifactTable.event_id))
    .limit(limit)
    .all()
    .pipe(Effect.orDie)
  const results = yield* Effect.forEach(candidates, (candidate) =>
    migrateCandidate(
      db,
      { ...candidate, sessionID: SessionID.make(candidate.sessionID) },
      input.now ?? Date.now(),
    ),
  )
  return {
    processed: results.length,
    committed: results.filter((result) => result.state === "committed").length,
    failed: results.filter((result) => result.state === "migration_validation_failed").length,
  }
})

function migrateCandidate(db: Database.Interface["db"], candidate: Candidate, now: number) {
  return db
    .transaction(
      (tx) =>
        Effect.gen(function* () {
          const existing = yield* tx
            .select()
            .from(SessionDiffMigrationReceiptTable)
            .where(eq(SessionDiffMigrationReceiptTable.message_id, candidate.messageID))
            .get()
          if (existing?.state === "committed") {
            if (
              existing.session_id !== candidate.sessionID ||
              existing.artifact_id !== candidate.artifactID ||
              existing.source_event_id !== candidate.sourceEventID
            )
              return yield* Effect.die(new Error(`Committed diff migration receipt conflict: ${candidate.messageID}`))
            return { state: "committed" as const }
          }
          if (existing?.state === "migration_validation_failed")
            return { state: "migration_validation_failed" as const }

          const failure = (reason: string, expectedMessageDataHash = Hash.sha256("missing")) =>
            Effect.gen(function* () {
              yield* tx
                .delete(SessionDiffArtifactFileChunkTable)
                .where(eq(SessionDiffArtifactFileChunkTable.artifact_id, candidate.artifactID))
                .run()
              yield* tx
                .delete(SessionDiffArtifactFileTable)
                .where(eq(SessionDiffArtifactFileTable.artifact_id, candidate.artifactID))
                .run()
              return yield* tx
              .insert(SessionDiffMigrationReceiptTable)
              .values({
                message_id: candidate.messageID,
                session_id: candidate.sessionID,
                artifact_id: candidate.artifactID,
                source_event_id: candidate.sourceEventID,
                expected_message_data_hash: expectedMessageDataHash,
                expected_session_summary_hash: Hash.sha256("unknown"),
                canonicalizer_version: candidate.codecVersion,
                canonicalization_version: HistoryAuthority.CANONICALIZATION_VERSION,
                epoch_hashes: [],
                state: "migration_validation_failed" as const,
                failure_reason: reason,
                created_at: now,
                updated_at: now,
              })
              .onConflictDoUpdate({
                target: SessionDiffMigrationReceiptTable.message_id,
                set: { state: "migration_validation_failed", failure_reason: reason, updated_at: now },
              })
              .run()
              .pipe(Effect.orDie, Effect.as({ state: "migration_validation_failed" as const }))
            })

          const artifact = canonicalArtifact(candidate)
          if (!artifact) return yield* failure("canonical artifact descriptor is invalid")
          if (candidate.bodyBytes > MAX_MIGRATION_BODY_BYTES)
            return yield* failure("artifact body exceeds the migration byte budget")
          if (Hash.sha256(candidate.canonicalDataText) !== candidate.canonicalDataHash)
            return yield* failure("artifact canonical data hash mismatch")
          const source = yield* tx.get<{ bytes: number }>(sql`
            SELECT length(CAST(data AS BLOB)) AS bytes
            FROM event
            WHERE id = ${candidate.sourceEventID}
              AND aggregate_id = ${candidate.sessionID}
              AND seq = ${candidate.sourceSeq}
          `)
          if (!source) return yield* failure("artifact source event is missing")
          const sourceDigest = createHash("sha256")
          const sourceChunkCount = Math.ceil(source.bytes / FILE_CHUNK_BYTES) || 1
          for (const index of Array.from({ length: sourceChunkCount }, (_, chunkIndex) => chunkIndex)) {
            const sourceChunk = yield* tx.get<{ data: Buffer }>(sql`
              SELECT substr(CAST(data AS BLOB), ${index * FILE_CHUNK_BYTES + 1}, ${FILE_CHUNK_BYTES}) AS data
              FROM event
              WHERE id = ${candidate.sourceEventID}
                AND aggregate_id = ${candidate.sessionID}
            `)
            if (!sourceChunk) return yield* failure(`artifact source chunk ${index} is missing`)
            sourceDigest.update(sourceChunk.data)
          }
          if (sourceDigest.digest("hex") !== candidate.originalDataHash)
            return yield* failure("artifact source event hash mismatch")
          if (candidate.chunkCount !== Math.max(1, Math.ceil(candidate.bodyBytes / FILE_CHUNK_BYTES)))
            return yield* failure("artifact chunk metadata is invalid")
          const artifactChunkCount = yield* tx
            .select({ count: sql<number>`count(*)` })
            .from(EventArtifactChunkTable)
            .where(eq(EventArtifactChunkTable.artifact_id, candidate.artifactID))
            .get()
          if (artifactChunkCount?.count !== candidate.chunkCount)
            return yield* failure("artifact chunk count mismatch")
          const bodyDigest = createHash("sha256")
          let observedBodyBytes = 0
          for (const index of Array.from({ length: candidate.chunkCount }, (_, chunkIndex) => chunkIndex)) {
            const chunk = yield* tx
              .select()
              .from(EventArtifactChunkTable)
              .where(
                and(
                  eq(EventArtifactChunkTable.artifact_id, candidate.artifactID),
                  eq(EventArtifactChunkTable.chunk_index, index),
                ),
              )
              .get()
            if (!chunk || Hash.sha256(chunk.data) !== chunk.chunk_hash)
              return yield* failure(`artifact chunk ${index} failed integrity validation`)
            bodyDigest.update(chunk.data)
            observedBodyBytes += chunk.data.length
          }
          if (observedBodyBytes !== candidate.bodyBytes) return yield* failure("artifact body byte count mismatch")
          if (bodyDigest.digest("hex") !== candidate.bodyHash) return yield* failure("artifact body hash mismatch")

          const current = yield* tx.get<{ data: string; body: string }>(sql`
            SELECT CAST(message.data AS TEXT) AS data,
              json_object('diffs', json_extract(message.data, '$.summary.diffs')) AS body
            FROM message
            WHERE message.id = ${candidate.messageID}
              AND message.session_id = ${candidate.sessionID}
              AND json_extract(message.data, '$.role') = 'user'
          `)
          if (!current) return yield* failure("candidate user message is missing")
          const expectedMessageDataHash = Hash.sha256(current.data)
          const sessionSummary = yield* tx.get<{ data: string | null; body: string | null }>(sql`
            SELECT CAST(summary_diffs AS TEXT) AS data,
              CASE WHEN summary_diffs IS NULL THEN NULL ELSE json_object('diffs', json(summary_diffs)) END AS body
            FROM session
            WHERE id = ${candidate.sessionID}
          `)
          if (!sessionSummary) return yield* failure("candidate Session is missing", expectedMessageDataHash)
          const expectedSessionSummaryHash = Hash.sha256(sessionSummary.data ?? "null")
          if (Hash.sha256(current.body) !== candidate.bodyHash)
            return yield* failure("message inline diff no longer matches the committed artifact", expectedMessageDataHash)
          if (sessionSummary.body !== null && Hash.sha256(sessionSummary.body) !== candidate.bodyHash)
            return yield* failure("Session summary no longer matches the committed artifact", expectedMessageDataHash)

          const decoded = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(current.data)
          const parsed = decoded._tag === "Some" ? decoded.value : undefined
          if (!record(parsed) || parsed.role !== "user" || !record(parsed.summary))
            return yield* failure("candidate message shape is invalid", expectedMessageDataHash)
          const next = {
            ...parsed,
            summary: {
              ...parsed.summary,
              diffs: undefined,
              diffArtifact: artifact,
            },
          }
          delete next.summary.diffs
          const nextData = CanonicalJson.stringify(next)
          const epochHashes = yield* validateEpochHashes(
            tx as unknown as Database.Interface["db"],
            candidate.sessionID,
            candidate.messageID,
            parsed,
            next,
          )
          if ("failure" in epochHashes)
            return yield* failure(epochHashes.failure ?? "history authority validation failed", expectedMessageDataHash)

          yield* tx
            .insert(SessionDiffMigrationReceiptTable)
            .values({
              message_id: candidate.messageID,
              session_id: candidate.sessionID,
              artifact_id: candidate.artifactID,
              source_event_id: candidate.sourceEventID,
              expected_message_data_hash: expectedMessageDataHash,
              expected_session_summary_hash: expectedSessionSummaryHash,
              canonicalizer_version: candidate.codecVersion,
              canonicalization_version: HistoryAuthority.CANONICALIZATION_VERSION,
              epoch_hashes: epochHashes.values,
              state: "prepared",
              created_at: now,
              updated_at: now,
            })
            .run()

          const files = yield* tx.all<{
            file_index: number
            path: string
            additions: number
            deletions: number
            status: "added" | "deleted" | "modified" | null
            patch_bytes: number
          }>(sql`
            SELECT CAST(diff.key AS INTEGER) AS file_index,
              json_extract(diff.value, '$.file') AS path,
              CAST(COALESCE(json_extract(diff.value, '$.additions'), 0) AS INTEGER) AS additions,
              CAST(COALESCE(json_extract(diff.value, '$.deletions'), 0) AS INTEGER) AS deletions,
              json_extract(diff.value, '$.status') AS status,
              length(CAST(COALESCE(json_extract(diff.value, '$.patch'), '') AS BLOB)) AS patch_bytes
            FROM message source, json_each(json_extract(source.data, '$.summary.diffs')) AS diff
            WHERE source.id = ${candidate.messageID}
              AND source.session_id = ${candidate.sessionID}
            ORDER BY CAST(diff.key AS INTEGER)
            LIMIT ${MAX_MIGRATION_FILES + 1}
          `)
          if (files.length !== artifact.fileCount || files.length > MAX_MIGRATION_FILES)
            return yield* failure("artifact file manifest count is invalid", expectedMessageDataHash)
          const pathKeys = new Set<string>()
          for (const file of files) {
            const path = normalizePath(file.path)
            if (!path) return yield* failure(`artifact file path ${file.file_index} is invalid`, expectedMessageDataHash)
            const pathKey = path.toLocaleLowerCase("en-US")
            if (pathKeys.has(pathKey)) return yield* failure("artifact contains a case-colliding file path", expectedMessageDataHash)
            pathKeys.add(pathKey)
            const chunkCount = Math.max(1, Math.ceil(file.patch_bytes / FILE_CHUNK_BYTES))
            const digest = createHash("sha256")
            yield* tx
              .insert(SessionDiffArtifactFileTable)
              .values({
                artifact_id: candidate.artifactID,
                file_index: file.file_index,
                path,
                path_key: pathKey,
                additions: file.additions,
                deletions: file.deletions,
                status: file.status,
                patch_hash: Hash.sha256("pending"),
                patch_bytes: file.patch_bytes,
                patch_chunk_count: chunkCount,
              })
              .run()
            for (const index of Array.from({ length: chunkCount }, (_, chunkIndex) => chunkIndex)) {
              const patchChunk = yield* tx.get<{ data: Buffer }>(sql`
                  SELECT substr(
                    CAST(COALESCE(json_extract(diff.value, '$.patch'), '') AS BLOB),
                    ${index * FILE_CHUNK_BYTES + 1}, ${FILE_CHUNK_BYTES}
                  ) AS data
                  FROM message source, json_each(json_extract(source.data, '$.summary.diffs')) AS diff
                  WHERE source.id = ${candidate.messageID}
                    AND source.session_id = ${candidate.sessionID}
                    AND CAST(diff.key AS INTEGER) = ${file.file_index}
                `)
              if (!patchChunk)
                return yield* failure(`artifact file ${file.file_index} chunk is missing`, expectedMessageDataHash)
              digest.update(patchChunk.data)
              yield* tx
                .insert(SessionDiffArtifactFileChunkTable)
                .values({
                  artifact_id: candidate.artifactID,
                  file_index: file.file_index,
                  chunk_index: index,
                  data: patchChunk.data,
                  chunk_hash: Hash.sha256(patchChunk.data),
                })
                .run()
            }
            yield* tx
              .update(SessionDiffArtifactFileTable)
              .set({ patch_hash: digest.digest("hex") })
              .where(
                and(
                  eq(SessionDiffArtifactFileTable.artifact_id, candidate.artifactID),
                  eq(SessionDiffArtifactFileTable.file_index, file.file_index),
                ),
              )
              .run()
          }

          const updated = yield* tx
            .update(MessageTable)
            .set({
              data: sql`json(${nextData})` as unknown as typeof MessageTable.$inferInsert.data,
              time_updated: now,
            })
            .where(
              and(
                eq(MessageTable.id, candidate.messageID),
                eq(MessageTable.session_id, candidate.sessionID),
                sql`CAST(${MessageTable.data} AS TEXT) = ${current.data}`,
              ),
            )
            .returning({ data: sql<string>`CAST(${MessageTable.data} AS TEXT)` })
            .get()
          if (!updated)
            return yield* new RewriteCasLost({
              message: "message compare-and-swap lost",
              expectedMessageDataHash,
              expectedSessionSummaryHash,
            })
          const committedMessageDataHash = Hash.sha256(updated.data)
          if (committedMessageDataHash !== Hash.sha256(nextData))
            return yield* Effect.die(new Error(`Committed diff message bytes diverged: ${candidate.messageID}`))
          if (sessionSummary.data !== null) {
            const sessionUpdated = yield* tx
              .update(SessionTable)
              .set({ summary_diffs: null })
              .where(
                and(
                  eq(SessionTable.id, candidate.sessionID),
                  sql`CAST(${SessionTable.summary_diffs} AS TEXT) = ${sessionSummary.data}`,
                ),
              )
              .returning({ id: SessionTable.id })
              .get()
            if (!sessionUpdated)
              return yield* new RewriteCasLost({
                message: "Session summary compare-and-swap lost",
                expectedMessageDataHash,
                expectedSessionSummaryHash,
              })
          }
          yield* tx
            .update(SessionDiffMigrationReceiptTable)
            .set({
              state: "committed",
              committed_message_data_hash: committedMessageDataHash,
              committed_session_summary_hash: NULL_SUMMARY_HASH,
              updated_at: now,
              committed_at: now,
            })
            .where(
              and(
                eq(SessionDiffMigrationReceiptTable.message_id, candidate.messageID),
                eq(SessionDiffMigrationReceiptTable.state, "prepared"),
              ),
            )
            .run()
          return { state: "committed" as const }
        }),
      { behavior: "immediate" },
    )
    .pipe(
      Effect.catchTag("SessionDiffArtifact.RewriteCasLost", (error) =>
        db
          .transaction(
            (tx) =>
              tx
                .insert(SessionDiffMigrationReceiptTable)
                .values({
                  message_id: candidate.messageID,
                  session_id: candidate.sessionID,
                  artifact_id: candidate.artifactID,
                  source_event_id: candidate.sourceEventID,
                  expected_message_data_hash: error.expectedMessageDataHash,
                  expected_session_summary_hash: error.expectedSessionSummaryHash,
                  canonicalizer_version: candidate.codecVersion,
                  canonicalization_version: HistoryAuthority.CANONICALIZATION_VERSION,
                  epoch_hashes: [],
                  state: "migration_validation_failed" as const,
                  failure_reason: error.message,
                  created_at: now,
                  updated_at: now,
                })
                .onConflictDoUpdate({
                  target: SessionDiffMigrationReceiptTable.message_id,
                  set: {
                    state: "migration_validation_failed",
                    failure_reason: error.message,
                    updated_at: now,
                  },
                })
                .run(),
            { behavior: "immediate" },
          )
          .pipe(Effect.orDie, Effect.as({ state: "migration_validation_failed" as const })),
      ),
      Effect.orDie,
    )
}

function canonicalArtifact(candidate: Candidate): CanonicalArtifact | undefined {
  const info = record(candidate.canonicalData.info) ? candidate.canonicalData.info : undefined
  const summary = info && record(info.summary) ? info.summary : undefined
  const descriptor = summary && record(summary.diffArtifact) ? summary.diffArtifact : undefined
  if (
    info?.id !== candidate.messageID ||
    !descriptor ||
    descriptor.id !== candidate.artifactID ||
    descriptor.hash !== candidate.bodyHash ||
    (descriptor.codec !== "legacy-message-diff.v1" && descriptor.codec !== "legacy-message-diff.v2") ||
    typeof descriptor.fileCount !== "number" ||
    !Number.isSafeInteger(descriptor.fileCount) ||
    descriptor.fileCount < 0
  )
    return
  return descriptor as CanonicalArtifact
}

function validateEpochHashes(
  tx: Database.Interface["db"],
  sessionID: SessionID,
  messageID: MessageID,
  beforeInfo: Record<string, unknown>,
  afterInfo: Record<string, unknown>,
) {
  return Effect.gen(function* () {
    const epochs = yield* tx
      .select()
      .from(SessionPromptEpochTable)
      .where(eq(SessionPromptEpochTable.session_id, sessionID))
      .orderBy(asc(SessionPromptEpochTable.epoch))
      .all()
    const physicalIDs = (
      yield* tx
        .select({ id: MessageTable.id })
        .from(MessageTable)
        .where(eq(MessageTable.session_id, sessionID))
        .orderBy(asc(MessageTable.time_created), asc(MessageTable.id))
        .all()
    ).map((row) => row.id)
    const values = [] as Array<{ epoch: number; before: string; after: string }>
    for (const epoch of epochs) {
      if (
        epoch.canonicalization_version !== HistoryAuthority.CANONICALIZATION_VERSION ||
        epoch.projection_version !== HistoryAuthority.PROJECTION_VERSION
      )
        return { failure: `PromptEpoch ${epoch.epoch} uses an unsupported history authority version` }
      const memberIDs = (
        yield* tx
          .select({ message_id: SessionPromptEpochMessageTable.message_id })
          .from(SessionPromptEpochMessageTable)
          .where(
            and(
              eq(SessionPromptEpochMessageTable.session_id, sessionID),
              eq(SessionPromptEpochMessageTable.prompt_epoch, epoch.epoch),
            ),
          )
          .orderBy(asc(SessionPromptEpochMessageTable.ordinal))
          .all()
      ).map((row) => row.message_id)
      const messages = yield* MessageV2.messagesInTransaction(tx, sessionID, physicalIDs)
      if (!messages) return { failure: `PromptEpoch ${epoch.epoch} physical history is incomplete` }
      const baseIDs = memberIDs.length > 0 ? memberIDs : physicalIDs.slice(0, epoch.base_message_count ?? 0)
      const base = yield* MessageV2.messagesInTransaction(tx, sessionID, baseIDs)
      if (!base) return { failure: `PromptEpoch ${epoch.epoch} references a missing base message` }
      if (epoch.base_message_count !== base.length || !epoch.effective_history_hash)
        return { failure: `PromptEpoch ${epoch.epoch} immutable base authority is incomplete` }
      if (HistoryAuthority.hash(base) !== epoch.effective_history_hash)
        return { failure: `PromptEpoch ${epoch.epoch} immutable base hash is already inconsistent` }
      const before = HistoryAuthority.hash(messages)
      const after = HistoryAuthority.hash(
        messages.map((message) =>
          message.info.id === messageID
            ? { ...message, info: { ...afterInfo, id: messageID, sessionID } as SessionV1.User }
            : message,
        ),
      )
      const isolatedBefore = HistoryAuthority.hash([
        { info: { ...beforeInfo, id: messageID, sessionID } as SessionV1.User, parts: [] },
      ])
      const isolatedAfter = HistoryAuthority.hash([
        { info: { ...afterInfo, id: messageID, sessionID } as SessionV1.User, parts: [] },
      ])
      if (before !== after || isolatedBefore !== isolatedAfter)
        return { failure: `PromptEpoch ${epoch.epoch} history hash changed during user summary rewrite` }
      values.push({ epoch: epoch.epoch, before, after })
    }
    return { values }
  })
}

export const manifest = Effect.fn("SessionDiffArtifact.manifest")(function* (input: {
  sessionID: SessionID
  messageID: MessageID
  artifactID: string
  cursor?: string
  limit?: number
}) {
  const { db } = yield* Database.Service
  const receipt = yield* requireReceipt(db, input)
  const after = decodeCursor(input.cursor)
  if (input.cursor && after === undefined) return yield* new Invalid({ message: "artifact manifest cursor is invalid" })
  const limit = Math.min(Math.max(input.limit ?? Limits.manifestFiles, 1), Limits.manifestFiles)
  const rows = yield* db
    .select()
    .from(SessionDiffArtifactFileTable)
    .where(
      and(
        eq(SessionDiffArtifactFileTable.artifact_id, input.artifactID),
        after === undefined ? undefined : gt(SessionDiffArtifactFileTable.file_index, after),
      ),
    )
    .orderBy(asc(SessionDiffArtifactFileTable.file_index))
    .limit(limit + 1)
    .all()
    .pipe(Effect.orDie)
  const files = rows.slice(0, limit)
  const descriptor = canonicalArtifact(receipt)
  if (!descriptor) return yield* new Invalid({ message: "committed artifact descriptor is invalid" })
  const fileCount = yield* db
    .select({ count: sql<number>`count(*)` })
    .from(SessionDiffArtifactFileTable)
    .where(eq(SessionDiffArtifactFileTable.artifact_id, input.artifactID))
    .get()
    .pipe(Effect.orDie)
  if (fileCount?.count !== descriptor.fileCount)
    return yield* new Invalid({ message: "artifact file manifest count mismatch" })
  return {
    artifact: descriptor,
    files: files.map((row) => ({
      file: row.path,
      additions: row.additions,
      deletions: row.deletions,
      ...(row.status ? { status: row.status } : {}),
      patchBytes: row.patch_bytes,
      patchHash: row.patch_hash,
    })),
    ...(rows.length > limit ? { nextCursor: encodeCursor(files.at(-1)!.file_index) } : {}),
    complete: rows.length <= limit,
  }
})

export const file = Effect.fn("SessionDiffArtifact.file")(function* (input: {
  sessionID: SessionID
  messageID: MessageID
  artifactID: string
  path: string
  maxBytes?: number
}) {
  const { db } = yield* Database.Service
  yield* requireReceipt(db, input)
  const path = normalizePath(input.path)
  if (!path) return yield* new Invalid({ message: "artifact file path is invalid" })
  const row = yield* db
    .select()
    .from(SessionDiffArtifactFileTable)
    .where(
      and(
        eq(SessionDiffArtifactFileTable.artifact_id, input.artifactID),
        eq(SessionDiffArtifactFileTable.path_key, path.toLocaleLowerCase("en-US")),
      ),
    )
    .get()
    .pipe(Effect.orDie)
  if (!row || row.path !== path) return yield* new NotFound({ message: "artifact file was not found" })
  const maxBytes = Math.min(Math.max(input.maxBytes ?? Limits.patchBytes, 1), Limits.patchBytes)
  if (row.patch_chunk_count !== Math.max(1, Math.ceil(row.patch_bytes / FILE_CHUNK_BYTES)))
    return yield* new Invalid({ message: "artifact file chunk metadata is invalid" })
  const chunkCount = yield* db
    .select({ count: sql<number>`count(*)` })
    .from(SessionDiffArtifactFileChunkTable)
    .where(
      and(
        eq(SessionDiffArtifactFileChunkTable.artifact_id, input.artifactID),
        eq(SessionDiffArtifactFileChunkTable.file_index, row.file_index),
      ),
    )
    .get()
    .pipe(Effect.orDie)
  if (chunkCount?.count !== row.patch_chunk_count)
    return yield* new Invalid({ message: "artifact file chunk count mismatch" })
  const digest = createHash("sha256")
  const prefix = [] as Buffer[]
  let remaining = maxBytes
  let observedBytes = 0
  for (const index of Array.from({ length: row.patch_chunk_count }, (_, chunkIndex) => chunkIndex)) {
    const chunk = yield* db
      .select()
      .from(SessionDiffArtifactFileChunkTable)
      .where(
        and(
          eq(SessionDiffArtifactFileChunkTable.artifact_id, input.artifactID),
          eq(SessionDiffArtifactFileChunkTable.file_index, row.file_index),
          eq(SessionDiffArtifactFileChunkTable.chunk_index, index),
        ),
      )
      .get()
      .pipe(Effect.orDie)
    if (!chunk || Hash.sha256(chunk.data) !== chunk.chunk_hash)
      return yield* new Invalid({ message: `artifact file chunk ${index} failed integrity validation` })
    digest.update(chunk.data)
    observedBytes += chunk.data.length
    if (remaining > 0) {
      prefix.push(chunk.data.subarray(0, remaining))
      remaining -= Math.min(remaining, chunk.data.length)
    }
  }
  if (observedBytes !== row.patch_bytes)
    return yield* new Invalid({ message: "artifact file byte count mismatch" })
  if (digest.digest("hex") !== row.patch_hash)
    return yield* new Invalid({ message: "artifact file hash mismatch" })
  const bytes = utf8Prefix(Buffer.concat(prefix), Math.min(row.patch_bytes, maxBytes))
  return {
    artifactID: input.artifactID,
    file: row.path,
    additions: row.additions,
    deletions: row.deletions,
    ...(row.status ? { status: row.status } : {}),
    patch: bytes.toString("utf8"),
    patchBytes: row.patch_bytes,
    returnedBytes: bytes.length,
    patchHash: row.patch_hash,
    truncated: bytes.length < row.patch_bytes,
  }
})

function requireReceipt(
  db: Database.Interface["db"],
  input: { sessionID: SessionID; messageID: MessageID; artifactID: string },
) {
  return Effect.gen(function* () {
    const row = yield* db
      .select({
        receipt: SessionDiffMigrationReceiptTable,
        artifact: EventArtifactTable,
        canonicalDataText: sql<string>`CAST(${EventArtifactTable.canonical_data} AS TEXT)`,
      })
      .from(SessionDiffMigrationReceiptTable)
      .innerJoin(EventArtifactTable, eq(EventArtifactTable.artifact_id, SessionDiffMigrationReceiptTable.artifact_id))
      .where(
        and(
          eq(SessionDiffMigrationReceiptTable.session_id, input.sessionID),
          eq(SessionDiffMigrationReceiptTable.message_id, input.messageID),
          eq(SessionDiffMigrationReceiptTable.artifact_id, input.artifactID),
          eq(SessionDiffMigrationReceiptTable.state, "committed"),
        ),
      )
      .get()
      .pipe(Effect.orDie)
    if (!row) return yield* new NotFound({ message: "committed artifact was not found for this Session message" })
    if (Hash.sha256(row.canonicalDataText) !== row.artifact.canonical_data_hash)
      return yield* new Invalid({ message: "committed artifact canonical data hash mismatch" })
    return {
      artifactID: row.artifact.artifact_id,
      sourceEventID: row.artifact.event_id,
      sourceSeq: row.artifact.seq,
      sessionID: SessionID.make(row.artifact.aggregate_id),
      messageID: input.messageID,
      originalDataHash: row.artifact.original_data_hash,
      canonicalDataHash: row.artifact.canonical_data_hash,
      canonicalDataText: row.canonicalDataText,
      bodyHash: row.artifact.body_hash,
      bodyBytes: row.artifact.body_bytes,
      chunkCount: row.artifact.chunk_count,
      codecVersion: row.artifact.codec_version,
      canonicalData: row.artifact.canonical_data,
    } satisfies Candidate
  })
}

function normalizePath(value: unknown) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > MAX_PATH_BYTES ||
    value.includes("\0")
  )
    return
  const path = value.replaceAll("\\", "/")
  if (path.startsWith("/") || /^[A-Za-z]:\//.test(path)) return
  const segments = path.split("/")
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return
  return segments.join("/")
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function encodeCursor(index: number) {
  return Buffer.from(JSON.stringify({ version: 1, index })).toString("base64url")
}

function decodeCursor(value?: string) {
  if (!value) return
  const decoded = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(Buffer.from(value, "base64url").toString())
  if (!decoded._tag || decoded._tag === "None" || !record(decoded.value)) return
  const index = decoded.value.index
  if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0) return
  return index
}

function utf8Prefix(value: Buffer, limit: number) {
  const length = Math.min(value.length, limit)
  for (const end of Array.from({ length: Math.min(4, length + 1) }, (_, index) => length - index)) {
    const prefix = value.subarray(0, end)
    if (Buffer.from(prefix.toString("utf8"), "utf8").equals(prefix)) return prefix
  }
  return Buffer.alloc(0)
}

export * as SessionDiffArtifact from "./diff-artifact"
