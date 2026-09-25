import path from "path"
import { Context, Duration, Effect, Layer, Option, Schedule, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { Global } from "./global"
import { Flag } from "./flag/flag"
import { EffectFlock } from "./util/effect-flock"
import { Hash } from "./util/hash"
import { FSUtil } from "./fs-util"
import { InstallationChannel, InstallationVersion } from "./installation/version"
import { EventV2 } from "./event"
import { makeGlobalNode } from "./effect/app-node"
import { httpClient } from "./effect/app-node-platform"
import { OFFICIAL_PROVIDER_CATALOG_ALIASES } from "./provider-official"

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
    provider: input.anthropic ? { npm: "@ai-sdk/anthropic", api: "https://api.deepagent.ltd/v1" } : undefined,
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
      "openai/gpt-5.6-sol": vendoredModel("openai/gpt-5.6-sol", "GPT-5.6 Sol", {
        context: 1_000_000,
        output: 32_000,
        reasoning: true,
        family: "openai",
      }),
      "openai/gpt-5.6-terra": vendoredModel("openai/gpt-5.6-terra", "GPT-5.6 Terra", {
        context: 1_000_000,
        output: 32_000,
        reasoning: true,
        family: "openai",
      }),
      "openai/gpt-5.6-luna": vendoredModel("openai/gpt-5.6-luna", "GPT-5.6 Luna", {
        context: 1_000_000,
        output: 32_000,
        reasoning: true,
        family: "openai",
      }),
      "anthropic/claude-opus-5": vendoredModel("anthropic/claude-opus-5", "Claude Opus 5", {
        context: 200_000,
        output: 32_000,
        reasoning: true,
        family: "anthropic",
        anthropic: true,
      }),
      "anthropic/claude-sonnet-5": vendoredModel("anthropic/claude-sonnet-5", "Claude Sonnet 5", {
        context: 200_000,
        output: 32_000,
        reasoning: true,
        family: "anthropic",
        anthropic: true,
      }),
      "anthropic/claude-fable-5": vendoredModel("anthropic/claude-fable-5", "Claude Fable 5", {
        context: 200_000,
        output: 32_000,
        reasoning: true,
        family: "anthropic",
        anthropic: true,
      }),
      "anthropic/claude-haiku-4.5": vendoredModel("anthropic/claude-haiku-4.5", "Claude Haiku 4.5", {
        context: 200_000,
        output: 32_000,
        family: "anthropic",
        anthropic: true,
      }),
      "x-ai/grok-4.6": vendoredModel("x-ai/grok-4.6", "Grok 4.6", {
        context: 256_000,
        output: 32_000,
        reasoning: true,
        family: "xai",
      }),
      "google/gemini-3.7-flash": vendoredModel("google/gemini-3.7-flash", "Gemini 3.7 Flash", {
        context: 1_000_000,
        output: 64_000,
        reasoning: true,
        attachment: true,
        family: "google",
      }),
      // The DeepSeek window + output are MEASURED against the endpoint, not guessed. They were
      // vendored as 128_000 / 16_000, which is not a conservative bound the provider enforces — it is
      // simply wrong, and the window propagated into the auto-compaction trigger
      // (`window - window*0.18`): 104,960 instead of ~860,000, i.e. 10% of the real window. The
      // provider states both limits directly:
      //   "This model's maximum context length is 1048576 tokens"   (a ~320,000-token request succeeds)
      //   "the valid range of max_tokens is [1, 393216]"
      // Every ablation run recorded so far peaks between 56k and 193k prompt tokens (5-18% of the
      // window), so auto-compaction never had a reason to fire there — which is the intended
      // behaviour for a mechanism that costs a summarization call and drops history.
      // The endpoint's id is `deepseek-flash` — NOT `deepseek-v4-flash`, which the catalog used to
      // carry. A vendored id the provider does not serve resolves to no limits (and, on the API
      // side, to a 400), so the id here is the API's, verbatim.
      "deepseek-flash": vendoredModel("deepseek-flash", "DeepSeek Flash", {
        context: 1_048_576,
        output: 393_216,
        reasoning: true,
        family: "deepseek",
      }),
      "deepseek-v4-pro": vendoredModel("deepseek-v4-pro", "DeepSeek V4 Pro", {
        context: 1_048_576,
        output: 393_216,
        reasoning: true,
        family: "deepseek",
      }),
      "qwen3.8-flash": vendoredModel("qwen3.8-flash", "Qwen 3.8 Flash", { context: 128_000, family: "qwen" }),
      "qwen3.8-max": vendoredModel("qwen3.8-max", "Qwen 3.8 Max", {
        context: 128_000,
        reasoning: true,
        family: "qwen",
      }),
      "glm-5.3": vendoredModel("glm-5.3", "GLM 5.3", { context: 200_000, reasoning: true, family: "glm" }),
      "glm-5.3-flash": vendoredModel("glm-5.3-flash", "GLM 5.3 Flash", {
        context: 128_000,
        reasoning: true,
        family: "glm",
      }),
      "kimi-k3": vendoredModel("kimi-k3", "Kimi K3", { context: 256_000, reasoning: true, family: "kimi" }),
      "k3-256k": vendoredModel("k3-256k", "Kimi K3 256K", { context: 256_000, reasoning: true, family: "kimi" }),
      "kimi-for-coding": vendoredModel("kimi-for-coding", "Kimi Coding", { context: 128_000, family: "kimi" }),
      "kimi-for-coding-highspeed": vendoredModel("kimi-for-coding-highspeed", "Kimi Coding HS", {
        context: 128_000,
        family: "kimi",
      }),
    },
  },
})

