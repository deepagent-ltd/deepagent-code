import { describe, expect, test } from "bun:test"
import { RateLimiter } from "@deepagent-code/core/deepagent/rate-limiter"

// RateLimiter carries a tiny bucket map but takes an injectable `now`, so these stay deterministic.

describe("RateLimiter.check", () => {
  test("§E2 admits up to the limit then rejects within a window", () => {
    const rl = new RateLimiter.Service()
    const t0 = 1_000_000
    expect(rl.check("wrk_1", 3, 60_000, t0)).toBe(true)
    expect(rl.check("wrk_1", 3, 60_000, t0 + 10)).toBe(true)
    expect(rl.check("wrk_1", 3, 60_000, t0 + 20)).toBe(true)
    // 4th hit within the same window is over the limit.
    expect(rl.check("wrk_1", 3, 60_000, t0 + 30)).toBe(false)
  })

  test("§E2 crossing the window boundary resets the bucket", () => {
    const rl = new RateLimiter.Service()
    const t0 = 1_000_000
    expect(rl.check("wrk_1", 1, 60_000, t0)).toBe(true)
    expect(rl.check("wrk_1", 1, 60_000, t0 + 100)).toBe(false) // still in window
    // at t0 + windowMs the window has elapsed → fresh bucket, allowed again.
    expect(rl.check("wrk_1", 1, 60_000, t0 + 60_000)).toBe(true)
    expect(rl.check("wrk_1", 1, 60_000, t0 + 60_100)).toBe(false)
  })

  test("§E2 keys are isolated", () => {
    const rl = new RateLimiter.Service()
    const t0 = 1_000_000
    expect(rl.check("a", 1, 60_000, t0)).toBe(true)
    expect(rl.check("b", 1, 60_000, t0)).toBe(true)
    expect(rl.check("a", 1, 60_000, t0)).toBe(false)
  })

  test("sweep drops only expired buckets", () => {
    const rl = new RateLimiter.Service()
    const t0 = 1_000_000
    rl.check("stale", 1, 10_000, t0)
    rl.check("fresh", 1, 60_000, t0)
    rl.sweep(t0 + 20_000) // stale window (10s) elapsed; fresh (60s) not.
    // stale key got swept → a fresh check starts a new window (allowed).
    expect(rl.check("stale", 1, 10_000, t0 + 20_000)).toBe(true)
    // fresh key survived → still over its limit within its window.
    expect(rl.check("fresh", 1, 60_000, t0 + 20_000)).toBe(false)
  })
})

describe("RateLimiter defaults (§E2 lenient)", () => {
  test("exported default ceilings", () => {
    expect(RateLimiter.EVENT_PUBLISH_PER_WORKSPACE).toEqual({ limit: 1000, windowMs: 60_000 })
    expect(RateLimiter.AGENT_PUSH_PER_AGENT_GROUP).toEqual({ limit: 20, windowMs: 3_600_000 })
    expect(RateLimiter.AGENT_EXEC_CONCURRENT_PER_WORKSPACE).toBe(5)
  })
})
