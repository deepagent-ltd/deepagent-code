import type { ReviewFinding } from "../agent/schema/orchestration"
import {
  type PanelOpinion,
  type PanelVerdict,
  type PanelDecision,
  type QuorumPolicy,
  type PanelLens,
  PANEL_LENSES,
} from "../agent/schema/panel"

/**
 * V3.9 §C.6 — Panel Arbiter. The CORE deterministic aggregation: consumes every `PanelOpinion` and
 * produces a `PanelVerdict`. This is NON-LLM, PURE, and DETERMINISTIC — the single highest-value
 * correctness target of §C.
 *
 * Determinism contract (§C.8): `arbitrate(opinions, policy)` depends ONLY on its arguments. It does
 * NOT read the clock, does NOT use randomness, does NOT mutate its inputs, and iterates in a stable
 * order (the fixed `PANEL_LENSES` order, then arrival order within a lens). Same opinions + same
 * policy → byte-identical verdict, every time.
 *
 * The §C.6 rule table, implemented in this exact precedence (the ORDER below matches the code):
 *   1. fail-closed / 阻断优先 : any `block` with confidence ≥ policy.blockThreshold ⇒ final `block`.
 *   2. quorum floor           : surviving opinions < policy.minQuorum ⇒ `needs_human`.
 *   3. weighted majority      : tally weight = confidence × lens-relevance, block/revise votes with
 *                               no reproducible evidence are down-weighted (证据要求); an all-zero
 *                               tally escalates rather than manufacturing a conservative block.
 *   4. tie (revise vs approve): resolve to the more conservative side (`revise`) + `needs_human`.
 *   5. critical dissent       : any OVERRULED opinion carrying a `critical` finding ⇒ `needs_human`.
 *
 * Note on ordering: the fail-closed check and quorum floor run FIRST — a high-confidence block is an
 * unambiguous, decidable outcome that never needs a human, and a sub-quorum panel must escalate rather
 * than let a thin majority decide. Critical-dissent is evaluated LAST (after the tally + tie), not
 * before: "dissent" is only defined once a winning decision exists, so it can only escalate an
 * already-computed decision. Because escalation is a monotonic OR onto `needs_human`, evaluating it
 * last is both the only implementable order and outcome-equivalent to any earlier placement.
 */

