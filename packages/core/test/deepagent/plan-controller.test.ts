import { describe, expect, test } from "bun:test"
import {
  initialPlanLatch,
  markStale,
  clearStale,
  shouldEscapeToHuman,
  isLightweightMode,
  isMutatingTool,
  createPlanDoc,
  buildPlanFromInput,
  planProgress,
  planScope,
  DEFAULT_REPLAN_LIMIT,
  buildCompletionReport,
  hasBlockedSteps,
  diffStepStatuses,
  planStatusesChanged,
  formatStepChange,
  renderPlanSnapshot,
  shouldNudgeReport,
  nudgeTrigger,
  nudgeMutationThreshold,
  attachEvidenceToNewlyDone,
  NUDGE_MUTATION_THRESHOLD,
  NUDGE_MUTATION_STRICT,
  NUDGE_MUTATION_LENIENT,
  PROGRESS_NUDGE,
  type PlanDoc,
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

  test("read/search/plan/task are never mutating (must pass even when stale)", () => {
    for (const t of ["read", "grep", "glob", "list", "search", "plan", "task", "webfetch"]) {
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

  // DESIGN (aligned with codex exec_policy): a stale plan ledger NEVER denies tool execution — it
  // WARNS (tool runs, reminder attached) so the model is nudged to re-sync without being deadlocked.
  // This holds in every mode, including high+ (the old code hard-blocked here, which caused the
  // production deadlock). The only remaining hard block is the U9 per-step binding gate, covered below.
  test("warns (never blocks) on a mutating tool when stale in high+ mode", () => {
    const d = gate({ name: "before_tool_use", payload: { planStale: true, isMutating: true, lightweight: false } })
    expect(d.decision).toBe("warn")
    expect(d.blockReason).toContain("stale")
  })

  test("warns (never blocks) in lightweight mode too", () => {
    const d = gate({ name: "before_tool_use", payload: { planStale: true, isMutating: true, lightweight: true } })
    expect(d.decision).toBe("warn")
  })

  // U9 per-step binding remains a hard block (strict hard modes) but gains a runtime grace release so
  // it can never permanently deadlock a model that fails to mark a step active.
  test("U9 binding: strict hard mode blocks a mutating tool with no active step", () => {
    const d = gate({
      name: "before_tool_use",
      payload: { planStale: false, isMutating: true, lightweight: false, hardGate: true, hasActiveStep: false, hardGateMissBlocks: true },
    })
    expect(d.decision).toBe("block")
  })

  test("U9 binding: grace release downgrades the strict block to a warn", () => {
    const d = gate({
      name: "before_tool_use",
      payload: { planStale: false, isMutating: true, lightweight: false, hardGate: true, hasActiveStep: false, hardGateMissBlocks: true, graceRelease: true },
    })
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

  test("buildPlanFromInput accepts todo status vocabulary", () => {
    const doc = buildPlanFromInput("sess1", {
      goal: "finish docs",
      steps: [
        { title: "write", status: "completed" },
        { title: "review", status: "in_progress" },
      ],
    })

    expect(doc.steps.map((step) => step.status)).toEqual(["done", "active"])
    expect(doc.active_step_id).toBe("step_2")
    expect(planProgress(doc)).toEqual({ done: 1, total: 2 })
  })

  test("buildPlanFromInput accepts blocked + skipped/stuck aliases and carries note", () => {
    const doc = buildPlanFromInput("sess1", {
      goal: "ship",
      steps: [
        { title: "a", status: "blocked", note: "waiting on API key" },
        { title: "b", status: "skipped" },
        { title: "c", status: "stuck" },
      ],
    })
    expect(doc.steps.map((s) => s.status)).toEqual(["blocked", "cancelled", "blocked"])
    expect(doc.steps[0].note).toBe("waiting on API key")
  })
})

// U10 step-reporting -----------------------------------------------------------------------------
const mkPlan = (steps: PlanDoc["steps"], activeId: string | null = null): PlanDoc => ({
  plan_id: "p1",
  session_id: "s1",
  goal: "ship the feature",
  assumptions: [],
  steps,
  active_step_id: activeId,
  created_at: "2026-01-01T00:00:00.000Z",
})

describe("blocked status + completion report", () => {
  test("blocked step is resolved (not outstanding) but reported with its note", () => {
    const plan = mkPlan([
      { step_id: "s1", title: "build", status: "done" },
      { step_id: "s2", title: "deploy", status: "blocked", note: "no prod creds" },
    ])
    const r = buildCompletionReport(plan)
    expect(r.outstanding).toEqual([]) // blocked does NOT keep the plan incomplete
    expect(r.complete).toBe(true) // so finalize is not deadlocked
    expect(r.blocked).toEqual(["deploy (no prod creds)"])
  })

  test("pending/active still block completion", () => {
    const plan = mkPlan([
      { step_id: "s1", title: "build", status: "active" },
      { step_id: "s2", title: "docs", status: "pending" },
    ])
    expect(buildCompletionReport(plan).complete).toBe(false)
  })

  test("hasBlockedSteps reflects any blocked step", () => {
    expect(hasBlockedSteps(mkPlan([{ step_id: "s1", title: "t", status: "done" }]))).toBe(false)
    expect(hasBlockedSteps(mkPlan([{ step_id: "s1", title: "t", status: "blocked" }]))).toBe(true)
    expect(hasBlockedSteps(null)).toBe(false)
  })
})

describe("status diff (runtime-computed, not model prose)", () => {
  const prev = mkPlan([
    { step_id: "s1", title: "build", status: "active" },
    { step_id: "s2", title: "docs", status: "pending" },
  ])

  test("reports only steps whose status changed", () => {
    const next = mkPlan([
      { step_id: "s1", title: "build", status: "done" },
      { step_id: "s2", title: "docs", status: "pending" },
    ])
    const changes = diffStepStatuses(prev, next)
    expect(changes).toHaveLength(1)
    expect(formatStepChange(changes[0])).toBe("build: active→done")
    expect(planStatusesChanged(prev, next)).toBe(true)
  })

  test("a newly added step is reported with no `from`", () => {
    const next = mkPlan([
      { step_id: "s1", title: "build", status: "active" },
      { step_id: "s2", title: "docs", status: "pending" },
      { step_id: "s3", title: "release", status: "pending" },
    ])
    const changes = diffStepStatuses(prev, next)
    expect(changes).toHaveLength(1)
    expect(formatStepChange(changes[0])).toBe("release: →pending")
  })

  test("a no-op re-write reports no change (nudge must not be silenced)", () => {
    expect(diffStepStatuses(prev, prev)).toEqual([])
    expect(planStatusesChanged(prev, prev)).toBe(false)
  })

  test("null previous treats every step as new", () => {
    expect(planStatusesChanged(null, prev)).toBe(true)
    expect(diffStepStatuses(null, prev)).toHaveLength(2)
  })
})

describe("plan snapshot render", () => {
  test("compact one-line-per-step with progress header and active line", () => {
    const plan = mkPlan(
      [
        { step_id: "s1", title: "build", status: "done" },
        { step_id: "s2", title: "test", status: "active" },
        { step_id: "s3", title: "deploy", status: "blocked", note: "creds" },
        { step_id: "s4", title: "docs", status: "pending" },
      ],
      "s2",
    )
    const out = renderPlanSnapshot(plan)
    expect(out).toContain("Current plan (1/4 done)")
    expect(out).toContain("[x] build")
    expect(out).toContain("[>] test")
    expect(out).toContain("[!] deploy")
    expect(out).toContain("[ ] docs")
    expect(out).toContain("Active step: test")
  })
})

describe("progress nudge (hybrid: semantic primary + mode-scaled count backstop)", () => {
  const plan = mkPlan([
    { step_id: "s1", title: "build", status: "active" },
    { step_id: "s2", title: "docs", status: "pending" },
  ])
  const donePlan = mkPlan([{ step_id: "s1", title: "build", status: "done" }])

  test("mode-scaled backstop: xhigh/max strict (4), high lenient (6)", () => {
    expect(nudgeMutationThreshold("max")).toBe(NUDGE_MUTATION_STRICT)
    expect(nudgeMutationThreshold("xhigh")).toBe(NUDGE_MUTATION_STRICT)
    expect(nudgeMutationThreshold("ultra")).toBe(NUDGE_MUTATION_STRICT)
    expect(nudgeMutationThreshold("high")).toBe(NUDGE_MUTATION_LENIENT)
  })

  test("count backstop fires at the mode-scaled threshold", () => {
    const under = { mutationsSinceReport: 3, validationPassedSinceReport: false, mode: "max" as const }
    const at = { mutationsSinceReport: 4, validationPassedSinceReport: false, mode: "max" as const }
    expect(nudgeTrigger(plan, under)).toBeNull()
    expect(nudgeTrigger(plan, at)).toBe("mutation_backstop")
    // high is more lenient: 4 is not enough, 6 is
    expect(nudgeTrigger(plan, { mutationsSinceReport: 4, validationPassedSinceReport: false, mode: "high" })).toBeNull()
    expect(nudgeTrigger(plan, { mutationsSinceReport: 6, validationPassedSinceReport: false, mode: "high" })).toBe(
      "mutation_backstop",
    )
  })

  test("SEMANTIC primary: a fresh validation pass + >=1 edit fires well before the count backstop", () => {
    const t = nudgeTrigger(plan, { mutationsSinceReport: 1, validationPassedSinceReport: true, mode: "max" })
    expect(t).toBe("validation_passed")
  })

  test("validation pass with ZERO edits since last report does NOT nudge (nothing new happened)", () => {
    const t = nudgeTrigger(plan, { mutationsSinceReport: 0, validationPassedSinceReport: true, mode: "max" })
    expect(t).toBeNull()
  })

  test("never nudges when nothing is outstanding, regardless of trigger", () => {
    expect(nudgeTrigger(donePlan, { mutationsSinceReport: 99, validationPassedSinceReport: true, mode: "max" })).toBeNull()
  })

  test("never nudges without a plan", () => {
    expect(nudgeTrigger(null, { mutationsSinceReport: 99, validationPassedSinceReport: true, mode: "max" })).toBeNull()
  })

  test("PROGRESS_NUDGE phrasing reflects the trigger", () => {
    expect(PROGRESS_NUDGE("validation_passed", 2)).toContain("validation just passed")
    expect(PROGRESS_NUDGE("mutation_backstop", 5)).toContain("without updating your plan")
  })

  test("back-compat shouldNudgeReport wrapper still works", () => {
    expect(shouldNudgeReport(plan, NUDGE_MUTATION_THRESHOLD - 1)).toBe(false)
    expect(shouldNudgeReport(plan, NUDGE_MUTATION_THRESHOLD)).toBe(true)
    expect(shouldNudgeReport(plan, 1, { validationPassedSinceReport: true })).toBe(true)
    expect(shouldNudgeReport(donePlan, 99)).toBe(false)
    expect(shouldNudgeReport(null, 99)).toBe(false)
  })
})

describe("evidence attachment (runtime supplies proof for newly-done steps)", () => {
  const prev = mkPlan([
    { step_id: "s1", title: "build", status: "active" },
    { step_id: "s2", title: "docs", status: "pending" },
  ])
  test("attaches the validation summary only to a step that just moved to done", () => {
    const next = mkPlan([
      { step_id: "s1", title: "build", status: "done" },
      { step_id: "s2", title: "docs", status: "pending" },
    ])
    const withEvidence = attachEvidenceToNewlyDone(prev, next, "validation 2/2 passed: tsc✓, test✓")
    expect(withEvidence.steps[0].evidence).toEqual(["validation 2/2 passed: tsc✓, test✓"])
    expect(withEvidence.steps[1].evidence ?? []).toEqual([]) // not done -> no evidence attached
  })
  test("no summary -> plan unchanged", () => {
    const next = mkPlan([{ step_id: "s1", title: "build", status: "done" }])
    expect(attachEvidenceToNewlyDone(prev, next, null)).toBe(next)
  })
  test("a step already done keeps its prior evidence (no duplicate)", () => {
    const prevDone = mkPlan([{ step_id: "s1", title: "build", status: "done", evidence: ["run:1"] }])
    const nextDone = mkPlan([{ step_id: "s1", title: "build", status: "done", evidence: ["run:1"] }])
    const out = attachEvidenceToNewlyDone(prevDone, nextDone, "new summary")
    expect(out.steps[0].evidence).toEqual(["run:1"])
  })
})
