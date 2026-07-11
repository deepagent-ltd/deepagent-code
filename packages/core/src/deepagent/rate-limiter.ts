export * as RateLimiter from "./rate-limiter"

// V4.0 §E2 — the in-memory fixed-window RATE LIMITER. Mirrors the existing `class RateLimiter` in
// deepagent-code (server/routes/instance/httpapi/handlers/im.ts): a per-key bucket that resets after a
// fixed window. Unlike the pure policy modules this one carries a tiny amount of state (the buckets),
// so it is a plain class — NOT Effect. It is still fully deterministic: pass an injectable `now` so
// tests can cross a window boundary without a real clock.
//
// LAYERING: lives in `core`, imports NOTHING runtime. The wiring owns a single instance and calls
// `check` on the hot path; a periodic `sweep` drops expired buckets to bound memory.
//
// §E2 defaults are LENIENT and configurable — they are exported as the constants below so callers pass
// them in explicitly. Nothing restrictive is baked into `check`; the limit/window are always parameters.

interface Bucket {
  count: number
  resetAt: number
}

// Named `Service` (not `RateLimiter`) to mirror the core self-barreled-class idiom (Scheduler.Service,
// GraphQuery.Service, DeepAgentEventBus.Service) — a class named `RateLimiter` would collide with the
// `export * as RateLimiter` barrel. Callers use `RateLimiter.Service`.
export class Service {
  private buckets = new Map<string, Bucket>()

  /**
   * §E2 — is another hit under `key` allowed within the current window? Returns true and records the
   * hit when under `limit`; returns false (over limit) otherwise. A new or expired bucket resets to a
   * fresh window starting at `now`. `now` is injectable for deterministic tests (defaults to Date.now).
   */
  check(key: string, limit: number, windowMs: number, now: number = Date.now()): boolean {
    const bucket = this.buckets.get(key)

    if (!bucket || now >= bucket.resetAt) {
      this.buckets.set(key, { count: 1, resetAt: now + windowMs })
      return true
    }

    if (bucket.count >= limit) {
      return false
    }

    bucket.count++
    return true
  }

  /** Drop buckets whose window has elapsed as of `now`, bounding memory for idle keys. */
  sweep(now: number = Date.now()): void {
    for (const [key, bucket] of this.buckets.entries()) {
      if (now >= bucket.resetAt) {
        this.buckets.delete(key)
      }
    }
  }
}

// §E2 defaults — LENIENT ceilings, meant to be overridden per workspace/agent config. Documented as
// defaults, not enforced minimums; the limiter takes limit/window as parameters on every call.

// Event publish: 1000 events / minute, keyed per workspace.
export const EVENT_PUBLISH_PER_WORKSPACE = { limit: 1000, windowMs: 60_000 } as const

// Agent proactive push: 20 pushes / hour, keyed per agent per group.
export const AGENT_PUSH_PER_AGENT_GROUP = { limit: 20, windowMs: 3_600_000 } as const

// Agent execution: at most 5 concurrent runs per workspace (a concurrency cap, not a window rate —
// enforced by the caller's in-flight counter, surfaced here as the default ceiling).
export const AGENT_EXEC_CONCURRENT_PER_WORKSPACE = 5 as const
