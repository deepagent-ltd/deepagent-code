import { describe, expect, beforeAll, beforeEach, afterAll } from "bun:test"
import { Effect, Exit, Layer, Ref } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { Flag } from "@deepagent-code/core/flag/flag"
import { Global } from "@deepagent-code/core/global"
import { ModelsDev, mergeVendored } from "@deepagent-code/core/models-dev"
import { EventV2 } from "@deepagent-code/core/event"
import { PROVIDER_PRESETS } from "@deepagent-code/core/provider-presets"
import { EffectFlock } from "@deepagent-code/core/util/effect-flock"
import { it } from "./lib/effect"
import { eventLayer } from "./fixture/event-layer"
import { readFile, rm, writeFile, utimes, mkdir } from "fs/promises"
import { mkdtempSync } from "node:fs"
import path from "path"
import os from "os"
import { tmpRootAsync } from "./fixture/tmpdir"

// test/preload.ts pins DEEPAGENT_CODE_MODELS_PATH to a fixture so other tests can
// resolve providers without network. These tests need to drive the on-disk
// cache themselves and silence the eager refresh fork. Save/restore around
// the suite — never leak the mutation to subsequent test files in the same
// bun process.
const ORIGINAL_MODELS_PATH = Flag.DEEPAGENT_CODE_MODELS_PATH
const ORIGINAL_DISABLE_FETCH = Flag.DEEPAGENT_CODE_DISABLE_MODELS_FETCH
beforeAll(() => {
  Flag.DEEPAGENT_CODE_MODELS_PATH = undefined
  Flag.DEEPAGENT_CODE_DISABLE_MODELS_FETCH = true
})
afterAll(() => {
  Flag.DEEPAGENT_CODE_MODELS_PATH = ORIGINAL_MODELS_PATH
  Flag.DEEPAGENT_CODE_DISABLE_MODELS_FETCH = ORIGINAL_DISABLE_FETCH
})

const testRoot = mkdtempSync(path.join(os.tmpdir(), "deepagent-code-models-test-"))
const testCache = path.join(testRoot, "cache")
const cacheFile = path.join(testCache, "models.json")
const testGlobal = Global.layerWith({ cache: testCache, state: path.join(testRoot, "state") })

const fixture: Record<string, ModelsDev.Provider> = {
  acme: {
    id: "acme",
    name: "Acme",
    env: ["ACME_API_KEY"],
    models: {
      "acme-1": {
        id: "acme-1",
        name: "Acme One",
        release_date: "2026-01-01",
        attachment: false,
        reasoning: false,
        temperature: true,
        tool_call: true,
        limit: { context: 128000, output: 8192 },
      },
    },
  },
}

const fixture2: Record<string, ModelsDev.Provider> = {
  beta: {
    id: "beta",
    name: "Beta",
    env: ["BETA_API_KEY"],
    models: {
      "beta-1": {
        id: "beta-1",
        name: "Beta One",
        release_date: "2026-02-01",
        attachment: false,
        reasoning: true,
        temperature: false,
        tool_call: false,
        limit: { context: 64000, output: 4096 },
      },
    },
  },
}

interface MockState {
  body: string
  status: number
  calls: Array<{ url: string; userAgent: string | null }>
  responses?: Record<string, string>
}

const makeMockClient = (state: Ref.Ref<MockState>) =>
  HttpClient.make((request) =>
    Effect.gen(function* () {
      yield* Ref.update(state, (s) => ({
        ...s,
        calls: [...s.calls, { url: request.url, userAgent: request.headers["user-agent"] ?? null }],
      }))
      const s = yield* Ref.get(state)
      return HttpClientResponse.fromWeb(
        request,
        new Response(s.responses?.[request.url] ?? s.body, { status: s.status }),
      )
    }),
  )

