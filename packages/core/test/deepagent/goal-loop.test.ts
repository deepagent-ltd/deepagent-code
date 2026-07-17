import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { DocumentStore } from "../../src/deepagent/document-store"
import {
  createPlanDoc,
  planScope,
  buildPlanFromInput,
  type PlanDoc,
  type PlanStep,
  type PlanInput,
} from "../../src/deepagent/plan-controller"
import {
  makeGoalLoop,
  readGoalTickCursor,
  persistPendingPlanEdit,
  readPendingPlanEdit,
  evaluateForController,
  budgetNotice,
  InvalidGoalError,
  type ControllerDeps,
  type GraderPorts,
  type StepExecutor,
  type StepExecutorResult,
  type RollbackPort,
  type GoalSpec,
  type BudgetLedger,
  type GoalLimits,
  type CompletionCriterion,
} from "../../src/deepagent/goal-loop"

// A deterministic clock the tests advance manually so wallclock accounting + restart recovery are
// exact (the pure controller never calls Date.now).
class FakeClock {
  private t = 1_000
  now = () => this.t
  advance(ms: number) {
    this.t += ms
  }
}

let root: string
let store: DocumentStore
const SESSION = "s-goal-1"

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "deepagent-goal-"))
  store = new DocumentStore(root)
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

// Persist a PlanDoc as a `type:"plan"`, scope "run:<session>" document (its body is the JSON PlanDoc,
// exactly as the plan tool stores it). Returns the doc id the GoalSpec references.
const putPlan = (steps: PlanStep[], goal = "reach the goal"): string => {
  const plan = createPlanDoc(SESSION, goal, steps)
  const doc = store.upsert({
    type: "plan",
    scope: planScope(SESSION),
    description: `plan ${SESSION}`,
    idSlug: `plan-${SESSION}`,
    body: JSON.stringify(plan),
    provenance: { source: "model", run_ref: planScope(SESSION) },
  })
  return doc.id
}

const updatePlan = (planDocId: string, mut: (p: PlanDoc) => PlanDoc): void => {
  const doc = store.get(planDocId)!
  const plan = JSON.parse(doc.body) as PlanDoc
  store.update(planDocId, JSON.stringify(mut(plan)))
}

const step = (id: string, status: PlanStep["status"], title = id): PlanStep => ({
  step_id: id,
  title,
  status,
  acceptance: null,
  assigned_agent: null,
  evidence: [],
  note: null,
})

// A permissive default port set; individual tests override the criterion under test.
const passingPorts = (): GraderPorts => ({
  runTests: () => Effect.succeed({ pass: true }),
  diagnostics: () => Effect.succeed({ maxSeverity: null }),
  reviewerClean: () => Effect.succeed({ pass: true }),
  panelApproves: () => Effect.succeed({ decision: "approve" }),
})

const noopExecutor: StepExecutor = () => Effect.succeed({ tokensUsed: 10 })
const noopRollback: RollbackPort = () => Effect.void

const deps = (over: Partial<ControllerDeps>, clock: FakeClock): ControllerDeps => ({
  store,
  ports: passingPorts(),
  executor: noopExecutor,
  rollback: noopRollback,
  now: clock.now,
  ...over,
})

const spec = (planDocId: string, over: Partial<GoalSpec> = {}): GoalSpec => ({
  planDocId,
  criteria: [{ kind: "plan_complete" }],
  limits: { maxTicks: 100, maxTokens: 100_000, maxWallclockMs: 100_000 },
  stallThreshold: 3,
  ...over,
})

describe("V3.9 §D — Goal Loop start validation (§D.4/D.6 判据客观性 + 有界性)", () => {
  test("rejects a goal with NO criteria → InvalidGoalError", async () => {
    const clock = new FakeClock()
    const planDocId = putPlan([step("a", "done")])
    const loop = makeGoalLoop(deps({}, clock))
    const err = await Effect.runPromise(loop.start(spec(planDocId, { criteria: [] })).pipe(Effect.flip))
    expect(err).toBeInstanceOf(InvalidGoalError)
    expect(err.reason).toMatch(/no completion criteria/)
  })

  const rejectsLimits = async (limits: { maxTicks: number; maxTokens: number; maxWallclockMs: number }) => {
    const clock = new FakeClock()
    const planDocId = putPlan([step("a", "pending")])
    const loop = makeGoalLoop(deps({}, clock))
    const err = await Effect.runPromise(loop.start(spec(planDocId, { limits })).pipe(Effect.flip))
    expect(err).toBeInstanceOf(InvalidGoalError)
  }
  test("rejects missing/non-positive maxTicks → InvalidGoalError", () =>
    rejectsLimits({ maxTicks: 0, maxTokens: 1, maxWallclockMs: 1 }))
  test("rejects missing/non-positive maxTokens → InvalidGoalError", () =>
    rejectsLimits({ maxTicks: 1, maxTokens: 0, maxWallclockMs: 1 }))
  test("rejects missing/non-positive maxWallclockMs → InvalidGoalError", () =>
    rejectsLimits({ maxTicks: 1, maxTokens: 1, maxWallclockMs: 0 }))

  test("accepts a well-formed goal", async () => {
    const clock = new FakeClock()
    const planDocId = putPlan([step("a", "pending")])
    const loop = makeGoalLoop(deps({}, clock))
    const handle = await Effect.runPromise(loop.start(spec(planDocId)))
    expect(handle.goalId).toMatch(/^goal_/)
    expect(handle.sessionId).toBe(SESSION)
  })
})

