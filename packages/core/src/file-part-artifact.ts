export * as FilePartArtifact from "./file-part-artifact"

import { createHash } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { and, asc, desc, eq, gt, isNull, sql } from "drizzle-orm"
import { Effect, Schema } from "effect"
import { Database } from "./database/database"
import type { EventV2 } from "./event"
import {
  FilePartArtifactBindingTable,
  FilePartArtifactChunkTable,
  FilePartArtifactDiscardTable,
  FilePartArtifactImportTable,
  FilePartArtifactTable,
} from "./file-part-artifact.sql"
import { NonNegativeInt } from "./schema"
import { Hash } from "./util/hash"
import { CanonicalJson } from "./util/canonical-json"
import { EventTable } from "./event/sql"
import { PartTable } from "./session/sql"

export const CHUNK_BYTES = 262_144 as const
export const MAX_BYTES = 32 * 1024 * 1024
export const MAX_CHUNKS = MAX_BYTES / CHUNK_BYTES
export const MAX_ENCODED_EVENT_BYTES = 64 * 1024 * 1024
export const MAX_BASE64_CHARS = Math.ceil(MAX_BYTES / 3) * 4
export const MAX_DATA_URL_CHARS = MAX_BASE64_CHARS + 256
export const CODEC = "file-part.v1" as const

const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
const EventID = Schema.String.check(Schema.isStartsWith("evt_"))
export const ID = Schema.String.check(Schema.isPattern(/^fpart_[a-f0-9]{64}$/))
export type ID = typeof ID.Type

export const Descriptor = Schema.Struct({
  codec: Schema.Literal(CODEC),
  id: ID,
  hash: Digest,
  bytes: NonNegativeInt.check(Schema.isLessThanOrEqualTo(MAX_BYTES)),
  chunkBytes: Schema.Literal(CHUNK_BYTES),
  chunks: NonNegativeInt.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(MAX_CHUNKS)),
})
  .annotate({ identifier: "FilePartArtifact.Descriptor" })
export type Descriptor = Schema.Schema.Type<typeof Descriptor>

export const Metadata = Schema.Struct({
  eventID: EventID,
  aggregateID: Schema.String,
  seq: NonNegativeInt,
  originalDataHash: Digest,
  canonicalDataHash: Digest,
  canonicalData: Schema.Record(Schema.String, Schema.Unknown),
  descriptor: Descriptor,
  chunkHashes: Schema.Array(Digest).check(Schema.isMaxLength(MAX_CHUNKS)),
})
  .annotate({ identifier: "FilePartArtifact.Metadata" })
export type Metadata = Schema.Schema.Type<typeof Metadata>

export class IntegrityError extends Schema.TaggedErrorClass<IntegrityError>()("FilePartArtifact.IntegrityError", {
  artifactID: Schema.String,
  message: Schema.String,
}) {}

export type Prepared = {
  readonly descriptor: Descriptor
  readonly chunks: readonly Buffer[]
}

type Binding = {
  readonly descriptor: Descriptor
  readonly aggregateID: string
  readonly partID: string
}

const descriptorFromData = (type: string, data: Record<string, unknown>): Binding | undefined => {
  if (type !== "message.part.updated") return undefined
  const part = data.part
  if (!part || typeof part !== "object" || Array.isArray(part)) return undefined
  const value = part as Record<string, unknown>
  if (value.type !== "file" || !Schema.is(Descriptor)(value.artifact)) return undefined
  if (
    value.url !== `artifact:${value.artifact.id}` ||
    data.sessionID !== value.sessionID ||
    typeof value.id !== "string" ||
    !value.id.startsWith("prt")
  )
    return undefined
  return { descriptor: value.artifact, aggregateID: String(data.sessionID), partID: value.id }
}

const fail = (artifactID: string, message: string) =>
  Effect.die(new IntegrityError({ artifactID, message }))

export function dataHash(data: unknown) {
  return Hash.sha256(CanonicalJson.stringify(data))
}

export function matchesDataHash(hash: string, data: unknown) {
  return hash === dataHash(data)
}

export function isLegacySyntheticCanonical(canonical: Record<string, unknown>, encoded: Record<string, unknown>) {
  const part = encoded.part
  const canonicalPart = canonical.part
  if (
    !part ||
    typeof part !== "object" ||
    Array.isArray(part) ||
    "synthetic" in part ||
    !canonicalPart ||
    typeof canonicalPart !== "object" ||
    Array.isArray(canonicalPart) ||
    (canonicalPart as Record<string, unknown>).synthetic !== true
  )
    return false
  const { synthetic: _, ...rest } = canonicalPart as Record<string, unknown>
  return isDeepStrictEqual(encoded, { ...canonical, part: rest })
}

