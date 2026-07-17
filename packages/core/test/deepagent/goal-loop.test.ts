import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { DocumentStore } from "../../src/deepagent/document-store"
import { createPlanDoc, planScope, type PlanDoc, type PlanStep } from "../../src/deepagent/plan-controller"
import {
  makeGoalLoop,
  evaluateCriteria,
  evaluateForController,
  InvalidGoalError,
  type ControllerDeps,
  type GraderPorts,
  type StepExecutor,
  type RollbackPort,
  type GoalSpec,
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
      const res = await Effect.runPromise(evaluateCriteria([c], passingPorts(), donePlan()))
      expect(res.met).toBe(true)
      expect(res.gaps).toEqual([])
      void name
    }
  })

  test("tests_pass unmet → met:false with gap", async () => {
    const ports: GraderPorts = { ...passingPorts(), runTests: () => Effect.succeed({ pass: false }) }
    const res = await Effect.runPromise(evaluateCriteria([criteria.tests_pass], ports, donePlan()))
    expect(res.met).toBe(false)
    expect(res.gaps[0]).toMatch(/tests_pass/)
  })

  test("no_diagnostics: any diagnostic is a gap when unbounded; within bound is met", async () => {
    const withDiag: GraderPorts = { ...passingPorts(), diagnostics: () => Effect.succeed({ maxSeverity: "warning" }) }
    const strict = await Effect.runPromise(evaluateCriteria([{ kind: "no_diagnostics" }], withDiag, donePlan()))
    expect(strict.met).toBe(false)
    const bounded = await Effect.runPromise(
      evaluateCriteria([{ kind: "no_diagnostics", severityAtMost: "warning" }], withDiag, donePlan()),
    )
    expect(bounded.met).toBe(true)
    const errDiag: GraderPorts = { ...passingPorts(), diagnostics: () => Effect.succeed({ maxSeverity: "error" }) }
    const exceeded = await Effect.runPromise(
      evaluateCriteria([{ kind: "no_diagnostics", severityAtMost: "warning" }], errDiag, donePlan()),
    )
    expect(exceeded.met).toBe(false)
  })

  test("reviewer_clean / panel_approves unmet → gap", async () => {
    const ports: GraderPorts = {
      ...passingPorts(),
      reviewerClean: () => Effect.succeed({ pass: false }),
      panelApproves: () => Effect.succeed({ decision: "block" }),
    }
    const rev = await Effect.runPromise(evaluateCriteria([criteria.reviewer_clean], ports, donePlan()))
    expect(rev.met).toBe(false)
    const pan = await Effect.runPromise(evaluateCriteria([criteria.panel_approves], ports, donePlan()))
    expect(pan.met).toBe(false)
    expect(pan.gaps[0]).toMatch(/block/)
  })

  test("plan_complete reflects outstanding steps", async () => {
    const met = await Effect.runPromise(evaluateCriteria([criteria.plan_complete], passingPorts(), donePlan()))
    expect(met.met).toBe(true)
    const unmet = await Effect.runPromise(evaluateCriteria([criteria.plan_complete], passingPorts(), openPlan()))
    expect(unmet.met).toBe(false)
    expect(unmet.gaps[0]).toMatch(/outstanding/)
  })

  test("AND semantics: one unmet among many → met:false", async () => {
    const ports: GraderPorts = { ...passingPorts(), runTests: () => Effect.succeed({ pass: false }) }
    const all = Object.values(criteria)
    const res = await Effect.runPromise(evaluateCriteria(all, ports, donePlan()))
    expect(res.met).toBe(false)
    expect(res.gaps.length).toBe(1)
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

  test("§D.6 有界性 (over-limit): exceeding maxTokens → needs_human", async () => {
    const clock = new FakeClock()
    const planDocId = putPlan([step("a", "pending")])
    const executor: StepExecutor = ({ planDocId }) =>
      Effect.sync(() => {
        updatePlan(planDocId, (p) => ({ ...p, steps: [{ ...p.steps[0], title: `${p.steps[0].title}.` }] }))
        return { tokensUsed: 100 }
      })
    const loop = makeGoalLoop(deps({ executor }, clock))
    const handle = await Effect.runPromise(
      loop.start(spec(planDocId, { limits: { maxTicks: 99, maxTokens: 50, maxWallclockMs: 100_000 }, stallThreshold: 99 })),
    )
    expect(await Effect.runPromise(loop.tick(handle))).toBe("needs_human")
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

  test("§D.7 非每轮: deferExpensive skips the panel gate when a cheaper criterion is already unmet", async () => {
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
    // deferExpensive OFF (default) → panel IS called.
    await Effect.runPromise(evaluateCriteria(criteria, ports, openPlanDoc()))
    expect(panelCalls).toBe(1)
    // deferExpensive ON → cheap tests_pass fails first, panel is NOT convened.
    panelCalls = 0
    const res = await Effect.runPromise(evaluateCriteria(criteria, ports, openPlanDoc(), { deferExpensive: true }))
    expect(panelCalls).toBe(0)
    expect(res.met).toBe(false) // verdict unchanged: still unmet
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
