import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { DocumentStore } from "@deepagent-code/core/deepagent/document-store"
import { createPlanDoc, type PlanDoc, type PlanStep, type PlanInput } from "@deepagent-code/core/deepagent/plan-controller"
import type {
  ControllerDeps,
  GraderPorts,
  StepExecutor,
  RollbackPort,
  GoalStatus,
} from "@deepagent-code/core/deepagent/goal-loop"
import {
  materializePlanDoc,
  startGoal,
  runToCompletion,
  noopPorts,
  type GoalDriverPorts,
} from "../../src/session/goal-driver"

/**
 * V3.9 §D — the Goal Driver. Verifies the production seam that goal-loop.ts + goal-loop-wiring.ts left
 * open: materialize the plan into a store doc, start the loop, drive ticks to a terminal outcome, and
 * observe status + cooperative pause/stop through the ports. The loop mechanics themselves are covered
 * by core/goal-loop.test.ts; here we assert the DRIVER wraps them correctly.
 */

let root: string
let store: DocumentStore
const SESSION = "drv-session-1"

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "goal-driver-"))
  store = new DocumentStore(root)
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const clock = () => {
  let t = 1_000
  return { now: () => t, advance: (ms: number) => (t += ms) }
}

const step = (id: string, status: PlanStep["status"]): PlanStep => ({
  step_id: id,
  title: id,
  status,
  acceptance: null,
  assigned_agent: null,
  evidence: [],
  note: null,
})

const plan = (steps: PlanStep[]): PlanDoc => createPlanDoc(SESSION, "reach the goal", steps)

const passingPorts = (): GraderPorts => ({
  runTests: () => Effect.succeed({ pass: true }),
  diagnostics: () => Effect.succeed({ maxSeverity: null }),
  reviewerClean: () => Effect.succeed({ pass: true }),
  panelApproves: () => Effect.succeed({ decision: "approve" }),
})

const noopExecutor: StepExecutor = () => Effect.succeed({ tokensUsed: 10 })
const noopRollback: RollbackPort = () => Effect.void

const controllerDeps = (over: Partial<ControllerDeps> = {}): ControllerDeps => ({
  store,
  ports: passingPorts(),
  executor: noopExecutor,
  rollback: noopRollback,
  now: clock().now,
  ...over,
})

describe("materializePlanDoc", () => {
  test("snapshots an in-memory plan into a type:plan store doc", () => {
    const id = materializePlanDoc({ store, sessionId: SESSION, plan: plan([step("a", "pending")]) })
    const doc = store.get(id)
    expect(doc?.type).toBe("plan")
    expect(doc?.scope).toBe(`run:${SESSION}`)
    const parsed = JSON.parse(doc!.body) as PlanDoc
    expect(parsed.steps[0].step_id).toBe("a")
  })

  test("is idempotent: re-materializing the SAME plan does not bump the version (INV-4)", () => {
    const p = plan([step("a", "pending")])
    const id1 = materializePlanDoc({ store, sessionId: SESSION, plan: p })
    const v1 = store.get(id1)!.version
    const id2 = materializePlanDoc({ store, sessionId: SESSION, plan: p })
    expect(id2).toBe(id1)
    expect(store.get(id2)!.version).toBe(v1)
  })

  test("an objective-seeded single-step plan is a valid goal carrier (CLI /goal <objective>)", async () => {
    // Mirrors GoalManager's seed path: no prior plan + a free-text objective → one active step.
    const seeded = createPlanDoc(SESSION, "migrate the payment module", [
      {
        step_id: "step_1",
        title: "migrate the payment module",
        status: "active",
        acceptance: null,
        assigned_agent: null,
        evidence: [],
        note: null,
      },
    ])
    const planDocId = materializePlanDoc({ store, sessionId: SESSION, plan: seeded })
    const parsed = JSON.parse(store.get(planDocId)!.body) as PlanDoc
    expect(parsed.goal).toBe("migrate the payment module")
    expect(parsed.active_step_id).toBe("step_1")

    // The goal starts from it and drives to done once the (stub) executor marks the step done.
    const deps = controllerDeps({
      executor: () =>
        Effect.sync(() => {
          store.update(planDocId, JSON.stringify(plan([step("step_1", "done")])))
          return { tokensUsed: 5 }
        }),
    })
    const { handle } = await Effect.runPromise(
      startGoal({
        deps,
        planDocId,
        criteria: [{ kind: "plan_complete" }],
        limits: { maxTicks: 10, maxTokens: 10_000, maxWallclockMs: 10_000 },
      }),
    )
    expect(await Effect.runPromise(runToCompletion({ deps, handle }))).toBe("done")
  })
})

