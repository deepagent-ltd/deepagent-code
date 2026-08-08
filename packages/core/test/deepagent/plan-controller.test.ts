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
  buildPlanFromWriteInput,
  decodePlanWriteInput,
  PlanConflictError,
  PlanValidationError,
  planWriteCandidateHash,
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
  // WARNS while the tool runs; dispatch records it outside model-visible tool output.
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

  // U9 per-step binding is now WARN-ONLY (deadlock fix): plan discipline never blocks a tool at the
  // call site — it is a nudge here and is enforced only at finalization (stopHookGate). The binding
  // nudge fires only when a plan actually EXISTS (planExists guard); a run with no plan is not nagged.
  test("U9 binding: warns (never blocks) when a plan exists with no active step", () => {
    const d = gate({
      name: "before_tool_use",
      payload: { planStale: false, isMutating: true, lightweight: false, hardGate: true, planExists: true, hasActiveStep: false },
    })
    expect(d.decision).toBe("warn")
  })

  test("U9 binding: a run with NO plan is not nagged (planExists guard)", () => {
    const d = gate({
      name: "before_tool_use",
      payload: { planStale: false, isMutating: true, lightweight: false, hardGate: true, planExists: false, hasActiveStep: false },
    })
    expect(d.decision).toBe("allow")
  })

  test("U9 binding: never returns block under any interleaving", () => {
    for (const planExists of [true, false]) {
      for (const hasActiveStep of [true, false]) {
        const d = gate({
          name: "before_tool_use",
          payload: { planStale: false, isMutating: true, lightweight: false, hardGate: true, planExists, hasActiveStep },
        })
        expect(d.decision).not.toBe("block")
      }
    }
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

describe("strict plan write admission", () => {
  const input = (overrides: Partial<Parameters<typeof buildPlanFromWriteInput>[1]> = {}) => ({
    operation: "create" as const,
    expected_plan_id: null,
    expected_version: null,
    goal: "ship a reliable change",
    steps: [
      { step_id: "s1", title: "implement", status: "active" as const, acceptance: "tests pass" },
      { step_id: "s2", title: "verify", status: "pending" as const, acceptance: "review complete" },
    ],
    active_step_id: "s1",
    ...overrides,
  })

  test("admits create and normalizes the explicit status vocabulary", () => {
    const plan = buildPlanFromWriteInput("s1", input(), null, null)
    expect(plan.steps.map((step) => step.status)).toEqual(["active", "pending"])
    expect(plan.active_step_id).toBe("s1")
  })

  test("decodes untrusted plan writes and hashes normalized semantics without leaking content", () => {
    const value = input({
      goal: "  ship a reliable change  ",
      steps: [
        { title: "  implement  ", status: "ACTIVE", acceptance: " tests pass " },
        { title: "verify", status: "pending" },
      ],
      active_step_id: null,
    })
    const decoded = decodePlanWriteInput(value)
    expect(decoded).not.toBeNull()
    expect(decodePlanWriteInput({ ...value, expected_version: 1.5 })).toBeNull()
    expect(decodePlanWriteInput({ ...value, steps: [{ title: "x", status: 4 }] })).toBeNull()
    const hash = planWriteCandidateHash(decoded!)
    expect(hash).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(hash).not.toContain("ship a reliable change")
    expect(hash).toBe(planWriteCandidateHash({ ...decoded!, goal: "ship a reliable change" }))
  })

  test("quality challenge uses a stable candidate hash and a fresh challenge id", () => {
    const previous = buildPlanFromWriteInput("s1", input(), null, null)
    const candidate = input({
      operation: "replan",
      expected_plan_id: previous.plan_id,
      expected_version: 1,
      replan_reason: "replace unresolved work",
      steps: [{ title: "do it", status: "pending" }],
      active_step_id: null,
    })
    const capture = () => {
      try {
        buildPlanFromWriteInput(
          "s1",
          candidate,
          previous,
          { plan_id: previous.plan_id, doc_id: "doc:plan:s1", version: 1 },
        )
        throw new Error("candidate unexpectedly admitted")
      } catch (error) {
        expect(error).toBeInstanceOf(PlanValidationError)
        return error as PlanValidationError
      }
    }
    const first = capture()
    const second = capture()
    expect(first.candidate_hash).toBe(planWriteCandidateHash(candidate))
    expect(second.candidate_hash).toBe(first.candidate_hash)
    expect(second.challenge_id).not.toBe(first.challenge_id)
  })

  test("rejects malformed steps before any store write", () => {
    expect(() =>
      buildPlanFromWriteInput(
        "s1",
        input({ steps: [{ step_id: "s1", title: "", status: "active" }], active_step_id: "s1" }),
        null,
        null,
      ),
    ).toThrow("empty_title")
    expect(() =>
      buildPlanFromWriteInput(
        "s1",
        input({ steps: [{ step_id: "s1", title: "implement", status: "sideways" as never }], active_step_id: "s1" }),
        null,
        null,
      ),
    ).toThrow("invalid_status")
  })

  test("requires exact identity and version for advance", () => {
    const previous = buildPlanFromWriteInput("s1", input(), null, null)
    const ref = { plan_id: previous.plan_id, doc_id: "doc:plan:s1", version: 1 }
    expect(() =>
      buildPlanFromWriteInput(
        "s1",
        input({ operation: "advance", expected_plan_id: previous.plan_id, expected_version: 0 }),
        previous,
        ref,
      ),
    ).toThrow(PlanConflictError)
    expect(() =>
      buildPlanFromWriteInput(
        "s1",
        input({ operation: "advance", expected_plan_id: previous.plan_id, expected_version: 1, steps: [{ title: "implement", status: "done" }] }),
        previous,
        ref,
      ),
    ).toThrow(PlanValidationError)
  })

  test("advance preserves ordered step identity and immutable goal contracts", () => {
    const previous = buildPlanFromWriteInput("s1", input(), null, null)
    const ref = { plan_id: previous.plan_id, doc_id: "doc:plan:s1", version: 1 }
    expect(() =>
      buildPlanFromWriteInput(
        "s1",
        input({
          operation: "advance",
          expected_plan_id: previous.plan_id,
          expected_version: 1,
          goal: "a different goal",
          steps: [
            { step_id: "s2", title: "verify", status: "active", acceptance: "review complete" },
            { step_id: "s1", title: "implement", status: "done", acceptance: "tests pass" },
          ],
          active_step_id: "s2",
        }),
        previous,
        ref,
      ),
    ).toThrow("unsafe_step_identity")
  })

  test("quality challenge rejects a replan that drops unresolved work", () => {
    const previous = buildPlanFromWriteInput("s1", input(), null, null)
    const ref = { plan_id: previous.plan_id, doc_id: "doc:plan:s1", version: 1 }
    expect(() =>
      buildPlanFromWriteInput(
        "s1",
        input({
          operation: "replan",
          expected_plan_id: previous.plan_id,
          expected_version: 1,
          replan_reason: "provider correction",
          steps: [{ step_id: "new", title: "do it", status: "active" }],
          active_step_id: "new",
        }),
        previous,
        ref,
      ),
    ).toThrow("suspicious_quality_regression")
  })

  test("quality oracle covers A/B/C, equality boundaries, and Unicode code points", () => {
    const write = (
      previous: PlanDoc,
      steps: Parameters<typeof buildPlanFromWriteInput>[1]["steps"],
      activeStepId: string | null,
    ) =>
      buildPlanFromWriteInput(
        "s1",
        {
          operation: "replan",
          expected_plan_id: previous.plan_id,
          expected_version: 1,
          replan_reason: "intentional test replan",
          goal: previous.goal,
          assumptions: previous.assumptions,
          steps,
          active_step_id: activeStepId,
        },
        previous,
        { plan_id: previous.plan_id, doc_id: "doc:plan:s1", version: 1 },
      )

    const aPrevious = buildPlanFromWriteInput(
      "s1",
      input({
        steps: [
          { step_id: "a1", title: "abcdefghij", status: "active" },
          { step_id: "a2", title: "abcdefghij", status: "pending" },
          { step_id: "a3", title: "abcdefghij", status: "pending" },
          { step_id: "a4", title: "abcdefghij", status: "pending" },
        ],
        active_step_id: "a1",
      }),
      null,
      null,
    )
    expect(() =>
      write(
        aPrevious,
        [
          { step_id: "a1", title: "abcdefghij", status: "active" },
          { step_id: "a2", title: "abcdefghij", status: "pending" },
        ],
        "a1",
      ),
    ).not.toThrow()
    expect(() =>
      write(
        aPrevious,
        [
          { step_id: "new-a1", title: "abcdefghij", status: "active" },
          { step_id: "new-a2", title: "abcdefghi", status: "pending" },
        ],
        "new-a1",
      ),
    ).toThrow("suspicious_quality_regression")

    const bPrevious = buildPlanFromWriteInput(
      "s1",
      input({
        steps: [
          { step_id: "b1", title: "first accepted work item", status: "active", acceptance: "first proof" },
          { step_id: "b2", title: "second accepted work item", status: "pending", acceptance: "second proof" },
        ],
        active_step_id: "b1",
      }),
      null,
      null,
    )
    expect(() =>
      write(
        bPrevious,
        [
          { step_id: "new-b1", title: "replacement work item one", status: "active" },
          { step_id: "new-b2", title: "replacement work item two", status: "pending" },
        ],
        "new-b1",
      ),
    ).toThrow("suspicious_quality_regression")
    expect(() =>
      write(
        bPrevious,
        [
          { step_id: "new-b1", title: "replacement work item one", status: "active", acceptance: "new proof one" },
          { step_id: "new-b2", title: "replacement work item two", status: "pending", acceptance: "new proof two" },
        ],
        "new-b1",
      ),
    ).not.toThrow()

    const cPrevious = buildPlanFromWriteInput(
      "s1",
      input({
        steps: [
          { step_id: "c1", title: "first unresolved work", status: "active" },
          { step_id: "c2", title: "second unresolved work", status: "pending" },
        ],
        active_step_id: "c1",
      }),
      null,
      null,
    )
    expect(() =>
      write(
        cPrevious,
        [
          { step_id: "new-c1", title: "one", status: "active" },
          { step_id: "new-c2", title: "two", status: "pending" },
        ],
        "new-c1",
      ),
    ).toThrow("suspicious_quality_regression")

    const unicodePrevious = buildPlanFromWriteInput(
      "s1",
      input({
        steps: [
          { step_id: "u1", title: "😀😀", status: "active" },
          { step_id: "u2", title: "😀😀", status: "pending" },
        ],
        active_step_id: "u1",
      }),
      null,
      null,
    )
    expect(() => write(unicodePrevious, [{ step_id: "u1", title: "😀😀", status: "active" }], "u1")).not.toThrow()
  })

  test("deterministic incident fixture rejects all 11 malformed forward-compatible replans", () => {
    const previous = buildPlanFromWriteInput(
      "s1",
      input({
        steps: [
          { step_id: "s1", title: "inspect the repository", status: "done", acceptance: "repository is understood" },
          { step_id: "s2", title: "implement the guarded write path", status: "active", acceptance: "write path is validated" },
          { step_id: "s3", title: "exercise the regression fixture", status: "pending", acceptance: "fixture is deterministic" },
          { step_id: "s4", title: "verify persistence and recovery", status: "pending", acceptance: "recovery is covered" },
          { step_id: "s5", title: "review the final diff", status: "pending", acceptance: "review is complete" },
        ],
        active_step_id: "s2",
      }),
      null,
      null,
    )
    const ref = { plan_id: previous.plan_id, doc_id: "doc:plan:s1", version: 1 }
    const malformed = [
      ["ayContext", "active"],
      ["Context", "pending"],
      ["Context", "active"],
      ["Context", "active"],
      ["", ""],
      ["Context", "active"],
      ["", "active"],
      ["Context", "pending"],
      ["", "active"],
      ["Context", "active"],
      ["Context", "active"],
    ] as const

    for (const [title, status] of malformed) {
      const candidate = {
        operation: "replan" as const,
        expected_plan_id: previous.plan_id,
        expected_version: 1,
        replan_reason: "provider returned a malformed plan payload",
        goal: previous.goal,
        assumptions: previous.assumptions,
        steps: [{ step_id: "s2", title, status: status as "pending" | "active" }],
        active_step_id: status === "active" ? "s2" : null,
      }
      expect(() => buildPlanFromWriteInput("s1", candidate, previous, ref)).toThrow(PlanValidationError)
      try {
        buildPlanFromWriteInput("s1", candidate, previous, ref)
        throw new Error("fixture candidate unexpectedly admitted")
      } catch (error) {
        expect(error).toBeInstanceOf(PlanValidationError)
        expect(["empty_title", "invalid_status", "unsafe_step_identity", "suspicious_quality_regression"]).toContain(
          (error as PlanValidationError).code,
        )
      }
    }
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
    expect(out).toContain("goal:")
    expect(renderPlanSnapshot(plan, "continuation")).not.toContain("goal:")
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