const buildLayer = (state: Ref.Ref<MockState>, global = testGlobal, events = eventLayer()) => {
  const fs = FSUtil.defaultLayer
  const flock = EffectFlock.layer.pipe(Layer.provide(fs), Layer.provide(global))
  // Layer.fresh is required: ModelsDev.layer is a module-level Layer constant,
  // and Effect.provide uses a process-global MemoMap by default — without fresh,
  // every test would reuse the cachedInvalidateWithTTL state from the first run.
  return Layer.fresh(ModelsDev.layer).pipe(
    Layer.provide(Layer.succeed(HttpClient.HttpClient, makeMockClient(state))),
    Layer.provide(fs),
    Layer.provide(events),
    Layer.provide(global),
    Layer.provide(flock),
  )
}

const writeCacheText = (text: string, mtimeMs?: number) =>
  Effect.promise(async () => {
    await mkdir(testCache, { recursive: true })
    await writeFile(cacheFile, text)
    if (mtimeMs !== undefined) {
      const t = mtimeMs / 1000
      await utimes(cacheFile, t, t)
    }
  })

const writeCache = (data: object, mtimeMs?: number) => writeCacheText(JSON.stringify(data), mtimeMs)

const provided = <A, E>(state: Ref.Ref<MockState>, eff: Effect.Effect<A, E, ModelsDev.Service>) =>
  eff.pipe(Effect.provide(buildLayer(state)))

beforeEach(async () => {
  await rm(cacheFile, { force: true })
})

afterAll(async () => {
  await rm(testRoot, { recursive: true, force: true })
})

// Vendored first-party catalog entries (deepagent) are always overlaid under
// whatever the disk/snapshot/network source provides.
const merged = mergeVendored

const initialState: MockState = {
  body: JSON.stringify(fixture),
  status: 200,
  calls: [],
}

