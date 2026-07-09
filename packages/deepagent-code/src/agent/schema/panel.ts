import { Schema } from "effect"
import { ReviewFinding } from "./orchestration"

/**
 * V3.9 §C — Expert Panel（会诊机制）schema.
 *
 * Expert Panel turns the old "fake votes" (`reviewerVotesForMode` — clones of the SAME reviewer
 * prompt with no code-level aggregation) into a production-grade, deterministic 会诊: differentiated
 * expert lenses answer the SAME frozen question independently, and a DETERMINISTIC, non-LLM Arbiter
 * (`panel/arbiter.ts`) aggregates their opinions into a `PanelVerdict` with preserved dissent and
 * supporting evidence.
 *
 * These schemas are a strict subset of the V4.0 §M shapes (event-triggered auto-会诊 + distributed
 * panelists + Approval Queue), so V4.0 only "connects an event source" without changing the contract.
 *
 * NOTE on confidence: §C's `Confidence` refers to the numeric ReviewFinding.confidence convention
 * (a plain 0..1 number), NOT the document-store `Confidence` knowledge type
 * ({evidence_strength, support_count}). Panel confidence is a 0..1 number to match ReviewFinding.
 */

/**
 * A 0..1 confidence scalar, matching `ReviewFinding.confidence`. Deliberately NOT the document-store
 * `Confidence` (evidence_strength/support_count) — that is the knowledge-provenance type and is the
 * wrong shape here. Values outside [0,1] are clamped by the Arbiter (`clampConfidence`) at
 * consumption time so a malformed opinion can never distort the deterministic weighting.
 */
export const PanelConfidence = Schema.Number
export type PanelConfidence = Schema.Schema.Type<typeof PanelConfidence>

/**
 * The core 5 analytical lenses (§C.3). Each panelist is bound to exactly one lens via a
 * differentiated system prompt (`agent/prompt/panel/<lens>.txt`); the lens is what makes panelists
 * genuinely differentiated rather than clones. The spec allows configurable extension
 * (privacy / compliance / scalability) — those are added as new literals here when a deployment
 * needs them; the Arbiter's lens-relevance weighting (`QuorumPolicy.lensWeights`) falls back to a
 * default weight of 1 for any lens not explicitly weighted, so the literal set stays open to
 * extension without breaking arbitration.
 */
export const PanelLens = Schema.Literals([
  "correctness",
  "security",
  "performance",
  "architecture",
  "repro",
]).annotate({ identifier: "PanelLens" })
export type PanelLens = Schema.Schema.Type<typeof PanelLens>

/** All core lenses, in a stable order (used for deterministic tie-breaking + defaults). */
export const PANEL_LENSES: readonly PanelLens[] = [
  "correctness",
  "security",
  "performance",
  "architecture",
  "repro",
] as const

export const PanelVerdictValue = Schema.Literals(["approve", "revise", "block"])
export type PanelVerdictValue = Schema.Schema.Type<typeof PanelVerdictValue>

/**
 * One panelist's independent answer to the frozen question, through its lens. Reuses the existing
 * `ReviewFinding` (severity/category/file/line/failureScenario/confidence) so a panelist is exactly
 * a lens-specialized reviewer whose structured output already conforms.
 */
export const PanelOpinion = Schema.Struct({
  lens: PanelLens,
  verdict: PanelVerdictValue,
  /** The panelist's findings; `failureScenario` is the reproducible evidence the Arbiter weighs. */
  findings: Schema.Array(ReviewFinding),
  /** The panelist's overall confidence in its verdict, 0..1 (matches ReviewFinding.confidence). */
  confidence: PanelConfidence,
}).annotate({ identifier: "PanelOpinion" })
export type PanelOpinion = Schema.Schema.Type<typeof PanelOpinion>

export const PanelDecision = Schema.Literals(["approve", "revise", "block", "needs_human"])
export type PanelDecision = Schema.Schema.Type<typeof PanelDecision>

/**
 * The Arbiter's deterministic aggregate (§C.3). `dissent` preserves overruled minority opinions
 * (§C.8 不丢信息); `evidence` carries the reproducible scenarios / code refs that grounded the
 * decision; `rounds` is the actual number of debate rounds run (≤ the frozen cap R).
 */