describe("V3.9 §D — Grader per-criterion evaluation (§D.3)", () => {
  const donePlan = (): PlanDoc => createPlanDoc(SESSION, "g", [step("a", "done"), step("b", "cancelled")])
  const openPlan = (): PlanDoc => createPlanDoc(SESSION, "g", [step("a", "pending")])

  const criteria: Record<string, CompletionCriterion> = {
    tests_pass: { kind: "tests_pass", commands: ["bun test"] },
    no_diagnostics: { kind: "no_diagnostics" },
    reviewer_clean: { kind: "reviewer_clean", maxSeverity: "high" },
    panel_approves: { kind: "panel_approves" },
    plan_complete: { kind: "plan_complete" },
  }

  test("each criterion met via passing ports → met:true, no gaps", async () => {
    for (const [name, c] of Object.entries(criteria)) {
      const res = await Effect.runPromise(evaluateForController([c], passingPorts(), donePlan()))
      expect(res.result.met).toBe(true)
      expect(res.result.gaps).toEqual([])
      void name
    }
  })

  test("tests_pass unmet → met:false with gap", async () => {
    const ports: GraderPorts = { ...passingPorts(), runTests: () => Effect.succeed({ pass: false }) }
    const res = await Effect.runPromise(evaluateForController([criteria.tests_pass], ports, donePlan()))
    expect(res.result.met).toBe(false)
    expect(res.result.gaps[0]).toMatch(/tests_pass/)
  })

  test("no_diagnostics: any diagnostic is a gap when unbounded; within bound is met", async () => {
    const withDiag: GraderPorts = { ...passingPorts(), diagnostics: () => Effect.succeed({ maxSeverity: "warning" }) }
    const strict = await Effect.runPromise(evaluateForController([{ kind: "no_diagnostics" }], withDiag, donePlan()))
    expect(strict.result.met).toBe(false)
    const bounded = await Effect.runPromise(
      evaluateForController([{ kind: "no_diagnostics", severityAtMost: "warning" }], withDiag, donePlan()),
    )
    expect(bounded.result.met).toBe(true)
    const errDiag: GraderPorts = { ...passingPorts(), diagnostics: () => Effect.succeed({ maxSeverity: "error" }) }
    const exceeded = await Effect.runPromise(
      evaluateForController([{ kind: "no_diagnostics", severityAtMost: "warning" }], errDiag, donePlan()),
    )
    expect(exceeded.result.met).toBe(false)
  })

  test("no_diagnostics: an UNCHECKED result (checked:false) is a gap, NOT a vacuous pass (fail-open fix)", async () => {
    // Regression for the seam bug: the production diagnostics port fell back to { maxSeverity: null } on
    // an LSP crash/timeout, which the grader read as "clean → met". A port that could not actually check
    // now reports checked:false → the grader must treat it as an unmet gap (mirrors runTests empty=fail),
    // so a broken/absent LSP can never vacuously satisfy no_diagnostics.
    const unchecked: GraderPorts = {
      ...passingPorts(),
      diagnostics: () => Effect.succeed({ maxSeverity: null, checked: false }),
    }
    const strict = await Effect.runPromise(evaluateForController([{ kind: "no_diagnostics" }], unchecked, donePlan()))
    expect(strict.result.met).toBe(false)
    // even with a severity bound, unchecked is still a gap (we never verified anything).
    const bounded = await Effect.runPromise(
      evaluateForController([{ kind: "no_diagnostics", severityAtMost: "warning" }], unchecked, donePlan()),
    )
    expect(bounded.result.met).toBe(false)
    // sanity: an explicit checked:true with no diagnostics is still a genuine pass.
    const cleanChecked: GraderPorts = {
      ...passingPorts(),
      diagnostics: () => Effect.succeed({ maxSeverity: null, checked: true }),
    }
    const met = await Effect.runPromise(evaluateForController([{ kind: "no_diagnostics" }], cleanChecked, donePlan()))
    expect(met.result.met).toBe(true)
  })

  test("reviewer_clean / panel_approves unmet → gap", async () => {
    const ports: GraderPorts = {
      ...passingPorts(),
      reviewerClean: () => Effect.succeed({ pass: false }),
      panelApproves: () => Effect.succeed({ decision: "block" }),
    }
    const rev = await Effect.runPromise(evaluateForController([criteria.reviewer_clean], ports, donePlan()))
    expect(rev.result.met).toBe(false)
    const pan = await Effect.runPromise(evaluateForController([criteria.panel_approves], ports, donePlan()))
    expect(pan.result.met).toBe(false)
    expect(pan.result.gaps[0]).toMatch(/block/)
  })

  test("plan_complete reflects outstanding steps", async () => {
    const met = await Effect.runPromise(evaluateForController([criteria.plan_complete], passingPorts(), donePlan()))
    expect(met.result.met).toBe(true)
    const unmet = await Effect.runPromise(evaluateForController([criteria.plan_complete], passingPorts(), openPlan()))
    expect(unmet.result.met).toBe(false)
    expect(unmet.result.gaps[0]).toMatch(/outstanding/)
  })

  test("AND semantics: one unmet among many → met:false", async () => {
    const ports: GraderPorts = { ...passingPorts(), runTests: () => Effect.succeed({ pass: false }) }
    // Cheap-only set so no expensive gate is deferred: the single tests_pass failure is the only gap.
    const cheap = [criteria.plan_complete, criteria.no_diagnostics, criteria.tests_pass]
    const res = await Effect.runPromise(evaluateForController(cheap, ports, donePlan()))
    expect(res.result.met).toBe(false)
    expect(res.result.gaps.length).toBe(1)
  })
})