/**
 * Per-model default protocol for the vendored `deepagent` catalog (applied by
 * the provider loader in fromModelsDevModel). The platform exposes OpenAI
 * Responses-compatible `/v1/responses` (same key) and documents the Responses
 * wire for its OpenAI/DeepSeek families; those models therefore default to
 * `openai-compatible.responses`, everything else stays `openai-compatible.chat`
 * (Claude-family overrides to anthropic.messages via their `@ai-sdk/anthropic`
 * npm + `/v1` base). Explicit per-model/attempt selection can override.
 */
export const DEEPAGENT_MODEL_PROTOCOL: Record<string, "openai-compatible.responses" | "openai-compatible.chat"> = {
  "openai/gpt-5.6-sol": "openai-compatible.responses",
  "openai/gpt-5.6-terra": "openai-compatible.responses",
  "openai/gpt-5.6-luna": "openai-compatible.responses",
  "deepseek-flash": "openai-compatible.responses",
  "deepseek-v4-pro": "openai-compatible.responses",
}

export const mergeVendored = (loaded: Record<string, Provider>) => {
  const merged = { ...OFFICIAL_VENDORED_CATALOG, ...loaded }
  // D2 — official-id catalog bridge, applied at the single choke point every consumer reads
  // (the V1 provider loader's database, the V2 Catalog via ModelsDevPlugin, and the refresh
  // handler all call ModelsDev.get()). Upstream models.dev renamed entries out from under
  // fixed official ids (kimi-for-coding → kimi-code-plan-cn); without re-homing, a key-store
  // credential for the official id merges into nothing — silently no-op for V1, and
  // CatalogV2.ProviderNotFound (HTTP 500) on the V2 prompt path. The catalog entry keeps its
  // new id too; the official id becomes a second key for the same data.
  for (const [officialID, catalogID] of Object.entries(OFFICIAL_PROVIDER_CATALOG_ALIASES)) {
    if (merged[officialID]) continue
    const entry = merged[catalogID]
    if (!entry) continue
    merged[officialID] = { ...entry, id: officialID }
  }
  return merged
}

// Chain entries may be base URLs ("https://models.dev") or full file URLs (".../api.json",
// the historical DEFAULT_MODELS_URL shape); both map to the base the catalog is fetched from.
const normalizeSource = (entry: string) => {
  const trimmed = entry.trim().replace(/\/+$/, "")
  return trimmed.endsWith("/api.json") ? trimmed.slice(0, -"/api.json".length) : trimmed
}

