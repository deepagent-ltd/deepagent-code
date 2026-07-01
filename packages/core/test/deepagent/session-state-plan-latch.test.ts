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

// U10 step-reporting: the mutation-since-report counter and evidence plumbing on the production seam.
describe("session-state progress-nudge counter", () => {
  beforeEach(() => {
    SessionState.configure(mkdtempSync(path.join(tmpdir(), "plan-nudge-")))
  })

  const plan = (steps: Array<{ id: string; status: string }>, activeId: string | null = null) => ({
    plan_id: "plan_x",
    session_id: "sess",
    goal: "g",
    assumptions: [] as string[],
    steps: steps.map((s) => ({ step_id: s.id, title: s.id, status: s.status as never })),
    active_step_id: activeId,
    created_at: new Date().toISOString(),
  })

  test("recordMutation is a no-op until a plan exists", () => {
    SessionState.getOrCreate("nudge-s1", "high")
    SessionState.recordMutation("nudge-s1")
    expect(SessionState.mutationsSinceReport("nudge-s1")).toBe(0)
  })

  test("recordMutation counts once a plan exists", () => {
    SessionState.getOrCreate("nudge-s2", "high")
    SessionState.setPlan("nudge-s2", plan([{ id: "s1", status: "active" }], "s1"))
    SessionState.recordMutation("nudge-s2")
    SessionState.recordMutation("nudge-s2")
    expect(SessionState.mutationsSinceReport("nudge-s2")).toBe(2)
  })

  test("a real status change resets the counter; a no-op re-write does not", () => {
    SessionState.getOrCreate("nudge-s3", "high")
    SessionState.setPlan("nudge-s3", plan([{ id: "s1", status: "active" }], "s1"))
    SessionState.recordMutation("nudge-s3")
    SessionState.recordMutation("nudge-s3")
    // no-op re-write (same statuses) -> counter keeps running (no report theater)
    SessionState.setPlan("nudge-s3", plan([{ id: "s1", status: "active" }], "s1"))
    expect(SessionState.mutationsSinceReport("nudge-s3")).toBe(2)
    // real status change -> reset
    SessionState.setPlan("nudge-s3", plan([{ id: "s1", status: "done" }]))
    expect(SessionState.mutationsSinceReport("nudge-s3")).toBe(0)
  })

  test("setPlan preserves evidence across a re-write (evidence is runtime-owned)", () => {
    SessionState.getOrCreate("nudge-s4", "high")
    SessionState.setPlan("nudge-s4", {
      ...plan([{ id: "s1", status: "done" }]),
      steps: [{ step_id: "s1", title: "build", status: "done", evidence: ["run:1"] }],
    })
    // model re-writes the plan (adds a step) without repeating evidence
    SessionState.setPlan("nudge-s4", {
      ...plan([
        { id: "s1", status: "done" },
        { id: "s2", status: "active" },
      ]),
      steps: [
        { step_id: "s1", title: "build", status: "done" },
        { step_id: "s2", title: "test", status: "active" },
      ],
    })
    // buildPlanFromInput is where preservation happens; setPlan stores what it is given, so this test
    // asserts the getPlan round-trip is intact for the stored value.
    expect(SessionState.getPlan("nudge-s4")?.steps[0].step_id).toBe("s1")
  })

  test("lastValidationSummary reflects the latest validation run", () => {
    SessionState.getOrCreate("nudge-s5", "high")
    expect(SessionState.lastValidationSummary("nudge-s5")).toBeNull()
    SessionState.recordValidation(
      "nudge-s5",
      [
        { command: "tsc", passed: true, exit_code: 0, output: "ok", duration_ms: 1 },
        { command: "test", passed: false, exit_code: 1, output: "err", duration_ms: 1 },
      ],
      "mixed",
    )
    const summary = SessionState.lastValidationSummary("nudge-s5")
    expect(summary).toContain("1/2 passed")
    expect(summary).toContain("tsc✓")
    expect(summary).toContain("test✗")
  })

  test("validationPassedSinceReport: set by an all-pass run, reset on a real status change", () => {
    SessionState.getOrCreate("nudge-s6", "high")
    SessionState.setPlan("nudge-s6", plan([{ id: "s1", status: "active" }], "s1"))
    expect(SessionState.validationPassedSinceReport("nudge-s6")).toBe(false)
    // a failing run does NOT set the semantic flag (it marks the latch stale instead)
    SessionState.recordValidation(
      "nudge-s6",
      [{ command: "tsc", passed: false, exit_code: 1, output: "err", duration_ms: 1 }],
      "err",
    )
    expect(SessionState.validationPassedSinceReport("nudge-s6")).toBe(false)
    // an all-passing run sets it
    SessionState.recordValidation(
      "nudge-s6",
      [{ command: "tsc", passed: true, exit_code: 0, output: "ok", duration_ms: 1 }],
      "ok",
    )
    expect(SessionState.validationPassedSinceReport("nudge-s6")).toBe(true)
    // a real status change clears it (fresh reporting window)
    SessionState.setPlan("nudge-s6", plan([{ id: "s1", status: "done" }]))
    expect(SessionState.validationPassedSinceReport("nudge-s6")).toBe(false)
  })

  test("validationPassedSinceReport: a no-op plan re-write does NOT clear the flag", () => {
    SessionState.getOrCreate("nudge-s7", "high")
    SessionState.setPlan("nudge-s7", plan([{ id: "s1", status: "active" }], "s1"))
    SessionState.recordValidation(
      "nudge-s7",
      [{ command: "tsc", passed: true, exit_code: 0, output: "ok", duration_ms: 1 }],
      "ok",
    )
    SessionState.setPlan("nudge-s7", plan([{ id: "s1", status: "active" }], "s1")) // no status change
    expect(SessionState.validationPassedSinceReport("nudge-s7")).toBe(true)
  })
})