describe("V3.9 §D — Controller tick semantics", () => {
  test("done: criteria met → done outcome + completion", async () => {
    const clock = new FakeClock()
    const planDocId = putPlan([step("a", "done")])
    const loop = makeGoalLoop(deps({}, clock))
    const handle = await Effect.runPromise(loop.start(spec(planDocId)))
    const outcome = await Effect.runPromise(loop.tick(handle))
    expect(outcome).toBe("done")
    const status = await Effect.runPromise(loop.status(handle))
    expect(status.phase).toBe("done")
    expect(status.ledger.ticks).toBe(1)
    expect(status.ledger.tokens).toBe(10)
  })

  test("continue: not yet met, under limits, progress made", async () => {
    const clock = new FakeClock()
    const planDocId = putPlan([step("a", "pending")])
    // Executor advances a→active (progress + version bump), goal not yet complete.
    const executor: StepExecutor = ({ planDocId }) =>
      Effect.sync(() => {
        updatePlan(planDocId, (p) => ({ ...p, steps: [{ ...p.steps[0], status: "active" }] }))
        return { tokensUsed: 5 }
      })
    const loop = makeGoalLoop(deps({ executor }, clock))
    const handle = await Effect.runPromise(loop.start(spec(planDocId)))
    const outcome = await Effect.runPromise(loop.tick(handle))
    expect(outcome).toBe("continue")
  })

  test("§D.6 幂等: repeated tick at same plan version → no double side-effect", async () => {
    const clock = new FakeClock()
    const planDocId = putPlan([step("a", "pending")])
    let execCount = 0
    // Executor that does NOT change the plan version — so a second tick sees the same version.
    const executor: StepExecutor = () =>
      Effect.sync(() => {
        execCount++
        return { tokensUsed: 7 }
      })
    const loop = makeGoalLoop(deps({ executor }, clock))
    const handle = await Effect.runPromise(loop.start(spec(planDocId)))
    const first = await Effect.runPromise(loop.tick(handle))
    const second = await Effect.runPromise(loop.tick(handle))
    expect(first).toBe(second) // replayed outcome
    expect(execCount).toBe(1) // executor NOT invoked twice
    const status = await Effect.runPromise(loop.status(handle))
    expect(status.ledger.ticks).toBe(1) // budget accumulated once
    expect(status.ledger.tokens).toBe(7)
  })

  test("goal tick cursor stays monotonic when progress follows a stalled tick", async () => {
    const clock = new FakeClock()
    const planDocId = putPlan([step("a", "pending")])
    let executions = 0
    const executor: StepExecutor = ({ planDocId }) =>
      Effect.sync(() => {
        executions++
        updatePlan(planDocId, (plan) =>
          executions === 1
            ? { ...plan, goal: `${plan.goal}.` }
            : {
                ...plan,
                steps: [{ ...plan.steps[0], evidence: [...(plan.steps[0].evidence ?? []), "made progress"] }],
              },
        )
        return { tokensUsed: 1 }
      })
    const loop = makeGoalLoop(deps({ executor }, clock))
    const handle = await Effect.runPromise(loop.start(spec(planDocId)))

    expect(await Effect.runPromise(loop.tick(handle))).toBe("continue")
    const stalled = readGoalTickCursor(store, SESSION, handle.goalId)!
    expect(stalled.seq).toBe(5) // ticks=1, stall=1, threshold=3

    expect(await Effect.runPromise(loop.tick(handle))).toBe("continue")
    const progressed = readGoalTickCursor(store, SESSION, handle.goalId)!
    expect(progressed.seq).toBe(8) // ticks=2, stall reset to 0
    expect(progressed.seq).toBeGreaterThan(stalled.seq)
  })

  test("§D.6 无进展即停: stallThreshold consecutive no-progress ticks → needs_human", async () => {
    const clock = new FakeClock()
    const planDocId = putPlan([step("a", "pending")])
    // Executor bumps the plan version each tick (so dedup never fires) but never changes step status —
    // no progress, no criterion newly met. This must stall, not loop forever.
    const executor: StepExecutor = ({ planDocId }) =>
      Effect.sync(() => {
        updatePlan(planDocId, (p) => ({ ...p, goal: `${p.goal}.` })) // touch → new version, same statuses
        return { tokensUsed: 1 }
      })
    const loop = makeGoalLoop(deps({ executor }, clock))
    const handle = await Effect.runPromise(loop.start(spec(planDocId, { stallThreshold: 3 })))
    const outcomes: string[] = []
    for (let i = 0; i < 3; i++) outcomes.push(await Effect.runPromise(loop.tick(handle)))
    expect(outcomes).toEqual(["continue", "continue", "needs_human"])
    const status = await Effect.runPromise(loop.status(handle))
    expect(status.phase).toBe("needs_human")
  })

  test("§D.6 有界性 (over-limit): exceeding maxTicks → needs_human", async () => {
    const clock = new FakeClock()
    const planDocId = putPlan([step("a", "pending")])
    const executor: StepExecutor = ({ planDocId }) =>
      Effect.sync(() => {
        updatePlan(planDocId, (p) => ({ ...p, steps: [{ ...p.steps[0], title: `${p.steps[0].title}.` }] }))
        return { tokensUsed: 1 }
      })
    // maxTicks 1, stallThreshold high so stall doesn't fire first.
    const loop = makeGoalLoop(deps({ executor }, clock))
    const handle = await Effect.runPromise(
      loop.start(spec(planDocId, { limits: { maxTicks: 1, maxTokens: 1_000, maxWallclockMs: 1_000 }, stallThreshold: 99 })),
    )
    // Tick 1: ticks=1 (== maxTicks, not over). Tick 2: ticks=2 > maxTicks → needs_human.
    expect(await Effect.runPromise(loop.tick(handle))).toBe("continue")
    expect(await Effect.runPromise(loop.tick(handle))).toBe("needs_human")
  })

  test("V4.0.1 P2 §4.3: exceeding maxTokens does NOT halt (token is a compaction line, not a stop line)", async () => {
    // Pre-V4.0.1 this exceeded the token cap and halted at needs_human. Under P2 the token count no longer
    // drives a stop — context pressure is handled by compaction, halting only by wallclock/cost/stall. The
    // tick makes forward progress (title touch is enough here since stall is high), so it must CONTINUE.
    const clock = new FakeClock()
    const planDocId = putPlan([step("a", "pending")])
    const executor: StepExecutor = ({ planDocId }) =>
      Effect.sync(() => {
        updatePlan(planDocId, (p) => ({
          ...p,
          steps: [{ ...p.steps[0], evidence: [...(p.steps[0].evidence ?? []), "progress"] }],
        }))
        return { tokensUsed: 100 }
      })
    const loop = makeGoalLoop(deps({ executor }, clock))
    const handle = await Effect.runPromise(
      loop.start(spec(planDocId, { limits: { maxTicks: 99, maxTokens: 50, maxWallclockMs: 100_000 }, stallThreshold: 99 })),
    )
    expect(await Effect.runPromise(loop.tick(handle))).toBe("continue") // token cap no longer halts
    const status = await Effect.runPromise(loop.status(handle))
    expect(status.ledger.tokens).toBe(100) // ledger past maxTokens=50, yet running
    expect(status.phase).toBe("running")
  })

  test("§D.6 有界性 (over-limit): exceeding maxWallclockMs → needs_human", async () => {
    const clock = new FakeClock()
    const planDocId = putPlan([step("a", "pending")])
    const executor: StepExecutor = ({ planDocId }) =>
      Effect.sync(() => {
        updatePlan(planDocId, (p) => ({ ...p, steps: [{ ...p.steps[0], title: `${p.steps[0].title}.` }] }))
        clock.advance(10_000) // burn wallclock
        return { tokensUsed: 1 }
      })
    const loop = makeGoalLoop(deps({ executor }, clock))
    const handle = await Effect.runPromise(
      loop.start(spec(planDocId, { limits: { maxTicks: 99, maxTokens: 1_000, maxWallclockMs: 5_000 }, stallThreshold: 99 })),
    )
    expect(await Effect.runPromise(loop.tick(handle))).toBe("needs_human")
  })

  test("§D.6 可回滚: critical failure → rolled_back + rollback port invoked", async () => {
    const clock = new FakeClock()
    const planDocId = putPlan([step("a", "pending")])
    let rolledBack = false
    const executor: StepExecutor = () => Effect.succeed({ tokensUsed: 1, critical: true })
    const rollback: RollbackPort = () =>
      Effect.sync(() => {
        rolledBack = true
      })
    const loop = makeGoalLoop(deps({ executor, rollback }, clock))
    const handle = await Effect.runPromise(loop.start(spec(planDocId)))
    const outcome = await Effect.runPromise(loop.tick(handle))
    expect(outcome).toBe("rolled_back")
    expect(rolledBack).toBe(true)
    const status = await Effect.runPromise(loop.status(handle))
    expect(status.phase).toBe("rolled_back")
    // A diagnosis doc was written (可观测).
    const diag = store.list({ type: "diagnosis", scope: planScope(SESSION) })
    expect(diag.length).toBeGreaterThan(0)
  })

  test("§D.6 可回滚: rollback reverts the executor's ACTUAL run session, not the parent goal session", async () => {
    // Regression for the wrong-session seam bug: the executor runs each turn in a CHILD session (where
    // the file edits live), but rollback was called with the parent goal session (which has no edits) →
    // `rolled_back` reported but nothing reverted. The executor now surfaces `executedSessionId`, and the
    // controller must pass THAT to the rollback port.
    const clock = new FakeClock()
    const planDocId = putPlan([step("a", "pending")])
    const CHILD = "child-session-xyz"
    let rolledBackSession: string | undefined
    const executor: StepExecutor = () =>
      Effect.succeed({ tokensUsed: 1, critical: true, executedSessionId: CHILD })
    const rollback: RollbackPort = (input) =>
      Effect.sync(() => {
        rolledBackSession = input.sessionId
      })
    const loop = makeGoalLoop(deps({ executor, rollback }, clock))
    const handle = await Effect.runPromise(loop.start(spec(planDocId)))
    const outcome = await Effect.runPromise(loop.tick(handle))
    expect(outcome).toBe("rolled_back")
    // The child session (edits live here) is reverted — NOT the parent goal session.
    expect(rolledBackSession).toBe(CHILD)
    expect(rolledBackSession).not.toBe(SESSION)
  })

  test("§D.6 可回滚: rollback falls back to the goal session when the executor reports none", async () => {
    // A defect before any child session exists ⇒ no executedSessionId ⇒ revert the goal session itself.
    const clock = new FakeClock()
    const planDocId = putPlan([step("a", "pending")])
    let rolledBackSession: string | undefined
    const executor: StepExecutor = () => Effect.succeed({ tokensUsed: 0, critical: true })
    const rollback: RollbackPort = (input) =>
      Effect.sync(() => {
        rolledBackSession = input.sessionId
      })
    const loop = makeGoalLoop(deps({ executor, rollback }, clock))
    const handle = await Effect.runPromise(loop.start(spec(planDocId)))
    await Effect.runPromise(loop.tick(handle))
    expect(rolledBackSession).toBe(SESSION)
  })

  test("§D.6 可接管: stop() → subsequent ticks replay terminal, no execution", async () => {
    const clock = new FakeClock()
    const planDocId = putPlan([step("a", "pending")])
    let execCount = 0
    const executor: StepExecutor = () =>
      Effect.sync(() => {
        execCount++
        return { tokensUsed: 1 }
      })
    const loop = makeGoalLoop(deps({ executor }, clock))
    const handle = await Effect.runPromise(loop.start(spec(planDocId)))
    await Effect.runPromise(loop.stop(handle))
    const outcome = await Effect.runPromise(loop.tick(handle))
    expect(execCount).toBe(0) // never executed after stop
    expect(outcome).toBe("needs_human") // stopped goal has no recorded outcome
    const status = await Effect.runPromise(loop.status(handle))
    expect(status.phase).toBe("stopped")
  })

  test("§D.6 可观测: every tick writes a worklog doc", async () => {
    const clock = new FakeClock()
    const planDocId = putPlan([step("a", "pending")])
    const executor: StepExecutor = ({ planDocId }) =>
      Effect.sync(() => {
        updatePlan(planDocId, (p) => ({ ...p, steps: [{ ...p.steps[0], title: `${p.steps[0].title}.` }] }))
        return { tokensUsed: 1 }
      })
    const loop = makeGoalLoop(deps({ executor }, clock))
    const handle = await Effect.runPromise(loop.start(spec(planDocId)))
    await Effect.runPromise(loop.tick(handle))
    await Effect.runPromise(loop.tick(handle))
    const worklogs = store.list({ type: "worklog", scope: planScope(SESSION) })
    expect(worklogs.length).toBe(2)
  })
})

