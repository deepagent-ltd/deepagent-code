export * as EventV2 from "./event"

import { Cause, Context, Effect, Layer, Option, PubSub, Schema, Stream } from "effect"
import { and, asc, eq, gt, inArray, lte, or, sql } from "drizzle-orm"
import { Database } from "./database/database"
import {
  EventArtifactTable,
  EventArtifactChunkTable,
  EventCompactionReceiptTable,
  EventDedupeTable,
  EventSequenceTable,
  EventSnapshotChunkTable,
  EventSnapshotAttemptTable,
  EventSnapshotRowTable,
  EventSnapshotTable,
  EventSyncBackfillTable,
  EventSyncIndexTable,
  EventSyncSequenceTable,
  EventTable,
} from "./event/sql"
import { Location } from "./location"
import { makeGlobalNode } from "./effect/app-node"
import { externalID, type ExternalID, NonNegativeInt, withStatics } from "./schema"
import { Identifier } from "./util/identifier"
import { isDeepStrictEqual } from "node:util"
import { Hash } from "./util/hash"
import { createHash } from "node:crypto"
import { FilePartArtifact } from "./file-part-artifact"
import { FilePartArtifactBindingTable } from "./file-part-artifact.sql"

export const ID = Schema.String.check(Schema.isStartsWith("evt_")).pipe(
  Schema.brand("Event.ID"),
  withStatics((schema) => ({
    create: () => schema.make("evt_" + Identifier.ascending()),
    fromExternal: (input: ExternalID) => schema.make(externalID("evt", input)),
  })),
)
export type ID = typeof ID.Type

/**
 * Durable aggregate continuation position for embedded replay streams.
 * TODO: Decide whether a future HTTP / SDK surface should expose an opaque cursor instead.
 */
export const Cursor = NonNegativeInt.pipe(Schema.brand("EventV2.Cursor"))
export type Cursor = typeof Cursor.Type

export type Definition<Type extends string = string, DataSchema extends Schema.Top = Schema.Top> = {
  readonly type: Type
  readonly sync?: {
    readonly version: number
    readonly aggregate: string
  }
  readonly data: DataSchema
}

export type Data<D extends Definition> = Schema.Schema.Type<D["data"]>

export type Payload<D extends Definition = Definition> = {
  readonly id: ID
  readonly type: D["type"]
  readonly data: Data<D>
  /** Durable aggregate order, populated while synchronized events are projected. */
  readonly seq?: number
  readonly version?: number
  readonly location?: Location.Ref
  readonly metadata?: Record<string, unknown>
  /** Internal replay marker for projectors that own non-replicated operational state. */
  readonly replay?: boolean
  /** Internal exact-replay marker set only after the durable event identity and payload are verified. */
  readonly replayExact?: boolean
  /** Internal owner authority supplied by a replay ingress. It is never serialized into the event payload. */
  readonly replayOwnerID?: string
}

export type Projector<D extends Definition = Definition> = (event: Payload<D>) => Effect.Effect<void>
type AnyProjector = (event: Payload) => Effect.Effect<void>
export type CommitGuard = (event: Payload) => Effect.Effect<void>
export type Listener = (event: Payload) => Effect.Effect<void>
export type Sync = (event: Payload) => Effect.Effect<void>
export type Unsubscribe = Effect.Effect<void>

export type SerializedEvent = {
  readonly id: ID
  readonly type: string
  readonly seq: number
  readonly aggregateID: string
  readonly data: Record<string, unknown>
}

export type SerializedSnapshot = {
  readonly snapshotID: string
  readonly aggregateID: string
  readonly throughSeq: number
  readonly syncSeq: number
  readonly codec: string
  readonly schemaVersion: number
  readonly snapshotHash: string
  readonly body: Record<string, unknown>
  readonly ownerID?: string
  readonly createdAt: number
}

export const SnapshotManifest = Schema.Struct({
  format: Schema.Literal("chunked-rows.v1"),
  projectionRevision: Schema.String,
  contentHash: Schema.String,
  rowCount: NonNegativeInt,
  encodedBytes: NonNegativeInt,
  tables: Schema.Record(Schema.String, NonNegativeInt),
})
export type SnapshotManifest = typeof SnapshotManifest.Type

export type SerializedSnapshotRow = {
  readonly snapshotID: string
  readonly rowIndex: number
  readonly tableName: string
  readonly rowKey: string
  readonly rowHash: string
  readonly rowBytes: number
  readonly chunkCount: number
  readonly chainHash: string
}

export type SerializedSnapshotChunk = {
  readonly rowHash: string
  readonly chunkIndex: number
  readonly data: Buffer
  readonly chunkHash: string
}

export type SnapshotProjectionRow = {
  readonly cursor: string
  readonly tableName: string
  readonly rowKey: string
  readonly value: Record<string, unknown>
}

export type SnapshotCodec = {
  readonly codec: string
  readonly schemaVersion: number
  readonly rebuildEventTypes: ReadonlySet<string>
  readonly revision: (aggregateID: string) => Effect.Effect<string>
  readonly next: (aggregateID: string, cursor?: string) => Effect.Effect<SnapshotProjectionRow | undefined>
  readonly clear: (aggregateID: string, snapshotID: string, manifest: SnapshotManifest) => Effect.Effect<void>
  readonly import: (
    aggregateID: string,
    row: SnapshotProjectionRow,
    ownerID: string | undefined,
  ) => Effect.Effect<void>
}

export type SnapshotAttempt = {
  readonly snapshotID: string
  readonly aggregateID: string
  readonly throughSeq: number
  readonly expectedLatest: number
  readonly ownerID?: string
  readonly codec: string
  readonly schemaVersion: number
  readonly cursor?: string
  readonly rowCount: number
  readonly encodedBytes: number
  readonly state: "prepared" | "staged" | "complete"
  readonly hasMore: boolean
}

export type CursorEvent<E extends Payload = Payload> = {
  readonly cursor: Cursor
  readonly event: E
}

export class InvalidSyncEventError extends Schema.TaggedErrorClass<InvalidSyncEventError>()(
  "EventV2.InvalidSyncEvent",
  {
    type: Schema.String,
    message: Schema.String,
  },
) {}

export const MAX_ENCODED_PAYLOAD_BYTES = 4 * 1024 * 1024
export const AGGREGATE_READ_BATCH_EVENTS = 100
export const AGGREGATE_READ_BATCH_BYTES = 4 * 1024 * 1024
export const SNAPSHOT_MAX_ENCODED_BYTES = 16 * 1024 * 1024
export const SNAPSHOT_ROW_MAX_ENCODED_BYTES = 32 * 1024 * 1024
export const SNAPSHOT_MAX_TOTAL_BYTES = 64 * 1024 * 1024
export const SNAPSHOT_MAX_ROWS = 1_000_000
export const SNAPSHOT_CHUNK_BYTES = 256 * 1024
export const SNAPSHOT_TRANSFER_ROWS = 100
export const SNAPSHOT_STAGE_BATCH_BYTES = 8 * 1024 * 1024
export const SNAPSHOT_TRANSFER_CHUNKS = 16
export const LEGACY_ARTIFACT_BATCH_EVENTS = 1
export const LEGACY_DIFF_DESCRIPTOR_FILES = 200
export const ARTIFACT_CHUNK_BYTES = 256 * 1024

export class EncodedPayloadTooLargeError extends Schema.TaggedErrorClass<EncodedPayloadTooLargeError>()(
  "EventV2.EncodedPayloadTooLarge",
  {
    type: Schema.String,
    encodedBytes: NonNegativeInt,
    limitBytes: NonNegativeInt,
    message: Schema.String,
  },
) {}

export class ResyncRequiredError extends Schema.TaggedErrorClass<ResyncRequiredError>()(
  "EventV2.ResyncRequired",
  {
    aggregateID: Schema.String,
    requestedAfter: Schema.Number,
    snapshotID: Schema.String,
    baseSeq: NonNegativeInt,
    snapshotHash: Schema.String,
    message: Schema.String,
  },
) {}

export class MaintenanceRequiredError extends Schema.TaggedErrorClass<MaintenanceRequiredError>()(
  "EventV2.MaintenanceRequired",
  {
    operation: Schema.String,
    reason: Schema.String,
    message: Schema.String,
  },
) {}

export function versionedType(type: string, version: number) {
  return `${type}.${version}`
}

export const registry = new Map<string, Definition>()
type SyncDefinition = Definition & {
  readonly sync: NonNullable<Definition["sync"]>
  readonly encode: (data: unknown) => unknown
  readonly decode: (data: unknown) => unknown
}
const syncRegistry = new Map<string, SyncDefinition>()

function admitEncodedPayload(definition: SyncDefinition, data: unknown) {
  const encoded = definition.encode(data) as Record<string, unknown>
  const encodedBytes = Buffer.byteLength(JSON.stringify(encoded))
  if (encodedBytes > MAX_ENCODED_PAYLOAD_BYTES)
    return {
      error: new EncodedPayloadTooLargeError({
        type: definition.type,
        encodedBytes,
        limitBytes: MAX_ENCODED_PAYLOAD_BYTES,
        message: `Encoded event payload is ${encodedBytes} bytes; limit is ${MAX_ENCODED_PAYLOAD_BYTES} bytes`,
      }),
    } as const
  return { encoded } as const
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => item === undefined ? "null" : stableJson(item)).join(",")}]`
  if (value && typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`
  return JSON.stringify(value) ?? "null"
}

function hashJson(value: unknown) {
  return Hash.sha256(stableJson(value))
}

// Synchronized events cross a JSON boundary, so their data schemas must encode and decode without services.
const syncCodec = (definition: Definition) => definition.data as Schema.Codec<unknown, unknown, never, never>

export function define<const Type extends string, Fields extends Schema.Struct.Fields>(input: {
  readonly type: Type
  readonly sync?: {
    readonly version: number
    readonly aggregate: string
  }
  readonly schema: Fields
}): Schema.Schema<Payload<Definition<Type, Schema.Struct<Fields>>>> & Definition<Type, Schema.Struct<Fields>> {
  const Data = Schema.Struct(input.schema)
  const Payload = Schema.Struct({
    id: ID,
    metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
    type: Schema.Literal(input.type),
    version: Schema.optional(Schema.Number),
    location: Schema.optional(Location.Ref),
    data: Data,
  }).annotate({ identifier: input.type })

  const definition = Object.assign(Payload, {
    type: input.type,
    ...(input.sync === undefined ? {} : { sync: input.sync }),
    data: Data,
  })
  const existing = registry.get(input.type)
  if (input.sync === undefined || existing?.sync === undefined || input.sync.version >= existing.sync.version) {
    registry.set(input.type, definition)
  }
  if (input.sync)
    syncRegistry.set(
      versionedType(input.type, input.sync.version),
      Object.assign(definition, {
        encode: Schema.encodeUnknownSync(syncCodec(definition)),
        decode: Schema.decodeUnknownSync(syncCodec(definition)),
      }) as SyncDefinition,
    )
  return definition as Schema.Schema<Payload<Definition<Type, Schema.Struct<Fields>>>> &
    Definition<Type, Schema.Struct<Fields>>
}

export function definitions() {
  return registry.values().toArray()
}

export interface PublishOptions {
  readonly id?: ID
  /** Accept an exact retry of a synchronized event with the same explicit ID without re-projecting or re-publishing it. */
  readonly idempotent?: boolean
  readonly metadata?: Record<string, unknown>
  readonly location?: Location.Ref
  /**
   * Local operational projection committed atomically with a synchronized event. Exact idempotent
   * publish retries run this hook again so a caller can repair a missing local receipt; the hook must
   * therefore use an idempotent write or CAS. It is not replayed from the serialized event log.
   */
  readonly commit?: (seq: number) => Effect.Effect<void>
}

