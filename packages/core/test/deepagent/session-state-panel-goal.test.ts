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

  test("a new session has no explicit choice → follows the global default", () => {
    SessionState.getOrCreate("panel-s1", "high")
    expect(SessionState.panelArmedChoice("panel-s1")).toBeNull()
    // effective state falls back to the supplied global default (both directions)
    expect(SessionState.resolvePanelArmed("panel-s1", false)).toBe(false)
    expect(SessionState.resolvePanelArmed("panel-s1", true)).toBe(true)
  })

  test("an explicit toggle overrides the global default", () => {
    SessionState.getOrCreate("panel-s2", "high")
    SessionState.setPanelArmed("panel-s2", false)
    // explicit false wins even when the global default is true
    expect(SessionState.panelArmedChoice("panel-s2")).toBe(false)
    expect(SessionState.resolvePanelArmed("panel-s2", true)).toBe(false)

    SessionState.setPanelArmed("panel-s2", true)
    expect(SessionState.resolvePanelArmed("panel-s2", false)).toBe(true)
  })

  test("arming an unknown session is a no-op", () => {
    expect(SessionState.panelArmedChoice("panel-missing")).toBeNull()
    SessionState.setPanelArmed("panel-missing", true) // must not throw / create state
    expect(SessionState.panelArmedChoice("panel-missing")).toBeNull()
    expect(SessionState.resolvePanelArmed("panel-missing", false)).toBe(false)
  })
})

describe("session-state panel debate depth (V4.0 three-state control)", () => {
  beforeEach(() => {
    SessionState.configure(mkdtempSync(path.join(tmpdir(), "panel-rounds-")))
  })

  test("defaults to single when never chosen; setPanelRounds persists the choice", () => {
    SessionState.getOrCreate("pr-1", "high")
    expect(SessionState.panelRounds("pr-1")).toBe("single") // default
    SessionState.setPanelRounds("pr-1", "multi")
    expect(SessionState.panelRounds("pr-1")).toBe("multi")
    SessionState.setPanelRounds("pr-1", "single")
    expect(SessionState.panelRounds("pr-1")).toBe("single")
  })

  test("depth is independent of armed state (decoupled dimensions)", () => {
    SessionState.getOrCreate("pr-2", "high")
    SessionState.setPanelRounds("pr-2", "multi")
    SessionState.setPanelArmed("pr-2", false) // disarm must NOT wipe the chosen depth
    expect(SessionState.panelRounds("pr-2")).toBe("multi")
    expect(SessionState.resolvePanelArmed("pr-2", false)).toBe(false)
  })

  test("setting depth on an unknown session is a no-op and still reads the default", () => {
    SessionState.setPanelRounds("pr-missing", "multi") // must not throw / create state
    expect(SessionState.panelRounds("pr-missing")).toBe("single")
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
    expect(SessionState.panelArmedChoice("goal-s5")).toBe(true)
    expect(SessionState.getActiveGoal("goal-s5")?.goalId).toBe("goal_x")
  })
})