describe("V3.9 §D — adversarial-review hardening (2026-07-09)", () => {
  const openPlanDoc = (): PlanDoc => createPlanDoc(SESSION, "g", [step("a", "pending")])

  test("start rejects a tests_pass criterion with an empty command set", async () => {
    const clock = new FakeClock()
    const planDocId = putPlan([step("a", "pending")])
    const loop = makeGoalLoop(deps({}, clock))
    const err = await Effect.runPromise(
      loop.start(spec(planDocId, { criteria: [{ kind: "tests_pass", commands: [] }] })).pipe(Effect.flip),
    )
    expect(err).toBeInstanceOf(InvalidGoalError)
    expect(err.reason).toMatch(/at least one command/)
  })

  test("有界性 pre-execution CEILING: executor does NOT run once maxTicks is reached (no +1 turn)", async () => {
    const clock = new FakeClock()
    const planDocId = putPlan([step("a", "pending")])
    let execCount = 0
    const executor: StepExecutor = ({ planDocId }) =>
      Effect.sync(() => {
        execCount++
        updatePlan(planDocId, (p) => ({ ...p, steps: [{ ...p.steps[0], title: `${p.steps[0].title}.` }] }))
        return { tokensUsed: 1 }
      })
    // maxTicks=1: the ceiling must let exactly ONE executor run happen, then stop WITHOUT a 2nd run.
    const loop = makeGoalLoop(deps({ executor }, clock))
    const handle = await Effect.runPromise(
      loop.start(spec(planDocId, { limits: { maxTicks: 1, maxTokens: 1_000, maxWallclockMs: 1_000 }, stallThreshold: 99 })),
    )
    expect(await Effect.runPromise(loop.tick(handle))).toBe("continue") // tick1 runs, ticks=1
    expect(await Effect.runPromise(loop.tick(handle))).toBe("needs_human") // ceiling: NO 2nd executor run
    expect(execCount).toBe(1) // the fix: executor never ran a (maxTicks+1)th time
  })

  test("token cap is NOT poisoned by a non-finite tokensUsed (NaN → treated as 0)", async () => {
    const clock = new FakeClock()
    const planDocId = putPlan([step("a", "pending")])
    const executor: StepExecutor = ({ planDocId }) =>
      Effect.sync(() => {
        updatePlan(planDocId, (p) => ({ ...p, steps: [{ ...p.steps[0], title: `${p.steps[0].title}.` }] }))
        return { tokensUsed: NaN } // a misbehaving port
      })
    const loop = makeGoalLoop(deps({ executor }, clock))
    const handle = await Effect.runPromise(loop.start(spec(planDocId, { stallThreshold: 99 })))
    await Effect.runPromise(loop.tick(handle))
    const status = await Effect.runPromise(loop.status(handle))
    expect(Number.isFinite(status.ledger.tokens)).toBe(true) // NOT NaN
    expect(status.ledger.tokens).toBe(0)
  })

  test("panel block ESCALATES on the first verdict (not re-run every tick until stall)", async () => {
    const clock = new FakeClock()
    const planDocId = putPlan([step("a", "pending")])
    let panelCalls = 0
    const ports: GraderPorts = {
      ...passingPorts(),
      panelApproves: () =>
        Effect.sync(() => {
          panelCalls++
          return { decision: "block" }
        }),
    }
    const executor: StepExecutor = ({ planDocId }) =>
      Effect.sync(() => {
        updatePlan(planDocId, (p) => ({ ...p, steps: [{ ...p.steps[0], status: "done" }] }))
        return { tokensUsed: 1 }
      })
    const loop = makeGoalLoop(deps({ ports, executor }, clock))
    const handle = await Effect.runPromise(
      loop.start(spec(planDocId, { criteria: [{ kind: "panel_approves" }], stallThreshold: 5 })),
    )
    const outcome = await Effect.runPromise(loop.tick(handle))
    expect(outcome).toBe("needs_human") // escalates immediately, does not "continue" until stall
    expect(panelCalls).toBe(1)
  })

  test("§D.7 非每轮: the controller skips the panel gate when a cheaper criterion is already unmet", async () => {
    let panelCalls = 0
    const ports: GraderPorts = {
      ...passingPorts(),
      runTests: () => Effect.succeed({ pass: false }), // cheap gate fails
      panelApproves: () =>
        Effect.sync(() => {
          panelCalls++
          return { decision: "approve" }
        }),
    }
    const criteria: CompletionCriterion[] = [{ kind: "panel_approves" }, { kind: "tests_pass", commands: ["x"] }]
    // The controller always defers: cheap tests_pass fails first, so the panel is NOT convened.
    const res = await Effect.runPromise(evaluateForController(criteria, ports, openPlanDoc()))
    expect(panelCalls).toBe(0)
    expect(res.result.met).toBe(false) // verdict unchanged: still unmet
  })

  test("evaluateForController flags panel block as escalate but revise as a soft gap", async () => {
    const blockPorts: GraderPorts = { ...passingPorts(), panelApproves: () => Effect.succeed({ decision: "block" }) }
    const blocked = await Effect.runPromise(
      evaluateForController([{ kind: "panel_approves" }], blockPorts, openPlanDoc()),
    )
    expect(blocked.escalate).toBe(true)
    const revisePorts: GraderPorts = { ...passingPorts(), panelApproves: () => Effect.succeed({ decision: "revise" }) }
    const revised = await Effect.runPromise(
      evaluateForController([{ kind: "panel_approves" }], revisePorts, openPlanDoc()),
    )
    expect(revised.escalate).toBe(false)
    expect(revised.result.met).toBe(false) // still a gap, keep iterating
  })

  test("stall guard is NOT evaded by status flapping (regression is not forward progress)", async () => {
    const clock = new FakeClock()
    const planDocId = putPlan([step("a", "pending")])
    // Executor flaps the step status pending↔active each tick (raw fingerprint changes) but never
    // resolves anything to done → must still stall despite the churn.
    let toggle = false
    const executor: StepExecutor = ({ planDocId }) =>
      Effect.sync(() => {
        toggle = !toggle
        updatePlan(planDocId, (p) => ({ ...p, steps: [{ ...p.steps[0], status: toggle ? "active" : "pending" }] }))
        return { tokensUsed: 1 }
      })
    const loop = makeGoalLoop(deps({ executor }, clock))
    const handle = await Effect.runPromise(loop.start(spec(planDocId, { stallThreshold: 3 })))
    const outcomes: string[] = []
    for (let i = 0; i < 3; i++) outcomes.push(await Effect.runPromise(loop.tick(handle)))
    expect(outcomes).toEqual(["continue", "continue", "needs_human"]) // stalls despite flapping
  })

  test("a hard step accruing EVIDENCE across ticks is NOT falsely stalled (evidence = forward progress)", async () => {
    const clock = new FakeClock()
    const planDocId = putPlan([step("a", "active")])
    // A single active step that never finishes within the window, but records NEW evidence each tick
    // (a command run / test passed) — honest incremental progress on a hard task. It must NOT stall.
    const executor: StepExecutor = ({ planDocId }) =>
      Effect.sync(() => {
        updatePlan(planDocId, (p) => ({
          ...p,
          steps: [{ ...p.steps[0], evidence: [...(p.steps[0].evidence ?? []), `ran check ${(p.steps[0].evidence?.length ?? 0) + 1}`] }],
        }))
        return { tokensUsed: 1 }
      })
    const loop = makeGoalLoop(deps({ executor }, clock))
    // stallThreshold 2, but run 5 ticks: with evidence-progress the stall counter never accrues.
    const handle = await Effect.runPromise(loop.start(spec(planDocId, { stallThreshold: 2 })))
    const outcomes: string[] = []
    for (let i = 0; i < 5; i++) outcomes.push(await Effect.runPromise(loop.tick(handle)))
    expect(outcomes).toEqual(["continue", "continue", "continue", "continue", "continue"]) // never stalled
    const status = await Effect.runPromise(loop.status(handle))
    expect(status.stallCount).toBe(0)
  })

  test("a step that stops accruing evidence DOES eventually stall (evidence must keep GROWING)", async () => {
    const clock = new FakeClock()
    const planDocId = putPlan([step("a", "active")])
    // Evidence is added ONCE (tick 1) then never again — statuses unchanged, no new evidence, no new
    // criterion. After the one-time progress, the stall counter must accrue and eventually escalate.
    let seeded = false
    const executor: StepExecutor = ({ planDocId }) =>
      Effect.sync(() => {
        updatePlan(planDocId, (p) => {
          const evidence = seeded ? (p.steps[0].evidence ?? []) : [...(p.steps[0].evidence ?? []), "one-time"]
          seeded = true
          // Always bump the version (touch goal) so dedup never masks the tick — isolates stall logic.
          return { ...p, goal: `${p.goal}.`, steps: [{ ...p.steps[0], evidence }] }
        })
        return { tokensUsed: 1 }
      })
    const loop = makeGoalLoop(deps({ executor }, clock))
    const handle = await Effect.runPromise(loop.start(spec(planDocId, { stallThreshold: 2 })))
    const outcomes: string[] = []
    for (let i = 0; i < 4; i++) outcomes.push(await Effect.runPromise(loop.tick(handle)))
    // tick1 progress (evidence added) → stall 0; tick2 no progress → stall 1; tick3 no progress →
    // stall 2 == threshold → needs_human.
    expect(outcomes).toEqual(["continue", "continue", "needs_human", "needs_human"])
  })

  test("done writes a completion report doc (decision type, report_kind:completion)", async () => {
    const clock = new FakeClock()
    const planDocId = putPlan([step("a", "done")])
    const loop = makeGoalLoop(deps({}, clock))
    const handle = await Effect.runPromise(loop.start(spec(planDocId)))
    expect(await Effect.runPromise(loop.tick(handle))).toBe("done")
    const decisions = store.list({ type: "decision", scope: planScope(SESSION) })
    const report = decisions.map((r) => store.get(r.id)!).find((d) => d.extensions?.report_kind === "completion")
    expect(report).toBeDefined()
  })

  test("a DEFECT in the executor degrades to a critical rollback, not a thrown tick", async () => {
    const clock = new FakeClock()
    const planDocId = putPlan([step("a", "pending")])
    let rolledBack = false
    const executor: StepExecutor = () => Effect.die(new Error("boom")) as ReturnType<StepExecutor>
    const rollback: RollbackPort = () =>
      Effect.sync(() => {
        rolledBack = true
      })
    const loop = makeGoalLoop(deps({ executor, rollback }, clock))
    const handle = await Effect.runPromise(loop.start(spec(planDocId)))
    const outcome = await Effect.runPromise(loop.tick(handle)) // must NOT reject
    expect(outcome).toBe("rolled_back")
    expect(rolledBack).toBe(true)
  })

  test("a DEFECT in the rollback port does not escape tick's never-fail contract", async () => {
    const clock = new FakeClock()
    const planDocId = putPlan([step("a", "pending")])
    const executor: StepExecutor = () => Effect.succeed({ tokensUsed: 1, critical: true })
    const rollback: RollbackPort = () => Effect.die(new Error("rollback boom")) as ReturnType<RollbackPort>
    const loop = makeGoalLoop(deps({ executor, rollback }, clock))
    const handle = await Effect.runPromise(loop.start(spec(planDocId)))
    const outcome = await Effect.runPromise(loop.tick(handle)) // must NOT reject despite rollback defect
    expect(outcome).toBe("rolled_back")
  })
})