export function prepare(type: string, data: Record<string, unknown>, encodedBytes: number, limitBytes: number) {
  if (type !== "message.part.updated") return { data, artifacts: [] as Prepared[] }
  const part = data.part
  if (!part || typeof part !== "object" || Array.isArray(part)) return { data, artifacts: [] as Prepared[] }
  const value = part as Record<string, unknown>
  if (value.type !== "file" || typeof value.url !== "string") return { data, artifacts: [] as Prepared[] }
  if (value.url.startsWith("data:") && value.url.length > MAX_DATA_URL_CHARS)
    throw new IntegrityError({
      artifactID: "pending",
      message: `File part data URL is ${value.url.length} characters; limit is ${MAX_DATA_URL_CHARS}`,
    })
  const match = /^data:([^;,]*);base64,([A-Za-z0-9+/]*={0,2})$/.exec(value.url)
  if (!match) return { data, artifacts: [] as Prepared[] }
  if (match[2]!.length > MAX_BASE64_CHARS)
    throw new IntegrityError({
      artifactID: "pending",
      message: `File part base64 payload is ${match[2]!.length} characters; limit is ${MAX_BASE64_CHARS}`,
    })
  const body = Buffer.from(match[2]!, "base64")
  if (body.toString("base64").replace(/=+$/, "") !== match[2]!.replace(/=+$/, ""))
    return { data, artifacts: [] as Prepared[] }
  if (body.byteLength > MAX_BYTES)
    throw new IntegrityError({
      artifactID: "pending",
      message: `File part body is ${body.byteLength} bytes; limit is ${MAX_BYTES} bytes`,
    })
  if (encodedBytes <= limitBytes && body.byteLength <= CHUNK_BYTES) return { data, artifacts: [] as Prepared[] }
  const hash = Hash.sha256(body)
  const descriptor = Descriptor.make({
    codec: CODEC,
    id: ID.make(`fpart_${hash}`),
    hash,
    bytes: body.byteLength,
    chunkBytes: CHUNK_BYTES,
    chunks: Math.max(1, Math.ceil(body.byteLength / CHUNK_BYTES)),
  })
  return {
    data: {
      ...data,
      part: { ...value, url: `artifact:${descriptor.id}`, artifact: descriptor },
    },
    artifacts: [
      {
        descriptor,
        chunks: Array.from({ length: descriptor.chunks }, (_, index) =>
          Buffer.from(body.subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES)),
        ),
      },
    ],
  }
}

export function put(db: Database.Interface["db"], prepared: Prepared, now = Date.now()) {
  return Effect.gen(function* () {
    yield* validate(prepared.descriptor, prepared.chunks)
    const existing = yield* db
      .select()
      .from(FilePartArtifactTable)
      .where(eq(FilePartArtifactTable.artifact_id, prepared.descriptor.id))
      .get()
      .pipe(Effect.orDie)
    if (existing) {
      if (
        existing.body_hash !== prepared.descriptor.hash ||
        existing.body_bytes !== prepared.descriptor.bytes ||
        existing.chunk_bytes !== prepared.descriptor.chunkBytes ||
        existing.chunk_count !== prepared.descriptor.chunks ||
        existing.codec_version !== 1 ||
        !existing.complete
      )
        return yield* fail(prepared.descriptor.id, "Artifact identity is bound to different metadata")
      return
    }
    yield* db
      .insert(FilePartArtifactTable)
      .values({
        artifact_id: prepared.descriptor.id,
        body_hash: prepared.descriptor.hash,
        body_bytes: prepared.descriptor.bytes,
        chunk_bytes: prepared.descriptor.chunkBytes,
        chunk_count: prepared.descriptor.chunks,
        codec_version: 1,
        complete: true,
        created_at: now,
      })
      .run()
      .pipe(Effect.orDie)
    yield* Effect.forEach(
      prepared.chunks,
      (chunk, index) =>
        db
          .insert(FilePartArtifactChunkTable)
          .values({ artifact_id: prepared.descriptor.id, chunk_index: index, data: chunk, chunk_hash: Hash.sha256(chunk) })
          .run()
          .pipe(Effect.orDie),
      { discard: true },
    )
  })
}

export function requireAvailable(db: Database.Interface["db"], descriptor: Descriptor) {
  return Effect.gen(function* () {
    const row = yield* db
      .select({
        hash: FilePartArtifactTable.body_hash,
        bytes: FilePartArtifactTable.body_bytes,
        chunkBytes: FilePartArtifactTable.chunk_bytes,
        chunks: FilePartArtifactTable.chunk_count,
        complete: FilePartArtifactTable.complete,
      })
      .from(FilePartArtifactTable)
      .where(eq(FilePartArtifactTable.artifact_id, descriptor.id))
      .get()
      .pipe(Effect.orDie)
    if (
      !row ||
      row.hash !== descriptor.hash ||
      row.bytes !== descriptor.bytes ||
      row.chunkBytes !== descriptor.chunkBytes ||
      row.chunks !== descriptor.chunks ||
      !row.complete
    )
      return yield* fail(descriptor.id, "Artifact body is missing or does not match its descriptor")
  })
}

