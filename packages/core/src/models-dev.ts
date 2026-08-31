import path from "path"
import { Context, Duration, Effect, Layer, Option, Schedule, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { Global } from "./global"
import { Flag } from "./flag/flag"
import { Flock } from "./util/flock"
import { Hash } from "./util/hash"
import { FSUtil } from "./fs-util"
import { InstallationChannel, InstallationVersion } from "./installation/version"
import { EventV2 } from "./event"
import { makeGlobalNode } from "./effect/app-node"
import { httpClient } from "./effect/app-node-platform"

export const CatalogModelStatus = Schema.Literals(["alpha", "beta", "deprecated"])
export type CatalogModelStatus = typeof CatalogModelStatus.Type

const USER_AGENT = `deepagent-code/${InstallationChannel}/${InstallationVersion}/${Flag.DEEPAGENT_CODE_CLIENT}`

const CostTier = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  cache_read: Schema.optional(Schema.Finite),
  cache_write: Schema.optional(Schema.Finite),
  tier: Schema.Struct({
    type: Schema.Literal("context"),
    size: Schema.Finite,
  }),
})

const Cost = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  cache_read: Schema.optional(Schema.Finite),
  cache_write: Schema.optional(Schema.Finite),
  tiers: Schema.optional(Schema.Array(CostTier)),
  context_over_200k: Schema.optional(
    Schema.Struct({
      input: Schema.Finite,
      output: Schema.Finite,
      cache_read: Schema.optional(Schema.Finite),
      cache_write: Schema.optional(Schema.Finite),
    }),
  ),
})

export const Model = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  family: Schema.optional(Schema.String),
  release_date: Schema.String,
  attachment: Schema.Boolean,
  reasoning: Schema.Boolean,
  temperature: Schema.Boolean,
  tool_call: Schema.Boolean,
  interleaved: Schema.optional(
    Schema.Union([
      Schema.Literal(true),
      Schema.Struct({
        field: Schema.Literals(["reasoning", "reasoning_content", "reasoning_details"]),
      }),
    ]),
  ),
  cost: Schema.optional(Cost),
  limit: Schema.Struct({
    context: Schema.Finite,
    input: Schema.optional(Schema.Finite),
    output: Schema.Finite,
  }),
  modalities: Schema.optional(
    Schema.Struct({
      input: Schema.Array(Schema.Literals(["text", "audio", "image", "video", "pdf"])),
      output: Schema.Array(Schema.Literals(["text", "audio", "image", "video", "pdf"])),
    }),
  ),
  experimental: Schema.optional(
    Schema.Struct({
      modes: Schema.optional(
        Schema.Record(
          Schema.String,
          Schema.Struct({
            cost: Schema.optional(Cost),
            provider: Schema.optional(
              Schema.Struct({
                body: Schema.optional(Schema.Record(Schema.String, Schema.MutableJson)),
                headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
              }),
            ),
          }),
        ),
      ),
    }),
  ),
  status: Schema.optional(CatalogModelStatus),
  provider: Schema.optional(
    Schema.Struct({ npm: Schema.optional(Schema.String), api: Schema.optional(Schema.String) }),
  ),
})
export type Model = Schema.Schema.Type<typeof Model>

export const Provider = Schema.Struct({
  api: Schema.optional(Schema.String),
  name: Schema.String,
  env: Schema.Array(Schema.String),
  id: Schema.String,
  npm: Schema.optional(Schema.String),
  models: Schema.Record(Schema.String, Model),
})

export type Provider = Schema.Schema.Type<typeof Provider>

export const Event = {
  Refreshed: EventV2.define({
    type: "models-dev.refreshed",
    schema: {},
  }),
}

declare const DEEPAGENT_CODE_MODELS_DEV: Record<string, Provider> | undefined

/**
 * Vendored catalog entry for the DeepAgent first-party API platform (newAPI
 * gateway) — the third-party models.dev catalog does not know it, so its
 * identity + model list live here and flow through the same catalog-driven
 * loader/UI as every other provider.
 *
 * Endpoints per the public docs (https://api.deepagent.ltd/docs):
 *   - OpenAI-compatible:  https://api.deepagent.ltd/v1   (Chat Completions + Responses)
 *   - Anthropic-compat:   https://api.deepagent.ltd      (`/v1/messages`)
 *   - credential env:     DEEPAGENT_API_KEY (sk-… from the platform console)
 *
 * Claude-family models carry `@ai-sdk/anthropic` + the `/v1`-suffixed base so the
 * SDK appends `/messages` → `https://api.deepagent.ltd/v1/messages` (the `/v1`
 * suffix is mandatory, same convention as kimi-for-coding); the rest speak
 * `@ai-sdk/openai-compatible` against `/v1`.
 */
const VENDORED_MODEL = (input: unknown) => Schema.decodeUnknownSync(Model)(input)