export interface Interface {
  readonly publish: <D extends Definition>(
    definition: D,
    data: Data<D>,
    options?: PublishOptions,
  ) => Effect.Effect<Payload<D>>
  readonly subscribe: <D extends Definition>(definition: D) => Stream.Stream<Payload<D>>
  readonly all: () => Stream.Stream<Payload>
  readonly aggregateEvents: (input: {
    readonly aggregateID: string
    readonly after?: Cursor
  }) => Stream.Stream<CursorEvent>
  readonly sync: (handler: Sync) => Effect.Effect<Unsubscribe>
  readonly listen: (listener: Listener) => Effect.Effect<Unsubscribe>
  readonly beforeCommit: (guard: CommitGuard) => Effect.Effect<void>
  readonly project: <D extends Definition>(definition: D, projector: Projector<D>) => Effect.Effect<void>
  readonly registerSnapshotCodec?: (codec: SnapshotCodec) => Effect.Effect<void>
  readonly replay: (
    event: SerializedEvent,
    options?: { readonly publish?: boolean; readonly ownerID?: string; readonly strictOwner?: boolean },
  ) => Effect.Effect<void>
  readonly replayAll: (
    events: SerializedEvent[],
    options?: { readonly publish?: boolean; readonly ownerID?: string; readonly strictOwner?: boolean },
  ) => Effect.Effect<string | undefined>
  readonly snapshot: (aggregateID: string) => Effect.Effect<SerializedSnapshot | undefined>
  readonly prepareCheckpoint?: (input: {
    readonly aggregateID: string
    readonly throughSeq: Cursor
    readonly codec: string
    readonly schemaVersion: number
    readonly expectedLatest: Cursor
    readonly ownerID?: string
    readonly now?: number
  }) => Effect.Effect<SnapshotAttempt>
  readonly stageCheckpoint?: (input: {
    readonly snapshotID: string
    readonly limit?: number
    readonly now?: number
  }) => Effect.Effect<SnapshotAttempt>
  readonly finalizeCheckpoint?: (input: {
    readonly snapshotID: string
    readonly now?: number
  }) => Effect.Effect<SerializedSnapshot>
  readonly discardCheckpoint?: (input: {
    readonly snapshotID: string
    readonly limit?: number
  }) => Effect.Effect<{ readonly deletedRows: number; readonly complete: boolean }>
  readonly checkpoint: (input: {
    readonly aggregateID: string
    readonly throughSeq: Cursor
    readonly codec: string
    readonly schemaVersion: number
    readonly expectedLatest: Cursor
    readonly ownerID?: string
    readonly now?: number
  }) => Effect.Effect<SerializedSnapshot>
  readonly importSnapshot: (snapshot: SerializedSnapshot) => Effect.Effect<void>
  readonly snapshotRows?: (input: {
    readonly snapshotID: string
    readonly after?: number
    readonly limit?: number
  }) => Effect.Effect<SerializedSnapshotRow[]>
  readonly snapshotChunks?: (input: {
    readonly rowHash: string
    readonly after?: number
    readonly limit?: number
  }) => Effect.Effect<SerializedSnapshotChunk[]>
  readonly stageSnapshotRows?: (
    snapshot: SerializedSnapshot,
    rows: readonly SerializedSnapshotRow[],
  ) => Effect.Effect<void>
  readonly stageSnapshotChunks?: (
    snapshot: SerializedSnapshot,
    row: SerializedSnapshotRow,
    chunks: readonly SerializedSnapshotChunk[],
  ) => Effect.Effect<void>
  readonly compact: (input: {
    readonly aggregateID: string
    readonly throughSeq: Cursor
    readonly limit?: number
    readonly now?: number
  }) => Effect.Effect<{ readonly deleted: number; readonly complete: boolean }>
  readonly canonicalizeLegacyArtifacts: (input?: {
    readonly afterID?: ID
    readonly limit?: number
    readonly now?: number
  }) => Effect.Effect<{ readonly processed: number; readonly next?: ID }>
  readonly backfillSyncIndex?: (input?: {
    readonly limit?: number
    readonly now?: number
  }) => Effect.Effect<{ readonly processed: number; readonly complete: boolean }>
  readonly remove: (aggregateID: string) => Effect.Effect<void>
  readonly claim: (aggregateID: string, ownerID: string) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/Event") {}

export interface LayerOptions {
  readonly beforeAggregateRead?: (aggregateID: string) => Effect.Effect<void>
  readonly afterAggregateReadMetadata?: (aggregateID: string, eventIDs: readonly ID[]) => Effect.Effect<void>
  readonly afterAggregateRead?: (aggregateID: string) => Effect.Effect<void>
  readonly afterReplayAllCommit?: (aggregateID: string) => Effect.Effect<void>
}

export const layerWith = (layerOptions?: LayerOptions) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const all = yield* PubSub.unbounded<Payload>()
      const synchronized = new Map<string, Set<PubSub.PubSub<void>>>()
      const typed = new Map<string, PubSub.PubSub<Payload>>()
      const projectors = new Map<string, AnyProjector[]>()
      const snapshotCodecs = new Map<string, SnapshotCodec>()
      const commitGuards = new Array<CommitGuard>()
      const listeners = new Array<Listener>()
      const syncHandlers = new Array<Sync>()
      const { db } = yield* Database.Service