export function bind(
  db: Database.Interface["db"],
  input: {
    readonly eventID: EventV2.ID
    readonly aggregateID: string
    readonly seq: number
    readonly type: string
    readonly data: Record<string, unknown>
    readonly originalData?: Record<string, unknown>
    readonly requireImport?: boolean
    readonly now?: number
  },
) {
  return Effect.gen(function* () {
    const binding = descriptorFromData(input.type, input.data)
    if (!binding) return
    if (binding.aggregateID !== input.aggregateID)
      return yield* fail(binding.descriptor.id, "Artifact aggregate does not match its event")
    yield* requireAvailable(db, binding.descriptor)
    const normalizedData = JSON.parse(CanonicalJson.stringify(input.data)) as Record<string, unknown>
    const imported = input.requireImport
      ? yield* db
          .select()
          .from(FilePartArtifactImportTable)
          .where(eq(FilePartArtifactImportTable.event_id, input.eventID))
          .get()
          .pipe(Effect.orDie)
      : undefined
    if (
      input.requireImport &&
      (!imported ||
        imported.aggregate_id !== input.aggregateID ||
        imported.seq !== input.seq ||
        imported.artifact_id !== binding.descriptor.id ||
        !matchesDataHash(imported.canonical_data_hash, imported.canonical_data) ||
        !isDeepStrictEqual(imported.canonical_data, input.data))
    )
      return yield* fail(binding.descriptor.id, "Replayed artifact has no exact staged import receipt")
    const canonicalData = imported?.canonical_data ?? normalizedData
    const canonicalDataHash = dataHash(canonicalData)
    const originalDataHash = imported?.original_data_hash ?? dataHash(input.originalData ?? input.data)
    const existing = yield* db
      .select()
      .from(FilePartArtifactBindingTable)
      .where(eq(FilePartArtifactBindingTable.event_id, input.eventID))
      .get()
      .pipe(Effect.orDie)
    if (existing) {
      if (
        existing.aggregate_id !== input.aggregateID ||
        existing.seq !== input.seq ||
        existing.part_id !== binding.partID ||
        existing.artifact_id !== binding.descriptor.id ||
        existing.original_data_hash !== originalDataHash ||
        existing.canonical_data_hash !== canonicalDataHash ||
        !isDeepStrictEqual(existing.canonical_data, canonicalData)
      )
        return yield* fail(binding.descriptor.id, "Event identity is bound to a different artifact")
      return
    }
    yield* db
      .insert(FilePartArtifactBindingTable)
      .values({
        event_id: input.eventID,
        aggregate_id: input.aggregateID,
        seq: input.seq,
        part_id: binding.partID,
        artifact_id: binding.descriptor.id,
        original_data_hash: originalDataHash,
        canonical_data_hash: canonicalDataHash,
        canonical_data: canonicalData,
        created_at: input.now ?? Date.now(),
      })
      .run()
      .pipe(Effect.orDie)
    if (input.requireImport)
      yield* db
        .delete(FilePartArtifactImportTable)
        .where(eq(FilePartArtifactImportTable.event_id, input.eventID))
        .run()
        .pipe(Effect.orDie)
  })
}

export function metadata(
  db: Database.Interface["db"],
  input: { readonly eventID: EventV2.ID; readonly aggregateID: string; readonly seq: number; readonly artifactID: ID },
) {
  return Effect.gen(function* () {
    const row = yield* db
      .select({
        originalDataHash: FilePartArtifactBindingTable.original_data_hash,
        canonicalDataHash: FilePartArtifactBindingTable.canonical_data_hash,
        canonicalData: FilePartArtifactBindingTable.canonical_data,
        hash: FilePartArtifactTable.body_hash,
        bytes: FilePartArtifactTable.body_bytes,
        chunkBytes: FilePartArtifactTable.chunk_bytes,
        chunks: FilePartArtifactTable.chunk_count,
        complete: FilePartArtifactTable.complete,
      })
      .from(FilePartArtifactBindingTable)
      .innerJoin(
        FilePartArtifactTable,
        eq(FilePartArtifactTable.artifact_id, FilePartArtifactBindingTable.artifact_id),
      )
      .where(
        and(
          eq(FilePartArtifactBindingTable.event_id, input.eventID),
          eq(FilePartArtifactBindingTable.aggregate_id, input.aggregateID),
          eq(FilePartArtifactBindingTable.seq, input.seq),
          eq(FilePartArtifactBindingTable.artifact_id, input.artifactID),
        ),
      )
      .get()
      .pipe(Effect.orDie)
    if (!row || !row.complete)
      return yield* fail(input.artifactID, "Artifact metadata is not bound to a complete requested event")
    const chunks = yield* db
      .select({ index: FilePartArtifactChunkTable.chunk_index, hash: FilePartArtifactChunkTable.chunk_hash })
      .from(FilePartArtifactChunkTable)
      .where(eq(FilePartArtifactChunkTable.artifact_id, input.artifactID))
      .orderBy(asc(FilePartArtifactChunkTable.chunk_index))
      .all()
      .pipe(Effect.orDie)
    const descriptor = Descriptor.make({
      codec: CODEC,
      id: input.artifactID,
      hash: row.hash,
      bytes: row.bytes,
      chunkBytes: CHUNK_BYTES,
      chunks: row.chunks,
    })
    if (chunks.length !== descriptor.chunks || chunks.some((chunk, index) => chunk.index !== index))
      return yield* fail(input.artifactID, "Artifact chunk metadata is incomplete")
    return Metadata.make({
      eventID: input.eventID,
      aggregateID: input.aggregateID,
      seq: input.seq,
      originalDataHash: row.originalDataHash,
      canonicalDataHash: row.canonicalDataHash,
      canonicalData: row.canonicalData,
      descriptor,
      chunkHashes: chunks.map((chunk) => chunk.hash),
    })
  })
}

