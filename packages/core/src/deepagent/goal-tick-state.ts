export * as GoalTickState from "./goal-tick-state"

import { Schema } from "effect"
import { GoalSpec, GoalPhase, TickOutcome, BudgetTokenScope } from "./goal-loop"
import { GoalTickProgram } from "./goal-tick-program"

const Count = GoalTickProgram.Count
const Ref = GoalTickProgram.Ref
const Text = Schema.String.check(Schema.isMaxLength(4096))
const Ledger = Schema.Struct({
  ticks: Count,
  tokens: Count,
  // Retain the known subtotal, but never interpret incomplete cost accounting as zero or a proven cap.
  cost: Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0)),
  costComplete: Schema.Boolean,
  wallclockMs: Count,
  startedAtMs: Count,
})
export const RuntimeV2 = Schema.Struct({
  version: Schema.Literal(2),
  goalId: Ref,
  spec: GoalSpec,
  planDocId: Ref,
  sessionId: Ref,
  phase: GoalPhase,
  ledger: Ledger,
  stallCount: Count,
  lastFingerprint: Schema.NullOr(Text),
  lastDoneCount: Count,
  lastEvidenceCount: Count,
  lastMetCount: Count,
  lastProcessedVersion: Schema.NullOr(Count),
  lastOutcome: Schema.NullOr(TickOutcome),
  gaps: Schema.Array(Text).check(Schema.isMaxLength(64)),
  lastDeliveredFeedback: Schema.Array(Text).check(Schema.isMaxLength(64)),
  pendingSteers: Schema.Array(Schema.Struct({ id: Ref, text: Text })).check(Schema.isMaxLength(256)),
  budgetTokenScope: BudgetTokenScope,
  // A deterministic reducer frontier. The store must bind this to the actual committed checkpoint.
  lastTransitionHash: Schema.NullOr(GoalTickProgram.Hash),
  haltReason: Schema.NullOr(Schema.Literals(["cost_unknown", "cost_exceeded"])),
})
export const RuntimeV3 = Schema.Struct({
  ...RuntimeV2.fields,
  version: Schema.Literal(3),
  planLineage: GoalTickProgram.PlanLineage,
})
export const Runtime = Schema.Union([RuntimeV2, RuntimeV3])
export type Runtime = typeof Runtime.Type

export const Transition = Schema.Struct({
  priorStateHash: GoalTickProgram.Hash,
  tickSeq: Count,
  planVersion: Count,
  finishedAt: Count,
  phase: GoalPhase,
  outcome: TickOutcome,
  fingerprint: Text,
  doneCount: Count,
  evidenceCount: Count,
  metCount: Count,
  gaps: Schema.Array(Text).check(Schema.isMaxLength(64)),
  deliveredFeedback: Schema.Array(Text).check(Schema.isMaxLength(64)),
  consumedSteers: Schema.Array(Ref).check(Schema.isMaxLength(256)),
  // Per-stage actual inclusive totals. This DTO is deliberately not an opaque verified result.
  usage: Schema.Array(
    Schema.Struct({
      inputID: Ref,
      input: Count,
      output: Count,
      cacheRead: Count,
      cacheWrite: Count,
      cost: Schema.NullOr(Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0))),
    }),
  ).check(Schema.isMaxLength(192)),
})
export type Transition = typeof Transition.Type

export function remainingBudget(state: Runtime, now = Date.now()) {
  return state.ledger.ticks < state.spec.limits.maxTicks &&
    state.ledger.tokens < state.spec.limits.maxTokens &&
    now - state.ledger.startedAtMs < state.spec.limits.maxWallclockMs &&
    (state.spec.limits.maxCost === undefined ||
      (state.ledger.costComplete && state.ledger.cost < state.spec.limits.maxCost))
}

