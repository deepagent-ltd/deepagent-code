import { describe, expect, test } from "bun:test"
import {
  initialPlanLatch,
  markStale,
  clearStale,
  shouldEscapeToHuman,
  isLightweightMode,
  isMutatingTool,
  createPlanDoc,
  planScope,
  DEFAULT_REPLAN_LIMIT,
} from "../../src/deepagent/plan-controller"
import { planGate, stopHookGate, HookPolicy } from "../../src/deepagent/hooks"

// U1 PlanController unit coverage. These assert the PURE state machine + gate decisions; the live-
// loop wiring (markPlanStale from five signals, stop-gate plan condition) is covered by integration
// tests against the production entrypoint (S1 §验收).

describe("plan latch state machine", () => {
  test("starts fresh with no reason and zero replans", () => {
    const s = initialPlanLatch()
    expect(s.latch).toBe("fresh")
    expect(s.stale_reason).toBeNull()
    expect(s.replan_count).toBe(0)
  })

  test("markStale flips to stale and records the reason", () => {
    const s = markStale(initialPlanLatch(), "validation_failed")
    expect(s.latch).toBe("stale")
    expect(s.stale_reason).toBe("validation_failed")
  })

  test("markStale is idempotent on the same reason (no churn)", () => {
    const a = markStale(initialPlanLatch(), "no_progress")
    const b = markStale(a, "no_progress")
    expect(b).toBe(a) // same reference -> caller skips persistence
  })

  test("a new reason overrides the previous one", () => {
    const a = markStale(initialPlanLatch(), "no_progress")
    const b = markStale(a, "user_appended")
    expect(b.stale_reason).toBe("user_appended")
  })

  test("clearStale returns to fresh and bumps replan_count", () => {
    const stale = markStale(initialPlanLatch(), "tool_failed")
    const cleared = clearStale(stale)
    expect(cleared.latch).toBe("fresh")
    expect(cleared.stale_reason).toBeNull()
    expect(cleared.replan_count).toBe(1)
  })

  test("clearStale on an already-fresh latch is a no-op (no spurious replan bump)", () => {
    const fresh = initialPlanLatch()
    expect(clearStale(fresh)).toBe(fresh)
  })

  test("escape hatch fires only after exceeding the replan limit", () => {
    let s = initialPlanLatch()
    for (let i = 0; i <= DEFAULT_REPLAN_LIMIT; i++) {
      s = clearStale(markStale(s, "no_progress"))
    }
    // replan_count is now DEFAULT_REPLAN_LIMIT + 1
    expect(s.replan_count).toBe(DEFAULT_REPLAN_LIMIT + 1)
    expect(shouldEscapeToHuman(s)).toBe(true)
  })

  test("escape hatch does not fire at or below the limit", () => {
    const s = { ...initialPlanLatch(), replan_count: DEFAULT_REPLAN_LIMIT }
    expect(shouldEscapeToHuman(s)).toBe(false)
  })
})

describe("tool classification", () => {
  test("write/edit/patch/bash are mutating", () => {
    for (const t of ["write", "edit", "patch", "apply_patch", "multiedit", "bash", "shell"]) {
      expect(isMutatingTool(t)).toBe(true)
    }
  })

  test("read/search/todowrite/task are never mutating (must pass even when stale)", () => {
    for (const t of ["read", "grep", "glob", "list", "search", "todowrite", "task", "webfetch"]) {
      expect(isMutatingTool(t)).toBe(false)
    }
  })

  test("classification is case-insensitive", () => {
    expect(isMutatingTool("Write")).toBe(true)
    expect(isMutatingTool("READ")).toBe(false)
  })
})

describe("lightweight mode", () => {
  test("general and direct are lightweight; high+ are not", () => {
    expect(isLightweightMode("general")).toBe(true)
    expect(isLightweightMode("direct")).toBe(true)
    expect(isLightweightMode("high")).toBe(false)
    expect(isLightweightMode("xhigh")).toBe(false)
    expect(isLightweightMode("max")).toBe(false)
    expect(isLightweightMode("ultra")).toBe(false)
  })
})

describe("planGate (before_tool_use soft gate)", () => {
  const gate = planGate()

  test("ignores non-tool events", () => {
    expect(gate({ name: "stop", payload: {} }).decision).toBe("continue")
  })

  test("allows everything when the plan is fresh", () => {
    expect(gate({ name: "before_tool_use", payload: { planStale: false, isMutating: true } }).decision).toBe("allow")
  })

  test("allows read/diagnosis tools even when stale", () => {
    expect(gate({ name: "before_tool_use", payload: { planStale: true, isMutating: false } }).decision).toBe("allow")
  })

  test("blocks mutating tools when stale in high+ mode", () => {
    const d = gate({ name: "before_tool_use", payload: { planStale: true, isMutating: true, lightweight: false } })
    expect(d.decision).toBe("block")
    expect(d.blockReason).toContain("stale")
  })

  test("only warns (never blocks) in lightweight mode", () => {
    const d = gate({ name: "before_tool_use", payload: { planStale: true, isMutating: true, lightweight: true } })
    expect(d.decision).toBe("warn")
  })
})

describe("stopHookGate (plan condition added by U1)", () => {
  const gate = stopHookGate()

  test("blocks finalize when the plan is stale", () => {
    const d = gate({ name: "stop", payload: { requiredValidationsRun: true, planStale: true } })
    expect(d.decision).toBe("block")
    expect(d.blockReason).toContain("plan is stale")
  })

  test("plan-stale block dominates even if validations ran", () => {
    const policy = new HookPolicy().on("stop", gate)
    const d = policy.evaluate({ name: "stop", payload: { requiredValidationsRun: true, planStale: true } })
    expect(d.decision).toBe("block")
  })

  test("allows finalize when fresh and validations ran", () => {
    expect(gate({ name: "stop", payload: { requiredValidationsRun: true, planStale: false } }).decision).toBe("allow")
  })

  test("still blocks on missing validations (pre-existing behavior preserved)", () => {
    expect(gate({ name: "stop", payload: { requiredValidationsRun: false, planStale: false } }).decision).toBe("block")
  })
})

describe("plan doc scaffold", () => {
  test("createPlanDoc derives active_step_id from an active step", () => {
    const doc = createPlanDoc("sess1", "ship feature", [
      { step_id: "s1", title: "design", status: "done" },
      { step_id: "s2", title: "build", status: "active" },
    ])
    expect(doc.active_step_id).toBe("s2")
    expect(doc.session_id).toBe("sess1")
    expect(doc.plan_id).toMatch(/^plan_/)
  })

  test("active_step_id is null when no step is active (P0 coarse-grained)", () => {
    const doc = createPlanDoc("sess1", "goal", [{ step_id: "s1", title: "t", status: "pending" }])
    expect(doc.active_step_id).toBeNull()
  })

  test("planScope reuses the run scope", () => {
    expect(planScope("abc")).toBe("run:abc")
  })
})