export function chunk(
  db: Database.Interface["db"],
  input: { readonly artifactID: ID; readonly index: number; readonly expectedHash: string },
) {
  return Effect.gen(function* () {
    const row = yield* db
      .select({ data: FilePartArtifactChunkTable.data, hash: FilePartArtifactChunkTable.chunk_hash })
      .from(FilePartArtifactChunkTable)
      .where(
        and(
          eq(FilePartArtifactChunkTable.artifact_id, input.artifactID),
          eq(FilePartArtifactChunkTable.chunk_index, input.index),
        ),
      )
      .get()
      .pipe(Effect.orDie)
    if (!row || row.hash !== input.expectedHash || Hash.sha256(row.data) !== row.hash)
      return yield* fail(input.artifactID, `Artifact chunk ${input.index} is missing or corrupt`)
    return row.data
  })
}

export function has(descriptor: Descriptor) {
  return Database.Service.use(({ db }) =>
    db
      .select({ id: FilePartArtifactTable.artifact_id })
      .from(FilePartArtifactTable)
      .where(
        and(
          eq(FilePartArtifactTable.artifact_id, descriptor.id),
          eq(FilePartArtifactTable.body_hash, descriptor.hash),
          eq(FilePartArtifactTable.body_bytes, descriptor.bytes),
          eq(FilePartArtifactTable.chunk_count, descriptor.chunks),
          eq(FilePartArtifactTable.complete, true),
        ),
      )
      .get()
      .pipe(Effect.orDie, Effect.map(Boolean)),
  )
}

export function importChunks(input: { readonly descriptor: Descriptor; readonly chunks: readonly Uint8Array[] }) {
  return Database.Service.use(({ db }) =>
    db.transaction(
      () => put(db, { descriptor: input.descriptor, chunks: input.chunks.map((chunk) => Buffer.from(chunk)) }),
      { behavior: "immediate" },
    ).pipe(Effect.orDie),
  )
}

export function importChunk(input: {
  readonly metadata: Metadata
  readonly index: number
  readonly hash: string
  readonly data: Uint8Array
}) {
  return Database.Service.use(({ db }) =>
    db
      .transaction(
        () =>
          Effect.gen(function* () {
            const descriptor = input.metadata.descriptor
            if (
              input.index < 0 ||
              input.index >= descriptor.chunks ||
              input.metadata.chunkHashes[input.index] !== input.hash ||
              Hash.sha256(Buffer.from(input.data)) !== input.hash
            )
              return yield* fail(descriptor.id, `Artifact import chunk ${input.index} does not match metadata`)
            const existing = yield* db
              .select()
              .from(FilePartArtifactTable)
              .where(eq(FilePartArtifactTable.artifact_id, descriptor.id))
              .get()
              .pipe(Effect.orDie)
            if (
              existing &&
              (existing.body_hash !== descriptor.hash ||
                existing.body_bytes !== descriptor.bytes ||
                existing.chunk_bytes !== descriptor.chunkBytes ||
                existing.chunk_count !== descriptor.chunks ||
                existing.codec_version !== 1)
            )
              return yield* fail(descriptor.id, "Artifact identity is bound to different import metadata")
            if (!existing)
              yield* db
                .insert(FilePartArtifactTable)
                .values({
                  artifact_id: descriptor.id,
                  body_hash: descriptor.hash,
                  body_bytes: descriptor.bytes,
                  chunk_bytes: descriptor.chunkBytes,
                  chunk_count: descriptor.chunks,
                  codec_version: 1,
                  complete: false,
                  created_at: Date.now(),
                })
                .run()
                .pipe(Effect.orDie)
            yield* stageReceipt(db, input.metadata)
            const storedChunk = yield* db
              .select({ hash: FilePartArtifactChunkTable.chunk_hash, data: FilePartArtifactChunkTable.data })
              .from(FilePartArtifactChunkTable)
              .where(
                and(
                  eq(FilePartArtifactChunkTable.artifact_id, descriptor.id),
                  eq(FilePartArtifactChunkTable.chunk_index, input.index),
                ),
              )
              .get()
              .pipe(Effect.orDie)
            if (storedChunk && (storedChunk.hash !== input.hash || !storedChunk.data.equals(Buffer.from(input.data))))
              return yield* fail(descriptor.id, `Artifact import chunk ${input.index} conflicts with durable CAS`)
            if (!storedChunk)
              yield* db
                .insert(FilePartArtifactChunkTable)
                .values({ artifact_id: descriptor.id, chunk_index: input.index, data: Buffer.from(input.data), chunk_hash: input.hash })
                .run()
                .pipe(Effect.orDie)
            const chunks = yield* db
              .select({ data: FilePartArtifactChunkTable.data })
              .from(FilePartArtifactChunkTable)
              .where(eq(FilePartArtifactChunkTable.artifact_id, descriptor.id))
              .orderBy(asc(FilePartArtifactChunkTable.chunk_index))
              .all()
              .pipe(Effect.orDie)
            if (chunks.length !== descriptor.chunks) return false
            yield* validate(descriptor, chunks.map((chunk) => chunk.data))
            yield* db
              .update(FilePartArtifactTable)
              .set({ complete: true })
              .where(eq(FilePartArtifactTable.artifact_id, descriptor.id))
              .run()
              .pipe(Effect.orDie)
            yield* stage(db, input.metadata)
            return true
          }),
        { behavior: "immediate" },
      )
      .pipe(Effect.orDie),
  )
}

