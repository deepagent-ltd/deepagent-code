import { describe, expect, test, beforeEach } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import * as SessionState from "../../src/deepagent/session-state"

// U1: the session-state latch mutators (the production seam the live loop calls). Verifies the latch
// is DERIVED from runtime facts — recordValidation with a failing result flips stale WITHOUT any
// model cooperation (S1 §验收 b).

describe("session-state plan latch", () => {
  beforeEach(() => {
    SessionState.configure(mkdtempSync(path.join(tmpdir(), "plan-latch-")))
  })

  test("a new session starts with a fresh latch", () => {
    SessionState.getOrCreate("latch-s1", "high")
    expect(SessionState.planLatch("latch-s1")?.latch).toBe("fresh")
  })

  test("a failing validation flips the latch to stale (runtime-derived, no model input)", () => {
    SessionState.getOrCreate("latch-s2", "high")
    SessionState.recordValidation(
      "latch-s2",
      [{ command: "tsc", passed: false, exit_code: 1, output: "err", duration_ms: 1 }],
      "err",
    )
    const latch = SessionState.planLatch("latch-s2")
    expect(latch?.latch).toBe("stale")
    expect(latch?.stale_reason).toBe("validation_failed")
  })

  test("a passing validation does NOT flip the latch", () => {
    SessionState.getOrCreate("latch-s3", "high")
    SessionState.recordValidation(
      "latch-s3",
      [{ command: "tsc", passed: true, exit_code: 0, output: "ok", duration_ms: 1 }],
      "ok",
    )
    expect(SessionState.planLatch("latch-s3")?.latch).toBe("fresh")
  })

  test("markPlanStale / clearPlanStale round-trip bumps replan_count", () => {
    SessionState.getOrCreate("latch-s4", "high")
    SessionState.markPlanStale("latch-s4", "user_appended")
    expect(SessionState.planLatch("latch-s4")?.latch).toBe("stale")
    SessionState.clearPlanStale("latch-s4")
    const latch = SessionState.planLatch("latch-s4")
    expect(latch?.latch).toBe("fresh")
    expect(latch?.replan_count).toBe(1)
  })

  test("setPlan stores the plan, binds the id, and clears a stale latch", () => {
    SessionState.getOrCreate("latch-s5", "high")
    SessionState.markPlanStale("latch-s5", "user_appended")
    SessionState.setPlan("latch-s5", {
      plan_id: "plan_abc",
      session_id: "latch-s5",
      goal: "ship it",
      assumptions: [],
      steps: [{ step_id: "latch-s1", title: "build", status: "active" }],
      active_step_id: "latch-s1",
      created_at: new Date().toISOString(),
    })
    expect(SessionState.planLatch("latch-s5")?.plan_id).toBe("plan_abc")
    expect(SessionState.planLatch("latch-s5")?.latch).toBe("fresh") // updating the plan cleared the latch
    expect(SessionState.getPlan("latch-s5")?.goal).toBe("ship it")
  })

  test("latch survives a save/load round-trip via getOrCreate normalize", () => {
    SessionState.getOrCreate("latch-s6", "high")
    SessionState.markPlanStale("latch-s6", "no_progress")
    // re-fetch through getOrCreate (the normalize path) — latch must be preserved
    const reloaded = SessionState.getOrCreate("latch-s6", "high")
    expect(reloaded.planLatch.latch).toBe("stale")
    expect(reloaded.planLatch.stale_reason).toBe("no_progress")
  })
})
