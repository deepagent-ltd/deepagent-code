export * as DeepAgentCapabilityMode from "./capability-mode"

import type { AgentMode } from "./mode"
import { flipFlagValueOn } from "./flip-flag"
import type { FanoutDecision, OrchestrationTier } from "./orchestration"

/**
 * Capability mode — how much runtime machinery a session is worth.
 *
 * The evidence this exists for (rounds 6–8 of the abs ablation, same task and model): the full
 * mechanism stack costs ~2.9× the tokens of the bare loop and the difference is turn count and
 * per-turn replay, not the size of any single prompt section. A task that needs one file edited
 * should not carry the plan gate, the orchestration section, the federation evidence path and the
 * knowledge retriever; a task that spans modules should not lose them. Today the ONLY consumer of
 * the complexity engine is the fan-out gate, so "how much machinery" is decided implicitly by
 * whatever each mechanism happens to check.
 *
 * Two independent inputs, deliberately kept apart:
 *
 *   - the EXPLICIT tier — the user's or the deployment's setting (`AgentMode`). It is the default
 *     authority: the peers (Codex, Claude Code, deepseek-harness) all route this by user/config
 *     effort tiers, and a runtime that guesses differently from the user is worse than one that
 *     does less.
 *   - the ESTIMATED complexity — a pure function of the request and of facts the runtime observed
 *     while working (files touched, validation failures, gate pressure). It is EXPERIMENTAL: it
 *     never changes execution unless the auto-detect flag is on, but it is always computed and
 *     recorded so its accuracy can be measured before it is trusted.
 *
 * Promotion is one-way: quick → standard → deep. A session that turned out to be bigger than its
 * first request suggested must not be forced back down mid-flight (the plan, the touched files and
 * the validation evidence are already in play).
 */

export type CapabilityMode = "quick" | "standard" | "deep"

export const CAPABILITY_MODES: readonly CapabilityMode[] = ["quick", "standard", "deep"]

/** The proactiveness ceiling each capability mode corresponds to, on the orchestration scale. */
export const tierForCapabilityMode = (mode: CapabilityMode): OrchestrationTier => {
  switch (mode) {
    case "quick":
      return 0
    case "standard":
      return 1
    case "deep":
      return 3
  }
}

/**
 * Runtime-observed facts that justify promoting a session. Each is a durable count the runner
 * already maintains; none requires an extra model call or an extra filesystem probe.
 */
export type PromotionSignals = {
  /** Distinct files/modules the session has mutated. */
  readonly filesMutated: number
  /** Validation runs that FAILED (a repair loop is a bigger task than it first looked). */
  readonly validationFailures: number
  /** Plan-gate blocks (the session keeps trying to mutate without a plan). */
  readonly gateBlocks: number
}

export const NO_PROMOTION_SIGNALS: PromotionSignals = { filesMutated: 0, validationFailures: 0, gateBlocks: 0 }

/** Thresholds that promote a session one step. Deliberately generous: promotion costs tokens, so
 * only clear evidence earns it. Derived from the ablation traces, where a single-file task mutated
 * 2–4 files and a multi-module task moved through 6+. */
const PROMOTE_FILES_MUTATED = 4
const PROMOTE_VALIDATION_FAILURES = 2
const PROMOTE_GATE_BLOCKS = 3

/**
 * The promotion a session's OBSERVED work justifies, independent of its first estimate. Returns the
 * signals that fired so the durable record can explain the step rather than just assert it.
 */
export const promoteFor = (
  signals: PromotionSignals,
): { readonly mode: CapabilityMode; readonly reasons: readonly string[] } | null => {
  const reasons: string[] = []
  if (signals.filesMutated >= PROMOTE_FILES_MUTATED) reasons.push(`files_mutated>=${PROMOTE_FILES_MUTATED}`)
  if (signals.validationFailures >= PROMOTE_VALIDATION_FAILURES)
    reasons.push(`validation_failures>=${PROMOTE_VALIDATION_FAILURES}`)
  if (signals.gateBlocks >= PROMOTE_GATE_BLOCKS) reasons.push(`gate_blocks>=${PROMOTE_GATE_BLOCKS}`)
  if (reasons.length === 0) return null
  return { mode: "deep", reasons }
}

