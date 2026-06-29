import { describe, expect, test, beforeEach } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import * as SessionState from "../../src/deepagent/session-state"
import * as PlanController from "../../src/deepagent/plan-controller"
import { planGate, HookPolicy } from "../../src/deepagent/hooks"

// U1 end-to-end contract (the exact decision the tools.ts chokepoint computes): a stale plan
// soft-blocks a mutating tool, read/plan tools pass, and calling the plan tool (setPlan) clears the
// latch so the next mutating tool is allowed again. This mirrors the wiring in session/tools.ts
// without booting the full session loop.

const gate = new HookPolicy().on("before_tool_use", planGate())

// Reproduce the chokepoint decision exactly (session/tools.ts).
const decideAt = (sessionId: string, toolId: string, mode: string) => {
  const latch = SessionState.planLatch(sessionId)
  const planStale = latch?.latch === "stale" && !PlanController.shouldEscapeToHuman(latch)
  return gate.evaluate({
    name: "before_tool_use",
    payload: {
      planStale,
      isMutating: PlanController.isMutatingTool(toolId),
      lightweight: PlanController.isLightweightMode(mode),
    },
  })
}

describe("U1 soft-gate loop (chokepoint contract)", () => {
  beforeEach(() => {
    SessionState.configure(mkdtempSync(path.join(tmpdir(), "plan-gate-")))
  })

  test("high mode: stale plan blocks edit, allows read/plan, plan tool unblocks", () => {
    SessionState.getOrCreate("gate-s1", "high")
    // a failing validation flips the latch from runtime truth
    SessionState.recordValidation("gate-s1", [{ command: "tsc", passed: false, output: "e", duration_ms: 1 }], "e")

    expect(decideAt("gate-s1", "edit", "high").decision).toBe("block")
    expect(decideAt("gate-s1", "read", "high").decision).toBe("allow")
    expect(decideAt("gate-s1", "todowrite", "high").decision).toBe("allow")

    // model calls the plan tool -> setPlan clears the latch
    SessionState.setPlan("gate-s1", PlanController.buildPlanFromInput("gate-s1", { goal: "g", steps: [{ title: "fix", status: "active" }] }))
    expect(decideAt("gate-s1", "edit", "high").decision).toBe("allow")
  })

  test("general (lightweight) mode: stale plan only warns, never blocks", () => {
    SessionState.getOrCreate("gate-s2", "general")
    SessionState.markPlanStale("gate-s2", "user_appended")
    expect(decideAt("gate-s2", "edit", "general").decision).toBe("warn")
  })

  test("escape hatch: after too many replans the gate stops blocking (routes to human elsewhere)", () => {
    SessionState.getOrCreate("gate-s3", "high")
    // exhaust the replan budget: each setPlan bumps replan_count
    for (let i = 0; i <= PlanController.DEFAULT_REPLAN_LIMIT; i++) {
      SessionState.markPlanStale("gate-s3", "no_progress")
      SessionState.setPlan("gate-s3", PlanController.buildPlanFromInput("gate-s3", { goal: "g", steps: [{ title: "t", status: "active" }] }))
    }
    // now mark stale once more; replan_count already exceeds the limit
    SessionState.markPlanStale("gate-s3", "no_progress")
    expect(PlanController.shouldEscapeToHuman(SessionState.planLatch("gate-s3")!)).toBe(true)
    // gate no longer blocks (escape hatch) — the macro-round stop gate routes to needs_human instead
    expect(decideAt("gate-s3", "edit", "high").decision).toBe("allow")
  })
})
