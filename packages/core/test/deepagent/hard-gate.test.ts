import { describe, expect, test } from "bun:test"
import * as PlanController from "../../src/deepagent/plan-controller"
import { planGate, stopHookGate } from "../../src/deepagent/hooks"

// U9 hard gate (S1 §P2): per-step binding + completion_report, high+ ONLY. general/direct never see
// it. Binding miss: high warns, xhigh/max block. Pure decision coverage (the tools.ts wiring reads
// these same helpers).

describe("hard gate enablement by mode", () => {
  test("lightweight modes never enable the hard gate", () => {
    expect(PlanController.hardGateEnabled("general")).toBe(false)
    expect(PlanController.isLightweightMode("general")).toBe(true)
    expect(PlanController.isLightweightMode("direct")).toBe(true)
  })
  test("high enables a lenient hard gate; xhigh/max/ultra are strict", () => {
    expect(PlanController.hardGateEnabled("high")).toBe(true)
    expect(PlanController.hardGateStrict("high")).toBe(false)
    expect(PlanController.hardGateStrict("xhigh")).toBe(true)
    expect(PlanController.hardGateStrict("max")).toBe(true)
    expect(PlanController.hardGateStrict("ultra")).toBe(true)
  })
})

describe("per-step binding via planGate (fresh plan, mutating tool)", () => {
  const gate = planGate()
  const payload = (over: Record<string, unknown>) => ({ planStale: false, isMutating: true, lightweight: false, ...over })

  test("high warns when no active step is bound (auto-replan path)", () => {
    const d = gate({ name: "before_tool_use", payload: payload({ hardGate: true, hasActiveStep: false, hardGateMissBlocks: false }) })
    expect(d.decision).toBe("warn")
  })
  test("xhigh/max block when no active step is bound", () => {
    const d = gate({ name: "before_tool_use", payload: payload({ hardGate: true, hasActiveStep: false, hardGateMissBlocks: true }) })
    expect(d.decision).toBe("block")
  })
  test("an active step allows the edit", () => {
    const d = gate({ name: "before_tool_use", payload: payload({ hardGate: true, hasActiveStep: true, hardGateMissBlocks: true }) })
    expect(d.decision).toBe("allow")
  })
  test("non-mutating tools are never bound-checked", () => {
    const d = gate({ name: "before_tool_use", payload: payload({ isMutating: false, hardGate: true, hasActiveStep: false, hardGateMissBlocks: true }) })
    expect(d.decision).toBe("allow")
  })
})

describe("hasActiveStep / stepCanComplete", () => {
  const plan = (activeStepId: string | null): PlanController.PlanDoc => ({
    plan_id: "p", session_id: "s", goal: "g", assumptions: [],
    steps: [{ step_id: "s1", title: "t", status: activeStepId ? "active" : "pending" }],
    active_step_id: activeStepId, created_at: "2026-01-01T00:00:00.000Z",
  })
  test("hasActiveStep reflects active_step_id", () => {
    expect(PlanController.hasActiveStep(plan("s1"))).toBe(true)
    expect(PlanController.hasActiveStep(plan(null))).toBe(false)
    expect(PlanController.hasActiveStep(null)).toBe(false)
  })
  test("a step with no acceptance can always complete; with acceptance it needs a passing validation", () => {
    expect(PlanController.stepCanComplete({ step_id: "s", title: "t", status: "active" }, false)).toBe(true)
    expect(PlanController.stepCanComplete({ step_id: "s", title: "t", status: "active", acceptance: "tests pass" }, false)).toBe(false)
    expect(PlanController.stepCanComplete({ step_id: "s", title: "t", status: "active", acceptance: "tests pass" }, true)).toBe(true)
  })
})

describe("completion_report + stop gate (high+)", () => {
  const stop = stopHookGate()
  const plan: PlanController.PlanDoc = {
    plan_id: "p", session_id: "s", goal: "ship", assumptions: [],
    steps: [
      { step_id: "s1", title: "build", status: "done", evidence: ["run:1"] },
      { step_id: "s2", title: "polish", status: "cancelled" },
      { step_id: "s3", title: "docs", status: "pending" },
    ],
    active_step_id: null, created_at: "2026-01-01T00:00:00.000Z",
  }

  test("buildCompletionReport summarizes done/cancelled/outstanding + evidence", () => {
    const r = PlanController.buildCompletionReport(plan)
    expect(r.done).toEqual(["build"])
    expect(r.cancelled).toEqual(["polish"])
    expect(r.outstanding).toEqual(["docs"])
    expect(r.evidence).toEqual(["run:1"])
    expect(r.complete).toBe(false) // docs still outstanding
  })

  test("high+ finalize is blocked without a completion report (when a plan exists)", () => {
    const d = stop({ name: "stop", payload: { requiredValidationsRun: true, planStale: false, hardGate: true, planExists: true, hasCompletionReport: false } })
    expect(d.decision).toBe("block")
    expect(d.blockReason).toContain("completion report")
  })
  test("high+ finalize allowed once a completion report exists", () => {
    const d = stop({ name: "stop", payload: { requiredValidationsRun: true, planStale: false, hardGate: true, planExists: true, hasCompletionReport: true } })
    expect(d.decision).toBe("allow")
  })
  test("high+ run that never made a plan is not retroactively forced to report", () => {
    const d = stop({ name: "stop", payload: { requiredValidationsRun: true, planStale: false, hardGate: true, planExists: false } })
    expect(d.decision).toBe("allow")
  })
  test("general (no hard gate) finalize never needs a completion report", () => {
    const d = stop({ name: "stop", payload: { requiredValidationsRun: true, planStale: false, hardGate: false } })
    expect(d.decision).toBe("allow")
  })
})
