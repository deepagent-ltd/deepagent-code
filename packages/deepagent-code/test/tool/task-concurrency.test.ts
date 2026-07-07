import { describe, expect, test } from "bun:test"
import { Effect, Ref } from "effect"
import { TaskConcurrency } from "../../src/tool/task-concurrency"

/**
 * §5a: the per-parent-session concurrency semaphore is a CODE-layer hard cap. These tests drive
 * `withTaskSlot` directly (the same primitive `TaskTool.runTask` wraps every subagent dispatch with)
 * and assert the observed peak parallelism never exceeds the resolved width.
 */

// Run `n` slot-guarded effects concurrently; each records the live count, briefly yields so overlap
// is observable, and the harness returns the PEAK concurrency actually reached.
const peakConcurrency = (input: {
  n: number
  parentSessionID: string
  subagentType?: (i: number) => string
  agentMaxConcurrency?: number
  caps?: { maxFanout?: number; maxConcurrency?: number }
}) =>
  Effect.gen(function* () {
    const live = yield* Ref.make(0)
    const peak = yield* Ref.make(0)
    const body = (i: number) =>
      TaskConcurrency.withTaskSlot({
        parentSessionID: input.parentSessionID,
        subagentType: input.subagentType?.(i) ?? "researcher",
        agentMaxConcurrency: input.agentMaxConcurrency,
        caps: input.caps,
        effect: Effect.gen(function* () {
          const now = yield* Ref.updateAndGet(live, (x) => x + 1)
          yield* Ref.update(peak, (p) => Math.max(p, now))
          // Yield across the event loop a few times so sibling fibers get a chance to overlap.
          yield* Effect.sleep("20 millis")
          yield* Ref.update(live, (x) => x - 1)
        }),
      })
    yield* Effect.all(
      Array.from({ length: input.n }, (_, i) => body(i)),
      { concurrency: "unbounded" },
    )
    return yield* Ref.get(peak)
  })

describe("§5a task concurrency semaphore (per-parent-session hard cap)", () => {
  test("N same-type subagents never exceed the default concurrency width (4)", async () => {
    const peak = await Effect.runPromise(peakConcurrency({ n: 10, parentSessionID: "ses_default" }))
    expect(peak).toBeLessThanOrEqual(4)
    // and it actually reached the cap (proves throttling, not accidental serialization)
    expect(peak).toBe(4)
  })

  test("caps are CONFIGURABLE: a lower maxConcurrency narrows the width", async () => {
    const peak = await Effect.runPromise(
      peakConcurrency({ n: 8, parentSessionID: "ses_cfg", caps: { maxConcurrency: 2 } }),
    )
    expect(peak).toBe(2)
  })

  test("caps are CONFIGURABLE: a higher maxConcurrency widens the width", async () => {
    const peak = await Effect.runPromise(
      peakConcurrency({ n: 8, parentSessionID: "ses_wide", caps: { maxConcurrency: 8 } }),
    )
    expect(peak).toBe(8)
  })

  test("agent limits.maxConcurrency TIGHTENS below the session cap (min wins)", async () => {
    // session cap 6, but the agent declares maxConcurrency 2 ⇒ effective 2.
    const peak = await Effect.runPromise(
      peakConcurrency({
        n: 8,
        parentSessionID: "ses_limited",
        agentMaxConcurrency: 2,
        caps: { maxConcurrency: 6 },
      }),
    )
    expect(peak).toBe(2)
  })

  test("agent limit LOOSER than the session cap never loosens it (session cap still binds)", async () => {
    // agent declares 10 but the session cap is 3 ⇒ effective 3.
    const peak = await Effect.runPromise(
      peakConcurrency({
        n: 8,
        parentSessionID: "ses_loose",
        agentMaxConcurrency: 10,
        caps: { maxConcurrency: 3 },
      }),
    )
    expect(peak).toBe(3)
  })

  test("different parent sessions do NOT share a limiter (independent widths)", async () => {
    // Two sessions each at width 2, run fully concurrently ⇒ combined peak can reach 4.
    const peak = await Effect.runPromise(
      Effect.gen(function* () {
        const live = yield* Ref.make(0)
        const peak = yield* Ref.make(0)
        const body = (session: string) =>
          TaskConcurrency.withTaskSlot({
            parentSessionID: session,
            subagentType: "researcher",
            caps: { maxConcurrency: 2 },
            effect: Effect.gen(function* () {
              const now = yield* Ref.updateAndGet(live, (x) => x + 1)
              yield* Ref.update(peak, (p) => Math.max(p, now))
              yield* Effect.sleep("20 millis")
              yield* Ref.update(live, (x) => x - 1)
            }),
          })
        const jobs = [...Array(4)].map(() => body("ses_a")).concat([...Array(4)].map(() => body("ses_b")))
        yield* Effect.all(jobs, { concurrency: "unbounded" })
        return yield* Ref.get(peak)
      }),
    )
    expect(peak).toBeGreaterThan(2)
    expect(peak).toBeLessThanOrEqual(4)
  })

  test("limiter entries are reference-counted and cleaned up when drained", async () => {
    await Effect.runPromise(peakConcurrency({ n: 4, parentSessionID: "ses_gc", caps: { maxConcurrency: 2 } }))
    expect(TaskConcurrency.activeSessionLimiters()).toBe(0)
  })
})
