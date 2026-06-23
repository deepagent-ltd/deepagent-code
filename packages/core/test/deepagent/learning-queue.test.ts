import { describe, expect, test } from "bun:test"
import { LearningQueue, type LearningJob } from "../../src/deepagent/background-learning"

// A fake worker job: build() returns a worker whose run() records the trigger and returns a
// minimal LearningWorkerResult. We capture order to prove enqueue is non-blocking (drained later).
const jobThatRecords = (log: string[], label: string, opts?: { throwOnBuild?: boolean }): LearningJob => ({
  trigger: "session_finalization",
  build: () => {
    if (opts?.throwOnBuild) throw new Error(`build failed: ${label}`)
    return {
      worker: {
        run: () => {
          log.push(label)
          return { trigger: "session_finalization", enqueue_ms: 0, candidate_count: 0, auto_merged_ids: [], inbox_ids: [], skipped_ids: [] }
        },
      } as any,
      input: {} as any,
    }
  },
})

describe("LearningQueue (E1: off-main-thread background learning)", () => {
  test("enqueue does not run the job synchronously; an injected scheduler drains it later", () => {
    const log: string[] = []
    const scheduled: Array<() => void> = []
    const queue = new LearningQueue((fn) => scheduled.push(fn))

    queue.enqueue(jobThatRecords(log, "A"))
    // Enqueue returned without running the job -> learning is off the enqueueing path.
    expect(log).toEqual([])
    expect(queue.pending).toBe(1)

    // Drain when the scheduler fires (simulating the microtask).
    scheduled.forEach((fn) => fn())
    expect(log).toEqual(["A"])
    expect(queue.pending).toBe(0)
    expect(queue.results).toHaveLength(1)
  })

  test("drainNow runs all queued jobs synchronously, in order", () => {
    const log: string[] = []
    const queue = new LearningQueue(() => {}) // never auto-schedules
    queue.enqueue(jobThatRecords(log, "A"))
    queue.enqueue(jobThatRecords(log, "B"))
    expect(log).toEqual([])
    queue.drainNow()
    expect(log).toEqual(["A", "B"])
  })

  test("a throwing job is non-fatal and does not stall the queue", () => {
    const log: string[] = []
    const queue = new LearningQueue(() => {})
    queue.enqueue(jobThatRecords(log, "A", { throwOnBuild: true }))
    queue.enqueue(jobThatRecords(log, "B"))
    queue.drainNow()
    // A threw during build, B still ran.
    expect(log).toEqual(["B"])
    expect(queue.pending).toBe(0)
  })
})
