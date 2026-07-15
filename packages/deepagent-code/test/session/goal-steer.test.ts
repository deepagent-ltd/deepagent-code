import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { DocumentStore } from "@deepagent-code/core/deepagent/document-store"
import { createPlanDoc, type PlanDoc, type PlanStep } from "@deepagent-code/core/deepagent/plan-controller"
import type {
  ControllerDeps,
  GraderPorts,
  StepExecutor,
  RollbackPort,
} from "@deepagent-code/core/deepagent/goal-loop"
import { SessionMessage } from "@deepagent-code/core/session/message"
import {
  materializePlanDoc,
  startGoal,
  runToCompletion,
  noopPorts,
  makeGoalSteerRelay,
  type GoalDriverPorts,
  type PendingGoalSteer,
} from "../../src/session/goal-driver"
import { buildStepExecutor, renderStepPrompt, type SubagentTurnRunner } from "../../src/session/goal-loop-wiring"
import { isTerminalGoalPhase } from "../../src/session/goal-manager"

/**
 * V4.1 §S1.3 — GOAL-TICK STEERING. A long-running goal absorbs a user steering message BETWEEN ticks:
 * the driver drains a goal-directed steer (admitted to the GOAL session's buffer), the shared relay
 * threads it into the NEXT tick's step prompt, and it is consumed once per successful tick (at-least-once
 * ADVISORY delivery — no-loss, re-threaded on crash-before-stamp, NOT exactly-once). These tests drive
 * the REAL composition — real `runToCompletion` + real `buildStepExecutor` + real relay + real
 * `renderStepPrompt` — over an in-memory steer store that models SessionSteer's consume-once semantics
 * (persist-first read + consumed-once guard), so no DB/LLM is needed while the seam runs for real.
 */

let root: string
let store: DocumentStore
const GOAL_SESSION = "goal-session-1"
// The goal-worker turns run in FRESH child session ids (see makeTaskSubagentRunner). S1.1's intra-turn
// drain reads the CHILD's buffer; the driver reads the GOAL's. Different keys ⇒ no double-consume.
const CHILD_SESSION = "child-session-1"

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "goal-steer-"))
  store = new DocumentStore(root)
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const step = (id: string, status: PlanStep["status"]): PlanStep => ({
  step_id: id,
  title: id,
  status,
  acceptance: null,
  assigned_agent: null,
  evidence: [],
  note: null,
})

const plan = (steps: PlanStep[]): PlanDoc => createPlanDoc(GOAL_SESSION, "reach the goal", steps)

const passingPorts = (): GraderPorts => ({
  runTests: () => Effect.succeed({ pass: true }),
  diagnostics: () => Effect.succeed({ maxSeverity: null }),
  reviewerClean: () => Effect.succeed({ pass: true }),
  panelApproves: () => Effect.succeed({ decision: "approve" }),
})

const noopRollback: RollbackPort = () => Effect.void

const controllerDeps = (executor: StepExecutor): ControllerDeps => ({
  store,
  ports: passingPorts(),
  executor,
  rollback: noopRollback,
  now: () => 1_000,
})

// ── An in-memory steer store modelling SessionSteer, keyed by session id (consume-once). ────────────
// Mirrors the DB service: admit is idempotent on id; pending is a NON-consuming read of unconsumed rows
// for a session; markConsumed stamps only still-pending ids (the `consumed_seq IS NULL` guard).
type SteerRow = { id: SessionMessage.ID; sessionId: string; text: string; consumed: boolean }
const makeSteerStore = () => {
  const rows: SteerRow[] = []
  return {
    admit: (sessionId: string, text: string, id: SessionMessage.ID = SessionMessage.ID.create()) => {
      if (!rows.some((r) => r.id === id)) rows.push({ id, sessionId, text, consumed: false })
      return id
    },
    pending: (sessionId: string): ReadonlyArray<PendingGoalSteer> =>
      rows.filter((r) => r.sessionId === sessionId && !r.consumed).map((r) => ({ id: r.id, text: r.text })),
    markConsumed: (sessionId: string, ids: ReadonlyArray<SessionMessage.ID>) => {
      for (const r of rows) {
        if (r.sessionId === sessionId && !r.consumed && ids.includes(r.id)) r.consumed = true
      }
    },
    rows,
  }
}