const vendoredModel = (
  id: string,
  name: string,
  input: {
    context: number
    output?: number
    reasoning?: boolean
    attachment?: boolean
    family?: string
    anthropic?: boolean
  },
) =>
  VENDORED_MODEL({
    id,
    name,
    family: input.family,
    release_date: "2026-08-01",
    attachment: input.attachment ?? false,
    reasoning: input.reasoning ?? false,
    temperature: true,
    tool_call: true,
    limit: { context: input.context, output: input.output ?? 16_000 },
    provider: input.anthropic
      ? { npm: "@ai-sdk/anthropic", api: "https://api.deepagent.ltd/v1" }
      : undefined,
  })

/** Fully schema-decoded (validated at module load) vendored official catalog. */
export const OFFICIAL_VENDORED_CATALOG: Record<string, Provider> = Schema.decodeUnknownSync(
  Schema.Record(Schema.String, Provider),
)({
  deepagent: {
    id: "deepagent",
    name: "DeepAgent API",
    api: "https://api.deepagent.ltd/v1",
    npm: "@ai-sdk/openai-compatible",
    env: ["DEEPAGENT_API_KEY"],
    models: {
      "gpt-5.6-sol": vendoredModel("gpt-5.6-sol", "GPT-5.6 Sol", { context: 1_000_000, output: 32_000, reasoning: true, family: "openai" }),
      "gpt-5.6-terra": vendoredModel("gpt-5.6-terra", "GPT-5.6 Terra", { context: 1_000_000, output: 32_000, reasoning: true, family: "openai" }),
      "gpt-5.6-luna": vendoredModel("gpt-5.6-luna", "GPT-5.6 Luna", { context: 1_000_000, output: 32_000, reasoning: true, family: "openai" }),
      "claude-opus-5": vendoredModel("claude-opus-5", "Claude Opus 5", { context: 200_000, output: 32_000, reasoning: true, family: "anthropic", anthropic: true }),
      "claude-sonnet-5": vendoredModel("claude-sonnet-5", "Claude Sonnet 5", { context: 200_000, output: 32_000, reasoning: true, family: "anthropic", anthropic: true }),
      "claude-fable-5": vendoredModel("claude-fable-5", "Claude Fable 5", { context: 200_000, output: 32_000, reasoning: true, family: "anthropic", anthropic: true }),
      "claude-haiku-4.5": vendoredModel("claude-haiku-4.5", "Claude Haiku 4.5", { context: 200_000, output: 32_000, family: "anthropic", anthropic: true }),
      "grok-4.6": vendoredModel("grok-4.6", "Grok 4.6", { context: 256_000, output: 32_000, reasoning: true, family: "xai" }),
      "gemini-3.7-flash": vendoredModel("gemini-3.7-flash", "Gemini 3.7 Flash", { context: 1_000_000, output: 64_000, reasoning: true, attachment: true, family: "google" }),
      "deepseek-v4-flash": vendoredModel("deepseek-v4-flash", "DeepSeek V4 Flash", { context: 128_000, reasoning: true, family: "deepseek" }),
      "deepseek-v4-pro": vendoredModel("deepseek-v4-pro", "DeepSeek V4 Pro", { context: 128_000, reasoning: true, family: "deepseek" }),
      "deepseek-v4-flash-vision-exp": vendoredModel("deepseek-v4-flash-vision-exp", "DeepSeek V4 Vision", { context: 128_000, reasoning: true, attachment: true, family: "deepseek" }),
      "qwen3.8-flash": vendoredModel("qwen3.8-flash", "Qwen 3.8 Flash", { context: 128_000, family: "qwen" }),
      "qwen3.8-max": vendoredModel("qwen3.8-max", "Qwen 3.8 Max", { context: 128_000, reasoning: true, family: "qwen" }),
      "glm-5.3": vendoredModel("glm-5.3", "GLM 5.3", { context: 200_000, reasoning: true, family: "glm" }),
      "glm-5.3-flash": vendoredModel("glm-5.3-flash", "GLM 5.3 Flash", { context: 128_000, family: "glm" }),
      "kimi-k3": vendoredModel("kimi-k3", "Kimi K3", { context: 256_000, reasoning: true, family: "kimi" }),
      "k3-256k": vendoredModel("k3-256k", "Kimi K3 256K", { context: 256_000, reasoning: true, family: "kimi" }),
      "kimi-for-coding": vendoredModel("kimi-for-coding", "Kimi Coding", { context: 128_000, family: "kimi" }),
      "kimi-for-coding-highspeed": vendoredModel("kimi-for-coding-highspeed", "Kimi Coding HS", { context: 128_000, family: "kimi" }),
    },
  },
})

const mergeVendored = (loaded: Record<string, Provider>) => ({ ...OFFICIAL_VENDORED_CATALOG, ...loaded })