export function requireState(state: Runtime) {
  if (
    !Schema.is(Runtime)(state) ||
    state.spec.planDocId !== state.planDocId ||
    state.spec.criteria.length < 1 ||
    state.spec.criteria.length > 64 ||
    state.spec.limits.maxTicks < 1 ||
    state.spec.limits.maxTokens < 1 ||
    state.spec.limits.maxWallclockMs < 1 ||
    state.spec.stallThreshold < 1 ||
    new Set(state.pendingSteers.map((item) => item.id)).size !== state.pendingSteers.length
  )
    throw new GoalTickProgram.Error({ code: "PROGRAM_INVALID", message: "Full Goal runtime state is invalid" })
  if (
    [
      state.spec.limits.maxTicks,
      state.spec.limits.maxTokens,
      state.spec.limits.maxWallclockMs,
      state.spec.stallThreshold,
    ].some((value) => !Number.isSafeInteger(value)) ||
    (state.spec.limits.maxCost !== undefined &&
      (!Number.isFinite(state.spec.limits.maxCost) || state.spec.limits.maxCost <= 0))
  )
    throw invalid("Goal limits are not finite positive bounds")
  // Both copies reserve their own JSON-string encoding, including control-character escaping.
  if (GoalTickProgram.bytes(GoalTickProgram.canonical(state)) > 131072)
    throw new GoalTickProgram.Error({
      code: "PROGRAM_CAPACITY",
      message: "Full Goal runtime state exceeds its encoded slot",
    })
  return state
}

/** Pure preparation only. The SQL caller must supply verified facts and persist state+proof in one transaction. */
export function reduce(
  prior: Runtime,
  transition: Transition,
  frozenSteers: Runtime["pendingSteers"] = prior.pendingSteers,
) {
  requireState(prior)
  if (!Schema.is(Transition)(transition)) throw invalid("Transition shape is invalid")
  const phases = { continue: "running", done: "done", needs_human: "needs_human", rolled_back: "rolled_back" } as const
  if (transition.phase !== phases[transition.outcome]) throw invalid("Outcome and phase disagree")
  const transitionHash = GoalTickProgram.hash(transition)
  if (prior.lastTransitionHash === transitionHash) return prior
  if (
    transition.priorStateHash !== GoalTickProgram.hash(prior) ||
    transition.tickSeq !== prior.ledger.ticks ||
    prior.phase !== "running" ||
    transition.finishedAt < prior.ledger.startedAtMs + prior.ledger.wallclockMs
  )
    throw invalid("Transition does not follow the frozen state")
  if (
    new Set(transition.usage.map((item) => item.inputID)).size !== transition.usage.length ||
    new Set(transition.consumedSteers).size !== transition.consumedSteers.length ||
    new Set(frozenSteers.map((item) => item.id)).size !== frozenSteers.length ||
    transition.consumedSteers.some((id) => !frozenSteers.some((item) => item.id === id))
  )
    throw invalid("Transition duplicates results or consumes an unfrozen steer")
  const tokens = transition.usage.reduce((sum, item) => {
    if (item.cacheRead + item.cacheWrite > item.input) throw invalid("Inclusive input usage is inconsistent")
    return (
      sum +
      item.output +
      (prior.budgetTokenScope === "net" ? item.input - item.cacheRead - item.cacheWrite : item.input)
    )
  }, 0)
  const progressed =
    transition.doneCount > prior.lastDoneCount ||
    transition.evidenceCount > prior.lastEvidenceCount ||
    transition.metCount > prior.lastMetCount
  const costComplete = prior.ledger.costComplete && transition.usage.every((item) => item.cost !== null)
  const cost = transition.usage.reduce((sum, item) => sum + (item.cost ?? 0), prior.ledger.cost)
  const costBlocked = prior.spec.limits.maxCost !== undefined && (!costComplete || cost > prior.spec.limits.maxCost)
  return requireState({
    ...prior,
    phase: costBlocked ? "needs_human" : phases[transition.outcome],
    ledger: {
      ...prior.ledger,
      ticks: prior.ledger.ticks + 1,
      tokens: prior.ledger.tokens + tokens,
      cost,
      costComplete,
      wallclockMs: transition.finishedAt - prior.ledger.startedAtMs,
    },
    stallCount: progressed ? 0 : prior.stallCount + 1,
    lastFingerprint: transition.fingerprint,
    lastDoneCount: transition.doneCount,
    lastEvidenceCount: transition.evidenceCount,
    lastMetCount: transition.metCount,
    lastProcessedVersion: transition.planVersion,
    lastOutcome: costBlocked ? "needs_human" : transition.outcome,
    gaps: transition.gaps,
    lastDeliveredFeedback: transition.deliveredFeedback,
    pendingSteers: prior.pendingSteers.filter((item) => !transition.consumedSteers.includes(item.id)),
    lastTransitionHash: transitionHash,
    haltReason: costBlocked ? (costComplete ? "cost_exceeded" : "cost_unknown") : null,
  })
}

function invalid(message: string) {
  return new GoalTickProgram.Error({ code: "PROGRAM_CONFLICT", message })
}
