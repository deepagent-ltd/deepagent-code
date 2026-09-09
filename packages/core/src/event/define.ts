export * as EventDefine from "./define"
import * as defineModule from "./define"
/** Namespace alias: callers import { EventV2 } from this module (matches the ../event barrel spelling). */
export const EventV2 = defineModule

import { Schema } from "effect"
import { NonNegativeInt, withStatics } from "../schema"
import { externalID, type ExternalID } from "../schema/external-id"
import { Identifier } from "../util/identifier"
import { LocationRef } from "../location/ref"
import { readonlyMap } from "../util/readonly-collections"

// Schema-only event identity + definition factory + the definition registries, extracted
// from event.ts (which keeps the drizzle/database service layer). Schema modules such as
// session/event.ts and session/message.ts depend on this module so the durable store stays
// out of browser-reachable bundles. The registries live here (not in event.ts) because
// define() must register on import from either entrypoint — one owner, no divergence.

export const ID = Schema.String.check(Schema.isStartsWith("evt_")).pipe(
  Schema.brand("Event.ID"),
  withStatics((schema) => ({
    create: () => schema.make("evt_" + Identifier.ascending()),
    fromExternal: (input: ExternalID) => schema.make(externalID("evt", input)),
  })),
)
export type ID = typeof ID.Type

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
  readonly location?: LocationRef.Ref
  readonly metadata?: Record<string, unknown>
  /** Internal replay marker for projectors that own non-replicated operational state. */
  readonly replay?: boolean
  /** Internal exact-replay marker set only after the durable event identity and payload are verified. */
  readonly replayExact?: boolean
  /** Internal owner authority supplied by a replay ingress. It is never serialized into the event payload. */
  readonly replayOwnerID?: string
}

// Synchronized events cross a JSON boundary, so their data schemas must encode and decode without services.
const syncCodec = (definition: Definition) => definition.data as Schema.Codec<unknown, unknown, never, never>

export type SyncDefinition = Definition & {
  readonly sync: NonNullable<Definition["sync"]>
  readonly encode: (data: unknown) => unknown
  readonly decode: (data: unknown) => unknown
}

export function versionedType(type: string, version: number) {
  return `${type}.${version}`
}

export const MAX_EVENT_DEFINITIONS = 1024

const definitionsByType = new Map<string, Definition>()
const syncDefinitionsByVersion = new Map<string, SyncDefinition>()

export const registry = readonlyMap(definitionsByType)
export const syncRegistry = readonlyMap(syncDefinitionsByVersion)

export function define<const Type extends string, Fields extends Schema.Struct.Fields>(input: {
  readonly type: Type
  readonly sync?: {
    readonly version: number
    readonly aggregate: string
  }
  readonly schema: Fields
}): Schema.Schema<Payload<Definition<Type, Schema.Struct<Fields>>>> & Definition<Type, Schema.Struct<Fields>> {
  const existing = definitionsByType.get(input.type)
  if (input.sync === undefined && existing) {
    throw new Error(`Duplicate EventV2 definition for ${input.type}`)
  }
  if (input.sync !== undefined && existing && existing.sync === undefined) {
    throw new Error(`EventV2 definition ${input.type} cannot change from local to synchronized`)
  }
  const syncKey = input.sync === undefined ? undefined : versionedType(input.type, input.sync.version)
  if (syncKey && syncDefinitionsByVersion.has(syncKey)) {
    throw new Error(`Duplicate EventV2 synchronized definition for ${syncKey}`)
  }
  if (!existing && definitionsByType.size >= MAX_EVENT_DEFINITIONS) {
    throw new Error(`EventV2 definition registry exceeds ${MAX_EVENT_DEFINITIONS} event types`)
  }
  if (syncKey && syncDefinitionsByVersion.size >= MAX_EVENT_DEFINITIONS) {
    throw new Error(`EventV2 synchronized definition registry exceeds ${MAX_EVENT_DEFINITIONS} versions`)
  }

  const Data = Schema.Struct(input.schema)
  const Payload = Schema.Struct({
    id: ID,
    metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
    type: Schema.Literal(input.type),
    version: Schema.optional(Schema.Number),
    location: Schema.optional(LocationRef.Ref),
    data: Data,
  }).annotate({ identifier: input.type })

  const definition = Object.assign(Payload, {
    type: input.type,
    ...(input.sync === undefined ? {} : { sync: input.sync }),
    data: Data,
  })
  if (input.sync === undefined || existing?.sync === undefined || input.sync.version >= existing.sync.version) {
    definitionsByType.set(input.type, definition)
  }
  if (input.sync)
    syncDefinitionsByVersion.set(
      syncKey!,
      Object.assign(definition, {
        encode: Schema.encodeUnknownSync(syncCodec(definition)),
        decode: Schema.decodeUnknownSync(syncCodec(definition)),
      }) as SyncDefinition,
    )
  return definition as Schema.Schema<Payload<Definition<Type, Schema.Struct<Fields>>>> &
    Definition<Type, Schema.Struct<Fields>>
}
