import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "fs/promises"
import os from "os"
import path from "path"
import { Duration, Effect, Layer } from "effect"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { EffectFlock } from "@deepagent-code/core/util/effect-flock"
import { Global } from "@deepagent-code/core/global"
import { discoverModelsCached, type DiscoverModelsCachedInput } from "@/provider/discovery-cache"
import type { DiscoveredModel } from "@/provider/model-discovery"

// Point the data root at a throwaway dir so cache files (Global.Path.cache) never touch the real
// home. Global reads DEEPAGENT_CODE_HOME lazily on each Path.cache access.
let tmp: string
let prevHome: string | undefined

beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "discovery-cache-"))
  prevHome = process.env.DEEPAGENT_CODE_HOME
  process.env.DEEPAGENT_CODE_HOME = tmp
})

afterAll(async () => {
  if (prevHome === undefined) delete process.env.DEEPAGENT_CODE_HOME
  else process.env.DEEPAGENT_CODE_HOME = prevHome
  await rm(tmp, { recursive: true, force: true })
})

const layer = Layer.mergeAll(FSUtil.defaultLayer, EffectFlock.defaultLayer)

const run = <A, E>(effect: (fs: FSUtil.Interface, flock: EffectFlock.Interface) => Effect.Effect<A, E, never>) =>
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const flock = yield* EffectFlock.Service
    return yield* effect(fs, flock)
  }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise)

const model = (id: string): DiscoveredModel => ({ id, name: id.toUpperCase() })

// Each test uses a distinct providerID/baseURL so their cache files don't collide.
const baseInput = (id: string) => ({
  providerID: id,
  baseURL: `https://${id}.example.com`,
  apiKey: "k",
  kind: "openai-compatible" as const,
})