describe("startGoal + runToCompletion", () => {
  test("a plan already complete + all criteria met ⇒ done", async () => {
    const planDocId = materializePlanDoc({ store, sessionId: SESSION, plan: plan([step("a", "done")]) })
    const deps = controllerDeps()
    const { handle } = await Effect.runPromise(
      startGoal({
        deps,
        planDocId,
        criteria: [{ kind: "plan_complete" }],
        limits: { maxTicks: 10, maxTokens: 10_000, maxWallclockMs: 10_000 },
      }),
    )
    const outcome = await Effect.runPromise(runToCompletion({ deps, handle }))
    expect(outcome).toBe("done")
  })

  test("onStatus port is called with the loop status after a tick", async () => {
    const planDocId = materializePlanDoc({ store, sessionId: SESSION, plan: plan([step("a", "done")]) })
    const deps = controllerDeps()
    const seen: GoalStatus[] = []
    const ports: GoalDriverPorts = {
      ...noopPorts,
      onStatus: (s) => Effect.sync(() => void seen.push(s)),
    }
    const { handle } = await Effect.runPromise(
      startGoal({
        deps,
        planDocId,
        criteria: [{ kind: "plan_complete" }],
        limits: { maxTicks: 10, maxTokens: 10_000, maxWallclockMs: 10_000 },
      }),
    )
    await Effect.runPromise(runToCompletion({ deps, handle, ports }))
    expect(seen.length).toBeGreaterThan(0)
    expect(seen[seen.length - 1].phase).toBe("done")
  })

  test("shouldStop halts the driver before ticking ⇒ needs_human", async () => {
    const planDocId = materializePlanDoc({ store, sessionId: SESSION, plan: plan([step("a", "pending")]) })
    const deps = controllerDeps()
    const ports: GoalDriverPorts = { ...noopPorts, shouldStop: () => Effect.succeed(true) }
    const { handle } = await Effect.runPromise(
      startGoal({
        deps,
        planDocId,
        criteria: [{ kind: "plan_complete" }],
        limits: { maxTicks: 10, maxTokens: 10_000, maxWallclockMs: 10_000 },
      }),
    )
    const outcome = await Effect.runPromise(runToCompletion({ deps, handle, ports }))
    expect(outcome).toBe("needs_human")
  })

  test("shouldPause suspends without a terminal outcome (resumes on next run)", async () => {
    const planDocId = materializePlanDoc({ store, sessionId: SESSION, plan: plan([step("a", "pending")]) })
    const deps = controllerDeps()
    let paused = true
    const ports: GoalDriverPorts = { ...noopPorts, shouldPause: () => Effect.succeed(paused) }
    const { handle } = await Effect.runPromise(
      startGoal({
        deps,
        planDocId,
        criteria: [{ kind: "plan_complete" }],
        limits: { maxTicks: 10, maxTokens: 10_000, maxWallclockMs: 10_000 },
      }),
    )
    // Paused ⇒ the driver returns "continue" without marking terminal.
    const first = await Effect.runPromise(runToCompletion({ deps, handle, ports }))
    expect(first).toBe("continue")
    // Unpause + complete the plan ⇒ resuming drives to done.
    paused = false
    store.update(planDocId, JSON.stringify(plan([step("a", "done")])))
    const second = await Effect.runPromise(runToCompletion({ deps, handle, ports }))
    expect(second).toBe("done")
  })
})

