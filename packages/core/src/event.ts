export * as EventV2 from "./event"

import { Cause, Context, Effect, Layer, Option, PubSub, Schema, Stream } from "effect"
import { and, eq, gt, inArray, sql } from "drizzle-orm"
import { Database } from "./database/database"
import { EventSequenceTable, EventTable } from "./event/sql"
import { Location } from "./location"
import { makeGlobalNode } from "./effect/app-node"
import { externalID, type ExternalID, NonNegativeInt, withStatics } from "./schema"
import { Identifier } from "./util/identifier"
import { isDeepStrictEqual } from "node:util"

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

export class EncodedPayloadTooLargeError extends Schema.TaggedErrorClass<EncodedPayloadTooLargeError>()(
  "EventV2.EncodedPayloadTooLarge",
  {
    type: Schema.String,
    encodedBytes: NonNegativeInt,
    limitBytes: NonNegativeInt,
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
  readonly replay: (
    event: SerializedEvent,
    options?: { readonly publish?: boolean; readonly ownerID?: string; readonly strictOwner?: boolean },
  ) => Effect.Effect<void>
  readonly replayAll: (
    events: SerializedEvent[],
    options?: { readonly publish?: boolean; readonly ownerID?: string; readonly strictOwner?: boolean },
  ) => Effect.Effect<string | undefined>
  readonly remove: (aggregateID: string) => Effect.Effect<void>
  readonly claim: (aggregateID: string, ownerID: string) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/Event") {}

export interface LayerOptions {
  readonly beforeAggregateRead?: (aggregateID: string) => Effect.Effect<void>
  readonly afterAggregateReadMetadata?: (aggregateID: string, eventIDs: readonly ID[]) => Effect.Effect<void>
}

export const layerWith = (options?: LayerOptions) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const all = yield* PubSub.unbounded<Payload>()
      const synchronized = new Map<string, Set<PubSub.PubSub<void>>>()
      const typed = new Map<string, PubSub.PubSub<Payload>>()
      const projectors = new Map<string, AnyProjector[]>()
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
              const admission = admitEncodedPayload(
                syncRegistry.get(versionedType(definition.type, sync.version))!,
                event.data,
              )
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
                            .select({ seq: EventSequenceTable.seq, ownerID: EventSequenceTable.owner_id })
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
                            if (
                              stored?.id === event.id &&
                              stored.type === versionedType(definition.type, sync.version) &&
                              isDeepStrictEqual(stored.data, encoded)
                            ) {
                              if (input.ownerID && row?.ownerID == null) {
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
                          for (const guard of commitGuards) {
                            yield* guard(event)
                          }
                          for (const projector of list) {
                            yield* projector({ ...event, seq } as Payload)
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
                          yield* db
                            .insert(EventTable)
                            .values([
                              {
                                id: event.id,
                                aggregate_id: aggregateID,
                                seq,
                                type: versionedType(definition.type, sync.version),
                                data: encoded,
                              },
                            ])
                            .run()
                            .pipe(Effect.orDie)
                          return { aggregateID, seq, inserted: true }
                        }),
                      { behavior: "immediate" },
                    )
                    .pipe(Effect.orDie)
                  if (committed?.inserted) {
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
              event = { ...event, seq: committed.seq }
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
        options?: { readonly publish?: boolean; readonly ownerID?: string; readonly strictOwner?: boolean },
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
              data: definition.decode(event.data),
              replay: true,
            } as Payload
            const committed = yield* commitSyncEvent(payload, {
              seq: event.seq,
              aggregateID: event.aggregateID,
              ownerID: options?.ownerID,
              strictOwner: options?.strictOwner,
            })
            if (committed && options?.publish) {
              yield* notify({ ...payload, seq: committed.seq }, true)
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
          for (const event of events) {
            yield* replay(event, options)
          }
          return source
        })
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
          yield* options?.beforeAggregateRead?.(aggregateID) ?? Effect.void
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
                  length(CAST(${EventTable.data} AS BLOB)) AS bytes
                FROM ${EventTable}
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
          if (metadata.length === 0) return { events: [], more: false }
          yield* options?.afterAggregateReadMetadata?.(
            aggregateID,
            metadata.map((event) => event.id),
          ) ?? Effect.void
          const rows = yield* db
            .select({ id: EventTable.id, data: sql<string>`${EventTable.data}` })
            .from(EventTable)
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

      return Service.of({
        publish,
        subscribe,
        all: streamAll,
        aggregateEvents: streamEvents,
        sync,
        listen,
        beforeCommit,
        project,
        replay,
        replayAll,
        remove,
        claim,
      })
    }),
  )

export const layer = layerWith()

export const node = makeGlobalNode({ service: Service, layer: layer, deps: [Database.node] })

export const defaultLayer = layer.pipe(Layer.provide(Database.defaultLayer))
