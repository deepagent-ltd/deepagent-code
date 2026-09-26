export * as ProviderV2 from "./provider"

import { ModelProtocol } from "./contract/model-protocol"
import { withStatics } from "./schema"
import { Schema } from "effect"

import { ID } from "./provider-id"
export { ID }

// The closed set of first-party "official" providers. These are the only ids whose credentials come
// from the auth key store and whose identity/protocol is fixed by the catalog. Every other provider
// id — including other models.dev catalog entries — is treated as a user-configured third-party
// provider (credentials from config `options.apiKey` or env). This list is the single source of
// truth shared by the backend provider loader and the app connect UI; keep them in sync.
// Order is display order (recommended-first) in the app.
//
// The constants live in the dependency-free `./provider-official` leaf so the browser/renderer can
// import them WITHOUT pulling this module's `./schema` -> `./util/hash` -> node `crypto` chain
// (which Vite externalizes and would crash the renderer). Re-exported here for backend callers.
export {
  OFFICIAL_PROVIDER_IDS,
  OFFICIAL_PROVIDER_ID_SET,
  OFFICIAL_PROVIDER_CATALOG_ALIASES,
  isOfficialProvider,
  officialProviderCatalogID,
  type OfficialProviderID,
} from "./provider-official"

export const AISDK = Schema.Struct({
  type: Schema.Literal("aisdk"),
  package: Schema.String,
  url: Schema.String.pipe(Schema.optional),
  settings: Schema.Record(Schema.String, Schema.Unknown).pipe(Schema.optional),
  // Explicit provider protocol (design §5.1). Optional so old config migrates:
  // an absent protocol is derived by the source classification. Declared here so
  // it flows to both the provider api and the derived model api.
  protocol: ModelProtocol.pipe(Schema.optional),
})

export const Native = Schema.Struct({
  type: Schema.Literal("native"),
  url: Schema.String.pipe(Schema.optional),
  settings: Schema.Record(Schema.String, Schema.Unknown),
  protocol: ModelProtocol.pipe(Schema.optional),
})

export const Api = Schema.Union([AISDK, Native]).pipe(Schema.toTaggedUnion("type"))
export type Api = typeof Api.Type

/**
 * Provenance of a catalog provider entry: which ingression source wrote it
 * (K-04). `"config"` marks user-defined providers ingressed from Core config
 * documents by ConfigProviderPlugin; absent means the first-party fillers
 * (models-dev catalog, first-party provider plugins). A dedicated field with a
 * closed literal set — availability (`enabled.via`) is never overloaded to
 * double as origin.
 */
export const Origin = Schema.Literals(["config"])
export type Origin = typeof Origin.Type

export const Request = Schema.Struct({
  headers: Schema.Record(Schema.String, Schema.String),
  body: Schema.Record(Schema.String, Schema.Any),
})
export type Request = typeof Request.Type

export class Info extends Schema.Class<Info>("ProviderV2.Info")({
  id: ID,
  name: Schema.String,
  // Ingression provenance (see Origin). Absent on first-party filled entries.
  origin: Origin.pipe(Schema.optional),
  enabled: Schema.Union([
    Schema.Literal(false),
    Schema.Struct({
      via: Schema.Literal("env"),
      name: Schema.String,
    }),
    Schema.Struct({
      via: Schema.Literal("account"),
      service: Schema.String,
    }),
    Schema.Struct({
      via: Schema.Literal("custom"),
      data: Schema.Record(Schema.String, Schema.Any),
    }),
  ]),
  env: Schema.String.pipe(Schema.Array),
  api: Api,
  request: Request,
}) {
  static empty(providerID: ID): Info {
    return new Info({
      id: providerID,
      name: providerID,
      enabled: false,
      env: [],
      api: {
        type: "native",
        settings: {},
      },
      request: {
        headers: {},
        body: {},
      },
    })
  }
}