export function stageImport(metadata: Metadata) {
  return Database.Service.use(({ db }) =>
    db.transaction(() => stage(db, metadata), { behavior: "immediate" }).pipe(Effect.orDie),
  )
}

export function discardImport(input: {
  readonly eventID: EventV2.ID
  readonly aggregateID: string
  readonly artifactID: ID
}) {
  return Database.Service.use(({ db }) =>
    db.transaction(
      () =>
        Effect.gen(function* () {
          const imported = yield* db
            .select()
            .from(FilePartArtifactImportTable)
            .where(
              and(
                eq(FilePartArtifactImportTable.event_id, input.eventID),
                eq(FilePartArtifactImportTable.aggregate_id, input.aggregateID),
                eq(FilePartArtifactImportTable.artifact_id, input.artifactID),
              ),
            )
            .get()
            .pipe(Effect.orDie)
          if (!imported) return false
          const binding = yield* db
            .select({ id: FilePartArtifactBindingTable.event_id })
            .from(FilePartArtifactBindingTable)
            .where(eq(FilePartArtifactBindingTable.event_id, input.eventID))
            .get()
            .pipe(Effect.orDie)
          if (binding) return yield* fail(input.artifactID, "Bound artifact imports cannot be discarded")
          yield* db.insert(FilePartArtifactDiscardTable).values({
            event_id: imported.event_id,
            aggregate_id: imported.aggregate_id,
            seq: imported.seq,
            artifact_id: imported.artifact_id,
            original_data_hash: imported.original_data_hash,
            canonical_data_hash: imported.canonical_data_hash,
            canonical_data: imported.canonical_data,
            created_at: Date.now(),
          }).onConflictDoNothing().run().pipe(Effect.orDie)
          yield* db.delete(FilePartArtifactImportTable)
            .where(eq(FilePartArtifactImportTable.event_id, input.eventID)).run().pipe(Effect.orDie)
          yield* db.delete(FilePartArtifactTable).where(and(
            eq(FilePartArtifactTable.artifact_id, input.artifactID),
            sql`NOT EXISTS (
              SELECT 1 FROM ${FilePartArtifactBindingTable} binding
              WHERE binding.artifact_id = ${input.artifactID}
            )`,
            sql`NOT EXISTS (
              SELECT 1 FROM ${FilePartArtifactImportTable} imported
              WHERE imported.artifact_id = ${input.artifactID}
            )`,
          )).run().pipe(Effect.orDie)
          return true
        }),
      { behavior: "immediate" },
    ).pipe(Effect.orDie),
  )
}

export function read(input: { readonly aggregateID: string; readonly descriptor: Descriptor }) {
  return Database.Service.use(({ db }) =>
    Effect.gen(function* () {
      const binding = yield* db
        .select({ id: FilePartArtifactBindingTable.event_id })
        .from(FilePartArtifactBindingTable)
        .where(
          and(
            eq(FilePartArtifactBindingTable.aggregate_id, input.aggregateID),
            eq(FilePartArtifactBindingTable.artifact_id, input.descriptor.id),
          ),
        )
        .get()
        .pipe(Effect.orDie)
      if (!binding) return yield* fail(input.descriptor.id, "Artifact is not bound to the requested aggregate")
      const chunks = yield* db
        .select({ data: FilePartArtifactChunkTable.data, hash: FilePartArtifactChunkTable.chunk_hash })
        .from(FilePartArtifactChunkTable)
        .where(eq(FilePartArtifactChunkTable.artifact_id, input.descriptor.id))
        .orderBy(asc(FilePartArtifactChunkTable.chunk_index))
        .all()
        .pipe(Effect.orDie)
      if (chunks.some((chunk) => Hash.sha256(chunk.data) !== chunk.hash))
        return yield* fail(input.descriptor.id, "Artifact chunk hash is corrupt")
      yield* validate(input.descriptor, chunks.map((chunk) => chunk.data))
      return Buffer.concat(chunks.map((chunk) => chunk.data), input.descriptor.bytes)
    }),
  )
}

export function descriptor(data: Record<string, unknown>) {
  return descriptorFromData("message.part.updated", data)?.descriptor
}

export function snapshotRef(
  db: Database.Interface["db"],
  input: { readonly aggregateID: string; readonly partID: string; readonly descriptor: Descriptor },
) {
  return Effect.gen(function* () {
    const binding = yield* db
      .select({
        eventID: FilePartArtifactBindingTable.event_id,
        seq: FilePartArtifactBindingTable.seq,
      })
      .from(FilePartArtifactBindingTable)
      .where(
        and(
          eq(FilePartArtifactBindingTable.aggregate_id, input.aggregateID),
          eq(FilePartArtifactBindingTable.part_id, input.partID),
          eq(FilePartArtifactBindingTable.artifact_id, input.descriptor.id),
        ),
      )
      .orderBy(desc(FilePartArtifactBindingTable.seq))
      .limit(1)
      .get()
      .pipe(Effect.orDie)
    if (!binding) return yield* fail(input.descriptor.id, "Snapshot part has no durable artifact binding")
    const result = yield* metadata(db, {
      eventID: binding.eventID,
      aggregateID: input.aggregateID,
      seq: binding.seq,
      artifactID: input.descriptor.id,
    })
    if (JSON.stringify(result.descriptor) !== JSON.stringify(input.descriptor))
      return yield* fail(input.descriptor.id, "Snapshot part descriptor diverges from its durable binding")
    return result
  })
}