describe("V4.1 §S2 — goal plan hot-edit port (pendingPlanEdit / markPlanEditConsumed)", () => {
  test("drains a pending plan edit BETWEEN ticks, applies it to the durable doc, then stamps consumed", async () => {
    const planDocId = materializePlanDoc({ store, sessionId: SESSION, plan: plan([step("a", "pending")]) })
    const deps = controllerDeps()

    // One pending edit, delivered on the FIRST iteration then cleared by markPlanEditConsumed.
    let pending: PlanInput | null = { goal: "reach the goal", steps: [{ step_id: "a", title: "renamed", status: "pending" }] }
    let consumedCount = 0
    let consumedWith: PlanInput | null = null
    const ports: GoalDriverPorts = {
      ...noopPorts,
      pendingPlanEdit: () => Effect.succeed(pending),
      // The driver passes the EXACT edit it drained+applied so the port can identity-guard the clear.
      markPlanEditConsumed: (applied) =>
        Effect.sync(() => {
          consumedCount += 1
          consumedWith = applied
          pending = null
        }),
    }
    const { handle } = await Effect.runPromise(
      startGoal({
        deps,
        planDocId,
        criteria: [{ kind: "plan_complete" }],
        limits: { maxTicks: 10, maxTokens: 10_000, maxWallclockMs: 10_000 },
      }),
    )

    // The plan never completes (step stays pending, executor is a no-op) so the run stalls out; what we
    // assert is that the edit landed on the durable doc and was consumed exactly once.
    await Effect.runPromise(runToCompletion({ deps, handle, ports }))

    const revised = JSON.parse(store.get(planDocId)!.body) as PlanDoc
    expect(revised.steps[0].title).toBe("renamed")
    expect(consumedCount).toBe(1)
    // The consume call received the SAME edit object the driver applied (enables the manager's identity
    // guard so a newer edit admitted mid-apply is not clobbered).
    expect(consumedWith).not.toBeNull()
    expect((consumedWith as unknown as PlanInput).steps[0]!.title).toBe("renamed")
  })

  test("a pendingPlanEdit port DEFECT does not crash the driver (degrades to no edit this iteration)", async () => {
    const planDocId = materializePlanDoc({ store, sessionId: SESSION, plan: plan([step("a", "done")]) })
    const deps = controllerDeps()
    const ports: GoalDriverPorts = {
      ...noopPorts,
      pendingPlanEdit: () => Effect.die(new Error("port blew up")),
    }
    const { handle } = await Effect.runPromise(
      startGoal({
        deps,
        planDocId,
        criteria: [{ kind: "plan_complete" }],
        limits: { maxTicks: 10, maxTokens: 10_000, maxWallclockMs: 10_000 },
      }),
    )
    // The plan is already complete; despite the throwing port, the driver still drives to done.
    const outcome = await Effect.runPromise(runToCompletion({ deps, handle, ports }))
    expect(outcome).toBe("done")
  })

  test("no pending edit (null) ⇒ the goal runs exactly as before, doc untouched", async () => {
    const planDocId = materializePlanDoc({ store, sessionId: SESSION, plan: plan([step("a", "done")]) })
    const v0 = store.get(planDocId)!.version
    const deps = controllerDeps()
    let consumed = false
    const ports: GoalDriverPorts = {
      ...noopPorts,
      pendingPlanEdit: () => Effect.succeed(null),
      markPlanEditConsumed: () => Effect.sync(() => (consumed = true)),
    }
    const { handle } = await Effect.runPromise(
      startGoal({
        deps,
        planDocId,
        criteria: [{ kind: "plan_complete" }],
        limits: { maxTicks: 10, maxTokens: 10_000, maxWallclockMs: 10_000 },
      }),
    )
    const outcome = await Effect.runPromise(runToCompletion({ deps, handle, ports }))
    expect(outcome).toBe("done")
    expect(consumed).toBe(false)
    expect(store.get(planDocId)!.version).toBe(v0)
  })
})