/** Clamp a possibly-malformed confidence into [0,1] so one bad opinion cannot distort the tally. */
export const clampConfidence = (value: number): number => {
  if (!Number.isFinite(value)) return 0
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

/** Non-negative lens-relevance weight for `lens` under `policy` (absent ⇒ 1, negative ⇒ 0). */
export const lensWeight = (lens: PanelLens, policy: QuorumPolicy): number => {
  const w = policy.lensWeights[lens]
  if (w == null || !Number.isFinite(w)) return 1
  return w < 0 ? 0 : w
}

/**
 * §C.6 证据要求: an opinion has reproducible evidence when at least one finding carries a non-empty
 * `failureScenario` OR a concrete code reference (a file path, optionally with a line). An `approve`
 * opinion needs no failure evidence (there is no failure to reproduce), so it is always "supported".
 */
const hasReproducibleEvidence = (opinion: PanelOpinion): boolean => {
  if (opinion.verdict === "approve") return true
  return opinion.findings.some((f: ReviewFinding) => {
    const scenario = (f.failureScenario ?? "").trim()
    if (scenario.length > 0) return true
    const file = (f.file ?? "").trim()
    return file.length > 0
  })
}

/** Whether an opinion contains a `critical`-severity finding. */
const hasCriticalFinding = (opinion: PanelOpinion): boolean =>
  opinion.findings.some((f: ReviewFinding) => f.severity === "critical")

/**
 * The effective tally weight of one opinion under `policy`:
 *   weight = clamp(confidence) × lensWeight(lens) × (evidence ? 1 : unsupportedVoteWeight)
 * The evidence factor only ever applies to block/revise votes (approve is always supported), so an
 * evidence-less block is worth strictly less than an otherwise-identical block WITH evidence.
 */
export const opinionWeight = (opinion: PanelOpinion, policy: QuorumPolicy): number => {
  const base = clampConfidence(opinion.confidence) * lensWeight(opinion.lens, policy)
  if (hasReproducibleEvidence(opinion)) return base
  const factor = Number.isFinite(policy.unsupportedVoteWeight)
    ? Math.max(0, Math.min(1, policy.unsupportedVoteWeight))
    : 1
  return base * factor
}

/** Collect the unique, non-empty evidence strings (failureScenario + code ref) from opinions. */
const collectEvidence = (opinions: readonly PanelOpinion[]): string[] => {
  const seen = new Set<string>()
  const out: string[] = []
  for (const op of opinions) {
    for (const f of op.findings) {
      const scenario = (f.failureScenario ?? "").trim()
      const file = (f.file ?? "").trim()
      const ref = file.length > 0 ? (f.line != null ? `${file}:${f.line}` : file) : ""
      const parts = [scenario, ref].filter((s) => s.length > 0)
      if (parts.length === 0) continue
      const line = `[${op.lens}] ${parts.join(" — ")}`
      if (seen.has(line)) continue
      seen.add(line)
      out.push(line)
    }
  }
  return out
}

/** Stable sort key: fixed lens order, then original arrival index (assigned by the caller). */
const lensOrder = (lens: PanelLens): number => {
  const i = PANEL_LENSES.indexOf(lens)
  return i < 0 ? PANEL_LENSES.length : i
}

/**
 * Deterministically order opinions so any downstream iteration (dissent[], evidence[]) is stable
 * regardless of the order the orchestrator collected them in (panelists finish concurrently).
 */
const orderOpinions = (opinions: readonly PanelOpinion[]): PanelOpinion[] =>
  opinions
    .map((op, index) => ({ op, index }))
    .sort((a, b) => {
      const lo = lensOrder(a.op.lens) - lensOrder(b.op.lens)
      if (lo !== 0) return lo
      return a.index - b.index
    })
    .map((x) => x.op)

/** The rounded, clamped aggregate confidence backing a decision (mean of the contributing votes). */
const aggregateConfidence = (opinions: readonly PanelOpinion[]): number => {
  if (opinions.length === 0) return 0
  const sum = opinions.reduce((acc, op) => acc + clampConfidence(op.confidence), 0)
  return sum / opinions.length
}

/**
 * §C.6 — the deterministic quorum decision. `opinions` are the SURVIVING panelist opinions (the
 * orchestrator has already dropped failed/timed-out panelists per §C.8). `rounds` is the actual
 * number of debate rounds run, threaded through onto the verdict.
 */
export const arbitrate = (
  opinions: readonly PanelOpinion[],
  policy: QuorumPolicy,
  rounds = 1,
): PanelVerdict => {
  const ordered = orderOpinions(opinions)

  // ---- Rule 1: fail-closed / 阻断优先 -------------------------------------------------------
  // Any block whose confidence clears the threshold forces `block`, regardless of the majority.
  const highConfBlocks = ordered.filter(
    (op) => op.verdict === "block" && clampConfidence(op.confidence) >= policy.blockThreshold,
  )
  if (highConfBlocks.length > 0) {
    // Dissent = every non-block opinion (they were overruled by the block).
    const dissent = ordered.filter((op) => op.verdict !== "block")
    return {
      decision: "block",
      dissent,
      evidence: collectEvidence(highConfBlocks),
      confidence: aggregateConfidence(highConfBlocks),
      rounds,
    }
  }

  // ---- Rule 2: quorum floor (§C.8 优雅降级) -------------------------------------------------
  // Below the minimum number of surviving votes ⇒ escalate; NEVER silently approve.
  if (ordered.length < policy.minQuorum) {
    return {
      decision: "needs_human",
      dissent: ordered,
      evidence: collectEvidence(ordered),
      confidence: aggregateConfidence(ordered),
      rounds,
    }
  }

  // ---- Weighted tally (§C.6 加权多数) -------------------------------------------------------
  const tally: Record<PanelVerdict["decision"], number> = {
    approve: 0,
    revise: 0,
    block: 0,
    needs_human: 0,
  }
  for (const op of ordered) tally[op.verdict] += opinionWeight(op, policy)

  const approve = tally.approve
  const revise = tally.revise
  const block = tally.block

  // Degenerate all-zero tally (every surviving opinion has effective weight 0 — e.g. all confidence 0,
  // or all lens weights 0). There is NO real signal to decide on, so escalate rather than let the
  // conservative tie-break manufacture a `block` from a set that contains no meaningful block vote.
  // (Without this, three zero-confidence `approve`s could resolve to `block` under a custom policy with
  // tieToConservativeNeedsHuman:false — a unanimous, if weak, approval becoming a hard block.)
  if (approve <= 0 && revise <= 0 && block <= 0) {
    return {
      decision: "needs_human",
      dissent: ordered,
      evidence: collectEvidence(ordered),
      confidence: aggregateConfidence(ordered),
      rounds,
    }
  }

  // Determine the winner among the three real verdicts. Ties are handled explicitly below;
  // conservative ordering (block > revise > approve) is the deterministic tie-break WITHIN the
  // "which is strictly largest" comparison and also the conservative fallback direction.
  const max = Math.max(approve, revise, block)

  // Identify tie membership at the top weight (within a tiny epsilon for float robustness).
  const EPS = 1e-9
  const atMax = (v: number) => Math.abs(v - max) <= EPS
  const topBlock = atMax(block)
  const topRevise = atMax(revise)
  const topApprove = atMax(approve)

  // ---- Rule 5 (part): conservative tie handling (§C.6 平票 → 向保守侧倒 + needs_human) ------
  // A tie that INCLUDES approve and at least one more-conservative verdict resolves to the
  // conservative side and is flagged needs_human. A block that ties (low-confidence, since a
  // high-confidence block already returned) still leans to the conservative winner.
  let decision: PanelDecision
  let escalate = false

  if (topBlock && (topRevise || topApprove)) {
    // block ties with a softer verdict — conservative side is block; but since the block was NOT
    // high-confidence (Rule 1 didn't fire), a genuine split warrants a human look.
    decision = "block"
    escalate = policy.tieToConservativeNeedsHuman
  } else if (topRevise && topApprove) {
    // revise vs approve tie ⇒ revise (more conservative) + needs_human.
    decision = "revise"
    escalate = policy.tieToConservativeNeedsHuman
  } else if (topBlock) {
    decision = "block"
  } else if (topRevise) {
    decision = "revise"
  } else {
    decision = "approve"
  }

  // The winners set (opinions whose verdict == decision) and the overruled dissent.
  const winners = ordered.filter((op) => op.verdict === decision)
  const dissent = ordered.filter((op) => op.verdict !== decision)

  // ---- Rule 3: critical dissent escalation (§C.6 dissent 涉 critical → needs_human) ---------
  if (policy.criticalDissentNeedsHuman && dissent.some(hasCriticalFinding)) {
    escalate = true
  }

  return {
    decision: escalate ? "needs_human" : decision,
    dissent,
    // Evidence backs the DECISION: prefer the winners' evidence; if the decision is approve (no
    // failure evidence) fall back to nothing meaningful, so evidence stays the reproducible refs of
    // whatever substantive concern drove the outcome.
    evidence: collectEvidence(escalate ? ordered : winners.length > 0 ? winners : ordered),
    confidence: aggregateConfidence(winners.length > 0 ? winners : ordered),
    rounds,
  }
}

export * as Arbiter from "./arbiter"