export function bindSnapshotRef(input: { readonly metadata: Metadata; readonly partID: string }) {
  return Database.Service.use(({ db }) =>
    db
      .transaction(
        () =>
          Effect.gen(function* () {
            if (!input.partID.startsWith("prt"))
              return yield* fail(input.metadata.descriptor.id, "Snapshot artifact part identity is invalid")
            const canonicalBinding = descriptorFromData("message.part.updated", input.metadata.canonicalData)
            if (
              !canonicalBinding ||
              canonicalBinding.aggregateID !== input.metadata.aggregateID ||
              canonicalBinding.partID !== input.partID ||
              !isDeepStrictEqual(canonicalBinding.descriptor, input.metadata.descriptor)
            )
              return yield* fail(input.metadata.descriptor.id, "Snapshot artifact canonical data does not match its descriptor")
            const projected = yield* db
              .select()
              .from(PartTable)
              .where(eq(PartTable.id, input.partID as typeof PartTable.$inferSelect.id))
              .get()
              .pipe(Effect.orDie)
            if (!projected || projected.session_id !== input.metadata.aggregateID || projected.message_id !== (input.metadata.canonicalData.part as Record<string, unknown>).messageID)
              return yield* fail(input.metadata.descriptor.id, "Snapshot artifact has no matching projected part")
            const canonicalPart = input.metadata.canonicalData.part as Record<string, unknown>
            const projectedData = Object.fromEntries(
              Object.entries(canonicalPart).filter(([key]) => key !== "id" && key !== "sessionID" && key !== "messageID"),
            )
            if (!isDeepStrictEqual(projected.data, projectedData))
              return yield* fail(input.metadata.descriptor.id, "Snapshot artifact projected part diverges from its binding")
            yield* stage(db, input.metadata)
            const existing = yield* db
              .select()
              .from(FilePartArtifactBindingTable)
              .where(eq(FilePartArtifactBindingTable.event_id, input.metadata.eventID as EventV2.ID))
              .get()
              .pipe(Effect.orDie)
            if (existing) {
              if (
                existing.aggregate_id !== input.metadata.aggregateID ||
                existing.seq !== input.metadata.seq ||
                existing.part_id !== input.partID ||
                existing.artifact_id !== input.metadata.descriptor.id ||
                existing.original_data_hash !== input.metadata.originalDataHash ||
                existing.canonical_data_hash !== input.metadata.canonicalDataHash ||
                !isDeepStrictEqual(existing.canonical_data, input.metadata.canonicalData)
              )
                return yield* fail(input.metadata.descriptor.id, "Snapshot artifact binding conflicts with durable CAS")
            } else {
              yield* db
                .insert(FilePartArtifactBindingTable)
                .values({
                  event_id: input.metadata.eventID as EventV2.ID,
                  aggregate_id: input.metadata.aggregateID,
                  seq: input.metadata.seq,
                  part_id: input.partID,
                  artifact_id: input.metadata.descriptor.id,
                  original_data_hash: input.metadata.originalDataHash,
                  canonical_data_hash: input.metadata.canonicalDataHash,
                  canonical_data: input.metadata.canonicalData,
                  created_at: Date.now(),
                })
                .run()
                .pipe(Effect.orDie)
            }
            yield* db
              .delete(FilePartArtifactImportTable)
              .where(eq(FilePartArtifactImportTable.event_id, input.metadata.eventID as EventV2.ID))
              .run()
              .pipe(Effect.orDie)
          }),
        { behavior: "immediate" },
      )
      .pipe(Effect.orDie),
  )
}

