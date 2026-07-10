import { describe, expect, test, beforeEach } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import * as SessionState from "../../src/deepagent/session-state"

// V3.9 §C/§D: the per-session Expert Panel arming flag and the active-goal pointer. These are the
// server/UI seams for the panel toggle and the goal status bar. Verifies default-off, explicit toggle,
// global-default seeding, and that the goal pointer phase patch is a no-op once the goal is cleared.

describe("session-state panel arming (§C)", () => {
  beforeEach(() => {
    SessionState.configure(mkdtempSync(path.join(tmpdir(), "panel-arm-")))
  })

  test("a new session starts disarmed", () => {
    SessionState.getOrCreate("panel-s1", "high")
    expect(SessionState.isPanelArmed("panel-s1")).toBe(false)
  })

  test("seedPanelArmed applies the global default", () => {
    SessionState.getOrCreate("panel-s2", "high")
    expect(SessionState.seedPanelArmed("panel-s2", true)).toBe(true)
    expect(SessionState.isPanelArmed("panel-s2")).toBe(true)
  })

  test("setPanelArmed overrides the seeded default per conversation", () => {
    SessionState.getOrCreate("panel-s3", "high")
    SessionState.seedPanelArmed("panel-s3", true)
    SessionState.setPanelArmed("panel-s3", false)
    expect(SessionState.isPanelArmed("panel-s3")).toBe(false)
  })

  test("arming an unknown session is a no-op, isPanelArmed reads false", () => {
    expect(SessionState.isPanelArmed("panel-missing")).toBe(false)
    SessionState.setPanelArmed("panel-missing", true) // must not throw / create state
    expect(SessionState.isPanelArmed("panel-missing")).toBe(false)
  })
})

describe("session-state active-goal pointer (§D)", () => {
  beforeEach(() => {
    SessionState.configure(mkdtempSync(path.join(tmpdir(), "goal-ptr-")))
  })

  test("a new session has no active goal", () => {
    SessionState.getOrCreate("goal-s1", "high")
    expect(SessionState.getActiveGoal("goal-s1")).toBeNull()
  })

  test("setActiveGoal stores the pointer, getActiveGoal returns it", () => {
    SessionState.getOrCreate("goal-s2", "high")
    SessionState.setActiveGoal("goal-s2", {
      goalId: "goal_abc",
      planDocId: "plan_1",
      phase: "running",
      startedAt: new Date().toISOString(),
    })
    const ptr = SessionState.getActiveGoal("goal-s2")
    expect(ptr?.goalId).toBe("goal_abc")
    expect(ptr?.phase).toBe("running")
  })

  test("setActiveGoalPhase patches only the phase", () => {
    SessionState.getOrCreate("goal-s3", "high")
    SessionState.setActiveGoal("goal-s3", {
      goalId: "goal_abc",
      planDocId: "plan_1",
      phase: "running",
      startedAt: "2026-07-09T00:00:00.000Z",
    })
    SessionState.setActiveGoalPhase("goal-s3", "paused")
    const ptr = SessionState.getActiveGoal("goal-s3")
    expect(ptr?.phase).toBe("paused")
    expect(ptr?.startedAt).toBe("2026-07-09T00:00:00.000Z") // untouched
  })

  test("setActiveGoalPhase is a no-op once the goal is cleared (no resurrection)", () => {
    SessionState.getOrCreate("goal-s4", "high")
    SessionState.setActiveGoal("goal-s4", {
      goalId: "goal_abc",
      planDocId: "plan_1",
      phase: "running",
      startedAt: new Date().toISOString(),
    })
    SessionState.setActiveGoal("goal-s4", null)
    SessionState.setActiveGoalPhase("goal-s4", "done")
    expect(SessionState.getActiveGoal("goal-s4")).toBeNull()
  })

  test("both slots survive normalize (disk backfill) for a pre-V3.9 session", () => {
    SessionState.getOrCreate("goal-s5", "high")
    SessionState.setPanelArmed("goal-s5", true)
    SessionState.setActiveGoal("goal-s5", {
      goalId: "goal_x",
      planDocId: "plan_x",
      phase: "running",
      startedAt: new Date().toISOString(),
    })
    // getOrCreate on an existing session runs normalizeState — the slots must be preserved.
    SessionState.getOrCreate("goal-s5", "high")
    expect(SessionState.isPanelArmed("goal-s5")).toBe(true)
    expect(SessionState.getActiveGoal("goal-s5")?.goalId).toBe("goal_x")
  })
})