// The GoalManager's goalSteerPort, over the in-memory store, keyed on the GOAL session id. `markCalls`
// records every markConsumed invocation so we can assert consume-EXACTLY-once.
const goalSteerPort = (
  steerStore: ReturnType<typeof makeSteerStore>,
  sessionId: string,
  markCalls: SessionMessage.ID[][],
): Pick<GoalDriverPorts, "pendingSteer" | "markSteerConsumed"> => ({
  pendingSteer: () => Effect.sync(() => steerStore.pending(sessionId)),
  markSteerConsumed: (ids) =>
    Effect.sync(() => {
      markCalls.push([...ids])
      steerStore.markConsumed(sessionId, ids)
    }),
})

describe("§S1.3 renderStepPrompt — mid-run steering threads into the step prompt (cache-safe tail)", () => {
  const base = { goalId: "g1", sessionId: GOAL_SESSION, planDocId: "plan-doc", activeStepId: "step_1" as string | null }

  test("no steer ⇒ prompt is unchanged (base behaviour)", () => {
    const withEmpty = renderStepPrompt({ ...base, steer: [] })
    const without = renderStepPrompt(base)
    expect(withEmpty).toBe(without)
    expect(withEmpty).not.toContain("USER GUIDANCE")
  })

  test("a staged steer is rendered as a clearly-marked USER GUIDANCE section, ahead of the advance line", () => {
    const prompt = renderStepPrompt({
      ...base,
      steer: [{ id: SessionMessage.ID.create(), text: "also handle the empty-input edge case" }],
    })
    expect(prompt).toContain("USER GUIDANCE (mid-run steering)")
    expect(prompt).toContain("also handle the empty-input edge case")
    // The guidance is INPUT (the user-message step prompt), ahead of the advance instruction so the
    // controller/step-selection weighs it — never a system prefix (renderStepPrompt returns the turn's
    // user message; there is no system-prefix channel here).
    expect(prompt.indexOf("USER GUIDANCE")).toBeLessThan(prompt.indexOf("Advance goal"))
  })

  test("multiple staged steers all appear, one bullet each", () => {
    const prompt = renderStepPrompt({
      ...base,
      steer: [
        { id: SessionMessage.ID.create(), text: "skip step 3" },
        { id: SessionMessage.ID.create(), text: "prefer the async API" },
      ],
    })
    expect(prompt).toContain("- skip step 3")
    expect(prompt).toContain("- prefer the async API")
  })
})