export function canonicalizeLegacy(
  db: Database.Interface["db"],
  input?: { readonly afterID?: EventV2.ID; readonly limit?: number; readonly now?: number },
) {
  return Effect.gen(function* () {
    const row = yield* db
      .select({
        id: EventTable.id,
        aggregateID: EventTable.aggregate_id,
        seq: EventTable.seq,
        bytes: sql<number>`length(CAST(${EventTable.data} AS BLOB))`,
      })
      .from(EventTable)
      .leftJoin(FilePartArtifactBindingTable, eq(FilePartArtifactBindingTable.event_id, EventTable.id))
      .where(
        and(
          eq(EventTable.type, "message.part.updated.1"),
          sql`length(CAST(${EventTable.data} AS BLOB)) > ${4 * 1024 * 1024}`,
          isNull(FilePartArtifactBindingTable.event_id),
          input?.afterID ? gt(EventTable.id, input.afterID) : undefined,
        ),
      )
      .orderBy(asc(EventTable.id))
      .limit(1)
      .get()
      .pipe(Effect.orDie)
    if (!row) return { processed: 0, next: undefined }
    if (row.bytes > MAX_ENCODED_EVENT_BYTES)
      return yield* fail(
        "pending",
        `Legacy file-part event ${row.id} is ${row.bytes} bytes; limit is ${MAX_ENCODED_EVENT_BYTES}`,
      )
    const source = yield* db
      .select({ data: EventTable.data })
      .from(EventTable)
      .where(eq(EventTable.id, row.id))
      .get()
      .pipe(Effect.orDie)
    if (!source) return yield* fail("pending", `Legacy file-part event ${row.id} disappeared during maintenance`)
    if (Buffer.byteLength(JSON.stringify(source.data)) !== row.bytes)
      return yield* fail("pending", `Legacy file-part event ${row.id} changed during maintenance`)
    const originalPart = source.data.part
    if (!originalPart || typeof originalPart !== "object" || Array.isArray(originalPart))
      return { processed: 0, next: row.id }
    const sourcePart = originalPart as Record<string, unknown>
    if (sourcePart.type !== "file" || typeof sourcePart.url !== "string" || !sourcePart.url.startsWith("data:"))
      return { processed: 0, next: row.id }
    if (sourcePart.url.length > MAX_DATA_URL_CHARS)
      return yield* fail(
        "pending",
        `Legacy file-part event ${row.id} data URL is ${sourcePart.url.length} characters; limit is ${MAX_DATA_URL_CHARS}`,
      )
    const prepared = prepare("message.part.updated", source.data, row.bytes, 4 * 1024 * 1024)
    if (prepared.artifacts.length !== 1)
      return yield* fail("pending", `Legacy file-part event ${row.id} cannot be externalized canonically`)
    const originalBinding = descriptorFromData("message.part.updated", prepared.data)
    const canonicalPart = prepared.data.part
    if (!originalBinding || !canonicalPart || typeof canonicalPart !== "object" || Array.isArray(canonicalPart))
      return yield* fail(prepared.artifacts[0]!.descriptor.id, `Legacy file-part event ${row.id} has invalid part data`)
    return yield* db
      .transaction(
        () =>
          Effect.gen(function* () {
            const current = yield* db
              .select({
                aggregateID: EventTable.aggregate_id,
                seq: EventTable.seq,
                data: EventTable.data,
              })
              .from(EventTable)
              .where(eq(EventTable.id, row.id))
              .get()
              .pipe(Effect.orDie)
            if (
              !current ||
              current.aggregateID !== row.aggregateID ||
              current.seq !== row.seq ||
              !isDeepStrictEqual(current.data, source.data)
            )
              return yield* fail("pending", `Legacy file-part event ${row.id} changed during maintenance`)
            const projected = yield* db
              .select()
              .from(PartTable)
              .where(eq(PartTable.id, originalBinding.partID as typeof PartTable.$inferSelect.id))
              .get()
              .pipe(Effect.orDie)
            if (!projected)
              return yield* fail(
                prepared.artifacts[0]!.descriptor.id,
                `Legacy file-part event ${row.id} has no corresponding projected part`,
              )
            if (projected.session_id !== row.aggregateID || projected.message_id !== sourcePart.messageID)
              return yield* fail(
                prepared.artifacts[0]!.descriptor.id,
                `Legacy file-part event ${row.id} has a conflicting projected part`,
              )
            const sourceData = Object.fromEntries(
              Object.entries(sourcePart).filter(([key]) => key !== "id" && key !== "sessionID" && key !== "messageID"),
            )
            // Older FilePart event schemas dropped the runtime-owned synthetic marker while
            // the local Part projection retained it. Accept only that exact historical skew.
            const legacySynthetic =
              !("synthetic" in sourceData) && "synthetic" in projected.data && projected.data.synthetic === true
            const expectedData = legacySynthetic ? { ...sourceData, synthetic: true } : sourceData
            if (!isDeepStrictEqual(projected.data, expectedData))
              return yield* fail(
                prepared.artifacts[0]!.descriptor.id,
                `Legacy file-part event ${row.id} no longer matches its projected part`,
              )
            const canonicalEventData = legacySynthetic
              ? { ...prepared.data, part: { ...(canonicalPart as Record<string, unknown>), synthetic: true } }
              : prepared.data
            const canonicalData = Object.fromEntries(
              Object.entries(canonicalEventData.part as Record<string, unknown>).filter(
                ([key]) => key !== "id" && key !== "sessionID" && key !== "messageID",
              ),
            ) as typeof PartTable.$inferInsert.data
            yield* put(db, prepared.artifacts[0]!, input?.now)
            yield* bind(db, {
              eventID: row.id,
              aggregateID: row.aggregateID,
              seq: row.seq,
              type: "message.part.updated",
              data: canonicalEventData,
              originalData: source.data,
              now: input?.now,
            })
            yield* db
              .update(PartTable)
              .set({ data: canonicalData })
              .where(eq(PartTable.id, originalBinding.partID as typeof PartTable.$inferSelect.id))
              .run()
              .pipe(Effect.orDie)
            return { processed: 1, next: row.id }
          }),
        { behavior: "immediate" },
      )
      .pipe(Effect.orDie)
  })
}

