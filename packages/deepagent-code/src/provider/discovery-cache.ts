import path from "path"
import { Duration, Effect, Option } from "effect"
import { Global } from "@deepagent-code/core/global"
import { Hash } from "@deepagent-code/core/util/hash"
import { Log } from "@deepagent-code/core/util/log"
import type { FSUtil } from "@deepagent-code/core/fs-util"
import type { EffectFlock } from "@deepagent-code/core/util/effect-flock"
import { discoverProviderModels, isChatModel, type DiscoveredModel, type ProviderDiscoveryKind } from "./model-discovery"

const log = Log.create({ service: "provider-discovery-cache" })

// Bounds on what an untrusted /models endpoint can inject into the provider model map. `id` becomes a
// map key and `api.id` (flows into request payloads); `name` is display-only. Cap both count and
// length so a hostile or broken endpoint can't blow up memory or the UI.
const MAX_DISCOVERED_MODELS = 1000
const MAX_MODEL_ID_LENGTH = 256
const MAX_MODEL_NAME_LENGTH = 256

// Keep only selectable chat models, drop pathological ids/names, and cap the count. Applied to every
// discovery result (fresh fetch and the values re-read from cache) so the runtime pre-pass and the
// interactive discover route agree on what's a usable model.
const sanitizeModels = (models: DiscoveredModel[]): DiscoveredModel[] => {
  const seen = new Set<string>()
  const out: DiscoveredModel[] = []
  for (const model of models) {
    if (!model || typeof model.id !== "string") continue
    const id = model.id.trim()
    if (!id || id.length > MAX_MODEL_ID_LENGTH) continue
    if (!isChatModel(id)) continue
    if (seen.has(id)) continue
    seen.add(id)
    const rawName = typeof model.name === "string" && model.name ? model.name : id
    out.push({ id, name: rawName.slice(0, MAX_MODEL_NAME_LENGTH) })
    if (out.length >= MAX_DISCOVERED_MODELS) break
  }
  return out
}

// Runtime model discovery for third-party providers that opt in with `discovery: true`.
// The live /models list is cached to disk (mtime + TTL, cross-process flock) exactly like the
// models.dev catalog cache, so a fresh instance start reuses the list and only refetches after the
// TTL lapses. Discovery is best-effort: a failed fetch falls back to the last good disk copy, and a
// total miss returns [] so the provider load never blocks on the network.

export const DEFAULT_DISCOVERY_TTL = Duration.hours(6)

export interface DiscoverModelsCachedInput {
  providerID: string
  baseURL: string
  // Optional: header-only-auth providers discover without a bearer/x-api-key credential.
  apiKey?: string
  kind: ProviderDiscoveryKind
  headers?: Record<string, string>
  ttl?: Duration.Duration
}

// Cache identity includes the credential and headers, not just providerID+baseURL: rotating the key
// (or a plan/tier change that alters which models are visible) must invalidate the cache rather than
// serving the old list until the TTL lapses. The secret is hashed, never stored in the filename.
const cacheFile = (input: DiscoverModelsCachedInput) => {
  const headerSig = input.headers
    ? Object.entries(input.headers)
        .map(([k, v]) => `${k}=${v}`)
        .sort()
        .join("&")
    : ""
  const identity = `${input.providerID}\n${input.baseURL}\n${input.kind}\n${input.apiKey}\n${headerSig}`
  return path.join(Global.Path.cache, `provider-models-${Hash.fast(identity)}.json`)
}

// `fs` and `flock` are passed in (rather than pulled from context) so callers inside a scoped
// effect — like the provider state build — don't have to widen their R requirements. `fetch` is
// injectable for testing; it defaults to the real /models HTTP call.
export const discoverModelsCached = Effect.fn("ProviderDiscovery.cached")(function* (
  fs: FSUtil.Interface,
  flock: EffectFlock.Interface,
  input: DiscoverModelsCachedInput,
  fetch: (input: DiscoverModelsCachedInput) => Promise<DiscoveredModel[]> = discoverProviderModels,
) {
  const ttl = input.ttl ?? DEFAULT_DISCOVERY_TTL
  const filepath = cacheFile(input)

  // Re-sanitize on read too: a cache file written by an older build (looser rules) is normalized to
  // the current bounds before use.
  const readDisk = fs.readJson(filepath).pipe(
    Effect.map((v) => (Array.isArray(v) ? sanitizeModels(v as DiscoveredModel[]) : undefined)),
    Effect.catch(() => Effect.succeed(undefined)),
  )

  const fresh = Effect.gen(function* () {
    const stat = yield* fs.stat(filepath).pipe(Effect.catch(() => Effect.succeed(undefined)))
    if (!stat) return false
    const mtime = Option.getOrElse(stat.mtime, () => new Date(0)).getTime()
    return Date.now() - mtime < Duration.toMillis(ttl)
  })

  if (yield* fresh) {
    const cached = yield* readDisk
    if (cached) return cached
  }

  const fetchAndWrite = Effect.gen(function* () {
    const models = sanitizeModels(yield* Effect.tryPromise(() => fetch(input)))
    // Never cache an empty result: a provider that's still provisioning (200 + `{data:[]}`) or whose
    // models are all filtered out would otherwise pin an empty list for the whole TTL and hide models
    // that come online later. Don't overwrite the cache; prefer a prior good (if stale) copy over
    // returning nothing.
    if (models.length === 0) return (yield* readDisk) ?? models
    const tempfile = `${filepath}.${process.pid}.${Date.now()}.tmp`
    yield* fs.writeWithDirs(tempfile, JSON.stringify(models)).pipe(
      Effect.andThen(fs.rename(tempfile, filepath)),
      Effect.catch((error) =>
        fs
          .remove(tempfile, { force: true })
          .pipe(Effect.ignore, Effect.andThen(Effect.fail(error))),
      ),
    )
    return models
  })

  // Refetch under a cross-process lock; re-check freshness inside in case a peer refreshed while we
  // waited on the lock. Any failure (lock, network, write) falls back to a stale disk copy, then [].
  return yield* flock
    .withLock(
      Effect.gen(function* () {
        if (yield* fresh) {
          const cached = yield* readDisk
          if (cached) return cached
        }
        return yield* fetchAndWrite
      }),
      `provider-models:${filepath}`,
    )
    .pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          log.warn("model discovery failed, falling back to cache", { providerID: input.providerID, error })
          const stale = yield* readDisk
          return stale ?? []
        }),
      ),
    )
})
