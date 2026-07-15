import { describe, expect, test, afterEach } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { DocumentStore } from "@deepagent-code/core/deepagent/document-store"
import { createPlanDoc, planScope, type PlanDoc, type PlanStep } from "@deepagent-code/core/deepagent/plan-controller"
import {
  makeGoalLoop,
  type ControllerDeps,
  type GraderPorts,
  type StepExecutor,
} from "@deepagent-code/core/deepagent/goal-loop"
import { WikiGraph, WikiService } from "../../src/wiki/wiki-service"
import { runPanel, type PanelistRunner } from "../../src/panel/orchestrator"
import { DEFAULT_QUORUM_POLICY, type PanelOpinion } from "../../src/agent/schema/panel"

/**
 * V3.9 §G integration — the B/C/D collaborative CLOSED LOOP (§D.7), proven deterministically.
 *
 * This is the key deliverable: it wires the REAL controller (core `makeGoalLoop`), the REAL Panel
 * (orchestrator `runPanel` + deterministic `arbitrate`), and the REAL archiver
 * (`WikiService.renderExecutionArchive`) over ONE real DocumentStore. Only the leaf I/O is stubbed:
 *   - the panelist LLM (a `PanelistRunner` returning fixed PanelOpinions → real arbiter → PanelVerdict)
 *   - step execution (a StubStepExecutor that advances the plan doc, i.e. writes plan versions)
 *
 * What each cross proves:
 *   §D.7 × C : `panel_approves` calls the REAL runPanel — the Goal Loop convenes the Panel at a
 *              decision point, and only when the panel approves does the goal reach `done`.
 *   §D.7 × B : every tick writes worklog/diagnosis into the run:<sessionId> Document Graph (the
 *              trajectory); WikiService.renderExecutionArchive then aggregates plan+worklog+trajectory
 *              into a Wiki archive page (the read path now exposed via GET /wiki/execution-archive).
 */

let roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})
const freshStore = () => {
  const root = mkdtempSync(path.join(tmpdir(), "deepagent-bcd-"))
  roots.push(root)
  return new DocumentStore(root)
}
const SESSION = "s-bcd-1"
const step = (id: string, status: PlanStep["status"], title = id): PlanStep => ({
  step_id: id,
  title,
  status,
  acceptance: null,
  assigned_agent: null,
  evidence: [],
  note: null,
})