describe("§S1.3 goal-tick steering — absorb a steer between ticks, consumed exactly once", () => {
  test("a goal-directed steer reaches the NEXT tick's step prompt and is consumed exactly once", async () => {
    const steerStore = makeSteerStore()
    const markCalls: SessionMessage.ID[][] = []
    const steerId = steerStore.admit(GOAL_SESSION, "also handle the edge case")

    const planDocId = materializePlanDoc({ store, sessionId: GOAL_SESSION, plan: plan([step("step_1", "active")]) })

    // REAL step executor + relay: it drains the staged steer into the prompt, and (here) advances the
    // plan to done so the goal completes on the first real tick.
    const relay = makeGoalSteerRelay()
    const capturedPrompts: string[] = []
    const runTurn: SubagentTurnRunner = (turnInput) =>
      Effect.sync(() => {
        capturedPrompts.push(turnInput.prompt)
        store.update(planDocId, JSON.stringify(plan([step("step_1", "done")])))
        return { ok: true, structured: undefined, text: "", tokensUsed: 5, cost: 0 }
      })
    const executor = buildStepExecutor(runTurn, undefined, relay)
    const deps = controllerDeps(executor)

    const steerPort = goalSteerPort(steerStore, GOAL_SESSION, markCalls)
    const ports: GoalDriverPorts = { ...noopPorts, ...steerPort }

    const { handle } = await Effect.runPromise(
      startGoal({
        deps,
        planDocId,
        criteria: [{ kind: "plan_complete" }],
        limits: { maxTicks: 10, maxTokens: 10_000, maxWallclockMs: 10_000 },
      }),
    )
    const outcome = await Effect.runPromise(runToCompletion({ deps, handle, ports, steerRelay: relay }))

    expect(outcome).toBe("done")
    // The steer reached the step prompt.
    expect(capturedPrompts[0]).toContain("USER GUIDANCE (mid-run steering)")
    expect(capturedPrompts[0]).toContain("also handle the edge case")
    // Consumed EXACTLY once: one markConsumed call, carrying exactly the steer id, and the store no
    // longer lists it pending.
    expect(markCalls).toHaveLength(1)
    expect(markCalls[0]).toEqual([steerId])
    expect(steerStore.pending(GOAL_SESSION)).toHaveLength(0)
  })

  test("double-consume guard: the GOAL drain and a CHILD-session drain read DIFFERENT keys", async () => {
    const steerStore = makeSteerStore()
    const markCalls: SessionMessage.ID[][] = []
    // A goal-directed steer is admitted to the GOAL session id.
    steerStore.admit(GOAL_SESSION, "goal-directed guidance")

    // S1.1's intra-turn drain runs against the CHILD session id — it never sees the goal-directed steer.
    expect(steerStore.pending(CHILD_SESSION)).toHaveLength(0)
    // The goal driver's channel (GOAL key) DOES see it.
    expect(steerStore.pending(GOAL_SESSION)).toHaveLength(1)

    const planDocId = materializePlanDoc({ store, sessionId: GOAL_SESSION, plan: plan([step("step_1", "active")]) })
    const relay = makeGoalSteerRelay()
    const runTurn: SubagentTurnRunner = () =>
      Effect.sync(() => {
        store.update(planDocId, JSON.stringify(plan([step("step_1", "done")])))
        return { ok: true, structured: undefined, text: "", tokensUsed: 1, cost: 0 }
      })
    const deps = controllerDeps(buildStepExecutor(runTurn, undefined, relay))
    const ports: GoalDriverPorts = { ...noopPorts, ...goalSteerPort(steerStore, GOAL_SESSION, markCalls) }

    const { handle } = await Effect.runPromise(
      startGoal({
        deps,
        planDocId,
        criteria: [{ kind: "plan_complete" }],
        limits: { maxTicks: 10, maxTokens: 10_000, maxWallclockMs: 10_000 },
      }),
    )
    await Effect.runPromise(runToCompletion({ deps, handle, ports, steerRelay: relay }))

    // The GOAL driver consumed it exactly once; the CHILD-session buffer was never touched (still empty),
    // so no path double-consumes the same steer.
    expect(markCalls).toHaveLength(1)
    expect(steerStore.pending(GOAL_SESSION)).toHaveLength(0)
    expect(steerStore.pending(CHILD_SESSION)).toHaveLength(0)
  })

  test("no-loss: a steer STAGED but NOT threaded (crash before the prompt is built) is NOT consumed", async () => {
    const steerStore = makeSteerStore()
    const markCalls: SessionMessage.ID[][] = []
    steerStore.admit(GOAL_SESSION, "DONT-LOSE-ME")

    const planDocId = materializePlanDoc({ store, sessionId: GOAL_SESSION, plan: plan([step("step_1", "active")]) })
    const relay = makeGoalSteerRelay()
    // A "crash before the prompt is built": the executor dies WITHOUT ever draining the relay
    // (drainForPrompt is never called). The driver's consume-after therefore stamps NOTHING — the steer
    // stays pending in the durable buffer and is re-drained on the next iteration. This mirrors S1.1's
    // persist-first / consume-after crash safety.
    const executor: StepExecutor = () => Effect.die("crash before threading the steer")
    const deps = controllerDeps(executor)
    const ports: GoalDriverPorts = { ...noopPorts, ...goalSteerPort(steerStore, GOAL_SESSION, markCalls) }

    const { handle } = await Effect.runPromise(
      startGoal({
        deps,
        planDocId,
        criteria: [{ kind: "plan_complete" }],
        limits: { maxTicks: 10, maxTokens: 10_000, maxWallclockMs: 10_000 },
      }),
    )
    // The tick degrades the executor defect to a critical/rolled_back outcome — terminal, so the driver
    // exits without ever threading the steer.
    await Effect.runPromise(runToCompletion({ deps, handle, ports, steerRelay: relay }))

    // NOTHING was marked consumed — the steer survives, still pending, re-drainable next run (no loss).
    expect(markCalls).toHaveLength(0)
    expect(steerStore.pending(GOAL_SESSION)).toHaveLength(1)
    expect(steerStore.pending(GOAL_SESSION)[0].text).toBe("DONT-LOSE-ME")
  })

  test("noopPorts: pendingSteer returns empty and the goal runs unchanged (no goal-tick steering)", async () => {
    // noopPorts.pendingSteer resolves to empty.
    expect(await Effect.runPromise(noopPorts.pendingSteer!())).toEqual([])

    const planDocId = materializePlanDoc({ store, sessionId: GOAL_SESSION, plan: plan([step("step_1", "active")]) })
    const relay = makeGoalSteerRelay()
    const capturedPrompts: string[] = []
    const runTurn: SubagentTurnRunner = (turnInput) =>
      Effect.sync(() => {
        capturedPrompts.push(turnInput.prompt)
        store.update(planDocId, JSON.stringify(plan([step("step_1", "done")])))
        return { ok: true, structured: undefined, text: "", tokensUsed: 1, cost: 0 }
      })
    const deps = controllerDeps(buildStepExecutor(runTurn, undefined, relay))

    const { handle } = await Effect.runPromise(
      startGoal({
        deps,
        planDocId,
        criteria: [{ kind: "plan_complete" }],
        limits: { maxTicks: 10, maxTokens: 10_000, maxWallclockMs: 10_000 },
      }),
    )
    const outcome = await Effect.runPromise(runToCompletion({ deps, handle, ports: noopPorts, steerRelay: relay }))
    expect(outcome).toBe("done")
    // No steer was staged, so the prompt carries no guidance section.
    expect(capturedPrompts[0]).not.toContain("USER GUIDANCE")
  })
})