export const PanelVerdict = Schema.Struct({
  decision: PanelDecision,
  dissent: Schema.Array(PanelOpinion),
  evidence: Schema.Array(Schema.String),
  confidence: PanelConfidence,
  rounds: Schema.Int,
}).annotate({ identifier: "PanelVerdict" })
export type PanelVerdict = Schema.Schema.Type<typeof PanelVerdict>

/**
 * A configurable, per-event-type quorum policy consumed by the Arbiter. Same opinions + same policy
 * → same verdict (deterministic). Policies differ by event type (a security audit uses
 * `anyBlockBlocks`, a style suggestion uses simple majority) but every policy is deterministic.
 *
 * This is a plain TS type, not an Effect Schema, because it is a code-side configuration object
 * consumed only by the deterministic Arbiter — it is never serialized into a model turn or a doc.
 */
export type QuorumPolicy = {
  /**
   * Any panelist `block` with confidence ≥ this threshold forces a final `block` (fail-closed /
   * 阻断优先). Range 0..1. A security-audit policy sets this to 0 so ANY block blocks.
   */
  readonly blockThreshold: number
  /**
   * Per-lens relevance weight for the weighted-majority tally (weight = confidence × lensWeight).
   * A lens absent from this map defaults to 1 (so the literal set stays extensible). Values < 0 are
   * treated as 0.
   */
  readonly lensWeights: Partial<Record<PanelLens, number>>
  /**
   * Minimum number of SURVIVING opinions required to reach a quorum. Below this ⇒ `needs_human`
   * (§C.8 优雅降级：存活票 < 最小法定数 → needs_human，不静默通过).
   */
  readonly minQuorum: number
  /**
   * Multiplier (0..1) applied to a block/revise vote that carries NO reproducible evidence
   * (no finding with a non-empty `failureScenario`, and no file/line code-ref). §C.6 证据要求：
   * "block/revise 无可复现场景/代码引用则该票降权". Approve votes are never down-weighted (approving
   * needs no failure evidence). Set to 1 to disable down-weighting.
   */
  readonly unsupportedVoteWeight: number
  /**
   * When true, a tie between `revise` and `approve` resolves to the more conservative side (`revise`)
   * AND is flagged `needs_human` (§C.6 平票 → 向保守侧倒 + 标记 needs_human). Always true for the
   * shipped policies; exposed for completeness.
   */
  readonly tieToConservativeNeedsHuman: boolean
  /**
   * When true, if any dissenting (overruled) opinion contains a `critical`-severity finding, the
   * decision escalates to `needs_human` (§C.6 升级人类：dissent 涉 critical → needs_human).
   */
  readonly criticalDissentNeedsHuman: boolean
}

/**
 * The default quorum policy: fail-closed on a high-confidence block, weighted majority otherwise,
 * conservative on ties, human escalation on critical dissent or sub-quorum. Lens weights are neutral
 * (all effectively 1) so no lens dominates by default — a deployment tunes them per event type.
 */
export const DEFAULT_QUORUM_POLICY: QuorumPolicy = {
  blockThreshold: 0.7,
  lensWeights: {},
  minQuorum: 2,
  unsupportedVoteWeight: 0.5,
  tieToConservativeNeedsHuman: true,
  criticalDissentNeedsHuman: true,
}

/**
 * Security-audit variant (§C.6 "安全审计：任一 block 即 block"). `blockThreshold: 0` means ANY block
 * vote — regardless of confidence — forces a final `block`. The security lens is weighted highest so
 * it dominates the weighted majority when no block fires. minQuorum is unchanged (still refuses to
 * silently pass below quorum).
 */
export const SECURITY_AUDIT_QUORUM_POLICY: QuorumPolicy = {
  blockThreshold: 0,
  lensWeights: { security: 2, correctness: 1.5 },
  minQuorum: 2,
  unsupportedVoteWeight: 0.5,
  tieToConservativeNeedsHuman: true,
  criticalDissentNeedsHuman: true,
}

export * as Panel from "./panel"
