export * as RateLimiter from "./rate-limiter"

// V4.0 §E2 — the in-memory fixed-window RATE LIMITER used by process-local ingress guards: a per-key
// bucket that resets after a fixed window. Unlike the pure policy modules this one carries a bounded
// amount of state (the buckets),
// so it is a plain class — NOT Effect. It is still fully deterministic: pass an injectable `now` so
// tests can cross a window boundary without a real clock.
//
// LAYERING: lives in `core`, imports NOTHING runtime. The wiring owns a single instance and calls
// `check` on the hot path; explicit `sweep` and capacity-pressure cleanup drop expired buckets.
//
// §E2 defaults are LENIENT and configurable — they are exported as the constants below so callers pass
// them in explicitly. Nothing restrictive is baked into `check`; the limit/window are always parameters.

interface Bucket {
  count: number
  resetAt: number
}

// Named `Service` (not `RateLimiter`) to mirror the core self-barreled-class idiom (Scheduler.Service,
// DeepAgentEventBus.Service) — a class named `RateLimiter` would collide with the
// `export * as RateLimiter` barrel. Callers use `RateLimiter.Service`.
export class Service {
  private buckets = new Map<string, Bucket>()

  constructor(private readonly maxBuckets = MAX_LIVE_BUCKETS) {}

  /**
   * §E2 — is another hit under `key` allowed within the current window? Returns true and records the
   * hit when under `limit`; returns false (over limit) otherwise. A new or expired bucket resets to a
   * fresh window starting at `now`. `now` is injectable for deterministic tests (defaults to Date.now).
   */
  check(key: string, limit: number, windowMs: number, now: number = Date.now()): boolean {
    const bucket = this.buckets.get(key)

    if (!bucket || now >= bucket.resetAt) {
      if (!bucket && this.buckets.size >= this.maxBuckets) this.sweep(now)
      // High-cardinality hostile keys must never turn this process-local guard into an
      // unbounded allocation. Existing keys keep their normal window semantics; a new
      // key fails closed once every retained bucket is still live.
      if (!bucket && this.buckets.size >= this.maxBuckets) return false
      this.buckets.set(key, { count: 1, resetAt: now + windowMs })
      return true
    }

    if (bucket.count >= limit) {
      return false
    }

    bucket.count++
    return true
  }

  /**
   * Drop buckets whose window has elapsed as of `now`, bounding memory for idle keys. Returns the
   * number of buckets pruned (0 when nothing was stale). A still-live bucket (window not yet elapsed)
   * is preserved untouched, so this is a selective prune, never a blanket reset. The count is a cheap
   * observability signal for the periodic sweep daemon and makes the prune deterministically testable.
   */
  sweep(now: number = Date.now()): number {
    let pruned = 0
    for (const [key, bucket] of this.buckets.entries()) {
      if (now >= bucket.resetAt) {
        this.buckets.delete(key)
        pruned++
      }
    }
    return pruned
  }

  /** Number of live buckets currently held — a memory-footprint probe for the sweep daemon + tests. */
  size(): number {
    return this.buckets.size
  }
}

// Hard process-memory ceiling. Callers with a smaller trust boundary can pass a lower
// value to Service; production must never construct an unlimited bucket table.
export const MAX_LIVE_BUCKETS = 10_000

// §E2 defaults — LENIENT ceilings, meant to be overridden per workspace/agent config. Documented as
// defaults, not enforced minimums; the limiter takes limit/window as parameters on every call.

// Event publish: 1000 events / minute, keyed per workspace.
export const EVENT_PUBLISH_PER_WORKSPACE = { limit: 1000, windowMs: 60_000 } as const

// Agent proactive push: 20 pushes / hour, keyed per agent per group.
export const AGENT_PUSH_PER_AGENT_GROUP = { limit: 20, windowMs: 3_600_000 } as const

// Agent execution: at most 5 concurrent runs per workspace (a concurrency cap, not a window rate —
// enforced by the caller's in-flight counter, surfaced here as the default ceiling).
export const AGENT_EXEC_CONCURRENT_PER_WORKSPACE = 5 as const