describe("§S1.3 FIX 2 — terminal-goal gate (no orphan steer/edit after a goal settles)", () => {
  // The orphan guard that promptOrSteer's goal-steer branch AND GoalManager.editPlan share: once the
  // active-goal pointer reports a TERMINAL phase, no live driver will drain again, so a goal-directed
  // steer/edit must NOT be admitted (else it would buffer a steer that is never consumed — the
  // orphan-buffer defect). "running"/"paused" are the only non-terminal phases (a paused goal resumes and
  // drains). This asserts the exact decision boundary the isTerminalGoalPhase predicate enforces.
  test("terminal phases (done / needs_human / rolled_back / stopped) are terminal; running/paused are not", () => {
    expect(isTerminalGoalPhase("done")).toBe(true)
    expect(isTerminalGoalPhase("needs_human")).toBe(true)
    expect(isTerminalGoalPhase("rolled_back")).toBe(true)
    expect(isTerminalGoalPhase("stopped")).toBe(true)
    // A goal that finished NATURALLY (done) is terminal even though its control is still non-null and
    // non-stopped (background.start has no onFinish that clears control) — this is exactly the case a
    // `!c || c.stopped` check missed, so the phase gate is what refuses the orphan admit.
    expect(isTerminalGoalPhase("running")).toBe(false)
    expect(isTerminalGoalPhase("paused")).toBe(false)
  })
})