/** Estimated capability mode from the runtime's complexity estimate (0..3). */
export const estimatedModeFor = (complexity: OrchestrationTier): CapabilityMode => {
  if (complexity <= 0) return "quick"
  if (complexity === 1) return "standard"
  return "deep"
}

export type ModeResolution = {
  /** The mode execution should use. */
  readonly mode: CapabilityMode
  /** The orchestration ceiling derived from `mode`. */
  readonly tier: OrchestrationTier
  /**
   * How the mode was arrived at. `explicit` — the configured tier decided, and auto-detect is off
   * or agrees; `estimated` — auto-detect raised it; `promoted` — observed work raised it.
   */
  readonly source: "explicit" | "estimated" | "promoted"
  /** The configured tier's own mode, recorded even when it did not win. */
  readonly explicitMode: CapabilityMode
  readonly estimatedMode: CapabilityMode
  readonly complexity: OrchestrationTier
  /** Signal names behind a promotion (`files_mutated>=4`, …) — empty when nothing promoted. */
  readonly reasons: readonly string[]
}

const rank = (mode: CapabilityMode): number => CAPABILITY_MODES.indexOf(mode)
const higher = (left: CapabilityMode, right: CapabilityMode): CapabilityMode =>
  rank(left) >= rank(right) ? left : right

/**
 * Resolve the capability mode for a session.
 *
 * `autoDetect` is the experimental switch: when it is off, the explicit tier is the ONLY authority
 * and the estimated mode is reported for measurement without being applied. Promotion from observed
 * work applies whenever the flag is on, and can only ever raise the mode.
 */
export const resolveMode = (input: {
  readonly explicitMode: CapabilityMode
  readonly complexity: OrchestrationTier
  readonly autoDetect: boolean
  readonly promotion?: { readonly mode: CapabilityMode; readonly reasons: readonly string[] } | null
}): ModeResolution => {
  const estimatedMode = estimatedModeFor(input.complexity)
  if (!input.autoDetect)
    return {
      mode: input.explicitMode,
      tier: tierForCapabilityMode(input.explicitMode),
      source: "explicit",
      explicitMode: input.explicitMode,
      estimatedMode,
      complexity: input.complexity,
      reasons: [],
    }
  const withEstimate = higher(input.explicitMode, estimatedMode)
  const promoted = input.promotion == null ? null : higher(withEstimate, input.promotion.mode)
  const mode = promoted ?? withEstimate
  return {
    mode,
    tier: tierForCapabilityMode(mode),
    source: promoted !== null ? "promoted" : mode === input.explicitMode ? "explicit" : "estimated",
    explicitMode: input.explicitMode,
    estimatedMode,
    complexity: input.complexity,
    reasons: promoted !== null ? (input.promotion?.reasons ?? []) : [],
  }
}

/**
 * Map the orchestration fan-out verdict's complexity onto the capability estimate. A single
 * conversion point keeps the two engines consistent: the fan-out decision already derives its
 * complexity from the same `estimateSignalsFromText` heuristic.
 */
export const complexityOf = (decision: FanoutDecision | undefined): OrchestrationTier => decision?.complexity ?? 0

/**
 * The configured tier expressed as a capability mode. `AgentMode` is the existing explicit surface
 * (general/high/xhigh/max/ultra), so the explicit default needs no new user-facing knob:
 *   general            → quick    (machinery off; the peers' "bare" posture)
 *   high / xhigh       → standard (the current production default)
 *   max / ultra        → deep     (the full stack)
 */
export const capabilityModeForAgentMode = (mode: AgentMode): CapabilityMode => {
  switch (mode) {
    case "general":
      return "quick"
    case "high":
    case "xhigh":
      return "standard"
    case "max":
    case "ultra":
      return "deep"
  }
}

/**
 * EXPERIMENTAL auto-detection switch. Off by default: the explicit tier decides, exactly as the
 * peers do. With it on, the runtime may raise the mode from its own estimate and from observed
 * work — never lower it. Every resolution is recorded either way, so the estimate's accuracy can be
 * measured from real sessions before the switch is ever turned on for anyone.
 */
export const autoDetectEnabled = (value: string | undefined = process.env["DEEPAGENT_CODE_CAPABILITY_AUTO"]): boolean =>
  flipFlagValueOn(value, false)