describe("V3.9 §D — confirmed-bug regressions (2026-07-14)", () => {
  test("BUG#6: a plan with a blocked step (all others done) routes to needs_human, NOT done", async () => {
    const clock = new FakeClock()
    // step a is done, step b is blocked → buildCompletionReport.complete is true (blocked counts as
    // resolved), which previously made plan_complete report DONE and silently swallowed the blocker.
    const planDocId = putPlan([step("a", "done"), step("b", "blocked")])
    const loop = makeGoalLoop(deps({}, clock))
    const handle = await Effect.runPromise(loop.start(spec(planDocId)))
    const outcome = await Effect.runPromise(loop.tick(handle))
    expect(outcome).toBe("needs_human")
    expect(outcome).not.toBe("done")
    const status = await Effect.runPromise(loop.status(handle))
    expect(status.phase).toBe("needs_human")
    expect(status.gaps.some((g) => /blocked/.test(g))).toBe(true)
  })

  test("BUG#6: evaluateForController surfaces a blocked plan as an unmet, escalating gap", async () => {
    const blockedPlan = createPlanDoc(SESSION, "g", [step("a", "done"), step("b", "blocked")])
    const res = await Effect.runPromise(
      evaluateForController([{ kind: "plan_complete" }], passingPorts(), blockedPlan),
    )
    expect(res.result.met).toBe(false) // NOT a clean completion
    expect(res.escalate).toBe(true) // route to a human on the first verdict
  })

  test("BUG#7: an executor that RUNS but leaves the plan-doc unchanged still accrues stall → needs_human", async () => {
    const clock = new FakeClock()
    const planDocId = putPlan([step("a", "pending")])
    let execCount = 0
    // A no-op executor: it runs (side effect) but NEVER bumps the plan version — the exact structural
    // defeat of the stall guard. Every later tick hits the version-dedup replay; before the fix that was
    // a free `return lastOutcome` with no stall accrual, so only the driver's maxIterations (10k) stopped
    // it. Now the non-terminal replay must accrue toward the stall guard.
    const executor: StepExecutor = () =>
      Effect.sync(() => {
        execCount++
        return { tokensUsed: 3 }
      })
    const loop = makeGoalLoop(deps({ executor }, clock))
    const handle = await Effect.runPromise(loop.start(spec(planDocId, { stallThreshold: 3 })))
    const outcomes: string[] = []
    for (let i = 0; i < 3; i++) outcomes.push(await Effect.runPromise(loop.tick(handle)))
    // tick1 executes (no progress) → stall 1 continue; tick2/tick3 are version-dedup replays that STILL
    // accrue stall → stall 2 continue, stall 3 == threshold → needs_human. Bounded by the stall guard.
    expect(outcomes).toEqual(["continue", "continue", "needs_human"])
    expect(execCount).toBe(1) // idempotency preserved: the replay never re-ran the executor
    const status = await Effect.runPromise(loop.status(handle))
    expect(status.phase).toBe("needs_human")
    expect(status.ledger.ticks).toBe(1) // replay never re-accrued budget either
  })

  test("cost clamp: a negative cost from a port does NOT decrement the ledger (clamped to 0)", async () => {
    const clock = new FakeClock()
    const planDocId = putPlan([step("a", "pending")])
    const executor: StepExecutor = ({ planDocId }) =>
      Effect.sync(() => {
        updatePlan(planDocId, (p) => ({ ...p, steps: [{ ...p.steps[0], title: `${p.steps[0].title}.` }] }))
        return { tokensUsed: 1, cost: -100 } // a misbehaving port returning a negative cost
      })
    const loop = makeGoalLoop(deps({ executor }, clock))
    const handle = await Effect.runPromise(
      loop.start(spec(planDocId, { limits: { maxTicks: 99, maxTokens: 1_000, maxWallclockMs: 100_000, maxCost: 10 }, stallThreshold: 99 })),
    )
    await Effect.runPromise(loop.tick(handle))
    const status = await Effect.runPromise(loop.status(handle))
    expect(status.ledger.cost).toBe(0) // clamped, NOT -100
    expect(status.ledger.cost).toBeGreaterThanOrEqual(0)
  })
})

describe("V3.9 §D — process restart recovery (§D.6 可恢复)", () => {
  test("a fresh Controller over the same store resumes from persisted state", async () => {
    const clock = new FakeClock()
    const planDocId = putPlan([step("a", "pending")])
    const executor: StepExecutor = ({ planDocId }) =>
      Effect.sync(() => {
        updatePlan(planDocId, (p) => ({ ...p, steps: [{ ...p.steps[0], title: `${p.steps[0].title}.` }] }))
        return { tokensUsed: 4 }
      })

    // First "process": start + 2 ticks.
    const loop1 = makeGoalLoop(deps({ executor }, clock))
    const handle = await Effect.runPromise(loop1.start(spec(planDocId, { stallThreshold: 99 })))
    await Effect.runPromise(loop1.tick(handle))
    await Effect.runPromise(loop1.tick(handle))
    const before = await Effect.runPromise(loop1.status(handle))
    expect(before.ledger.ticks).toBe(2)
    expect(before.ledger.tokens).toBe(8)

    // Rebuild the store from disk (simulating a process restart) + a brand-new Controller instance.
    const store2 = new DocumentStore(root)
    store = store2
    const loop2 = makeGoalLoop(deps({ executor, store: store2 }, clock))
    const recovered = await Effect.runPromise(loop2.status(handle))
    expect(recovered.ledger.ticks).toBe(2) // recovered, not reset
    expect(recovered.ledger.tokens).toBe(8)

    // And it continues accumulating from the recovered ledger.
    await Effect.runPromise(loop2.tick(handle))
    const after = await Effect.runPromise(loop2.status(handle))
    expect(after.ledger.ticks).toBe(3)
    expect(after.ledger.tokens).toBe(12)
  })
})