// A source only succeeds when the body parses to a non-empty provider map — a proxy/WAF HTML
// error page served with a 200 must fall through to the next source, not poison the disk cache.
const parseCatalog = (text: string) =>
  Effect.try({
    try: () => {
      const data = JSON.parse(text) as Record<string, Provider>
      if (typeof data !== "object" || data === null || Array.isArray(data) || Object.keys(data).length === 0)
        throw new Error("not a non-empty provider map")
      return { text, data }
    },
    catch: () => new Error("models.dev catalog body is not valid JSON"),
  })

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
    const global = yield* Global.Service
    const flock = yield* EffectFlock.Service
    const http = HttpClient.filterStatusOk(
      (yield* HttpClient.HttpClient).pipe(
        HttpClient.retryTransient({
          retryOn: "errors-and-responses",
          times: 2,
          schedule: Schedule.exponential(200).pipe(Schedule.jittered),
        }),
      ),
    )

    // Ordered fetch chain: the self-hosted aly mirror (hourly-synced from models.dev, reachable
    // from CN networks) first, models.dev itself as the authoritative fallback. No build-time
    // snapshot: offline first runs serve the vendored deepagent catalog until refresh heals.
    const rawSource = Flag.DEEPAGENT_CODE_MODELS_URL
    const sources = (rawSource ?? "https://ai.deepagent.ltd,https://models.dev")
      .split(",")
      .map(normalizeSource)
      .filter((entry) => entry.length > 0)
    const filepath = path.join(
      global.cache,
      rawSource === undefined || rawSource.trim() === "https://models.dev"
        ? "models.json"
        : `models-${Hash.fast(rawSource)}.json`,
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
      return yield* Effect.firstSuccessOf(
        sources.map((base) =>
          HttpClientRequest.get(`${base}/api.json`).pipe(
            HttpClientRequest.setHeader("User-Agent", USER_AGENT),
            http.execute,
            Effect.flatMap((res) => res.text),
            Effect.timeout("10 seconds"),
            Effect.flatMap(parseCatalog),
            Effect.tapError((error) => Effect.logDebug("models.dev source failed", { base, error })),
          ),
        ),
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

    const fetchAndWrite = Effect.fn("ModelsDev.fetchAndWrite")(function* () {
      const fetched = yield* fetchApi()
      const tempfile = `${filepath}.${process.pid}.${Date.now()}.tmp`
      yield* fs.writeWithDirs(tempfile, fetched.text).pipe(
        Effect.andThen(fs.rename(tempfile, filepath)),
        Effect.catch((error) =>
          Effect.gen(function* () {
            yield* fs.remove(tempfile, { force: true }).pipe(Effect.ignore)
            return yield* Effect.fail(error)
          }),
        ),
      )
      return fetched.data
    })

    const populate = Effect.gen(function* () {
      const fromDisk = yield* loadFromDisk
      if (fromDisk) return mergeVendored(fromDisk)
      if (Flag.DEEPAGENT_CODE_DISABLE_MODELS_FETCH) return OFFICIAL_VENDORED_CATALOG
      // The root-scoped flock is cross-process: concurrent CLIs sharing this Global root serialize
      // the cache file, while independent embedded roots cannot accidentally share a module path.
      // A failed chain must not kill provider init (there is no bundled snapshot anymore): serve
      // the vendored deepagent catalog and let the hourly refresh heal the disk cache.
      const data = yield* Effect.scoped(
        Effect.gen(function* () {
          yield* flock.acquire(lockKey)
          return yield* fetchAndWrite()
        }),
      ).pipe(
        Effect.catch((error) =>
          Effect.logWarning("models.dev catalog fetch failed, serving vendored catalog", { error }).pipe(
            Effect.as(undefined),
          ),
        ),
      )
      if (!data) return OFFICIAL_VENDORED_CATALOG
      return mergeVendored(data)
    }).pipe(Effect.withSpan("ModelsDev.populate"), Effect.orDie)

    const [cachedGet, invalidate] = yield* Effect.cachedInvalidateWithTTL(populate, Duration.infinity)

    const get = (): Effect.Effect<Record<string, Provider>> => cachedGet

    const refresh = Effect.fn("ModelsDev.refresh")(function* (force = false) {
      if (!force && (yield* fresh())) return
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* flock.acquire(lockKey)
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

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [FSUtil.node, EventV2.node, Global.node, EffectFlock.node, httpClient],
})

export const defaultLayer = layer.pipe(
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(FSUtil.defaultLayer),
  Layer.provide(EventV2.defaultLayer),
  Layer.provide(Global.layer),
  Layer.provide(EffectFlock.layer.pipe(Layer.provide(FSUtil.defaultLayer), Layer.provide(Global.layer))),
)

export * as ModelsDev from "./models-dev"
