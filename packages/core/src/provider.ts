export * as ProviderV2 from "./provider"

import { withStatics } from "./schema"
import { Schema } from "effect"

export const ID = Schema.String.pipe(
  Schema.brand("ProviderV2.ID"),
  withStatics((schema) => ({
    // Well-known providers
    "deepagent-code": schema.make("deepagent-code"),
    anthropic: schema.make("anthropic"),
    openai: schema.make("openai"),
    google: schema.make("google"),
    googleVertex: schema.make("google-vertex"),
    githubCopilot: schema.make("github-copilot"),
    amazonBedrock: schema.make("amazon-bedrock"),
    azure: schema.make("azure"),
    openrouter: schema.make("openrouter"),
    mistral: schema.make("mistral"),
    gitlab: schema.make("gitlab"),
  })),
)
export type ID = typeof ID.Type

// The closed set of first-party "official" providers. These are the only ids whose credentials come
// from the auth key store and whose identity/protocol is fixed by the catalog. Every other provider
// id — including other models.dev catalog entries — is treated as a user-configured third-party
// provider (credentials from config `options.apiKey` or env). This list is the single source of
// truth shared by the backend provider loader and the app connect UI; keep them in sync.
// Order is display order (recommended-first) in the app.
export const OFFICIAL_PROVIDER_IDS = ["openai", "deepseek", "anthropic", "zhipuai", "xai", "google"] as const
export type OfficialProviderID = (typeof OFFICIAL_PROVIDER_IDS)[number]
export const OFFICIAL_PROVIDER_ID_SET: ReadonlySet<string> = new Set(OFFICIAL_PROVIDER_IDS)
export function isOfficialProvider(providerID: string): boolean {
  return OFFICIAL_PROVIDER_ID_SET.has(providerID)
}

export const AISDK = Schema.Struct({
  type: Schema.Literal("aisdk"),
  package: Schema.String,
  url: Schema.String.pipe(Schema.optional),
  settings: Schema.Record(Schema.String, Schema.Unknown).pipe(Schema.optional),
})

export const Native = Schema.Struct({
  type: Schema.Literal("native"),
  url: Schema.String.pipe(Schema.optional),
  settings: Schema.Record(Schema.String, Schema.Unknown),
})

export const Api = Schema.Union([AISDK, Native]).pipe(Schema.toTaggedUnion("type"))
export type Api = typeof Api.Type

export const Request = Schema.Struct({
  headers: Schema.Record(Schema.String, Schema.String),
  body: Schema.Record(Schema.String, Schema.Any),
})
export type Request = typeof Request.Type

export class Info extends Schema.Class<Info>("ProviderV2.Info")({
  id: ID,
  name: Schema.String,
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