describe("ModelsDev Service", () => {
  it.live("get() returns providers from disk when cache file exists", () =>
    Effect.gen(function* () {
      yield* writeCache(fixture)
      const state = yield* Ref.make(initialState)
      const result = yield* provided(
        state,
        ModelsDev.Service.use((s) => s.get()),
      )
      expect(result).toEqual(merged(fixture))
      const final = yield* Ref.get(state)
      expect(final.calls).toEqual([])
    }),
  )

  it.live(
    "get() retains supported connection identities in an empty offline profile without claiming loaded models",
    () =>
      Effect.gen(function* () {
        const state = yield* Ref.make(initialState)
        const result = yield* provided(
          state,
          ModelsDev.Service.use((s) => s.get()),
        )
        expect(result).toEqual(mergeVendored({}))
        expect(result["deepagent"]).toBeDefined()
        for (const preset of PROVIDER_PRESETS) expect(result[preset.id]?.id).toBe(preset.id)
        expect(result.openai?.models).toEqual({})
        expect(result["alibaba-coding-plan-cn"]?.api).toBe("https://coding.dashscope.aliyuncs.com/v1")
        const final = yield* Ref.get(state)
        expect(final.calls).toEqual([])
      }),
  )

  it.live("get() recovers from a corrupted cache file by fetching a fresh catalog", () =>
    Effect.gen(function* () {
      yield* writeCacheText("{")
      const state = yield* Ref.make({ ...initialState, body: JSON.stringify(fixture2) })
      const result = yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          Flag.DEEPAGENT_CODE_DISABLE_MODELS_FETCH = false
        }),
        () =>
          provided(
            state,
            ModelsDev.Service.use((s) => s.get()),
          ),
        () =>
          Effect.sync(() => {
            Flag.DEEPAGENT_CODE_DISABLE_MODELS_FETCH = true
          }),
      )
      expect(result).toEqual(merged(fixture2))
      expect(yield* Effect.promise(() => readFile(cacheFile, "utf8"))).toBe(JSON.stringify(fixture2))
      const final = yield* Ref.get(state)
      expect(final.calls.length).toBe(1)
    }),
  )

  it.live("get() rejects structurally invalid cached JSON while retaining offline provider identities", () =>
    Effect.gen(function* () {
      yield* writeCache({ error: "upstream_unavailable" })
      const state = yield* Ref.make(initialState)
      const result = yield* provided(
        state,
        ModelsDev.Service.use((service) => service.get()),
      )
      expect(result).toEqual(merged({}))
      expect(yield* Effect.promise(() => Bun.file(cacheFile).exists())).toBe(false)
    }),
  )

  it.live("get() accepts omitted upstream temperature and preserves extensible catalog metadata", () =>
    Effect.gen(function* () {
      const model = { ...fixture.acme!.models["acme-1"]!, temperature: undefined, future: { capability: "retained" } }
      const catalog = { acme: { ...fixture.acme!, future: "provider-metadata", models: { "acme-1": model } } }
      yield* writeCache(catalog)
      const state = yield* Ref.make(initialState)
      const result = yield* provided(
        state,
        ModelsDev.Service.use((service) => service.get()),
      )
      expect(result).toEqual(merged(catalog))
      expect(result.acme!.models["acme-1"]!.temperature).toBeUndefined()
    }),
  )

  it.live("refresh(true) skips a JSON error response and uses the next catalog source", () =>
    Effect.gen(function* () {
      yield* writeCache(fixture)
      const state = yield* Ref.make<MockState>({
        ...initialState,
        body: JSON.stringify(fixture2),
        responses: { "https://ai.deepagent.ltd/api.json": JSON.stringify({ error: "upstream_unavailable" }) },
      })
      const result = yield* provided(
        state,
        Effect.gen(function* () {
          const service = yield* ModelsDev.Service
          yield* service.refresh(true)
          return yield* service.get()
        }),
      )
      expect(result).toEqual(merged(fixture2))
      expect((yield* Ref.get(state)).calls.map((call) => call.url)).toEqual([
        "https://ai.deepagent.ltd/api.json",
        "https://models.dev/api.json",
      ])
      expect(yield* Effect.promise(() => readFile(cacheFile, "utf8"))).toBe(JSON.stringify(fixture2))
    }),
  )

  it.live("get() is single-flight under concurrent calls", () =>
    Effect.gen(function* () {
      yield* writeCache(fixture)
      const state = yield* Ref.make(initialState)
      const results = yield* provided(
        state,
        Effect.gen(function* () {
          const svc = yield* ModelsDev.Service
          return yield* Effect.all([svc.get(), svc.get(), svc.get(), svc.get(), svc.get()], {
            concurrency: "unbounded",
          })
        }),
      )
      for (const result of results) expect(result).toEqual(merged(fixture))
    }),
  )

  it.live("get() caches across calls (later disk writes are ignored until invalidate)", () =>
    Effect.gen(function* () {
      yield* writeCache(fixture)
      const state = yield* Ref.make(initialState)
      const first = yield* provided(
        state,
        Effect.gen(function* () {
          const svc = yield* ModelsDev.Service
          const a = yield* svc.get()
          // mutate disk between calls — cache should mask the change
          yield* writeCache(fixture2)
          const b = yield* svc.get()
          return { a, b }
        }),
      )
      expect(first.a).toEqual(merged(fixture))
      expect(first.b).toEqual(merged(fixture))
    }),
  )

  it.live("refresh(true) fetches via HttpClient and updates the cache", () =>
    Effect.gen(function* () {
      yield* writeCache(fixture)
      const state = yield* Ref.make({ ...initialState, body: JSON.stringify(fixture2) })
      const result = yield* provided(
        state,
        Effect.gen(function* () {
          const svc = yield* ModelsDev.Service
          const before = yield* svc.get()
          yield* svc.refresh(true)
          const after = yield* svc.get()
          return { before, after }
        }),
      )
      expect(result.before).toEqual(merged(fixture))
      expect(result.after).toEqual(merged(fixture2))
      const final = yield* Ref.get(state)
      expect(final.calls.length).toBe(1)
      expect(final.calls[0].url).toContain("/api.json")
      expect(final.calls[0].userAgent).toContain("/cli")
    }),
  )

  it.live("uses the injected cache and lock roots for independent embedded runtimes", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpRootAsync()),
      (testRoot) =>
        Effect.gen(function* () {
          const stateA = yield* Ref.make({ ...initialState, body: JSON.stringify(fixture) })
          const stateB = yield* Ref.make({ ...initialState, body: JSON.stringify(fixture2) })
          const cacheA = path.join(testRoot, "a", "cache")
          const cacheB = path.join(testRoot, "b", "cache")
          const layerA = buildLayer(
            stateA,
            Global.layerWith({ cache: cacheA, state: path.join(testRoot, "a", "state") }),
          )
          const layerB = buildLayer(
            stateB,
            Global.layerWith({ cache: cacheB, state: path.join(testRoot, "b", "state") }),
          )

          yield* Effect.all(
            [
              ModelsDev.Service.use((service) => service.refresh(true)).pipe(Effect.provide(layerA)),
              ModelsDev.Service.use((service) => service.refresh(true)).pipe(Effect.provide(layerB)),
            ],
            { concurrency: "unbounded" },
          )

          expect(yield* Effect.promise(() => readFile(path.join(cacheA, "models.json"), "utf8"))).toBe(
            JSON.stringify(fixture),
          )
          expect(yield* Effect.promise(() => readFile(path.join(cacheB, "models.json"), "utf8"))).toBe(
            JSON.stringify(fixture2),
          )
          expect(yield* Effect.promise(() => Bun.file(cacheFile).exists())).toBe(false)
        }),
      (testRoot) => Effect.promise(() => rm(testRoot, { recursive: true, force: true })),
    ),
  )

  it.live("refresh(false) skips fetch when on-disk file is fresh", () =>
    Effect.gen(function* () {
      // Fresh: mtime within the 5-minute TTL.
      yield* writeCache(fixture, Date.now() - 1000)
      const state = yield* Ref.make({ ...initialState, body: JSON.stringify(fixture2) })
      yield* provided(
        state,
        ModelsDev.Service.use((s) => s.refresh(false)),
      )
      const final = yield* Ref.get(state)
      expect(final.calls).toEqual([])
    }),
  )

  it.live("refresh(false) fetches when on-disk file is stale", () =>
    Effect.gen(function* () {
      // Stale: mtime 10 minutes ago, beyond the 5-minute TTL.
      yield* writeCache(fixture, Date.now() - 10 * 60 * 1000)
      const state = yield* Ref.make({ ...initialState, body: JSON.stringify(fixture2) })
      const after = yield* provided(
        state,
        Effect.gen(function* () {
          const svc = yield* ModelsDev.Service
          yield* svc.refresh(false)
          return yield* svc.get()
        }),
      )
      const final = yield* Ref.get(state)
      expect(final.calls.length).toBe(1)
      expect(after).toEqual(merged(fixture2))
    }),
  )

  it.live("a failed forced refresh reports failure without changing or publishing the last good catalog", () =>
    Effect.gen(function* () {
      yield* writeCache(fixture)
      const state = yield* Ref.make({ ...initialState, status: 503, body: "upstream unavailable" })
      const events = eventLayer()
      const published: string[] = []
      yield* Effect.gen(function* () {
        const service = yield* ModelsDev.Service
        const event = yield* EventV2.Service
        const unsubscribe = yield* event.listen((event) =>
          Effect.sync(() => {
            if (event.type === ModelsDev.Event.Refreshed.type) published.push(event.type)
          }),
        )
        const before = yield* service.get()
        const failed = yield* service.refresh(true).pipe(Effect.exit)
        expect(Exit.isFailure(failed)).toBe(true)
        expect(yield* service.get()).toEqual(before)
        expect(yield* Effect.promise(() => readFile(cacheFile, "utf8"))).toBe(JSON.stringify(fixture))
        expect(published).toEqual([])
        yield* unsubscribe
      }).pipe(Effect.provide(Layer.mergeAll(events, buildLayer(state, testGlobal, events))))
    }),
  )

  it.live("background refresh swallows HTTP errors and leaves cache intact", () =>
    Effect.gen(function* () {
      yield* writeCache(fixture, Date.now() - 10 * 60 * 1000)
      const state = yield* Ref.make({ ...initialState, status: 500, body: "boom" })
      const result = yield* provided(
        state,
        Effect.gen(function* () {
          const svc = yield* ModelsDev.Service
          yield* svc.refresh(false)
          return yield* svc.get()
        }),
      )
      expect(result).toEqual(merged(fixture))
      // retryTransient retries 5xx, so calls may be > 1.
      const final = yield* Ref.get(state)
      expect(final.calls.length).toBeGreaterThanOrEqual(1)
    }),
  )
})
