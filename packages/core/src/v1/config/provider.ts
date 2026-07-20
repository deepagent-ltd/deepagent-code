export * as ConfigProviderV1 from "./provider"

import { Schema } from "effect"
import { PositiveInt } from "../../schema"

export const ModelStatus = Schema.Literals(["alpha", "beta", "deprecated", "active"])

export const Model = Schema.Struct({
  id: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  family: Schema.optional(Schema.String),
  release_date: Schema.optional(Schema.String),
  attachment: Schema.optional(Schema.Boolean),
  reasoning: Schema.optional(Schema.Boolean),
  temperature: Schema.optional(Schema.Boolean),
  tool_call: Schema.optional(Schema.Boolean),
  interleaved: Schema.optional(
    Schema.Union([
      Schema.Literal(true),
      Schema.Struct({
        field: Schema.Literals(["reasoning", "reasoning_content", "reasoning_details"]),
      }),
    ]),
  ),
  cost: Schema.optional(
    Schema.Struct({
      input: Schema.Finite,
      output: Schema.Finite,
      cache_read: Schema.optional(Schema.Finite),
      cache_write: Schema.optional(Schema.Finite),
      context_over_200k: Schema.optional(
        Schema.Struct({
          input: Schema.Finite,
          output: Schema.Finite,
          cache_read: Schema.optional(Schema.Finite),
          cache_write: Schema.optional(Schema.Finite),
        }),
      ),
    }),
  ),
  limit: Schema.optional(
    Schema.Struct({
      context: Schema.Finite,
      input: Schema.optional(Schema.Finite),
      // Optional: a custom/third-party model override may set only the context window and let the
      // catalog/backend fill the output limit (the build loop defaults it). Existing configs that set
      // output stay valid.
      output: Schema.optional(Schema.Finite),
    }),
  ),
  modalities: Schema.optional(
    Schema.Struct({
      input: Schema.optional(Schema.mutable(Schema.Array(Schema.Literals(["text", "audio", "image", "video", "pdf"])))),
      output: Schema.optional(
        Schema.mutable(Schema.Array(Schema.Literals(["text", "audio", "image", "video", "pdf"]))),
      ),
    }),
  ),
  experimental: Schema.optional(Schema.Boolean),
  status: Schema.optional(ModelStatus),
  provider: Schema.optional(
    Schema.Struct({ npm: Schema.optional(Schema.String), api: Schema.optional(Schema.String) }),
  ),
  options: Schema.optional(Schema.Record(Schema.String, Schema.Any)),
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  variants: Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.StructWithRest(
        Schema.Struct({
          disabled: Schema.optional(Schema.Boolean).annotate({ description: "Disable this variant for the model" }),
        }),
        [Schema.Record(Schema.String, Schema.Any)],
      ),
    ).annotate({ description: "Variant-specific configuration" }),
  ),
})

// NEW (v4.0.6): a model group — sub-namespace within a provider with its own protocol and/or
// credentials. Models inside a group inherit group-level settings, which in turn inherit
// provider-level settings. Enables a single provider entry to serve mixed protocols
// (e.g. Anthropic + OpenAI-compatible on the same gateway) with separate API keys per group.
export const ModelGroup = Schema.Struct({
  /** Human-readable label (shown in settings UI). */
  name: Schema.optional(Schema.String),
  /** Protocol override: npm package that drives the SDK for this group's models.
   *  Overrides provider.npm. e.g. "@ai-sdk/anthropic" for Claude on a mixed gateway. */
  npm: Schema.optional(Schema.String),
  /** Credential + transport overrides for this group.
   *  apiKey overrides provider.options.apiKey; baseURL overrides provider.options.baseURL. */
  options: Schema.optional(
    Schema.StructWithRest(
      Schema.Struct({
        apiKey: Schema.optional(Schema.String),
        baseURL: Schema.optional(Schema.String),
        timeout: Schema.optional(Schema.Union([PositiveInt, Schema.Literal(false)])),
      }),
      [Schema.Record(Schema.String, Schema.Any)],
    ),
  ),
  /** When true the group's models are discovered at runtime from its endpoint.
   *  The discovery kind (openai-compatible vs anthropic) is derived from group.npm. */
  discovery: Schema.optional(Schema.Boolean),
  /** Models belonging to this group. Same schema as provider.models. */
  models: Schema.optional(Schema.Record(Schema.String, Model)),
}).annotate({ identifier: "ProviderModelGroup" })
export type ModelGroup = Schema.Schema.Type<typeof ModelGroup>

export const Info = Schema.Struct({
  api: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  env: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
  id: Schema.optional(Schema.String),
  npm: Schema.optional(Schema.String),
  whitelist: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
  blacklist: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
  discovery: Schema.optional(Schema.Boolean).annotate({
    description:
      "Discover this provider's models at runtime from its /models endpoint instead of listing them in config. Discovered models are cached locally and refreshed periodically; manual `models` entries always take precedence.",
  }),
  options: Schema.optional(
    Schema.StructWithRest(
      Schema.Struct({
        apiKey: Schema.optional(Schema.String),
        baseURL: Schema.optional(Schema.String),
        enterpriseUrl: Schema.optional(Schema.String).annotate({
          description: "GitHub Enterprise URL for copilot authentication",
        }),
        setCacheKey: Schema.optional(Schema.Boolean).annotate({
          description: "Enable promptCacheKey for this provider (default false)",
        }),
        timeout: Schema.optional(
          Schema.Union([PositiveInt, Schema.Literal(false)]).annotate({
            description: "Timeout in milliseconds for full requests to this provider. Set to false to disable timeout.",
          }),
        ).annotate({
          description: "Timeout in milliseconds for full requests to this provider. Set to false to disable timeout.",
        }),
        headerTimeout: Schema.optional(
          Schema.Union([PositiveInt, Schema.Literal(false)]).annotate({
            description:
              "Timeout in milliseconds to wait for response headers. Provider integrations may set defaults. Set to false to disable timeout.",
          }),
        ).annotate({
          description:
            "Timeout in milliseconds to wait for response headers. Provider integrations may set defaults. Set to false to disable timeout.",
        }),
        chunkTimeout: Schema.optional(PositiveInt).annotate({
          description:
            "Timeout in milliseconds between streamed SSE chunks for this provider. If no chunk arrives within this window, the request is aborted.",
        }),
      }),
      [Schema.Record(Schema.String, Schema.Any)],
    ),
  ),
  models: Schema.optional(Schema.Record(Schema.String, Model)),
  // NEW (v4.0.6): named model groups — a sub-namespace within a provider that carries its own
  // protocol (npm) and/or credentials (options.apiKey), while inheriting the provider-level
  // baseURL unless explicitly overridden. Useful when a single vendor endpoint serves both
  // OpenAI-compatible and Anthropic-protocol models with separate API keys.
  //
  // Priority chain per model in a group:
  //   model.provider.npm   > group.npm   > provider.npm   > "@ai-sdk/openai-compatible"
  //   model.options.apiKey > group.options.apiKey > provider.options.apiKey
  groups: Schema.optional(Schema.Record(Schema.String, ModelGroup)),
}).annotate({ identifier: "ProviderConfig" })
export type Info = Schema.Schema.Type<typeof Info>