describe("V4.1 §S2 — goal plan hot-edit (applyPlanEdit)", () => {
  // A user plan edit expressed as the loose PlanInput the route/handler forwards.
  const edit = (steps: { title: string; step_id?: string; status?: string }[], goal = "reach the goal"): PlanInput => ({
    goal,
    steps,
  })

  test("upserts the edited plan to the durable doc (version+1) so the next tick sees the revision", async () => {
    const clock = new FakeClock()
    const planDocId = putPlan([step("a", "pending")])
    const v0 = store.get(planDocId)!.version
    const loop = makeGoalLoop(deps({}, clock))
    const handle = await Effect.runPromise(loop.start(spec(planDocId)))

    await Effect.runPromise(loop.applyPlanEdit(handle, edit([{ title: "revised step", status: "pending" }])))

    const doc = store.get(planDocId)!
    expect(doc.version).toBeGreaterThan(v0)
    const revised = JSON.parse(doc.body) as PlanDoc
    expect(revised.steps.map((s) => s.title)).toEqual(["revised step"])
    // Human-sourced provenance distinguishes a user edit from the model's plan-tool writes.
    expect(doc.provenance.source).toBe("human")
  })

  test("preserves step ids + accumulated evidence across the rewrite (buildPlanFromInput reconciliation)", async () => {
    const clock = new FakeClock()
    // Seed a plan whose step "a" already carries evidence (as the executor's mirror-back would leave it).
    const seeded = createPlanDoc(SESSION, "reach the goal", [{ ...step("a", "active"), evidence: ["tests pass"] }])
    const planDocId = store.upsert({
      type: "plan",
      scope: planScope(SESSION),
      description: `plan ${SESSION}`,
      idSlug: `plan-${SESSION}`,
      body: JSON.stringify(seeded),
      provenance: { source: "model", run_ref: planScope(SESSION) },
    }).id
    const loop = makeGoalLoop(deps({}, clock))
    const handle = await Effect.runPromise(loop.start(spec(planDocId)))

    // The user re-titles the SAME step (same id) — evidence must survive (it is runtime-owned, never
    // taken from the loose input).
    await Effect.runPromise(loop.applyPlanEdit(handle, edit([{ step_id: "a", title: "renamed", status: "active" }])))

    const revised = JSON.parse(store.get(planDocId)!.body) as PlanDoc
    expect(revised.steps[0].step_id).toBe("a")
    expect(revised.steps[0].title).toBe("renamed")
    expect(revised.steps[0].evidence).toEqual(["tests pass"])
  })

  test("re-baselines stall tracking: re-opening a done step (done→pending) does NOT read as a regression stall", async () => {
    const clock = new FakeClock()
    // Executor bumps the version each tick (dedup never fires) but never resolves the step or records
    // evidence — no forward progress. plan_complete stays UNMET (a pending step remains), so the loop
    // accumulates stall ticks rather than completing.
    const executor: StepExecutor = ({ planDocId }) =>
      Effect.sync(() => {
        updatePlan(planDocId, (p) => ({ ...p, goal: `${p.goal}.` }))
        return { tokensUsed: 1 }
      })
    const planDocId = putPlan([step("a", "pending")])
    const loop = makeGoalLoop(deps({ executor }, clock))
    const handle = await Effect.runPromise(loop.start(spec(planDocId, { stallThreshold: 5 })))

    // Drive it near the stall threshold with a plan that has no forward movement.
    await Effect.runPromise(loop.tick(handle))
    await Effect.runPromise(loop.tick(handle))
    const beforeEdit = await Effect.runPromise(loop.status(handle))
    expect(beforeEdit.stallCount).toBe(2)

    // User re-opens the step (done→pending) + adds a new one. The re-baseline resets stallCount to 0.
    await Effect.runPromise(
      loop.applyPlanEdit(handle, edit([{ step_id: "a", title: "a", status: "pending" }, { title: "b", status: "pending" }])),
    )
    const afterEdit = await Effect.runPromise(loop.status(handle))
    expect(afterEdit.stallCount).toBe(0)

    // The tick immediately after the edit runs (lastProcessedVersion was nulled) and does not
    // immediately stall — the revision got a fresh runway.
    const outcome = await Effect.runPromise(loop.tick(handle))
    expect(outcome).toBe("continue")
  })

  test("no-op on an unknown/unstarted goal (never throws, never creates a doc)", async () => {
    const clock = new FakeClock()
    const loop = makeGoalLoop(deps({}, clock))
    const handle = { goalId: "nope", planDocId: "no-doc", sessionId: SESSION }
    await Effect.runPromise(loop.applyPlanEdit(handle, edit([{ title: "x" }])))
    expect(store.get("no-doc")).toBeNull()
  })

  test("no-op once the goal is terminal (a stopped goal cannot be re-planned)", async () => {
    const clock = new FakeClock()
    const planDocId = putPlan([step("a", "pending")])
    const loop = makeGoalLoop(deps({}, clock))
    const handle = await Effect.runPromise(loop.start(spec(planDocId)))
    await Effect.runPromise(loop.stop(handle))
    const vAfterStop = store.get(planDocId)!.version

    await Effect.runPromise(loop.applyPlanEdit(handle, edit([{ title: "revised" }])))

    // Terminal → the edit is ignored; the durable doc is untouched.
    expect(store.get(planDocId)!.version).toBe(vAfterStop)
    const status = await Effect.runPromise(loop.status(handle))
    expect(status.phase).toBe("stopped")
  })

  test("a repeated identical edit is a harmless no-op write (INV-4, no version bump)", async () => {
    const clock = new FakeClock()
    // Seed a doc ALREADY human-authored, so the first edit below can no-op (provenance is in the
    // fingerprint: a model→human authorship change bumps the version even on identical body — that is
    // correct, so we start from human provenance to isolate the body no-op).
    const seeded = createPlanDoc(SESSION, "reach the goal", [step("a", "pending")])
    const planDocId = store.upsert({
      type: "plan",
      scope: planScope(SESSION),
      description: `plan ${SESSION}`,
      idSlug: `plan-${SESSION}`,
      body: JSON.stringify(seeded),
      provenance: { source: "human", run_ref: planScope(SESSION) },
    }).id
    const loop = makeGoalLoop(deps({}, clock))
    const handle = await Effect.runPromise(loop.start(spec(planDocId)))
    const v0 = store.get(planDocId)!.version

    // An edit that reconciles to the exact same body + same (human) provenance ⇒ INV-4 no-op.
    await Effect.runPromise(loop.applyPlanEdit(handle, edit([{ step_id: "a", title: "a", status: "pending" }])))

    expect(store.get(planDocId)!.version).toBe(v0)
  })
})

