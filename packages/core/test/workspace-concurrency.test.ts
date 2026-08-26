import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { WorkspaceConcurrency } from "@deepagent-code/core/deepagent/workspace-concurrency"
import { WorkspaceConfig } from "@deepagent-code/core/deepagent/workspace-config"
import { RateLimiter } from "@deepagent-code/core/deepagent/rate-limiter"
import { Database } from "@deepagent-code/core/database/database"
import { testEffect } from "./lib/effect"

// V4.0 §E2 — the per-workspace agent-execution concurrency cap. In-memory counter gated by
// WorkspaceConfig.rateLimits.agentExecConcurrent (fallback AGENT_EXEC_CONCURRENT_PER_WORKSPACE = 5).

const database = Database.layerFromPath(":memory:")
const configLayer = WorkspaceConfig.layerWith().pipe(Layer.provideMerge(database))
const concurrencyLayer = WorkspaceConcurrency.layer.pipe(Layer.provideMerge(configLayer))
const it = testEffect(concurrencyLayer)

describe("WorkspaceConcurrency (§E2)", () => {
  it.effect("acquire admits up to the default cap then rejects, release frees a slot", () =>
    Effect.gen(function* () {
      const wc = yield* WorkspaceConcurrency.Service
      const cap = RateLimiter.AGENT_EXEC_CONCURRENT_PER_WORKSPACE // 5
      // admit exactly `cap` runs
      for (let i = 0; i < cap; i++) {
        const r = yield* wc.acquire("wrk_1")
        expect(r.admitted).toBe(true)
        expect(r.depth).toBe(i + 1)
        expect(r.cap).toBe(cap)
      }
      expect(wc.depth("wrk_1")).toBe(cap)
      // the next is over the cap → rejected, counter unchanged
      const over = yield* wc.acquire("wrk_1")
      expect(over.admitted).toBe(false)
      expect(over.depth).toBe(cap)
      expect(wc.depth("wrk_1")).toBe(cap)
      // release one → a slot frees and the next acquire is admitted again
      wc.release("wrk_1")
      expect(wc.depth("wrk_1")).toBe(cap - 1)
      const readmit = yield* wc.acquire("wrk_1")
      expect(readmit.admitted).toBe(true)
      expect(wc.depth("wrk_1")).toBe(cap)
    }),
  )

  it.effect("depth/totalDepth track per-workspace counters; release floors at 0", () =>
    Effect.gen(function* () {
      const wc = yield* WorkspaceConcurrency.Service
      yield* wc.acquire("wrk_a")
      yield* wc.acquire("wrk_a")
      yield* wc.acquire("wrk_b")
      expect(wc.depth("wrk_a")).toBe(2)
      expect(wc.depth("wrk_b")).toBe(1)
      expect(wc.depth("wrk_unseen")).toBe(0)
      expect(wc.totalDepth()).toBe(3)
      // over-release can't drive the counter negative
      wc.release("wrk_b")
      wc.release("wrk_b")
      wc.release("wrk_b")
      expect(wc.depth("wrk_b")).toBe(0)
      expect(wc.totalDepth()).toBe(2)
    }),
  )

  it.effect("the per-workspace override from WorkspaceConfig raises/lowers the cap", () =>
    Effect.gen(function* () {
      const config = yield* WorkspaceConfig.Service
      const wc = yield* WorkspaceConcurrency.Service
      // tighten wrk_tight to a cap of 1
      yield* config.set("wrk_tight", { rateLimits: { agentExecConcurrent: 1 } })
      const first = yield* wc.acquire("wrk_tight")
      expect(first.admitted).toBe(true)
      expect(first.cap).toBe(1)
      const second = yield* wc.acquire("wrk_tight")
      expect(second.admitted).toBe(false) // over the override cap of 1
    }),
  )
})