describe("discoverModelsCached", () => {
  test("fetches and caches on a miss, then serves the cache without refetching", async () => {
    let calls = 0
    const fetch = async () => {
      calls++
      return [model("a"), model("b")]
    }

    const first = await run((fs, flock) => discoverModelsCached(fs, flock, baseInput("miss"), fetch))
    expect(first.map((m) => m.id)).toEqual(["a", "b"])
    expect(calls).toBe(1)

    // Fresh cache (default 6h TTL) → no second fetch.
    const second = await run((fs, flock) => discoverModelsCached(fs, flock, baseInput("miss"), fetch))
    expect(second.map((m) => m.id)).toEqual(["a", "b"])
    expect(calls).toBe(1)
  })

  test("refetches once the cache is stale (ttl elapsed)", async () => {
    let calls = 0
    const fetch = async () => {
      calls++
      return [model(`gen-${calls}`)]
    }
    const input = { ...baseInput("stale"), ttl: Duration.zero }

    const first = await run((fs, flock) => discoverModelsCached(fs, flock, input, fetch))
    expect(first.map((m) => m.id)).toEqual(["gen-1"])

    // ttl=0 → cache is always stale → refetch.
    const second = await run((fs, flock) => discoverModelsCached(fs, flock, input, fetch))
    expect(second.map((m) => m.id)).toEqual(["gen-2"])
    expect(calls).toBe(2)
  })

  test("falls back to the last good cache when a refetch fails", async () => {
    let calls = 0
    const fetch = async () => {
      calls++
      if (calls === 1) return [model("good")]
      throw new Error("HTTP 500")
    }
    const input = { ...baseInput("fallback"), ttl: Duration.zero }

    const first = await run((fs, flock) => discoverModelsCached(fs, flock, input, fetch))
    expect(first.map((m) => m.id)).toEqual(["good"])

    // Second call: cache stale, fetch throws → stale disk copy is returned instead of erroring.
    const second = await run((fs, flock) => discoverModelsCached(fs, flock, input, fetch))
    expect(second.map((m) => m.id)).toEqual(["good"])
    expect(calls).toBe(2)
  })

  test("returns [] when there is no cache and the fetch fails", async () => {
    const fetch = async () => {
      throw new Error("HTTP 404")
    }
    const result = await run((fs, flock) => discoverModelsCached(fs, flock, baseInput("empty"), fetch))
    expect(result).toEqual([])
  })

  test("does not cache a successful-but-empty result (no TTL pinning)", async () => {
    let calls = 0
    const fetch = async () => {
      calls++
      return calls === 1 ? [] : [model("late")]
    }
    // Fresh TTL: if the empty first result were cached, the second call would serve it and never see
    // the model that came online.
    const input = baseInput("empty-nocache")

    const first = await run((fs, flock) => discoverModelsCached(fs, flock, input, fetch))
    expect(first).toEqual([])

    const second = await run((fs, flock) => discoverModelsCached(fs, flock, input, fetch))
    expect(second.map((m) => m.id)).toEqual(["late"])
    expect(calls).toBe(2)
  })

  test("empty refetch prefers the prior good cache over returning nothing", async () => {
    let calls = 0
    const fetch = async () => {
      calls++
      return calls === 1 ? [model("good")] : []
    }
    const input = { ...baseInput("empty-prefers-stale"), ttl: Duration.zero }

    const first = await run((fs, flock) => discoverModelsCached(fs, flock, input, fetch))
    expect(first.map((m) => m.id)).toEqual(["good"])

    // Stale cache + empty refetch → keep serving the last good list.
    const second = await run((fs, flock) => discoverModelsCached(fs, flock, input, fetch))
    expect(second.map((m) => m.id)).toEqual(["good"])
  })

  test("filters non-chat models and caps id/name length", async () => {
    const longId = "x".repeat(300)
    const fetch = async (): Promise<DiscoveredModel[]> => [
      model("gpt-4o"),
      { id: "text-embedding-3-large", name: "Embed" },
      { id: "whisper-1", name: "Whisper" },
      { id: longId, name: "TooLong" },
      { id: "claude-sonnet-4", name: "n".repeat(300) },
    ]
    const result = await run((fs, flock) => discoverModelsCached(fs, flock, baseInput("filter"), fetch))
    // Non-chat ids dropped; over-length id dropped; chat models kept; name truncated to 256.
    expect(result.map((m) => m.id).sort()).toEqual(["claude-sonnet-4", "gpt-4o"])
    expect(result.find((m) => m.id === "claude-sonnet-4")!.name.length).toBe(256)
  })

  test("rotating the api key invalidates the cache (key is part of cache identity)", async () => {
    let calls = 0
    const fetch = async () => {
      calls++
      return [model(`key-${calls}`)]
    }
    const withKey = (apiKey: string) => ({ ...baseInput("rotate"), apiKey })

    const first = await run((fs, flock) => discoverModelsCached(fs, flock, withKey("old-key"), fetch))
    expect(first.map((m) => m.id)).toEqual(["key-1"])

    // Same providerID+baseURL but a new key → different cache file → refetch, not a stale hit.
    const second = await run((fs, flock) => discoverModelsCached(fs, flock, withKey("new-key"), fetch))
    expect(second.map((m) => m.id)).toEqual(["key-2"])
    expect(calls).toBe(2)
  })

  test("discovers with header-only auth (no api key)", async () => {
    let received: DiscoverModelsCachedInput | undefined
    const fetch = async (input: DiscoverModelsCachedInput) => {
      received = input
      return [model("hdr-a")]
    }
    const input: DiscoverModelsCachedInput = {
      providerID: "header-only",
      baseURL: "https://header-only.example.com",
      kind: "openai-compatible",
      headers: { "X-Api-Key": "in-header" },
    }
    const result = await run((fs, flock) => discoverModelsCached(fs, flock, input, fetch))
    expect(result.map((m) => m.id)).toEqual(["hdr-a"])
    expect(received?.apiKey).toBeUndefined()
    expect(received?.headers).toEqual({ "X-Api-Key": "in-header" })
  })
})