// V4.0.1 P2 — budget semantic refactor: token→compaction line (never a halt), tiered cost soft-notify,
// net-generation ledger.
describe("V4.0.1 P2 — budgetNotice (tiered cost soft-notify)", () => {
  const ledgerAt = (cost: number): BudgetLedger => ({ ticks: 1, tokens: 0, cost, wallclockMs: 0, startedAtMs: 0 })
  const limitsWith = (over: Partial<GoalLimits> = {}): GoalLimits => ({
    maxTicks: 100,
    maxTokens: 100_000,
    maxWallclockMs: 100_000,
    maxCost: 10,
    ...over,
  })

  test("returns null below the lowest tier (<70%)", () => {
    expect(budgetNotice(ledgerAt(6), limitsWith())).toBeNull() // 60%
  })

  test("returns the 70% notice at exactly 70%", () => {
    const notice = budgetNotice(ledgerAt(7), limitsWith())
    expect(notice).not.toBeNull()
    expect(notice).toMatch(/70% used/)
    expect(notice).toMatch(/CONVERGE/)
  })

  test("returns the 90% notice at exactly 90% (highest tier crossed wins)", () => {
    expect(budgetNotice(ledgerAt(9), limitsWith())).toMatch(/90% used/)
  })

  test("crossing the highest tier still fires (95% → non-null, reports the ACTUAL usage percent)", () => {
    // The tier gate (descending match) decides WHETHER to notify; the message always shows the actual
    // usage fraction (95%), matching the design's Math.round(fr*100).
    const notice = budgetNotice(ledgerAt(9.5), limitsWith())
    expect(notice).not.toBeNull()
    expect(notice).toMatch(/95% used/)
  })

  test("honours custom softNotifyFractions (descending match)", () => {
    const limits = limitsWith({ softNotifyFractions: [0.5, 0.8] })
    expect(budgetNotice(ledgerAt(4), limits)).toBeNull() // 40% < 50%
    expect(budgetNotice(ledgerAt(6), limits)).toMatch(/60% used/) // crosses 50%, reports actual 60%
    expect(budgetNotice(ledgerAt(8.5), limits)).toMatch(/85% used/) // crosses 80%, reports actual 85%
  })

  test("no cost ceiling (maxCost absent / 0) ⇒ never notifies (fraction 0)", () => {
    expect(budgetNotice(ledgerAt(1000), limitsWith({ maxCost: undefined }))).toBeNull()
    expect(budgetNotice(ledgerAt(1000), limitsWith({ maxCost: 0 }))).toBeNull()
  })
})

describe("V4.0.1 P2 — token count is NOT a halting line (§4.3)", () => {
  test("massive token pressure but wallclock/cost under limit → goal CONTINUES (never needs_human)", async () => {
    const clock = new FakeClock()
    const planDocId = putPlan([step("a", "pending")])
    // Every tick burns tokens WAY past maxTokens, makes forward progress (new evidence), but stays under
    // wallclock/cost. Pre-V4.0.1 this halted at needs_human on the token cap; now it must keep ticking.
    const executor: StepExecutor = ({ planDocId }) =>
      Effect.sync(() => {
        updatePlan(planDocId, (p) => ({
          ...p,
          steps: [{ ...p.steps[0], evidence: [...(p.steps[0].evidence ?? []), `progress ${(p.steps[0].evidence?.length ?? 0) + 1}`] }],
        }))
        return { tokensUsed: 1_000_000 } // 1M tokens/tick, maxTokens is 50
      })
    const loop = makeGoalLoop(deps({ executor }, clock))
    const handle = await Effect.runPromise(
      loop.start(spec(planDocId, { limits: { maxTicks: 99, maxTokens: 50, maxWallclockMs: 100_000 }, stallThreshold: 99 })),
    )
    const outcomes: string[] = []
    for (let i = 0; i < 5; i++) outcomes.push(await Effect.runPromise(loop.tick(handle)))
    expect(outcomes).toEqual(["continue", "continue", "continue", "continue", "continue"]) // never halts on tokens
    const status = await Effect.runPromise(loop.status(handle))
    expect(status.phase).toBe("running")
    expect(status.ledger.tokens).toBeGreaterThan(50) // ledger well past maxTokens, yet no halt
  })

  test("maxWallclockMs STILL halts (boundedness invariant intact)", async () => {
    const clock = new FakeClock()
    const planDocId = putPlan([step("a", "pending")])
    const executor: StepExecutor = ({ planDocId }) =>
      Effect.sync(() => {
        updatePlan(planDocId, (p) => ({ ...p, steps: [{ ...p.steps[0], title: `${p.steps[0].title}.` }] }))
        clock.advance(10_000)
        return { tokensUsed: 1 }
      })
    const loop = makeGoalLoop(deps({ executor }, clock))
    const handle = await Effect.runPromise(
      loop.start(spec(planDocId, { limits: { maxTicks: 99, maxTokens: 1_000, maxWallclockMs: 5_000 }, stallThreshold: 99 })),
    )
    expect(await Effect.runPromise(loop.tick(handle))).toBe("needs_human")
  })

  test("maxCost STILL halts (boundedness invariant intact)", async () => {
    const clock = new FakeClock()
    const planDocId = putPlan([step("a", "pending")])
    const executor: StepExecutor = ({ planDocId }) =>
      Effect.sync(() => {
        updatePlan(planDocId, (p) => ({ ...p, steps: [{ ...p.steps[0], title: `${p.steps[0].title}.` }] }))
        return { tokensUsed: 1, cost: 100 }
      })
    const loop = makeGoalLoop(deps({ executor }, clock))
    const handle = await Effect.runPromise(
      loop.start(spec(planDocId, { limits: { maxTicks: 99, maxTokens: 1_000, maxWallclockMs: 100_000, maxCost: 10 }, stallThreshold: 99 })),
    )
    // Tick 1 spends cost 100 > maxCost 10 → the post-gate (overLimit) fires this same tick → needs_human.
    expect(await Effect.runPromise(loop.tick(handle))).toBe("needs_human")
  })

  test("maxTicks STILL halts (boundedness invariant intact)", async () => {
    const clock = new FakeClock()
    const planDocId = putPlan([step("a", "pending")])
    const executor: StepExecutor = ({ planDocId }) =>
      Effect.sync(() => {
        updatePlan(planDocId, (p) => ({ ...p, steps: [{ ...p.steps[0], title: `${p.steps[0].title}.` }] }))
        return { tokensUsed: 1 }
      })
    const loop = makeGoalLoop(deps({ executor }, clock))
    const handle = await Effect.runPromise(
      loop.start(spec(planDocId, { limits: { maxTicks: 1, maxTokens: 1_000, maxWallclockMs: 100_000 }, stallThreshold: 99 })),
    )
    expect(await Effect.runPromise(loop.tick(handle))).toBe("continue")
    expect(await Effect.runPromise(loop.tick(handle))).toBe("needs_human") // maxTicks ceiling
  })

  test("stall STILL halts (无进展即停 intact)", async () => {
    const clock = new FakeClock()
    const planDocId = putPlan([step("a", "pending")])
    const executor: StepExecutor = ({ planDocId }) =>
      Effect.sync(() => {
        updatePlan(planDocId, (p) => ({ ...p, goal: `${p.goal}.` })) // version bump, no progress
        return { tokensUsed: 1 }
      })
    const loop = makeGoalLoop(deps({ executor }, clock))
    const handle = await Effect.runPromise(loop.start(spec(planDocId, { stallThreshold: 2 })))
    expect(await Effect.runPromise(loop.tick(handle))).toBe("continue")
    expect(await Effect.runPromise(loop.tick(handle))).toBe("needs_human")
  })

  test("validateSpec STILL rejects a non-positive maxTokens (bounded field, just not a halt line)", async () => {
    const clock = new FakeClock()
    const planDocId = putPlan([step("a", "pending")])
    const loop = makeGoalLoop(deps({}, clock))
    const err = await Effect.runPromise(
      loop.start(spec(planDocId, { limits: { maxTicks: 1, maxTokens: 0, maxWallclockMs: 1 } })).pipe(Effect.flip),
    )
    expect(err).toBeInstanceOf(InvalidGoalError)
    expect(err.reason).toMatch(/maxTokens/)
  })
})