      const getOrCreate = (definition: Definition) =>
        Effect.gen(function* () {
          const existing = typed.get(definition.type)
          if (existing) return existing
          const pubsub = yield* PubSub.unbounded<Payload>()
          typed.set(definition.type, pubsub)
          return pubsub
        })

      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          yield* PubSub.shutdown(all)
          yield* Effect.forEach(
            synchronized.values(),
            (pubsubs) => Effect.forEach(pubsubs, PubSub.shutdown, { discard: true }),
            { discard: true },
          )
          yield* Effect.forEach(typed.values(), PubSub.shutdown, { discard: true })
        }),
      )

      function commitSyncEvent(
        event: Payload,
        input?: {
          readonly seq: number
          readonly aggregateID: string
          readonly ownerID?: string
          readonly strictOwner?: boolean
        },
        commit?: (seq: number) => Effect.Effect<void>,
        idempotent = false,
        deferDurableWake = false,
      ) {
        return Effect.gen(function* () {
          const definition = registry.get(event.type)
          const sync = definition?.sync
          if (sync) {
            if (event.version !== sync.version) {
              yield* Effect.die(
                new InvalidSyncEventError({
                  type: event.type,
                  message: `Expected event version ${sync.version}, got ${event.version}`,
                }),
              )
            }
            const aggregateID = (event.data as Record<string, unknown>)[sync.aggregate]
            if (typeof aggregateID !== "string") {
              yield* Effect.die(
                new InvalidSyncEventError({
                  type: event.type,
                  message: `Expected string aggregate field ${sync.aggregate}`,
                }),
              )
            } else {
              if (input && input.aggregateID !== aggregateID) {
                yield* Effect.die(
                  new InvalidSyncEventError({
                    type: event.type,
                    message: `Aggregate mismatch: expected ${input.aggregateID}, got ${aggregateID}`,
                  }),
                )
              }
              const codec = syncRegistry.get(versionedType(definition.type, sync.version))!
              const original = codec.encode(event.data) as Record<string, unknown>
              const prepared = FilePartArtifact.prepare(
                definition.type,
                original,
                Buffer.byteLength(JSON.stringify(original)),
                MAX_ENCODED_PAYLOAD_BYTES,
              )
              const canonicalEvent = { ...event, data: codec.decode(prepared.data) } as Payload
              const admission = admitEncodedPayload(codec, canonicalEvent.data)
              if ("error" in admission) return yield* Effect.die(admission.error)
              const encoded = admission.encoded
              const list = projectors.get(event.type) ?? []
              return yield* Effect.uninterruptible(
                Effect.gen(function* () {
                  const committed = yield* db
                    .transaction(
                      () =>
                        Effect.gen(function* () {
                          const row = yield* db
                            .select({
                              seq: EventSequenceTable.seq,
                              ownerID: EventSequenceTable.owner_id,
                              writeFence: EventSequenceTable.write_fence_transfer_id,
                            })
                            .from(EventSequenceTable)
                            .where(eq(EventSequenceTable.aggregate_id, aggregateID))
                            .get()
                            .pipe(Effect.orDie)
                          const latest = row?.seq ?? -1
                          if (input?.strictOwner && row?.ownerID && row.ownerID !== input.ownerID) {
                            yield* Effect.die(
                              new InvalidSyncEventError({
                                type: event.type,
                                message: `Replay owner mismatch for aggregate ${aggregateID}: expected ${row.ownerID}, got ${input.ownerID ?? "none"}`,
                              }),
                            )
                          }
                          if (input && input.seq <= latest) {
                            const stored = yield* db
                              .select()
                              .from(EventTable)
                              .where(and(eq(EventTable.aggregate_id, aggregateID), eq(EventTable.seq, input.seq)))
                              .get()
                              .pipe(Effect.orDie)
                            const artifact = stored
                              ? yield* db
                                  .select({
                                    originalDataHash: EventArtifactTable.original_data_hash,
                                    canonicalData: EventArtifactTable.canonical_data,
                                    codecVersion: EventArtifactTable.codec_version,
                                  })
                                  .from(EventArtifactTable)
                                  .where(eq(EventArtifactTable.event_id, stored.id))
                                  .get()
                                  .pipe(Effect.orDie)
                              : undefined
                            const fileArtifact = stored
                              ? yield* db
                                  .select({
                                    originalDataHash: FilePartArtifactBindingTable.original_data_hash,
                                    canonicalData: FilePartArtifactBindingTable.canonical_data,
                                  })
                                  .from(FilePartArtifactBindingTable)
                                  .where(eq(FilePartArtifactBindingTable.event_id, stored.id))
                                  .get()
                                  .pipe(Effect.orDie)
                              : undefined
                            const dedupe = !stored
                              ? yield* db
                                  .select()
                                  .from(EventDedupeTable)
                                  .where(
                                    and(
                                      eq(EventDedupeTable.aggregate_id, aggregateID),
                                      eq(EventDedupeTable.seq, input.seq),
                                    ),
                                  )
                                  .get()
                                  .pipe(Effect.orDie)
                              : undefined
                            if (
                              ((stored?.id === event.id &&
                                stored.type === versionedType(definition.type, sync.version) &&
                                (isDeepStrictEqual(stored.data, encoded) ||
                                  isDeepStrictEqual(artifact?.canonicalData, encoded) ||
                                  (isDeepStrictEqual(fileArtifact?.canonicalData, encoded) &&
                                    (fileArtifact?.originalDataHash === Hash.sha256(JSON.stringify(original)) ||
                                      isDeepStrictEqual(stored.data, original))) ||
                                  (artifact &&
                                    artifact.originalDataHash ===
                                      (artifact.codecVersion >= 2
                                        ? Hash.sha256(JSON.stringify(encoded))
                                        : hashJson(encoded))))) ||
                                (dedupe?.event_id === event.id &&
                                  dedupe.type === versionedType(definition.type, sync.version) &&
                                  dedupe.data_hash === hashJson(encoded)))
                            ) {
                              if (input.ownerID && row?.ownerID == null) {
                                for (const guard of commitGuards) {
                                  yield* guard({ ...event, replayExact: true })
                                }
                                yield* db
                                  .update(EventSequenceTable)
                                  .set({ owner_id: input.ownerID })
                                  .where(eq(EventSequenceTable.aggregate_id, aggregateID))
                                  .run()
                                  .pipe(Effect.orDie)
                              }
                              return
                            }
                            yield* Effect.die(
                              new InvalidSyncEventError({
                                type: event.type,
                                message: `Replay diverged at aggregate ${aggregateID} sequence ${input.seq}`,
                              }),
                            )
                          }
                          if (row?.writeFence)
                            return yield* Effect.die(
                              new InvalidSyncEventError({
                                type: event.type,
                                message: `Aggregate ${aggregateID} is fenced by transfer ${row.writeFence}`,
                              }),
                            )
                          if (input && row?.ownerID && row.ownerID !== input.ownerID) {
                            return
                          }
                          const seq = input?.seq ?? latest + 1
                          if (input && seq !== latest + 1) {
                            yield* Effect.die(
                              new InvalidSyncEventError({
                                type: event.type,
                                message: `Sequence mismatch for aggregate ${aggregateID}: expected ${latest + 1}, got ${seq}`,
                              }),
                            )
                          }
                          const stored = yield* db
                            .select({
                              aggregateID: EventTable.aggregate_id,
                              seq: EventTable.seq,
                              type: EventTable.type,
                              data: EventTable.data,
                            })
                            .from(EventTable)
                            .where(eq(EventTable.id, event.id))
                            .get()
                            .pipe(Effect.orDie)
                          if (
                            stored &&
                            idempotent &&
                            stored.aggregateID === aggregateID &&
                            stored.type === versionedType(definition.type, sync.version) &&
                            isDeepStrictEqual(stored.data, encoded)
                          ) {
                            if (commit) yield* commit(stored.seq)
                            return { aggregateID, seq: stored.seq, inserted: false }
                          }
                          if (stored)
                            yield* Effect.die(
                              new InvalidSyncEventError({
                                type: event.type,
                                message: `Event ${event.id} already exists at aggregate ${stored.aggregateID} sequence ${stored.seq}`,
                              }),
                            )
                          yield* Effect.forEach(prepared.artifacts, (artifact) => FilePartArtifact.put(db, artifact), {
                            discard: true,
                          })
                          if (prepared.artifacts.length === 0) {
                            const descriptor = FilePartArtifact.descriptor(encoded)
                            if (descriptor) yield* FilePartArtifact.requireAvailable(db, descriptor)
                          }
                          for (const guard of commitGuards) {
                            yield* guard(canonicalEvent)
                          }
                          for (const projector of list) {
                            yield* projector({ ...canonicalEvent, seq } as Payload)
                          }
                          if (commit) yield* commit(seq)
                          yield* db
                            .insert(EventSequenceTable)
                            .values([{ aggregate_id: aggregateID, seq, owner_id: input?.ownerID }])
                            .onConflictDoUpdate({
                              target: EventSequenceTable.aggregate_id,
                              set: {
                                seq,
                                ...(input?.ownerID && row?.ownerID == null ? { owner_id: input.ownerID } : {}),
                              },
                            })
                            .run()
                            .pipe(Effect.orDie)
                          const syncSequence = yield* db
                            .update(EventSyncSequenceTable)
                            .set({ seq: sql`${EventSyncSequenceTable.seq} + 1` })
                            .where(eq(EventSyncSequenceTable.id, 1))
                            .returning({ seq: EventSyncSequenceTable.seq })
                            .get()
                            .pipe(Effect.orDie)
                          if (!syncSequence)
                            return yield* Effect.die(
                              new InvalidSyncEventError({ type: event.type, message: "Sync sequence authority missing" }),
                            )
                          yield* db
                            .insert(EventTable)
                            .values([
                              {
                                id: event.id,
                                aggregate_id: aggregateID,
                                seq,
                                type: versionedType(definition.type, sync.version),
                                data: encoded,
                                sync_seq: syncSequence.seq,
                              },
                            ])
                            .run()
                            .pipe(Effect.orDie)
                          yield* FilePartArtifact.bind(db, {
                            eventID: event.id,
                            aggregateID,
                            seq,
                            type: definition.type,
                            data: encoded,
                            originalData: original,
                            requireImport: Boolean(canonicalEvent.replay),
                          })
                          return { aggregateID, seq, inserted: true, event: canonicalEvent }
                        }),
                      { behavior: "immediate" },
                    )
                    .pipe(Effect.orDie)
                  if (committed?.inserted && !deferDurableWake) {
                    yield* Effect.forEach(
                      synchronized.get(committed.aggregateID) ?? [],
                      (pubsub) => PubSub.publish(pubsub, undefined),
                      { discard: true },
                    )
                  }
                  return committed
                }),
              )
            }
          }
        })
      }

      function publishEvent<D extends Definition>(
        event: Payload<D>,
        commit?: PublishOptions["commit"],
        idempotent = false,
      ) {
        return Effect.gen(function* () {
          const durable = registry.get(event.type)?.sync !== undefined
          if (!durable && commit)
            return yield* Effect.die(
              new InvalidSyncEventError({
                type: event.type,
                message: "Local commit hooks require a synchronized event",
              }),
            )
          if (durable) {
            const committed = yield* commitSyncEvent(event as Payload, undefined, commit, idempotent)
            if (committed) {
              event = { ...(committed.event ?? event), seq: committed.seq } as Payload<D>
              if (committed.inserted) {
                yield* Effect.forEach(syncHandlers, (sync) => observe(event as Payload, "sync", sync), {
                  discard: true,
                })
                yield* notify(event as Payload, true)
              }
              return event
            }
          }
          yield* notify(event as Payload, false)
          return event
        })
      }

      const observe = (event: Payload, kind: "sync" | "listener", observer: (event: Payload) => Effect.Effect<void>) =>
        Effect.suspend(() => observer(event)).pipe(
          Effect.catchCauseIf(
            (cause) => !Cause.hasInterrupts(cause),
            (cause) =>
              Effect.logError("Event observer failed").pipe(
                Effect.annotateLogs({ eventID: event.id, eventType: event.type, kind, cause }),
              ),
          ),
        )

      function notify(event: Payload, isolateListeners: boolean) {
        return Effect.gen(function* () {
          yield* Effect.forEach(
            listeners,
            (listener) => (isolateListeners ? observe(event, "listener", listener) : listener(event)),
            { discard: true },
          )
          const pubsub = typed.get(event.type)
          if (pubsub) yield* PubSub.publish(pubsub, event)
          yield* PubSub.publish(all, event)
        })
      }

      function publish<D extends Definition>(definition: D, data: Data<D>, options?: PublishOptions) {
        return Effect.gen(function* () {
          if (options?.idempotent && (!options.id || definition.sync === undefined)) {
            return yield* Effect.die(
              new InvalidSyncEventError({
                type: definition.type,
                message: "Idempotent publish requires a synchronized event and an explicit event ID",
              }),
            )
          }
          const serviceLocation = Option.getOrUndefined(yield* Effect.serviceOption(Location.Service))
          const location =
            options?.location ??
            (serviceLocation
              ? { directory: serviceLocation.directory, workspaceID: serviceLocation.workspaceID }
              : undefined)
          return yield* publishEvent(
            {
              id: options?.id ?? ID.create(),
              ...(options?.metadata ? { metadata: options.metadata } : {}),
              type: definition.type,
              ...(definition.sync === undefined ? {} : { version: definition.sync.version }),
              ...(location ? { location } : {}),
              data,
            } as Payload<D>,
            options?.commit,
            options?.idempotent,
          )
        })
      }

      function replay(
        event: SerializedEvent,
        options?: {
          readonly publish?: boolean
          readonly ownerID?: string
          readonly strictOwner?: boolean
          readonly onCommitted?: (event: Payload) => void
          readonly deferDurableWake?: boolean
        },
      ) {
        return Effect.gen(function* () {
          const definition = syncRegistry.get(event.type)
          if (!definition) {
            yield* Effect.die(
              new InvalidSyncEventError({ type: event.type, message: `Unknown sync event type ${event.type}` }),
            )
          } else {
            const payload = {
              id: event.id,
              type: definition.type,
              version: definition.sync.version,
              seq: event.seq,
              data: definition.decode(event.data),
              replay: true,
              ...(options?.ownerID ? { replayOwnerID: options.ownerID } : {}),
            } as Payload
            const committed = yield* commitSyncEvent(
              payload,
              {
                seq: event.seq,
                aggregateID: event.aggregateID,
                ownerID: options?.ownerID,
                strictOwner: options?.strictOwner,
              },
              undefined,
              false,
              options?.deferDurableWake,
            )
            if (committed) options?.onCommitted?.({ ...(committed.event ?? payload), seq: committed.seq })
            if (committed && options?.publish) {
              yield* notify({ ...(committed.event ?? payload), seq: committed.seq }, true)
            }
          }
        })
      }

      function replayAll(
        events: SerializedEvent[],
        options?: { readonly publish?: boolean; readonly ownerID?: string; readonly strictOwner?: boolean },
      ) {
        return Effect.gen(function* () {
          const source = events[0]?.aggregateID
          if (!source) return undefined
          if (events.some((event) => event.aggregateID !== source)) {
            yield* Effect.die(
              new InvalidSyncEventError({
                type: events[0]?.type ?? "unknown",
                message: "Replay events must belong to the same aggregate",
              }),
            )
          }
          const start = events[0]?.seq ?? 0
          for (const [index, event] of events.entries()) {
            const seq = start + index
            if (event.seq !== seq) {
              yield* Effect.die(
                new InvalidSyncEventError({
                  type: event.type,
                  message: `Replay sequence mismatch at index ${index}: expected ${seq}, got ${event.seq}`,
                }),
              )
            }
          }
          for (const event of events) {
            const definition = syncRegistry.get(event.type)
            if (!definition) {
              yield* Effect.die(
                new InvalidSyncEventError({ type: event.type, message: `Unknown sync event type ${event.type}` }),
              )
              continue
            }
            const admission = admitEncodedPayload(definition, definition.decode(event.data))
            if ("error" in admission) return yield* Effect.die(admission.error)
          }
          const committed: Payload[] = []
          yield* Effect.uninterruptible(
            Effect.gen(function* () {
              yield* db
                .transaction(
                  () =>
                    Effect.forEach(
                      events,
                      (event) =>
                        replay(event, {
                          ...options,
                          publish: false,
                          deferDurableWake: true,
                          onCommitted: (event) => committed.push(event),
                        }),
                      { discard: true },
                    ),
                  { behavior: "immediate" },
                )
                .pipe(Effect.orDie)
              yield* (layerOptions?.afterReplayAllCommit?.(source) ?? Effect.void).pipe(
                Effect.catchCause(() => Effect.void),
              )
              if (committed.length > 0)
                yield* Effect.forEach(synchronized.get(source) ?? [], (pubsub) => PubSub.publish(pubsub, undefined), {
                  discard: true,
                })
            }),
          )
          if (options?.publish) yield* Effect.forEach(committed, (event) => notify(event, true), { discard: true })
          return source
        })
      }

      function snapshot(aggregateID: string) {
        return db
          .select({
            snapshotID: EventSnapshotTable.snapshot_id,
            aggregateID: EventSnapshotTable.aggregate_id,
            throughSeq: EventSnapshotTable.through_seq,
            syncSeq: EventSnapshotTable.sync_seq,
            codec: EventSnapshotTable.codec,
            schemaVersion: EventSnapshotTable.schema_version,
            snapshotHash: EventSnapshotTable.snapshot_hash,
            body: EventSnapshotTable.body,
            ownerID: EventSnapshotTable.owner_id,
            createdAt: EventSnapshotTable.created_at,
          })
          .from(EventSnapshotTable)
          .innerJoin(EventSequenceTable, eq(EventSequenceTable.snapshot_id, EventSnapshotTable.snapshot_id))
          .where(eq(EventSnapshotTable.aggregate_id, aggregateID))
          .get()
          .pipe(
            Effect.orDie,
            Effect.map((row) =>
              row
                ? {
                    snapshotID: row.snapshotID,
                    aggregateID: row.aggregateID,
                    throughSeq: row.throughSeq,
                    syncSeq: row.syncSeq,
                    codec: row.codec,
                    schemaVersion: row.schemaVersion,
                    snapshotHash: row.snapshotHash,
                    body: row.body,
                    ...(row.ownerID ? { ownerID: row.ownerID } : {}),
                    createdAt: row.createdAt,
                  }
                : undefined,
            ),
          )
      }

      function checkpoint(input: {
        readonly aggregateID: string
        readonly throughSeq: Cursor
        readonly codec: string
        readonly schemaVersion: number
        readonly expectedLatest: Cursor
        readonly ownerID?: string
        readonly now?: number
      }) {
        return Effect.gen(function* () {
          const attempt = yield* prepareCheckpoint(input)
          if (attempt.state === "complete") {
            const existing = yield* snapshot(input.aggregateID)
            if (existing?.snapshotID === attempt.snapshotID) return existing
            return yield* Effect.die(new InvalidSyncEventError({
              type: "snapshot",
              message: `Completed snapshot attempt ${attempt.snapshotID} is not active`,
            }))
          }
          let staged = attempt
          while (staged.state !== "staged") staged = yield* stageCheckpoint({ snapshotID: staged.snapshotID })
          return yield* finalizeCheckpoint({ snapshotID: staged.snapshotID, now: input.now })
        })
      }

      const snapshotAttempt = (row: typeof EventSnapshotAttemptTable.$inferSelect): SnapshotAttempt => ({
        snapshotID: row.snapshot_id,
        aggregateID: row.aggregate_id,
        throughSeq: row.through_seq,
        expectedLatest: row.expected_latest,
        ...(row.owner_id ? { ownerID: row.owner_id } : {}),
        codec: row.codec,
        schemaVersion: row.schema_version,
        ...(row.cursor ? { cursor: row.cursor } : {}),
        rowCount: row.row_count,
        encodedBytes: row.encoded_bytes,
        state: row.state,
        hasMore: row.state === "prepared",
      })

      function prepareCheckpoint(input: {
        readonly aggregateID: string
        readonly throughSeq: Cursor
        readonly codec: string
        readonly schemaVersion: number
        readonly expectedLatest: Cursor
        readonly ownerID?: string
        readonly now?: number
      }) {
        return db.transaction(
          () => Effect.gen(function* () {
            const codec = snapshotCodecs.get(`${input.codec}@${input.schemaVersion}`)
            if (!codec)
              return yield* Effect.die(new InvalidSyncEventError({
                type: "snapshot",
                message: `Unsupported snapshot codec ${input.codec}@${input.schemaVersion}`,
              }))
            const projectionRevision = yield* codec.revision(input.aggregateID)
            const snapshotID = `evtsnap_${Hash.sha256(
              `${input.codec}:${input.schemaVersion}:${input.aggregateID}:${input.throughSeq}:${projectionRevision}`,
            )}`
            const syncAuthority = yield* db.select({ complete: EventSyncSequenceTable.backfill_complete })
              .from(EventSyncSequenceTable).where(eq(EventSyncSequenceTable.id, 1)).get().pipe(Effect.orDie)
            if (!syncAuthority?.complete)
              return yield* Effect.die(new MaintenanceRequiredError({
                operation: "snapshot.checkpoint",
                reason: "event_sync_backfill_required",
                message: "Event sync index backfill must complete before checkpointing",
              }))
            const current = yield* db.select({
              seq: EventSequenceTable.seq,
              ownerID: EventSequenceTable.owner_id,
              floor: EventSequenceTable.retention_floor_seq,
              fence: EventSequenceTable.write_fence_transfer_id,
            }).from(EventSequenceTable).where(eq(EventSequenceTable.aggregate_id, input.aggregateID)).get().pipe(Effect.orDie)
            if (!current || current.seq !== input.expectedLatest || input.throughSeq !== current.seq ||
              input.throughSeq < (current.floor ?? -1) || current.fence !== null ||
              (input.ownerID !== undefined && current.ownerID !== input.ownerID))
              return yield* Effect.die(new InvalidSyncEventError({
                type: "snapshot",
                message: `Snapshot authority changed or is fenced for aggregate ${input.aggregateID}`,
              }))
            const existing = yield* db.select().from(EventSnapshotAttemptTable)
              .where(eq(EventSnapshotAttemptTable.snapshot_id, snapshotID)).get().pipe(Effect.orDie)
            if (existing) return snapshotAttempt(existing)
            const now = input.now ?? Date.now()
            const inserted = yield* db.insert(EventSnapshotAttemptTable).values({
              snapshot_id: snapshotID,
              aggregate_id: input.aggregateID,
              through_seq: input.throughSeq,
              expected_latest: input.expectedLatest,
              owner_id: input.ownerID,
              codec: input.codec,
              schema_version: input.schemaVersion,
              projection_revision: projectionRevision,
              row_count: 0,
              encoded_bytes: 0,
              content_hash: Hash.sha256(""),
              tables: {},
              state: "prepared",
              created_at: now,
              updated_at: now,
            }).returning().get().pipe(Effect.orDie)
            return snapshotAttempt(inserted!)
          }),
          { behavior: "immediate" },
        ).pipe(Effect.orDie)
      }

      function stageCheckpoint(input: { readonly snapshotID: string; readonly limit?: number; readonly now?: number }) {
        const limit = Math.min(Math.max(input.limit ?? SNAPSHOT_TRANSFER_ROWS, 1), SNAPSHOT_TRANSFER_ROWS)
        return db.transaction(
          () => Effect.gen(function* () {
            const attempt = yield* db.select().from(EventSnapshotAttemptTable)
              .where(eq(EventSnapshotAttemptTable.snapshot_id, input.snapshotID)).get().pipe(Effect.orDie)
            if (!attempt) return yield* Effect.die(new InvalidSyncEventError({ type: "snapshot", message: `Unknown snapshot attempt ${input.snapshotID}` }))
            if (attempt.state !== "prepared") return snapshotAttempt(attempt)
            const codec = snapshotCodecs.get(`${attempt.codec}@${attempt.schema_version}`)
            if (!codec) return yield* Effect.die(new InvalidSyncEventError({ type: "snapshot", message: `Unsupported snapshot codec ${attempt.codec}@${attempt.schema_version}` }))
            let cursor = attempt.cursor ?? undefined
            let rowCount = attempt.row_count
            let encodedBytes = attempt.encoded_bytes
            let batchBytes = 0
            const tables = { ...attempt.tables }
            let staged = 0
            let exhausted = false
            while (staged < limit) {
              const row = yield* codec.next(attempt.aggregate_id, cursor)
              if (!row) {
                exhausted = true
                break
              }
              if (rowCount >= SNAPSHOT_MAX_ROWS) return yield* Effect.die(new InvalidSyncEventError({ type: "snapshot", message: `Snapshot exceeds ${SNAPSHOT_MAX_ROWS} projection rows` }))
              const data = Buffer.from(stableJson(row.value))
              if (data.length > SNAPSHOT_ROW_MAX_ENCODED_BYTES) return yield* Effect.die(new EncodedPayloadTooLargeError({
                type: `event.snapshot.${row.tableName}`, encodedBytes: data.length, limitBytes: SNAPSHOT_ROW_MAX_ENCODED_BYTES,
                message: `Snapshot row ${row.tableName}:${row.rowKey} exceeds the per-row limit`,
              }))
              if (encodedBytes + data.length > SNAPSHOT_MAX_TOTAL_BYTES) return yield* Effect.die(new EncodedPayloadTooLargeError({
                type: "event.snapshot", encodedBytes: encodedBytes + data.length, limitBytes: SNAPSHOT_MAX_TOTAL_BYTES,
                message: `Snapshot exceeds the ${SNAPSHOT_MAX_TOTAL_BYTES} byte total limit`,
              }))
              if (staged > 0 && batchBytes + data.length > SNAPSHOT_STAGE_BATCH_BYTES) break
              encodedBytes += data.length
              const rowHash = Hash.sha256(data)
              const chunks = Math.ceil(data.length / SNAPSHOT_CHUNK_BYTES)
              const chainHash = Hash.sha256(`${attempt.content_hash}\0${row.tableName}\0${row.rowKey}\0${rowHash}\0${data.length}`)
              const insertedRow = yield* db.insert(EventSnapshotRowTable).values({
                snapshot_id: input.snapshotID, row_index: rowCount, table_name: row.tableName, row_key: row.rowKey,
                row_hash: rowHash, row_bytes: data.length, chunk_count: chunks, chain_hash: chainHash,
              }).onConflictDoNothing().returning().get().pipe(Effect.orDie)
              if (!insertedRow) {
                const existing = yield* db.select().from(EventSnapshotRowTable).where(and(
                  eq(EventSnapshotRowTable.snapshot_id, input.snapshotID),
                  eq(EventSnapshotRowTable.row_index, rowCount),
                )).get().pipe(Effect.orDie)
                if (!existing || existing.table_name !== row.tableName || existing.row_key !== row.rowKey ||
                  existing.row_hash !== rowHash || existing.row_bytes !== data.length || existing.chunk_count !== chunks ||
                  existing.chain_hash !== chainHash)
                  return yield* Effect.die(new InvalidSyncEventError({ type: "snapshot", message: `Snapshot row ${rowCount} conflicts with staged content` }))
              }
              yield* Effect.forEach(Array.from({ length: chunks }, (_, index) => index), (index) => {
                const chunk = data.subarray(index * SNAPSHOT_CHUNK_BYTES, (index + 1) * SNAPSHOT_CHUNK_BYTES)
                return db.insert(EventSnapshotChunkTable).values({ row_hash: rowHash, chunk_index: index, data: chunk, chunk_hash: Hash.sha256(chunk) })
                  .onConflictDoNothing().returning().get().pipe(
                    Effect.orDie,
                    Effect.flatMap((inserted) => {
                      if (inserted) return Effect.void
                      return db.select().from(EventSnapshotChunkTable).where(and(
                        eq(EventSnapshotChunkTable.row_hash, rowHash),
                        eq(EventSnapshotChunkTable.chunk_index, index),
                      )).get().pipe(
                        Effect.orDie,
                        Effect.flatMap((existing) => existing && existing.chunk_hash === Hash.sha256(chunk) && Buffer.from(existing.data).equals(chunk)
                          ? Effect.void
                          : Effect.die(new InvalidSyncEventError({ type: "snapshot", message: `Snapshot chunk ${rowHash}:${index} conflicts with staged content` }))),
                      )
                    }),
                  )
              }, { discard: true })
              tables[row.tableName] = (tables[row.tableName] ?? 0) + 1
              attempt.content_hash = chainHash
              cursor = row.cursor
              rowCount += 1
              batchBytes += data.length
              staged += 1
            }
            const updated = yield* db.update(EventSnapshotAttemptTable).set({
              cursor,
              row_count: rowCount,
              encoded_bytes: encodedBytes,
              tables,
              content_hash: attempt.content_hash,
              state: exhausted ? "staged" : "prepared",
              updated_at: input.now ?? Date.now(),
            }).where(and(eq(EventSnapshotAttemptTable.snapshot_id, input.snapshotID), eq(EventSnapshotAttemptTable.row_count, attempt.row_count)))
              .returning().get().pipe(Effect.orDie)
            if (!updated) return yield* Effect.die(new InvalidSyncEventError({ type: "snapshot", message: `Snapshot attempt ${input.snapshotID} changed concurrently` }))
            return snapshotAttempt(updated)
          }),
          { behavior: "immediate" },
        ).pipe(Effect.orDie)
      }

      function finalizeCheckpoint(input: { readonly snapshotID: string; readonly now?: number }) {
        return db.transaction(
          () => Effect.gen(function* () {
            const attempt = yield* db.select().from(EventSnapshotAttemptTable)
              .where(eq(EventSnapshotAttemptTable.snapshot_id, input.snapshotID)).get().pipe(Effect.orDie)
            if (!attempt || attempt.state !== "staged") return yield* Effect.die(new InvalidSyncEventError({ type: "snapshot", message: `Snapshot attempt ${input.snapshotID} is not fully staged` }))
            if (attempt.tables.session !== 1) return yield* Effect.die(new InvalidSyncEventError({ type: "snapshot", message: `Canonical projection for ${attempt.aggregate_id} must contain one Session root` }))
            const current = yield* db.select({ seq: EventSequenceTable.seq, ownerID: EventSequenceTable.owner_id, fence: EventSequenceTable.write_fence_transfer_id })
              .from(EventSequenceTable).where(eq(EventSequenceTable.aggregate_id, attempt.aggregate_id)).get().pipe(Effect.orDie)
            if (!current || current.seq !== attempt.expected_latest || current.ownerID !== attempt.owner_id || current.fence !== null)
              return yield* Effect.die(new InvalidSyncEventError({ type: "snapshot", message: `Snapshot finalize authority changed for aggregate ${attempt.aggregate_id}` }))
            const codec = snapshotCodecs.get(`${attempt.codec}@${attempt.schema_version}`)
            if (!codec || (yield* codec.revision(attempt.aggregate_id)) !== attempt.projection_revision)
              return yield* Effect.die(new InvalidSyncEventError({ type: "snapshot", message: `Snapshot projection changed for aggregate ${attempt.aggregate_id}` }))
            const rowCount = yield* db.$count(EventSnapshotRowTable, eq(EventSnapshotRowTable.snapshot_id, input.snapshotID)).pipe(Effect.orDie)
            const lastRow = yield* db.select({ index: EventSnapshotRowTable.row_index, chainHash: EventSnapshotRowTable.chain_hash })
              .from(EventSnapshotRowTable).where(eq(EventSnapshotRowTable.snapshot_id, input.snapshotID))
              .orderBy(sql`${EventSnapshotRowTable.row_index} DESC`).limit(1).get().pipe(Effect.orDie)
            const body = SnapshotManifest.make({ format: "chunked-rows.v1", projectionRevision: attempt.projection_revision,
              contentHash: attempt.content_hash, rowCount: attempt.row_count, encodedBytes: attempt.encoded_bytes, tables: attempt.tables })
            if (rowCount !== attempt.row_count) return yield* Effect.die(new InvalidSyncEventError({ type: "snapshot", message: `Snapshot attempt ${input.snapshotID} lost staged rows` }))
            if (!lastRow || lastRow.index !== attempt.row_count - 1 || lastRow.chainHash !== attempt.content_hash)
              return yield* Effect.die(new InvalidSyncEventError({ type: "snapshot", message: `Snapshot attempt ${input.snapshotID} metadata chain is incomplete` }))
            const syncSequence = yield* db.update(EventSyncSequenceTable).set({ seq: sql`${EventSyncSequenceTable.seq} + 1` })
              .where(eq(EventSyncSequenceTable.id, 1)).returning({ seq: EventSyncSequenceTable.seq }).get().pipe(Effect.orDie)
            if (!syncSequence) return yield* Effect.die(new InvalidSyncEventError({ type: "snapshot", message: "Sync sequence authority missing" }))
            const createdAt = input.now ?? Date.now()
            const snapshotHash = hashJson(body)
            yield* db.insert(EventSnapshotTable).values({ snapshot_id: input.snapshotID, aggregate_id: attempt.aggregate_id, through_seq: attempt.through_seq,
              sync_seq: syncSequence.seq, codec: attempt.codec, schema_version: attempt.schema_version, snapshot_hash: snapshotHash,
              body, owner_id: attempt.owner_id, created_at: createdAt }).run().pipe(Effect.orDie)
            yield* db.update(EventSequenceTable).set({ retention_floor_seq: attempt.through_seq, snapshot_id: input.snapshotID })
              .where(and(eq(EventSequenceTable.aggregate_id, attempt.aggregate_id), eq(EventSequenceTable.seq, attempt.expected_latest))).run().pipe(Effect.orDie)
            yield* db.update(EventSnapshotAttemptTable).set({ state: "complete", content_hash: body.contentHash, updated_at: createdAt })
              .where(eq(EventSnapshotAttemptTable.snapshot_id, input.snapshotID)).run().pipe(Effect.orDie)
            return { snapshotID: input.snapshotID, aggregateID: attempt.aggregate_id, throughSeq: attempt.through_seq,
              syncSeq: syncSequence.seq, codec: attempt.codec, schemaVersion: attempt.schema_version, snapshotHash, body,
              ...(attempt.owner_id ? { ownerID: attempt.owner_id } : {}), createdAt }
          }),
          { behavior: "immediate" },
        ).pipe(Effect.orDie)
      }

      function discardCheckpoint(input: { readonly snapshotID: string; readonly limit?: number }) {
        const limit = Math.min(Math.max(input.limit ?? SNAPSHOT_TRANSFER_ROWS, 1), SNAPSHOT_TRANSFER_ROWS)
        return db.transaction(
          () => Effect.gen(function* () {
            const attempt = yield* db.select({ state: EventSnapshotAttemptTable.state }).from(EventSnapshotAttemptTable)
              .where(eq(EventSnapshotAttemptTable.snapshot_id, input.snapshotID)).get().pipe(Effect.orDie)
            if (!attempt || attempt.state !== "prepared") return yield* Effect.die(new InvalidSyncEventError({
              type: "snapshot", message: `Only a prepared snapshot attempt can be discarded: ${input.snapshotID}`,
            }))
            const rows = yield* db.select({ rowIndex: EventSnapshotRowTable.row_index, rowHash: EventSnapshotRowTable.row_hash })
              .from(EventSnapshotRowTable).where(eq(EventSnapshotRowTable.snapshot_id, input.snapshotID))
              .orderBy(asc(EventSnapshotRowTable.row_index)).limit(limit).all().pipe(Effect.orDie)
            if (rows.length > 0) yield* db.delete(EventSnapshotRowTable).where(and(eq(EventSnapshotRowTable.snapshot_id, input.snapshotID), inArray(EventSnapshotRowTable.row_index, rows.map((row) => row.rowIndex)))).run().pipe(Effect.orDie)
            yield* Effect.forEach(rows, (row) => db.delete(EventSnapshotChunkTable).where(and(
              eq(EventSnapshotChunkTable.row_hash, row.rowHash),
              sql`NOT EXISTS (SELECT 1 FROM ${EventSnapshotRowTable} WHERE ${EventSnapshotRowTable.row_hash} = ${row.rowHash})`,
            )).run().pipe(Effect.orDie), { discard: true })
            const remaining = yield* db.select({ rowIndex: EventSnapshotRowTable.row_index }).from(EventSnapshotRowTable)
              .where(eq(EventSnapshotRowTable.snapshot_id, input.snapshotID)).limit(1).get().pipe(Effect.orDie)
            if (!remaining) yield* db.delete(EventSnapshotAttemptTable).where(and(eq(EventSnapshotAttemptTable.snapshot_id, input.snapshotID), eq(EventSnapshotAttemptTable.state, "prepared"))).run().pipe(Effect.orDie)
            return { deletedRows: rows.length, complete: !remaining }
          }),
          { behavior: "immediate" },
        ).pipe(Effect.orDie)
      }

      function importSnapshot(input: SerializedSnapshot) {
        return Effect.gen(function* () {
          const codec = snapshotCodecs.get(`${input.codec}@${input.schemaVersion}`)
          if (!codec)
            return yield* Effect.die(
              new InvalidSyncEventError({
                type: "snapshot",
                message: `Unsupported snapshot codec ${input.codec}@${input.schemaVersion}`,
              }),
            )
          const manifest = Schema.decodeUnknownSync(SnapshotManifest)(input.body)
          if (hashJson(manifest) !== input.snapshotHash)
            return yield* Effect.die(
              new InvalidSyncEventError({ type: "snapshot", message: `Snapshot ${input.snapshotID} hash mismatch` }),
            )
          const expectedSnapshotID = `evtsnap_${Hash.sha256(
            `${input.codec}:${input.schemaVersion}:${input.aggregateID}:${input.throughSeq}:${manifest.projectionRevision}`,
          )}`
          if (input.snapshotID !== expectedSnapshotID)
            return yield* Effect.die(
              new InvalidSyncEventError({ type: "snapshot", message: `Snapshot ${input.snapshotID} identity mismatch` }),
            )
          yield* db
            .transaction(
              () =>
                Effect.gen(function* () {
                  const current = yield* db
                    .select()
                    .from(EventSequenceTable)
                    .where(eq(EventSequenceTable.aggregate_id, input.aggregateID))
                    .get()
                    .pipe(Effect.orDie)
                  const syncAuthority = yield* db.select({ complete: EventSyncSequenceTable.backfill_complete })
                    .from(EventSyncSequenceTable).where(eq(EventSyncSequenceTable.id, 1)).get().pipe(Effect.orDie)
                  if (!syncAuthority?.complete) return yield* Effect.die(new MaintenanceRequiredError({
                    operation: "snapshot.import", reason: "event_sync_backfill_required",
                    message: "Event sync index backfill must complete before importing a snapshot",
                  }))
                  if (
                    current &&
                    (current.seq > input.throughSeq ||
                      current.write_fence_transfer_id !== null ||
                      (current.owner_id !== null && current.owner_id !== input.ownerID))
                  )
                    return yield* Effect.die(
                      new InvalidSyncEventError({
                        type: "snapshot",
                        message: `Snapshot import authority conflicts with aggregate ${input.aggregateID}`,
                      }),
                    )
                  if (current?.snapshot_id === input.snapshotID && current.seq === input.throughSeq) return
                  let contentHash = Hash.sha256("")
                  const tables: Record<string, number> = {}
                  let after = -1
                  let rowCount = 0
                  let encodedBytes = 0
                  while (true) {
                    const rows = yield* db
                      .select()
                      .from(EventSnapshotRowTable)
                      .where(
                        and(
                          eq(EventSnapshotRowTable.snapshot_id, input.snapshotID),
                          gt(EventSnapshotRowTable.row_index, after),
                        ),
                      )
                      .orderBy(asc(EventSnapshotRowTable.row_index))
                      .limit(SNAPSHOT_TRANSFER_ROWS)
                      .all()
                      .pipe(Effect.orDie)
                    if (rows.length === 0) break
                    for (const row of rows) {
                      if (row.row_index !== rowCount)
                        return yield* Effect.die(
                          new InvalidSyncEventError({
                            type: "snapshot",
                            message: `Snapshot ${input.snapshotID} row sequence is incomplete at ${rowCount}`,
                          }),
                        )
                      const chunks = yield* db
                        .select()
                        .from(EventSnapshotChunkTable)
                        .where(eq(EventSnapshotChunkTable.row_hash, row.row_hash))
                        .orderBy(asc(EventSnapshotChunkTable.chunk_index))
                        .all()
                        .pipe(Effect.orDie)
                      if (
                        chunks.length !== row.chunk_count ||
                        chunks.some(
                          (chunk, index) =>
                            chunk.chunk_index !== index || Hash.sha256(chunk.data) !== chunk.chunk_hash,
                        )
                      )
                        return yield* Effect.die(
                          new InvalidSyncEventError({
                            type: "snapshot",
                            message: `Snapshot ${input.snapshotID} row ${row.row_index} chunks are incomplete`,
                          }),
                        )
                      const data = Buffer.concat(chunks.map((chunk) => chunk.data))
                      if (data.length !== row.row_bytes || Hash.sha256(data) !== row.row_hash)
                        return yield* Effect.die(
                          new InvalidSyncEventError({
                            type: "snapshot",
                            message: `Snapshot ${input.snapshotID} row ${row.row_index} hash mismatch`,
                          }),
                        )
                      const value = Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(data.toString())
                      if (!value || typeof value !== "object" || Array.isArray(value))
                        return yield* Effect.die(
                          new InvalidSyncEventError({
                            type: "snapshot",
                            message: `Snapshot ${input.snapshotID} row ${row.row_index} is not an object`,
                          }),
                        )
                      contentHash = Hash.sha256(`${contentHash}\0${row.table_name}\0${row.row_key}\0${row.row_hash}\0${row.row_bytes}`)
                      tables[row.table_name] = (tables[row.table_name] ?? 0) + 1
                      encodedBytes += row.row_bytes
                      rowCount += 1
                      after = row.row_index
                    }
                  }
                  if (
                    rowCount !== manifest.rowCount ||
                    encodedBytes !== manifest.encodedBytes ||
                    !isDeepStrictEqual(tables, manifest.tables) ||
                    contentHash !== manifest.contentHash
                  )
                    return yield* Effect.die(
                      new InvalidSyncEventError({
                        type: "snapshot",
                        message: `Snapshot ${input.snapshotID} manifest does not match its staged rows`,
                      }),
                    )
                  yield* db
                    .insert(EventSequenceTable)
                    .values({
                      aggregate_id: input.aggregateID,
                      seq: input.throughSeq,
                      owner_id: input.ownerID,
                    })
                    .onConflictDoUpdate({
                      target: EventSequenceTable.aggregate_id,
                      set: { seq: input.throughSeq, owner_id: input.ownerID },
                    })
                    .run()
                    .pipe(Effect.orDie)
                  yield* codec.clear(input.aggregateID, input.snapshotID, manifest)
                  let importAfter = -1
                  while (true) {
                    const rows = yield* db.select().from(EventSnapshotRowTable).where(and(
                      eq(EventSnapshotRowTable.snapshot_id, input.snapshotID),
                      gt(EventSnapshotRowTable.row_index, importAfter),
                    )).orderBy(asc(EventSnapshotRowTable.row_index)).limit(SNAPSHOT_TRANSFER_ROWS).all().pipe(Effect.orDie)
                    if (rows.length === 0) break
                    for (const row of rows) {
                      const chunks = yield* db.select().from(EventSnapshotChunkTable)
                        .where(eq(EventSnapshotChunkTable.row_hash, row.row_hash))
                        .orderBy(asc(EventSnapshotChunkTable.chunk_index)).all().pipe(Effect.orDie)
                      const value = Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(Buffer.concat(chunks.map((chunk) => chunk.data)).toString())
                      yield* codec.import(input.aggregateID, {
                        cursor: String(row.row_index),
                        tableName: row.table_name,
                        rowKey: row.row_key,
                        value: value as Record<string, unknown>,
                      }, input.ownerID)
                      importAfter = row.row_index
                    }
                  }
                  const syncSequence = yield* db
                    .update(EventSyncSequenceTable)
                    .set({ seq: sql`${EventSyncSequenceTable.seq} + 1` })
                    .where(eq(EventSyncSequenceTable.id, 1))
                    .returning({ seq: EventSyncSequenceTable.seq })
                    .get()
                    .pipe(Effect.orDie)
                  if (!syncSequence)
                    return yield* Effect.die(
                      new InvalidSyncEventError({ type: "snapshot", message: "Sync sequence authority missing" }),
                    )
                  yield* db
                    .insert(EventSnapshotTable)
                    .values({
                      snapshot_id: input.snapshotID,
                      aggregate_id: input.aggregateID,
                      through_seq: input.throughSeq,
                      sync_seq: syncSequence.seq,
                      codec: input.codec,
                      schema_version: input.schemaVersion,
                      snapshot_hash: input.snapshotHash,
                      body: input.body,
                      owner_id: input.ownerID,
                      created_at: input.createdAt,
                    })
                    .run()
                    .pipe(Effect.orDie)
                  yield* db
                    .update(EventSequenceTable)
                    .set({ retention_floor_seq: input.throughSeq, snapshot_id: input.snapshotID })
                    .where(eq(EventSequenceTable.aggregate_id, input.aggregateID))
                    .run()
                    .pipe(Effect.orDie)
                }),
              { behavior: "immediate" },
            )
            .pipe(Effect.orDie)
        })
      }

      function snapshotRows(input: { readonly snapshotID: string; readonly after?: number; readonly limit?: number }) {
        return db
          .select({
            snapshotID: EventSnapshotRowTable.snapshot_id,
            rowIndex: EventSnapshotRowTable.row_index,
            tableName: EventSnapshotRowTable.table_name,
            rowKey: EventSnapshotRowTable.row_key,
            rowHash: EventSnapshotRowTable.row_hash,
            rowBytes: EventSnapshotRowTable.row_bytes,
            chunkCount: EventSnapshotRowTable.chunk_count,
            chainHash: EventSnapshotRowTable.chain_hash,
          })
          .from(EventSnapshotRowTable)
          .where(
            and(
              eq(EventSnapshotRowTable.snapshot_id, input.snapshotID),
              gt(EventSnapshotRowTable.row_index, input.after ?? -1),
            ),
          )
          .orderBy(asc(EventSnapshotRowTable.row_index))
          .limit(Math.min(Math.max(input.limit ?? SNAPSHOT_TRANSFER_ROWS, 1), SNAPSHOT_TRANSFER_ROWS))
          .all()
          .pipe(Effect.orDie)
      }

      function snapshotChunks(input: { readonly rowHash: string; readonly after?: number; readonly limit?: number }) {
        return db
          .select({
            rowHash: EventSnapshotChunkTable.row_hash,
            chunkIndex: EventSnapshotChunkTable.chunk_index,
            data: EventSnapshotChunkTable.data,
            chunkHash: EventSnapshotChunkTable.chunk_hash,
          })
          .from(EventSnapshotChunkTable)
          .where(
            and(
              eq(EventSnapshotChunkTable.row_hash, input.rowHash),
              gt(EventSnapshotChunkTable.chunk_index, input.after ?? -1),
            ),
          )
          .orderBy(asc(EventSnapshotChunkTable.chunk_index))
          .limit(Math.min(Math.max(input.limit ?? SNAPSHOT_TRANSFER_CHUNKS, 1), SNAPSHOT_TRANSFER_CHUNKS))
          .all()
          .pipe(Effect.orDie)
      }

      function stageSnapshotRows(input: SerializedSnapshot, rows: readonly SerializedSnapshotRow[]) {
        return db.transaction(() => Effect.gen(function* () {
          if (rows.length > SNAPSHOT_TRANSFER_ROWS)
            return yield* Effect.die(new InvalidSyncEventError({ type: "snapshot", message: `Snapshot row page exceeds ${SNAPSHOT_TRANSFER_ROWS}` }))
          if (hashJson(Schema.decodeUnknownSync(SnapshotManifest)(input.body)) !== input.snapshotHash)
            return yield* Effect.die(
              new InvalidSyncEventError({ type: "snapshot", message: `Snapshot ${input.snapshotID} hash mismatch` }),
            )
          yield* Effect.forEach(
            rows,
            (row) => Effect.gen(function* () {
              if (row.snapshotID !== input.snapshotID)
                return yield* Effect.die(
                  new InvalidSyncEventError({ type: "snapshot", message: "Snapshot row identity mismatch" }),
                )
              const inserted = yield* db
                .insert(EventSnapshotRowTable)
                .values({
                  snapshot_id: row.snapshotID,
                  row_index: row.rowIndex,
                  table_name: row.tableName,
                  row_key: row.rowKey,
                  row_hash: row.rowHash,
                  row_bytes: row.rowBytes,
                  chunk_count: row.chunkCount,
                  chain_hash: row.chainHash,
                })
                .onConflictDoNothing()
                .returning().get()
                .pipe(Effect.orDie)
              if (inserted) return
              const existing = yield* db.select().from(EventSnapshotRowTable).where(and(
                eq(EventSnapshotRowTable.snapshot_id, row.snapshotID),
                eq(EventSnapshotRowTable.row_index, row.rowIndex),
              )).get().pipe(Effect.orDie)
              if (!existing || existing.table_name !== row.tableName || existing.row_key !== row.rowKey ||
                existing.row_hash !== row.rowHash || existing.row_bytes !== row.rowBytes || existing.chunk_count !== row.chunkCount ||
                existing.chain_hash !== row.chainHash)
                return yield* Effect.die(new InvalidSyncEventError({ type: "snapshot", message: `Snapshot row ${row.rowIndex} conflicts with durable CAS` }))
            }),
            { discard: true },
          )
        }), { behavior: "immediate" }).pipe(Effect.orDie)
      }

      function stageSnapshotChunks(
        input: SerializedSnapshot,
        row: SerializedSnapshotRow,
        chunks: readonly SerializedSnapshotChunk[],
      ) {
        return db.transaction(() => Effect.gen(function* () {
          if (chunks.length > SNAPSHOT_TRANSFER_CHUNKS)
            return yield* Effect.die(new InvalidSyncEventError({ type: "snapshot", message: `Snapshot chunk page exceeds ${SNAPSHOT_TRANSFER_CHUNKS}` }))
          if (row.snapshotID !== input.snapshotID || chunks.some((chunk) => chunk.rowHash !== row.rowHash))
            return yield* Effect.die(
              new InvalidSyncEventError({ type: "snapshot", message: "Snapshot chunk identity mismatch" }),
            )
          yield* Effect.forEach(
            chunks,
            (chunk) => Effect.gen(function* () {
              if (chunk.data.length > SNAPSHOT_CHUNK_BYTES || Hash.sha256(chunk.data) !== chunk.chunkHash)
                return yield* Effect.die(
                  new InvalidSyncEventError({ type: "snapshot", message: "Snapshot chunk hash mismatch" }),
                )
              const inserted = yield* db
                .insert(EventSnapshotChunkTable)
                .values({
                  row_hash: chunk.rowHash,
                  chunk_index: chunk.chunkIndex,
                  data: chunk.data,
                  chunk_hash: chunk.chunkHash,
                })
                .onConflictDoNothing()
                .returning().get()
                .pipe(Effect.orDie)
              if (inserted) return
              const existing = yield* db.select().from(EventSnapshotChunkTable).where(and(
                eq(EventSnapshotChunkTable.row_hash, chunk.rowHash),
                eq(EventSnapshotChunkTable.chunk_index, chunk.chunkIndex),
              )).get().pipe(Effect.orDie)
              if (!existing || existing.chunk_hash !== chunk.chunkHash || !Buffer.from(existing.data).equals(chunk.data))
                return yield* Effect.die(new InvalidSyncEventError({ type: "snapshot", message: `Snapshot chunk ${chunk.rowHash}:${chunk.chunkIndex} conflicts with durable CAS` }))
            }),
            { discard: true },
          )
        }), { behavior: "immediate" }).pipe(Effect.orDie)
      }

      function compact(input: {
        readonly aggregateID: string
        readonly throughSeq: Cursor
        readonly limit?: number
        readonly now?: number
      }) {
        return db
          .transaction(
            () =>
              Effect.gen(function* () {
                const sequence = yield* db
                  .select({ floor: EventSequenceTable.retention_floor_seq, snapshotID: EventSequenceTable.snapshot_id })
                  .from(EventSequenceTable)
                  .where(eq(EventSequenceTable.aggregate_id, input.aggregateID))
                  .get()
                  .pipe(Effect.orDie)
                const syncAuthority = yield* db.select({ complete: EventSyncSequenceTable.backfill_complete })
                  .from(EventSyncSequenceTable).where(eq(EventSyncSequenceTable.id, 1)).get().pipe(Effect.orDie)
                if (!syncAuthority?.complete) return yield* Effect.die(new MaintenanceRequiredError({
                  operation: "event.compact", reason: "event_sync_backfill_required",
                  message: "Event sync index backfill must complete before compaction",
                }))
                if (sequence?.floor === undefined || sequence.floor === null || input.throughSeq > sequence.floor)
                  return yield* Effect.die(
                    new InvalidSyncEventError({
                      type: "snapshot",
                      message: `Compaction exceeds the durable retention floor for ${input.aggregateID}`,
                    }),
                  )
                const active = sequence.snapshotID ? yield* db.select().from(EventSnapshotTable)
                  .where(and(eq(EventSnapshotTable.snapshot_id, sequence.snapshotID), eq(EventSnapshotTable.aggregate_id, input.aggregateID)))
                  .get().pipe(Effect.orDie) : undefined
                const codec = active ? snapshotCodecs.get(`${active.codec}@${active.schema_version}`) : undefined
                if (!active || !codec || active.through_seq < input.throughSeq)
                  return yield* Effect.die(new InvalidSyncEventError({ type: "snapshot", message: `Compaction requires an active importable snapshot for ${input.aggregateID}` }))
                const receipt = yield* db.select().from(EventCompactionReceiptTable)
                  .where(eq(EventCompactionReceiptTable.aggregate_id, input.aggregateID)).get().pipe(Effect.orDie)
                if (receipt && (receipt.snapshot_id !== active.snapshot_id || receipt.through_seq !== input.throughSeq ||
                  receipt.codec !== active.codec || receipt.schema_version !== active.schema_version))
                  return yield* Effect.die(new InvalidSyncEventError({ type: "snapshot", message: `Compaction receipt conflicts with active snapshot ${active.snapshot_id}` }))
                const cursor = receipt?.cursor_seq ?? -1
                const candidates = yield* db
                  .select({
                    row: EventTable,
                    canonicalData: sql<Record<string, unknown> | null>`COALESCE(${FilePartArtifactBindingTable.canonical_data}, ${EventArtifactTable.canonical_data})`,
                  })
                  .from(EventTable)
                  .leftJoin(EventArtifactTable, eq(EventArtifactTable.event_id, EventTable.id))
                  .leftJoin(FilePartArtifactBindingTable, eq(FilePartArtifactBindingTable.event_id, EventTable.id))
                  .where(and(eq(EventTable.aggregate_id, input.aggregateID), gt(EventTable.seq, cursor), lte(EventTable.seq, input.throughSeq)))
                  .orderBy(asc(EventTable.seq))
                  .limit(Math.min(Math.max(input.limit ?? 100, 1), 100) + 1)
                  .all()
                  .pipe(Effect.orDie)
                const rows = candidates.slice(0, Math.min(Math.max(input.limit ?? 100, 1), 100))
                const compactable = rows.filter((item) => codec.rebuildEventTypes.has(item.row.type))
                yield* Effect.forEach(compactable, (item) => Effect.gen(function* () {
                  const dataHash = hashJson(item.canonicalData ?? item.row.data)
                  const existing = yield* db.select().from(EventDedupeTable).where(or(
                    and(eq(EventDedupeTable.aggregate_id, item.row.aggregate_id), eq(EventDedupeTable.seq, item.row.seq)),
                    eq(EventDedupeTable.event_id, item.row.id),
                  )).get().pipe(Effect.orDie)
                  if (existing && (existing.aggregate_id !== item.row.aggregate_id || existing.seq !== item.row.seq ||
                    existing.event_id !== item.row.id || existing.type !== item.row.type || existing.data_hash !== dataHash))
                    return yield* Effect.die(new InvalidSyncEventError({ type: "snapshot", message: `Compaction dedupe conflicts at ${item.row.aggregate_id}:${item.row.seq}` }))
                  if (!existing) yield* db.insert(EventDedupeTable).values({
                    aggregate_id: item.row.aggregate_id, seq: item.row.seq, event_id: item.row.id, type: item.row.type,
                    data_hash: dataHash, source_data: item.row.data, compacted_at: input.now ?? Date.now(),
                  }).run().pipe(Effect.orDie)
                }), { discard: true })
                if (compactable.length > 0) yield* db.delete(EventTable)
                  .where(inArray(EventTable.id, compactable.map((item) => item.row.id))).run().pipe(Effect.orDie)
                if (compactable.length > 0) yield* db.update(EventDedupeTable)
                  .set({ source_data: null })
                  .where(inArray(EventDedupeTable.event_id, compactable.map((item) => item.row.id)))
                  .run()
                  .pipe(Effect.orDie)
                const nextCursor = rows.at(-1)?.row.seq ?? cursor
                const complete = rows.length === 0 || (nextCursor >= input.throughSeq && candidates.length <= rows.length)
                yield* db.insert(EventCompactionReceiptTable).values({ aggregate_id: input.aggregateID,
                  snapshot_id: active.snapshot_id, through_seq: input.throughSeq, codec: active.codec,
                  schema_version: active.schema_version, cursor_seq: nextCursor,
                  deleted_count: (receipt?.deleted_count ?? 0) + compactable.length,
                  state: complete ? "complete" : "running", updated_at: input.now ?? Date.now(),
                }).onConflictDoUpdate({ target: EventCompactionReceiptTable.aggregate_id, set: {
                  cursor_seq: nextCursor, deleted_count: (receipt?.deleted_count ?? 0) + compactable.length,
                  state: complete ? "complete" : "running", updated_at: input.now ?? Date.now(),
                }}).run().pipe(Effect.orDie)
                return { deleted: compactable.length, complete }
              }),
            { behavior: "immediate" },
          )
          .pipe(Effect.orDie)
      }

      function canonicalizeLegacyArtifacts(input?: { readonly afterID?: ID; readonly limit?: number; readonly now?: number }) {
        const bodyData = sql`json_object('diffs', json_extract(${EventTable.data}, '$.info.summary.diffs'))`
        const chunk = (eventID: ID, kind: "source" | "body", index: number) =>
          db
            .select({
              data: kind === "source"
                ? sql<Buffer>`substr(CAST(${EventTable.data} AS BLOB), ${index * ARTIFACT_CHUNK_BYTES + 1}, ${ARTIFACT_CHUNK_BYTES})`
                : sql<Buffer>`substr(CAST(${bodyData} AS BLOB), ${index * ARTIFACT_CHUNK_BYTES + 1}, ${ARTIFACT_CHUNK_BYTES})`,
            })
            .from(EventTable)
            .where(eq(EventTable.id, eventID))
            .get()
            .pipe(Effect.orDie)
        const hash = (eventID: ID, kind: "source" | "body", bytes: number) =>
          Effect.gen(function* () {
            const digest = createHash("sha256")
            yield* Effect.forEach(
              Array.from({ length: Math.ceil(bytes / ARTIFACT_CHUNK_BYTES) }, (_, index) => index),
              (index) => chunk(eventID, kind, index).pipe(Effect.tap((value) => Effect.sync(() => digest.update(value!.data)))),
              { discard: true },
            )
            return digest.digest("hex")
          })
        return db
          .transaction(
            () =>
              Effect.gen(function* () {
                const rows = yield* db
                  .select({
                    id: EventTable.id,
                    aggregateID: EventTable.aggregate_id,
                    seq: EventTable.seq,
                    fileCount: sql<number>`json_array_length(${EventTable.data}, '$.info.summary.diffs')`,
                    sourceBytes: sql<number>`length(CAST(${EventTable.data} AS BLOB))`,
                    bodyBytes: sql<number>`length(CAST(${bodyData} AS BLOB))`,
                  })
                  .from(EventTable)
                  .leftJoin(EventArtifactTable, eq(EventArtifactTable.event_id, EventTable.id))
                  .where(
                    and(
                      eq(EventTable.type, versionedType("message.updated", 1)),
                      sql`length(CAST(${EventTable.data} AS BLOB)) > ${MAX_ENCODED_PAYLOAD_BYTES}`,
                      sql`json_valid(${EventTable.data})`,
                      sql`json_type(${EventTable.data}, '$.info.summary.diffs') = 'array'`,
                      sql`json_array_length(${EventTable.data}, '$.info.summary.diffs') > 0`,
                      input?.afterID ? gt(EventTable.id, input.afterID) : undefined,
                      sql`${EventArtifactTable.event_id} is null`,
                    ),
                  )
                  .orderBy(asc(EventTable.id))
                  .limit(Math.min(Math.max(input?.limit ?? LEGACY_ARTIFACT_BATCH_EVENTS, 1), LEGACY_ARTIFACT_BATCH_EVENTS))
                  .all()
                  .pipe(Effect.orDie)
                yield* Effect.forEach(
                  rows,
                  (row) => Effect.gen(function* () {
                    const originalDataHash = yield* hash(row.id, "source", row.sourceBytes)
                    const bodyHash = yield* hash(row.id, "body", row.bodyBytes)
                    const artifactID = `evtart_${Hash.sha256(`legacy-message-diff.v2:${row.id}:${originalDataHash}:${bodyHash}`)}`
                    const canonicalData = db
                      .select({
                        data: sql<string>`json_set(
                          ${EventTable.data},
                          '$.info.summary.diffs',
                          json(COALESCE((
                            SELECT json_group_array(json_remove(value, '$.patch'))
                            FROM (
                              SELECT value
                              FROM json_each(json_extract(${EventTable.data}, '$.info.summary.diffs'))
                              LIMIT ${LEGACY_DIFF_DESCRIPTOR_FILES}
                            )
                          ), '[]')),
                          '$.info.summary.diffArtifact',
                          json_object(
                            'id', ${artifactID},
                            'hash', ${bodyHash},
                            'codec', 'legacy-message-diff.v2',
                            'fileCount', ${row.fileCount}
                          )
                        )`,
                      })
                      .from(EventTable)
                      .where(eq(EventTable.id, row.id))
                      .get()
                      .pipe(Effect.orDie)
                    return yield* canonicalData.pipe(
                      Effect.flatMap((canonical) => {
                        if (!canonical) return Effect.die(new Error(`Missing artifact source event ${row.id}`))
                        const chunks = Math.ceil(row.bodyBytes / ARTIFACT_CHUNK_BYTES) || 1
                        return db.run(sql`
                          INSERT INTO event_artifact (
                            artifact_id, event_id, aggregate_id, seq, kind,
                            original_data_hash, canonical_data_hash, canonical_data,
                            body_hash, body_bytes, chunk_count, codec_version, created_at
                          ) VALUES (
                            ${artifactID}, ${row.id}, ${row.aggregateID}, ${row.seq}, 'legacy_message_diff',
                            ${originalDataHash}, ${Hash.sha256(canonical.data)}, ${canonical.data},
                            ${bodyHash}, ${row.bodyBytes}, ${chunks}, 2, ${input?.now ?? Date.now()}
                          ) ON CONFLICT DO NOTHING
                        `).pipe(
                          Effect.orDie,
                          Effect.andThen(
                            Effect.forEach(
                              Array.from({ length: chunks }, (_, index) => index),
                              (index) => chunk(row.id, "body", index).pipe(
                                Effect.flatMap((value) => db.run(sql`
                                  INSERT INTO event_artifact_chunk (artifact_id, chunk_index, data, chunk_hash)
                                  VALUES (${artifactID}, ${index}, ${value!.data}, ${Hash.sha256(value!.data)})
                                  ON CONFLICT DO NOTHING
                                `)),
                                Effect.orDie,
                              ),
                              { discard: true },
                            ),
                          ),
                        )
                      }),
                    )
                  }),
                  { discard: true },
                )
                return { processed: rows.length, next: rows.at(-1)?.id }
              }),
            { behavior: "immediate" },
          )
          .pipe(Effect.orDie)
      }

      function remove(aggregateID: string) {
        return db
          .transaction(() =>
            Effect.gen(function* () {
              yield* db.delete(EventSequenceTable).where(eq(EventSequenceTable.aggregate_id, aggregateID)).run()
              yield* db.delete(EventTable).where(eq(EventTable.aggregate_id, aggregateID)).run()
            }),
          )
          .pipe(Effect.orDie)
      }

      function claim(aggregateID: string, ownerID: string) {
        return db
          .update(EventSequenceTable)
          .set({ owner_id: ownerID })
          .where(eq(EventSequenceTable.aggregate_id, aggregateID))
          .run()
          .pipe(Effect.orDie)
      }

      const subscribe = <D extends Definition>(definition: D): Stream.Stream<Payload<D>> =>
        Stream.unwrap(getOrCreate(definition).pipe(Effect.map((pubsub) => Stream.fromPubSub(pubsub)))).pipe(
          Stream.map((event) => event as Payload<D>),
        )

      const streamAll = (): Stream.Stream<Payload> => Stream.fromPubSub(all)

      const decodeSerializedEvent = (event: SerializedEvent): CursorEvent => {
        const definition = syncRegistry.get(event.type)
        if (!definition) {
          throw new InvalidSyncEventError({ type: event.type, message: `Unknown sync event type ${event.type}` })
        }
        return {
          cursor: Cursor.make(event.seq),
          event: {
            id: event.id,
            type: definition.type,
            version: definition.sync.version,
            seq: event.seq,
            data: definition.decode(event.data),
          },
        }
      }

      const decodeStoredEventData = Schema.decodeUnknownSync(Schema.UnknownFromJsonString)

      const readAfter = (aggregateID: string, after: number) =>
        Effect.gen(function* () {
          yield* layerOptions?.beforeAggregateRead?.(aggregateID) ?? Effect.void
          const authority = yield* db
            .select({
              floor: EventSequenceTable.retention_floor_seq,
              snapshotID: EventSequenceTable.snapshot_id,
              snapshotHash: EventSnapshotTable.snapshot_hash,
            })
            .from(EventSequenceTable)
            .leftJoin(EventSnapshotTable, eq(EventSnapshotTable.snapshot_id, EventSequenceTable.snapshot_id))
            .where(eq(EventSequenceTable.aggregate_id, aggregateID))
            .get()
            .pipe(Effect.orDie)
          if (authority?.floor !== null && authority?.floor !== undefined && after < authority.floor) {
            if (!authority.snapshotID || !authority.snapshotHash)
              return yield* Effect.die(
                new InvalidSyncEventError({
                  type: "snapshot",
                  message: `Retention floor for ${aggregateID} has no readable snapshot`,
                }),
              )
            return yield* Effect.die(
              new ResyncRequiredError({
                aggregateID,
                requestedAfter: after,
                snapshotID: authority.snapshotID,
                baseSeq: authority.floor,
                snapshotHash: authority.snapshotHash,
                message: `Aggregate ${aggregateID} requires snapshot resynchronization`,
              }),
            )
          }
          const candidates = yield* db
            .all<{
              id: ID
              seq: number
              type: string
              bytes: number
              cumulativeBytes: number
            }>(sql`
              WITH candidate AS (
                SELECT
                  ${EventTable.id} AS id,
                  ${EventTable.seq} AS seq,
                  ${EventTable.type} AS type,
                  length(CAST(COALESCE(${FilePartArtifactBindingTable.canonical_data}, ${EventArtifactTable.canonical_data}, ${EventTable.data}) AS BLOB)) AS bytes
                FROM ${EventTable}
                LEFT JOIN ${EventArtifactTable} ON ${EventArtifactTable.event_id} = ${EventTable.id}
                LEFT JOIN ${FilePartArtifactBindingTable} ON ${FilePartArtifactBindingTable.event_id} = ${EventTable.id}
                WHERE ${EventTable.aggregate_id} = ${aggregateID}
                  AND ${EventTable.seq} > ${after}
                ORDER BY ${EventTable.seq} ASC
                LIMIT ${AGGREGATE_READ_BATCH_EVENTS + 1}
              )
              SELECT
                id,
                seq,
                type,
                bytes,
                sum(bytes) OVER (ORDER BY seq ASC ROWS UNBOUNDED PRECEDING) AS cumulativeBytes
              FROM candidate
              ORDER BY seq ASC
            `)
            .pipe(Effect.orDie)
          const oversized = candidates[0]
          if (oversized && oversized.bytes > AGGREGATE_READ_BATCH_BYTES)
            return yield* Effect.die(
              new EncodedPayloadTooLargeError({
                type: oversized.type,
                encodedBytes: oversized.bytes,
                limitBytes: AGGREGATE_READ_BATCH_BYTES,
                message: `Stored event payload is ${oversized.bytes} bytes; aggregate read limit is ${AGGREGATE_READ_BATCH_BYTES} bytes`,
              }),
            )
          const metadata = candidates
            .slice(0, AGGREGATE_READ_BATCH_EVENTS)
            .filter((event) => event.cumulativeBytes <= AGGREGATE_READ_BATCH_BYTES)
          if (metadata.length === 0) {
            yield* layerOptions?.afterAggregateRead?.(aggregateID) ?? Effect.void
            return { events: [], more: false }
          }
          yield* layerOptions?.afterAggregateReadMetadata?.(
            aggregateID,
            metadata.map((event) => event.id),
          ) ?? Effect.void
          const rows = yield* db
            .select({
              id: EventTable.id,
              data: sql<string>`COALESCE(${FilePartArtifactBindingTable.canonical_data}, ${EventArtifactTable.canonical_data}, ${EventTable.data})`,
            })
            .from(EventTable)
            .leftJoin(EventArtifactTable, eq(EventArtifactTable.event_id, EventTable.id))
            .leftJoin(FilePartArtifactBindingTable, eq(FilePartArtifactBindingTable.event_id, EventTable.id))
            .where(inArray(EventTable.id, metadata.map((event) => event.id)))
            .all()
            .pipe(Effect.orDie)
          const dataByID = new Map(rows.map((row) => [row.id, row.data]))
          const missing = metadata.find((event) => !dataByID.has(event.id))
          if (missing)
            return yield* Effect.die(
              new InvalidSyncEventError({
                type: missing.type,
                message: `Stored event ${missing.id} disappeared while reading aggregate ${aggregateID}`,
              }),
            )
          const events = metadata.map((event) =>
            decodeSerializedEvent({
              id: event.id,
              aggregateID,
              seq: event.seq,
              type: event.type,
              data: decodeStoredEventData(dataByID.get(event.id)!) as Record<string, unknown>,
            }),
          )
          yield* layerOptions?.afterAggregateRead?.(aggregateID) ?? Effect.void
          return { events, more: candidates.length > metadata.length }
        })

      const subscribeSynchronized = (aggregateID: string) =>
        Effect.gen(function* () {
          const pubsub = yield* PubSub.sliding<void>(1)
          const subscription = yield* PubSub.subscribe(pubsub)
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              const pubsubs = synchronized.get(aggregateID) ?? new Set()
              pubsubs.add(pubsub)
              synchronized.set(aggregateID, pubsubs)
            }),
            () =>
              Effect.sync(() => {
                const pubsubs = synchronized.get(aggregateID)
                pubsubs?.delete(pubsub)
                if (pubsubs?.size === 0) synchronized.delete(aggregateID)
              }).pipe(Effect.andThen(PubSub.shutdown(pubsub))),
          )
          return subscription
        })

      const streamEvents = (input: {
        readonly aggregateID: string
        readonly after?: Cursor
      }): Stream.Stream<CursorEvent> =>
        Stream.unwrap(
          Effect.gen(function* () {
            const synchronized = yield* subscribeSynchronized(input.aggregateID)
            let cursor = input.after ?? -1
            const drain = () =>
              Stream.paginate(cursor, (after) =>
                readAfter(input.aggregateID, after).pipe(
                  Effect.map((page) => {
                    const next = page.events.at(-1)?.cursor
                    if (next !== undefined) cursor = next
                    return [
                      page.events,
                      page.more && next !== undefined ? Option.some(next) : Option.none<Cursor>(),
                    ] as const
                  }),
                ),
              )
            const live = Stream.fromSubscription(synchronized).pipe(
              Stream.flatMap(() => drain()),
            )
            return Stream.concat(drain(), live)
          }),
        )

      const listen = (listener: Listener): Effect.Effect<Unsubscribe> =>
        Effect.sync(() => {
          listeners.push(listener)
          return Effect.sync(() => {
            const index = listeners.indexOf(listener)
            if (index >= 0) listeners.splice(index, 1)
          })
        })

      const sync = (handler: Sync): Effect.Effect<Unsubscribe> =>
        Effect.sync(() => {
          syncHandlers.push(handler)
          return Effect.sync(() => {
            const index = syncHandlers.indexOf(handler)
            if (index >= 0) syncHandlers.splice(index, 1)
          })
        })

      const beforeCommit = (guard: CommitGuard): Effect.Effect<void> =>
        Effect.sync(() => {
          commitGuards.push(guard)
        })

      const project = <D extends Definition>(definition: D, projector: Projector<D>): Effect.Effect<void> =>
        Effect.sync(() => {
          const list = projectors.get(definition.type) ?? []
          list.push((event) => projector(event as Payload<D>))
          projectors.set(definition.type, list)
        })

      const registerSnapshotCodec = (codec: SnapshotCodec) =>
        Effect.sync(() => {
          const key = `${codec.codec}@${codec.schemaVersion}`
          if (snapshotCodecs.has(key))
            throw new InvalidSyncEventError({ type: "snapshot", message: `Snapshot codec ${key} is already registered` })
          snapshotCodecs.set(key, codec)
        })

      function backfillSyncIndex(input?: { readonly limit?: number; readonly now?: number }) {
        const limit = Math.min(Math.max(input?.limit ?? 500, 1), 5000)
        return db
          .transaction(
            () =>
              Effect.gen(function* () {
                const authority = yield* db
                  .select()
                  .from(EventSyncBackfillTable)
                  .where(eq(EventSyncBackfillTable.id, 1))
                  .get()
                  .pipe(Effect.orDie)
                const syncAuthority = yield* db
                  .select({ complete: EventSyncSequenceTable.backfill_complete })
                  .from(EventSyncSequenceTable)
                  .where(eq(EventSyncSequenceTable.id, 1))
                  .get()
                  .pipe(Effect.orDie)
                if (!authority || !syncAuthority)
                  return yield* Effect.die(
                    new MaintenanceRequiredError({
                      operation: "event.sync.backfill",
                      reason: "event_sync_backfill_authority_missing",
                      message: "Event sync backfill authority is unavailable",
                    }),
                  )
                if (authority.state === "complete" && syncAuthority.complete) return { processed: 0, complete: true }
                const rows = yield* db
                  .all<{
                    rowid: number
                    id: string
                    aggregate_id: string
                    seq: number
                    sync_seq: number | null
                  }>(sql`
                    SELECT rowid, id, aggregate_id, seq, sync_seq
                    FROM event
                    WHERE rowid > ${authority.cursor_rowid} AND rowid <= ${authority.high_water_rowid}
                    ORDER BY rowid ASC
                    LIMIT ${limit}
                  `)
                  .pipe(Effect.orDie)
                yield* Effect.forEach(
                  rows,
                  (row) => Effect.gen(function* () {
                    const syncSeq = row.sync_seq ?? row.rowid
                    const existing = yield* db.select().from(EventSyncIndexTable).where(or(
                      eq(EventSyncIndexTable.sync_seq, syncSeq),
                      eq(EventSyncIndexTable.event_id, ID.make(row.id)),
                      and(eq(EventSyncIndexTable.aggregate_id, row.aggregate_id), eq(EventSyncIndexTable.seq, row.seq)),
                    )).get().pipe(Effect.orDie)
                    if (existing) {
                      if (existing.sync_seq === syncSeq && existing.event_id === row.id &&
                        existing.aggregate_id === row.aggregate_id && existing.seq === row.seq) return
                      return yield* Effect.die(new InvalidSyncEventError({
                        type: "event.sync.backfill",
                        message: `Sync index identity conflict at legacy event rowid ${row.rowid}`,
                      }))
                    }
                    yield* db.insert(EventSyncIndexTable).values({ sync_seq: syncSeq, event_id: ID.make(row.id),
                      aggregate_id: row.aggregate_id, seq: row.seq }).run().pipe(Effect.orDie)
                  }),
                  { discard: true },
                )
                const cursor = rows.at(-1)?.rowid ?? authority.cursor_rowid
                const complete = cursor >= authority.high_water_rowid
                const now = input?.now ?? Date.now()
                yield* db
                  .update(EventSyncBackfillTable)
                  .set({
                    state: complete ? "complete" : "pending",
                    cursor_rowid: cursor,
                    processed_count: sql`${EventSyncBackfillTable.processed_count} + ${rows.length}`,
                    updated_at: now,
                    ...(complete ? { completed_at: now } : {}),
                  })
                  .where(eq(EventSyncBackfillTable.id, 1))
                  .run()
                  .pipe(Effect.orDie)
                if (complete)
                  yield* db
                    .update(EventSyncSequenceTable)
                    .set({ backfill_complete: true })
                    .where(eq(EventSyncSequenceTable.id, 1))
                    .run()
                    .pipe(Effect.orDie)
                return { processed: rows.length, complete }
              }),
            { behavior: "immediate" },
          )
          .pipe(Effect.orDie)
      }

      return Service.of({
        publish,
        subscribe,
        all: streamAll,
        aggregateEvents: streamEvents,
        sync,
        listen,
        beforeCommit,
        project,
        registerSnapshotCodec,
        replay,
        replayAll,
        snapshot,
        prepareCheckpoint,
        stageCheckpoint,
        finalizeCheckpoint,
        discardCheckpoint,
        checkpoint,
        importSnapshot,
        compact,
        canonicalizeLegacyArtifacts,
        snapshotRows,
        snapshotChunks,
        stageSnapshotRows,
        stageSnapshotChunks,
        backfillSyncIndex,
        remove,
        claim,
      })
    }),
  )

export const layer = layerWith()

export const node = makeGlobalNode({ service: Service, layer: layer, deps: [Database.node] })

export const defaultLayer = layer.pipe(Layer.provide(Database.defaultLayer))
