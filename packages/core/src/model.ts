import { DateTime, Schema } from "effect"
import { DateTimeUtcFromMillis } from "effect/Schema"
import { ModelProtocolCapabilities } from "./contract/model-protocol"
import { ProviderV2 } from "./provider"
import { ID, Ref, VariantID } from "./model/ref"
import { ModelRequest } from "./model-request"

export { ID, Ref, VariantID }

// Grouping of models, eg claude opus, claude sonnet
export const Family = Schema.String.pipe(Schema.brand("Family"))
export type Family = typeof Family.Type

export const Capabilities = Schema.Struct({
  tools: Schema.Boolean,
  // mime patterns, image, audio, video/*, text/*
  input: Schema.String.pipe(Schema.Array),
  output: Schema.String.pipe(Schema.Array),
})
export type Capabilities = typeof Capabilities.Type

export const Cost = Schema.Struct({
  tier: Schema.Struct({
    type: Schema.Literal("context"),
    size: Schema.Int,
  }).pipe(Schema.optional),
  input: Schema.Finite,
  output: Schema.Finite,
  // Cache rates unknown stay absent — typed unavailable, never coerced to 0
  // (405-007: a fabricated 0 reads as "cache is free" to every consumer).
  cache: Schema.Struct({
    read: Schema.Finite.pipe(Schema.optional),
    write: Schema.Finite.pipe(Schema.optional),
  }).pipe(Schema.optional),
})


export const Api = Schema.Union([
  Schema.Struct({
    id: ID,
    ...ProviderV2.AISDK.fields,
    // Resolved protocol capability set (design §5.1). Optional: withheld until
    // the model declares it (probe is C2-03); the resolver defaults otherwise.
    protocolCapabilities: ModelProtocolCapabilities.pipe(Schema.optional),
  }),
  Schema.Struct({
    id: ID,
    ...ProviderV2.Native.fields,
    protocolCapabilities: ModelProtocolCapabilities.pipe(Schema.optional),
  }),
]).pipe(Schema.toTaggedUnion("type"))
export type Api = typeof Api.Type

export class Info extends Schema.Class<Info>("ModelV2.Info")({
  id: ID,
  providerID: ProviderV2.ID,
  family: Family.pipe(Schema.optional),
  name: Schema.String,
  api: Api,
  capabilities: Capabilities,
  request: Schema.Struct({
    ...ModelRequest.Request.fields,
    variant: Schema.String.pipe(Schema.optional),
  }),
  variants: Schema.Struct({
    id: VariantID,
    ...ModelRequest.Request.fields,
  }).pipe(Schema.Array),
  time: Schema.Struct({
    released: DateTimeUtcFromMillis,
  }),
  cost: Cost.pipe(Schema.Array),
  status: Schema.Literals(["alpha", "beta", "deprecated", "active"]),
  enabled: Schema.Boolean,
  // Unknown limits stay absent — typed unavailable, never coerced to 0 (K-04 /
  // 405-007: a fabricated 0 reads as a real window to consumers that sum or
  // display it). Models.dev and config ingression write only declared values.
  limit: Schema.Struct({
    context: Schema.Int.pipe(Schema.optional),
    input: Schema.Int.pipe(Schema.optional),
    output: Schema.Int.pipe(Schema.optional),
  }),
}) {
  static empty(providerID: ProviderV2.ID, modelID: ID): Info {
    return new Info({
      id: modelID,
      providerID,
      name: modelID,
      api: {
        id: modelID,
        type: "native",
        settings: {},
      },
      capabilities: {
        tools: false,
        input: [],
        output: [],
      },
      request: {
        headers: {},
        body: {},
        generation: {},
        options: {},
      },
      variants: [],
      time: {
        released: DateTime.makeUnsafe(0),
      },
      cost: [],
      status: "active",
      enabled: true,
      // No fabricated zeros: every limit field starts typed-unavailable (absent).
      limit: {},
    })
  }
}

export function parse(input: string): { providerID: ProviderV2.ID; modelID: ID } {
  const [providerID, ...modelID] = input.split("/")
  return {
    providerID: ProviderV2.ID.make(providerID),
    modelID: ID.make(modelID.join("/")),
  }
}

export * as ModelV2 from "./model"