function validate(descriptor: Descriptor, chunks: readonly Uint8Array[]) {
  return Effect.gen(function* () {
    if (
      descriptor.codec !== CODEC ||
      descriptor.id !== `fpart_${descriptor.hash}` ||
      descriptor.chunkBytes !== CHUNK_BYTES ||
      descriptor.bytes > MAX_BYTES ||
      descriptor.chunks !== Math.max(1, Math.ceil(descriptor.bytes / CHUNK_BYTES)) ||
      chunks.length !== descriptor.chunks
    )
      return yield* fail(descriptor.id, "Artifact descriptor is not canonical")
    const digest = createHash("sha256")
    let bytes = 0
    for (const [index, chunk] of chunks.entries()) {
      const expected = index === chunks.length - 1 ? descriptor.bytes - index * CHUNK_BYTES : CHUNK_BYTES
      if (chunk.byteLength !== expected) return yield* fail(descriptor.id, `Artifact chunk ${index} has an invalid length`)
      bytes += chunk.byteLength
      digest.update(chunk)
    }
    if (bytes !== descriptor.bytes || digest.digest("hex") !== descriptor.hash)
      return yield* fail(descriptor.id, "Artifact body hash does not match its descriptor")
  })
}

function stage(db: Database.Interface["db"], metadata: Metadata) {
  return Effect.gen(function* () {
    yield* requireAvailable(db, metadata.descriptor)
    if (!matchesDataHash(metadata.canonicalDataHash, metadata.canonicalData))
      return yield* fail(metadata.descriptor.id, "Artifact import metadata canonical hash is invalid")
    const canonicalData = JSON.parse(CanonicalJson.stringify(metadata.canonicalData)) as Record<string, unknown>
    const chunks = yield* db
      .select({ index: FilePartArtifactChunkTable.chunk_index, hash: FilePartArtifactChunkTable.chunk_hash, data: FilePartArtifactChunkTable.data })
      .from(FilePartArtifactChunkTable)
      .where(eq(FilePartArtifactChunkTable.artifact_id, metadata.descriptor.id))
      .orderBy(asc(FilePartArtifactChunkTable.chunk_index))
      .all()
      .pipe(Effect.orDie)
    if (
      metadata.chunkHashes.length !== metadata.descriptor.chunks ||
      chunks.length !== metadata.descriptor.chunks ||
      chunks.some(
        (chunk, index) =>
          chunk.index !== index ||
          chunk.hash !== metadata.chunkHashes[index] ||
          Hash.sha256(chunk.data) !== chunk.hash,
      )
    )
      return yield* fail(metadata.descriptor.id, "Artifact import metadata does not match durable chunks")
    yield* validate(metadata.descriptor, chunks.map((chunk) => chunk.data))
    yield* stageReceipt(db, metadata)
  })
}

function stageReceipt(db: Database.Interface["db"], metadata: Metadata) {
  return Effect.gen(function* () {
    if (!matchesDataHash(metadata.canonicalDataHash, metadata.canonicalData))
      return yield* fail(metadata.descriptor.id, "Artifact import metadata canonical hash is invalid")
    const canonicalData = JSON.parse(CanonicalJson.stringify(metadata.canonicalData)) as Record<string, unknown>
    const existing = yield* db
      .select()
      .from(FilePartArtifactImportTable)
      .where(eq(FilePartArtifactImportTable.event_id, metadata.eventID as EventV2.ID))
      .get()
      .pipe(Effect.orDie)
    if (existing) {
      if (
        existing.aggregate_id !== metadata.aggregateID ||
        existing.seq !== metadata.seq ||
        existing.artifact_id !== metadata.descriptor.id ||
        existing.original_data_hash !== metadata.originalDataHash ||
        existing.canonical_data_hash !== metadata.canonicalDataHash ||
        !isDeepStrictEqual(existing.canonical_data, canonicalData)
      )
        return yield* fail(metadata.descriptor.id, "Artifact import receipt conflicts with durable CAS")
      return
    }
    const binding = yield* db
      .select()
      .from(FilePartArtifactBindingTable)
      .where(eq(FilePartArtifactBindingTable.event_id, metadata.eventID as EventV2.ID))
      .get()
      .pipe(Effect.orDie)
    if (binding) {
      if (
        binding.aggregate_id !== metadata.aggregateID ||
        binding.seq !== metadata.seq ||
        binding.artifact_id !== metadata.descriptor.id ||
        binding.original_data_hash !== metadata.originalDataHash ||
        binding.canonical_data_hash !== metadata.canonicalDataHash ||
        !isDeepStrictEqual(binding.canonical_data, metadata.canonicalData)
      )
        return yield* fail(metadata.descriptor.id, "Artifact binding conflicts with import metadata")
      return
    }
    yield* db
      .insert(FilePartArtifactImportTable)
      .values({
        event_id: metadata.eventID as EventV2.ID,
        aggregate_id: metadata.aggregateID,
        seq: metadata.seq,
        artifact_id: metadata.descriptor.id,
        original_data_hash: metadata.originalDataHash,
        canonical_data_hash: metadata.canonicalDataHash,
        canonical_data: canonicalData,
        created_at: Date.now(),
      })
      .run()
      .pipe(Effect.orDie)
  })
}
