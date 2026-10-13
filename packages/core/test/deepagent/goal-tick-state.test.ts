import { expect, test } from "bun:test"
import { GoalTickProgram } from "../../src/deepagent/goal-tick-program"
import { GoalTickState } from "../../src/deepagent/goal-tick-state"

function state(): GoalTickState.Runtime {
  return {
    version: 2,
    goalId: "goal_fixed",
    sessionId: "ses_parent",
    planDocId: "doc:plan:parent",
    phase: "running",
    spec: {
      planDocId: "doc:plan:parent",
      criteria: [{ kind: "plan_complete" }],
      limits: { maxTicks: 50, maxTokens: 500000, maxWallclockMs: 3600000 },
      stallThreshold: 3,
    },
    ledger: { ticks: 0, tokens: 0, cost: 0, costComplete: true, wallclockMs: 0, startedAtMs: 1000 },
    stallCount: 0,
    lastFingerprint: "step:active",
    lastDoneCount: 0,
    lastEvidenceCount: 0,
    lastMetCount: 0,
    lastProcessedVersion: null,
    lastOutcome: null,
    gaps: [],
    lastDeliveredFeedback: ["initial"],
    pendingSteers: [
      { id: "steer_frozen", text: "frozen" },
      { id: "steer_later", text: "later" },
    ],
    budgetTokenScope: "gross",
    lastTransitionHash: null,
    haltReason: null,
  }
}

function transition(prior: GoalTickState.Runtime): GoalTickState.Transition {
  return {
    priorStateHash: GoalTickProgram.hash(prior),
    tickSeq: 0,
    planVersion: 1,
    finishedAt: 1200,
    phase: "running",
    outcome: "continue",
    fingerprint: "step:active",
    doneCount: 0,
    evidenceCount: 0,
    metCount: 0,
    gaps: ["work remains"],
    deliveredFeedback: prior.lastDeliveredFeedback,
    consumedSteers: ["steer_frozen"],
    usage: [
      { inputID: "msg_worker", input: 10, output: 5, cacheRead: 3, cacheWrite: 2, cost: 0.1 },
      { inputID: "msg_reviewer", input: 20, output: 10, cacheRead: 0, cacheWrite: 0, cost: null },
    ],
  }
}

test("full state reducer preserves original spec, accounting and undelivered steering; all stage totals count once", () => {
  const prior = state()
  const step = transition(prior)
  const next = GoalTickState.reduce(prior, step)
  expect(next.ledger).toEqual({
    ticks: 1,
    tokens: 45,
    cost: 0.1,
    costComplete: false,
    startedAtMs: 1000,
    wallclockMs: 200,
  })
  expect(next.pendingSteers).toEqual([{ id: "steer_later", text: "later" }])
  expect(next.spec).toEqual(prior.spec)
  expect(next.stallCount).toBe(1)
  expect(GoalTickState.reduce(next, step)).toBe(next)
  expect(prior.ledger.ticks).toBe(0)
})

test("net accounting uses inclusive output without adding reasoning again", () => {
  const prior = { ...state(), budgetTokenScope: "net" as const }
  const next = GoalTickState.reduce(prior, transition(prior))
  expect(next.ledger.tokens).toBe(40)
})

test("phase cannot contradict outcome and incomplete cost cannot satisfy an explicit monetary limit", () => {
  const prior = state()
  expect(() => GoalTickState.reduce(prior, { ...transition(prior), phase: "done" })).toThrow("disagree")
  const bounded = { ...prior, spec: { ...prior.spec, limits: { ...prior.spec.limits, maxCost: 5 } } }
  const next = GoalTickState.reduce(bounded, { ...transition(bounded), phase: "done", outcome: "done" })
  expect(next.phase).toBe("needs_human")
  expect(next.ledger.costComplete).toBe(false)
  expect(next.ledger.cost).toBe(0.1)
  expect(next.lastOutcome).toBe("needs_human")
})

test("stale state, duplicate usage, unfrozen steering, unknown or overflowing counts are rejected", () => {
  const prior = state()
  const step = transition(prior)
  expect(() => GoalTickState.reduce({ ...prior, stallCount: 1 }, step)).toThrow("frozen")
  expect(() => GoalTickState.reduce(prior, { ...step, usage: [...step.usage, step.usage[0]] })).toThrow("duplicates")
  expect(() => GoalTickState.reduce(prior, { ...step, consumedSteers: ["not_frozen"] })).toThrow("unfrozen")
  expect(() =>
    GoalTickState.reduce(prior, {
      ...step,
      usage: [{ ...step.usage[0], input: Number.MAX_SAFE_INTEGER, output: Number.MAX_SAFE_INTEGER }],
    }),
  ).toThrow()
  expect(() => GoalTickState.reduce(prior, { ...step, usage: [{ ...step.usage[0], input: 1 }] })).toThrow(
    "inconsistent",
  )
  expect(() =>
    GoalTickState.requireState({ ...prior, gaps: Array.from({ length: 64 }, () => "\u0000".repeat(4096)) }),
  ).toThrow("encoded")
})