describe("V4.0.1 P2 — net-generation token accounting (§4.4/§4.5, budgetTokenScope marker)", () => {
  // An executor that reports the granular breakdown of a tick whose FULL input re-pays a big fixed prefix
  // every tick (the gross-inflation scenario). input=1000 (prefix 900 + 100 new), output=50.
  const granularExecutor: StepExecutor = ({ planDocId }) =>
    Effect.sync(() => {
      updatePlan(planDocId, (p) => ({
        ...p,
        steps: [{ ...p.steps[0], evidence: [...(p.steps[0].evidence ?? []), `e${(p.steps[0].evidence?.length ?? 0) + 1}`] }],
      }))
      return {
        tokensUsed: 1_050, // gross: input+output = 1000 + 50
        inputTokens: 1_000,
        outputTokens: 50,
        carriedPrefixTokens: 900,
      } satisfies StepExecutorResult
    })

  test("GROSS scope (flag OFF): ledger sums full throughput incl. the repeated prefix (legacy path)", async () => {
    const clock = new FakeClock()
    const planDocId = putPlan([step("a", "active")])
    // netTokenBudget omitted (OFF) → scope "gross".
    const loop = makeGoalLoop(deps({ executor: granularExecutor }, clock))
    const handle = await Effect.runPromise(loop.start(spec(planDocId, { stallThreshold: 99 })))
    for (let i = 0; i < 3; i++) await Effect.runPromise(loop.tick(handle))
    const status = await Effect.runPromise(loop.status(handle))
    // gross = 3 ticks × 1050 = 3150 (the prefix is re-counted every tick).
    expect(status.ledger.tokens).toBe(3_150)
  })

  test("NET scope (flag ON): ledger does NOT inflate from the repeated prefix", async () => {
    const clock = new FakeClock()
    const planDocId = putPlan([step("a", "active")])
    const loop = makeGoalLoop(deps({ executor: granularExecutor, netTokenBudget: true }, clock))
    const handle = await Effect.runPromise(loop.start(spec(planDocId, { stallThreshold: 99 })))
    for (let i = 0; i < 3; i++) await Effect.runPromise(loop.tick(handle))
    const status = await Effect.runPromise(loop.status(handle))
    // net per tick = output 50 + max(0, input 1000 − carried 900) = 50 + 100 = 150. 3 ticks → 450.
    // This is far below the gross 3150 — the ledger no longer inflates linearly from the prefix.
    expect(status.ledger.tokens).toBe(450)
  })

  test("NET scope falls back to gross tokensUsed when granular fields are absent (monotonic)", async () => {
    const clock = new FakeClock()
    const planDocId = putPlan([step("a", "active")])
    // Executor reports only gross tokensUsed (no breakdown) even though scope is "net".
    const executor: StepExecutor = ({ planDocId }) =>
      Effect.sync(() => {
        updatePlan(planDocId, (p) => ({
          ...p,
          steps: [{ ...p.steps[0], evidence: [...(p.steps[0].evidence ?? []), `e${(p.steps[0].evidence?.length ?? 0) + 1}`] }],
        }))
        return { tokensUsed: 200 }
      })
    const loop = makeGoalLoop(deps({ executor, netTokenBudget: true }, clock))
    const handle = await Effect.runPromise(loop.start(spec(planDocId, { stallThreshold: 99 })))
    for (let i = 0; i < 2; i++) await Effect.runPromise(loop.tick(handle))
    const status = await Effect.runPromise(loop.status(handle))
    expect(status.ledger.tokens).toBe(400) // 2 × 200, no breakdown → gross fallback
  })

  test("the scope marker survives persist/load — a NET goal recovers as NET after restart", async () => {
    const clock = new FakeClock()
    const planDocId = putPlan([step("a", "active")])
    const loop1 = makeGoalLoop(deps({ executor: granularExecutor, netTokenBudget: true }, clock))
    const handle = await Effect.runPromise(loop1.start(spec(planDocId, { stallThreshold: 99 })))
    await Effect.runPromise(loop1.tick(handle))
    const before = await Effect.runPromise(loop1.status(handle))
    expect(before.ledger.tokens).toBe(150) // net

    // Rebuild the store from disk + a fresh Controller. CRUCIALLY, the new Controller has netTokenBudget
    // UNSET (flag "off") — the persisted budgetTokenScope marker must still drive NET accumulation, proving
    // tick() obeys the marker, not the live flag.
    const store2 = new DocumentStore(root)
    store = store2
    const loop2 = makeGoalLoop(deps({ executor: granularExecutor, store: store2 }, clock))
    const recovered = await Effect.runPromise(loop2.status(handle))
    expect(recovered.ledger.tokens).toBe(150) // recovered net ledger, not reset
    await Effect.runPromise(loop2.tick(handle))
    const after = await Effect.runPromise(loop2.status(handle))
    expect(after.ledger.tokens).toBe(300) // continues NET (150+150), NOT gross — marker survived
  })

  test("a GROSS goal stays GROSS even if the flag is later turned on (no mid-flight re-interpretation)", async () => {
    const clock = new FakeClock()
    const planDocId = putPlan([step("a", "active")])
    // Start with the flag OFF (gross).
    const loop1 = makeGoalLoop(deps({ executor: granularExecutor }, clock))
    const handle = await Effect.runPromise(loop1.start(spec(planDocId, { stallThreshold: 99 })))
    await Effect.runPromise(loop1.tick(handle))
    // A new Controller with the flag now ON — but the goal was stamped "gross" at creation.
    const loop2 = makeGoalLoop(deps({ executor: granularExecutor, netTokenBudget: true }, clock))
    await Effect.runPromise(loop2.tick(handle))
    const status = await Effect.runPromise(loop2.status(handle))
    expect(status.ledger.tokens).toBe(2_100) // 2 × 1050 gross — stays gross despite the flag flip
  })
})

// V4.0.1 P3(a) — tick idempotency / crash recovery. The infrastructure already exists (durable command
// cursor + plan-version dedup on the event path; shared run_context doc for both drivers); these tests
// pin the DURABILITY guarantees that the exactly-once story rests on. `persistPendingPlanEdit` /
// `readPendingPlanEdit` are pure functions over a DocumentStore, so "cold recovery" is modeled by opening
// a FRESH DocumentStore handle over the same on-disk root — the exact "second process" reconstruction the
// event-driven cold-recovery test uses (goal-tick-cold-recovery.test.ts).
describe("V4.0.1 P3(a) — pendingPlanEdit durability + cold recovery", () => {
  const GOAL = "g-pending-1"
  const editInput: PlanInput = { goal: "reach the goal", steps: [{ title: "revised", status: "pending" }] }

  test("a persisted pending edit survives a process restart (fresh store over the same root)", () => {
    persistPendingPlanEdit(store, SESSION, GOAL, editInput)

    // Simulate a process restart: NOTHING in memory, only the run_context doc on disk. A brand-new store
    // handle over the same root must reconstruct the pending edit byte-for-byte.
    const recovered = readPendingPlanEdit(new DocumentStore(root), SESSION, GOAL)
    expect(recovered).toEqual(editInput)
  })

  test("consume-once: writing the null sentinel clears the edit, and a re-read after restart stays cleared", () => {
    persistPendingPlanEdit(store, SESSION, GOAL, editInput)
    expect(readPendingPlanEdit(store, SESSION, GOAL)).toEqual(editInput)

    // markPlanEditConsumed persists the empty-body sentinel (plan == null). Once consumed it must never
    // re-materialize — not on this handle, and not after a cold restart.
    persistPendingPlanEdit(store, SESSION, GOAL, null)
    expect(readPendingPlanEdit(store, SESSION, GOAL)).toBeNull()
    expect(readPendingPlanEdit(new DocumentStore(root), SESSION, GOAL)).toBeNull()
  })

  test("a pending edit is keyed per goal — reading a different goalId never returns another goal's edit", () => {
    persistPendingPlanEdit(store, SESSION, GOAL, editInput)
    // pending_edit_goal_id scopes the doc: a sibling goal in the same session sees nothing.
    expect(readPendingPlanEdit(new DocumentStore(root), SESSION, "g-other")).toBeNull()
    expect(readPendingPlanEdit(new DocumentStore(root), SESSION, GOAL)).toEqual(editInput)
  })

  test("the latest write wins across a restart (a newer edit persisted after read is preserved)", () => {
    persistPendingPlanEdit(store, SESSION, GOAL, editInput)
    const newer: PlanInput = { goal: "reach the goal", steps: [{ title: "newer step", status: "active" }] }
    // A second edit lands (e.g. the user revised again before the first was consumed) — the durable doc
    // reflects the newest content, and a cold reader sees it.
    persistPendingPlanEdit(store, SESSION, GOAL, newer)
    expect(readPendingPlanEdit(new DocumentStore(root), SESSION, GOAL)).toEqual(newer)
  })

  test("the pending-edit doc is invisible to the goal-tick cursor (kept off loadState's run_context match)", () => {
    // The pending-edit doc uses `pending_edit_goal_id`, NOT `goal_id`, so it must never be mistaken for the
    // goal's run-state doc — otherwise readGoalTickCursor could parse the edit body as GoalRuntimeState.
    persistPendingPlanEdit(store, SESSION, GOAL, editInput)
    expect(readGoalTickCursor(new DocumentStore(root), SESSION, GOAL)).toBeNull()
  })
})