const putPlan = (store: DocumentStore, steps: PlanStep[]): string => {
  const plan = createPlanDoc(SESSION, "ship the migration", steps)
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

const updatePlan = (store: DocumentStore, planDocId: string, mut: (p: PlanDoc) => PlanDoc): void => {
  const doc = store.get(planDocId)!
  store.update(planDocId, JSON.stringify(mut(JSON.parse(doc.body) as PlanDoc)))
}

// A real panelist runner backed by a fixed opinion table (the ONLY stubbed leaf on the C side).
const fixedPanelist = (byLens: Record<string, PanelOpinion["verdict"]>): PanelistRunner => ({ spec }) =>
  Effect.succeed({
    lens: spec.lens,
    verdict: byLens[spec.lens] ?? "approve",
    findings: [],
    confidence: 0.9,
  })

// The panel_approves port drives the REAL runPanel (real arbiter) with the fixed panelist.
const panelPort =
  (byLens: Record<string, PanelOpinion["verdict"]>) =>
  (): Effect.Effect<{ readonly decision: string }> =>
    runPanel({
      question: {
        question: "approve the destructive migration?",
        codeRefs: ["src/db/migrate.ts:12"],
        lenses: ["correctness", "security"],
        maxRounds: 1,
        policy: DEFAULT_QUORUM_POLICY,
      },
      runPanelist: fixedPanelist(byLens),
      parentSessionID: SESSION,
    }).pipe(Effect.map((verdict) => ({ decision: verdict.decision })))

const ports = (panelByLens: Record<string, PanelOpinion["verdict"]>): GraderPorts => ({
  runTests: () => Effect.succeed({ pass: true }),
  diagnostics: () => Effect.succeed({ maxSeverity: null }),
  reviewerClean: () => Effect.succeed({ pass: true }),
  panelApproves: panelPort(panelByLens),
})

const deps = (store: DocumentStore, executor: StepExecutor, panelByLens: Record<string, PanelOpinion["verdict"]>): ControllerDeps => ({
  store,
  ports: ports(panelByLens),
  executor,
  rollback: () => Effect.void,
  now: () => Date.now(),
})

describe("V3.9 §G — B/C/D closed loop (real controller + real panel + real archiver)", () => {
  test("Goal Loop convenes the real Panel; panel approves + plan complete → done; trajectory → Wiki archive", async () => {
    const store = freshStore()
    // A 2-step plan; the executor advances one step per tick until all done (writes plan versions).
    const planDocId = putPlan(store, [step("a", "active"), step("b", "pending")])

    const stepExecutor: StepExecutor = ({ planDocId }) =>
      Effect.sync(() => {
        updatePlan(store, planDocId, (p) => {
          const steps = p.steps.map((s) => ({ ...s }))
          const active = steps.find((s) => s.status === "active")
          if (active) {
            active.status = "done"
            const nextPending = steps.find((s) => s.status === "pending")
            if (nextPending) nextPending.status = "active"
            return { ...p, steps, active_step_id: nextPending?.step_id ?? null }
          }
          return { ...p, steps }
        })
        return { tokensUsed: 100, cost: 0.01 }
      })

    // criteria: plan_complete AND panel_approves — the goal is only "done" when BOTH hold, so the
    // Grader MUST actually convene the panel (§D.7 × C).
    const loop = makeGoalLoop(
      deps(store, stepExecutor, { correctness: "approve", security: "approve" }),
    )
    const spec = {
      planDocId,
      criteria: [{ kind: "plan_complete" as const }, { kind: "panel_approves" as const }],
      limits: { maxTicks: 10, maxTokens: 100_000, maxWallclockMs: 100_000 },
      stallThreshold: 5,
    }
    const handle = await Effect.runPromise(loop.start(spec))

    // Tick 1: step a→done, b→active. plan not complete yet → continue.
    expect(await Effect.runPromise(loop.tick(handle))).toBe("continue")
    // Tick 2: step b→done. plan complete AND panel approves → done.
    expect(await Effect.runPromise(loop.tick(handle))).toBe("done")

    const status = await Effect.runPromise(loop.status(handle))
    expect(status.phase).toBe("done")
    expect(status.ledger.ticks).toBe(2)
    expect(status.ledger.tokens).toBe(200)

    // §D.7 × B: the trajectory (plan + per-tick worklog) landed in the run:<sessionId> Document Graph.
    const worklogs = store.list({ type: "worklog", scope: planScope(SESSION) })
    expect(worklogs.length).toBe(2)

    // The REAL archiver aggregates plan + worklog trajectory into a Wiki archive page. This is the
    // §B.6 read path now exposed via GET /deepagent/wiki/execution-archive (WikiService.render).
    const graph = new WikiGraph([store])
    const wiki = new WikiService(graph)
    const archive = await Effect.runPromise(wiki.renderExecutionArchive({ sessionId: SESSION }))
    const types = archive.entries.map((e) => e.type)
    expect(types).toContain("plan")
    expect(types.filter((t) => t === "worklog").length).toBe(2)
    expect(archive.markdown).toContain(`Execution Archive — session ${SESSION}`)
  })

  test("§D.7 × C: a real panel BLOCK keeps the goal from completing (fail-closed) → not done", async () => {
    const store = freshStore()
    // plan is already fully done, so plan_complete is met — the ONLY thing standing between the goal
    // and `done` is the panel verdict. A high-confidence security block must prevent completion.
    const planDocId = putPlan(store, [step("a", "done")])

    // Executor bumps the plan version each tick (so ticks are not deduped) without changing statuses.
    const stepExecutor: StepExecutor = ({ planDocId }) =>
      Effect.sync(() => {
        updatePlan(store, planDocId, (p) => ({ ...p, goal: `${p.goal}.` }))
        return { tokensUsed: 10 }
      })

    const loop = makeGoalLoop(
      // security panelist BLOCKS with high confidence → real arbiter (fail-closed) → decision "block".
      deps(store, stepExecutor, { correctness: "approve", security: "block" }),
    )
    const spec = {
      planDocId,
      criteria: [{ kind: "plan_complete" as const }, { kind: "panel_approves" as const }],
      limits: { maxTicks: 10, maxTokens: 100_000, maxWallclockMs: 100_000 },
      stallThreshold: 2,
    }
    const handle = await Effect.runPromise(loop.start(spec))

    // The panel blocks → panel_approves is unmet → goal never reaches done; it stalls to needs_human.
    const outcomes: string[] = []
    for (let i = 0; i < 3; i++) outcomes.push(await Effect.runPromise(loop.tick(handle)))
    expect(outcomes).not.toContain("done")
    const status = await Effect.runPromise(loop.status(handle))
    expect(status.phase).toBe("needs_human")
    // The panel_approves gap must be in the recorded gaps (the panel really ran and blocked).
    expect(status.gaps.some((g) => g.includes("panel_approves") && g.includes("block"))).toBe(true)
  })

  test("determinism: the real arbiter yields the same panel decision across repeated goal runs", async () => {
    const run = async (): Promise<string> => {
      const store = freshStore()
      const planDocId = putPlan(store, [step("a", "done")])
      const loop = makeGoalLoop(
        deps(store, () => Effect.succeed({ tokensUsed: 1 }), { correctness: "approve", security: "approve" }),
      )
      const handle = await Effect.runPromise(
        loop.start({
          planDocId,
          criteria: [{ kind: "panel_approves" as const }],
          limits: { maxTicks: 3, maxTokens: 1000, maxWallclockMs: 1000 },
          stallThreshold: 3,
        }),
      )
      return Effect.runPromise(loop.tick(handle))
    }
    expect(await run()).toBe("done")
    expect(await run()).toBe("done")
  })
})