export interface Interface {
  readonly get: () => Effect.Effect<Record<string, Provider>>
  readonly refresh: (force?: boolean) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/ModelsDev") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const events = yield* EventV2.Service
    const http = HttpClient.filterStatusOk(
      (yield* HttpClient.HttpClient).pipe(
        HttpClient.retryTransient({
          retryOn: "errors-and-responses",
          times: 2,
          schedule: Schedule.exponential(200).pipe(Schedule.jittered),
        }),
      ),
    )

    const source = Flag.DEEPAGENT_CODE_MODELS_URL || "https://models.dev"
    const filepath = path.join(
      Global.Path.cache,
      source === "https://models.dev" ? "models.json" : `models-${Hash.fast(source)}.json`,
    )
    const ttl = Duration.minutes(5)
    const lockKey = `models-dev:${filepath}`

    const fresh = Effect.fnUntraced(function* () {
      const stat = yield* fs.stat(filepath).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (!stat) return false
      const mtime = Option.getOrElse(stat.mtime, () => new Date(0)).getTime()
      return Date.now() - mtime < Duration.toMillis(ttl)
    })

    const fetchApi = Effect.fn("ModelsDev.fetchApi")(function* () {
      return yield* HttpClientRequest.get(`${source}/api.json`).pipe(
        HttpClientRequest.setHeader("User-Agent", USER_AGENT),
        http.execute,
        Effect.flatMap((res) => res.text),
        Effect.timeout("10 seconds"),
      )
    })

    const loadFromDisk = fs.readJson(Flag.DEEPAGENT_CODE_MODELS_PATH ?? filepath).pipe(
      Effect.catch((error) => {
        if (
          Flag.DEEPAGENT_CODE_MODELS_PATH === undefined &&
          error._tag === "FileSystemError" &&
          error.method === "readJson"
        ) {
          return fs.remove(filepath, { force: true }).pipe(Effect.ignore, Effect.as(undefined))
        }
        return Effect.succeed(undefined)
      }),
      Effect.map((v) => v as Record<string, Provider> | undefined),
    )

    const loadSnapshot = Effect.sync(() =>
      typeof DEEPAGENT_CODE_MODELS_DEV === "undefined" ? undefined : DEEPAGENT_CODE_MODELS_DEV,
    )

    const fetchAndWrite = Effect.fn("ModelsDev.fetchAndWrite")(function* () {
      const text = yield* fetchApi()
      const tempfile = `${filepath}.${process.pid}.${Date.now()}.tmp`
      yield* fs.writeWithDirs(tempfile, text).pipe(
        Effect.andThen(fs.rename(tempfile, filepath)),
        Effect.catch((error) =>
          Effect.gen(function* () {
            yield* fs.remove(tempfile, { force: true }).pipe(Effect.ignore)
            return yield* Effect.fail(error)
          }),
        ),
      )
      return text
    })

    const populate = Effect.gen(function* () {
      const fromDisk = yield* loadFromDisk
      if (fromDisk) return mergeVendored(fromDisk)
      const snapshot = yield* loadSnapshot
      if (snapshot) return mergeVendored(snapshot)
      if (Flag.DEEPAGENT_CODE_DISABLE_MODELS_FETCH) return OFFICIAL_VENDORED_CATALOG
      // Flock is cross-process: concurrent deepagent-code CLIs can race on this cache file.
      const text = yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Flock.effect(lockKey)
          return yield* fetchAndWrite()
        }),
      )
      return mergeVendored(JSON.parse(text) as Record<string, Provider>)
    }).pipe(Effect.withSpan("ModelsDev.populate"), Effect.orDie)

    const [cachedGet, invalidate] = yield* Effect.cachedInvalidateWithTTL(populate, Duration.infinity)

    const get = (): Effect.Effect<Record<string, Provider>> => cachedGet

    const refresh = Effect.fn("ModelsDev.refresh")(function* (force = false) {
      if (!force && (yield* fresh())) return
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Flock.effect(lockKey)
          // Re-check under the lock: another process may have refreshed between
          // our outer check and lock acquisition.
          if (!force && (yield* fresh())) return
          yield* fetchAndWrite()
          yield* invalidate
          yield* events.publish(Event.Refreshed, {})
        }),
      ).pipe(
        Effect.tapCause((cause) =>
          Effect.logError("Failed to fetch models.dev").pipe(Effect.annotateLogs("cause", cause)),
        ),
        Effect.ignore,
      )
    })

    if (!Flag.DEEPAGENT_CODE_DISABLE_MODELS_FETCH && !process.argv.includes("--get-yargs-completions")) {
      // Schedule.spaced runs the effect once, then waits between completions.
      yield* Effect.forkScoped(refresh().pipe(Effect.repeat(Schedule.spaced("60 minutes")), Effect.ignore))
    }

    return Service.of({ get, refresh })
  }),
)

export const node = makeGlobalNode({ service: Service, layer: layer, deps: [FSUtil.node, EventV2.node, httpClient] })

export const defaultLayer = layer.pipe(
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(FSUtil.defaultLayer),
  Layer.provide(EventV2.defaultLayer),
)

export * as ModelsDev from "./models-dev"
