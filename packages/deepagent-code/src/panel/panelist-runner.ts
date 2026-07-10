import { Effect } from "effect"
import type { PanelistRunInput, PanelistRunner } from "./orchestrator"
import { type PanelLens, type PanelOpinion } from "../agent/schema/panel"
import { ReviewResult } from "../agent/schema/orchestration"
import { ToolJsonSchema } from "../tool/json-schema"
import PROMPT_CORRECTNESS from "../agent/prompt/panel/correctness.txt"
import PROMPT_SECURITY from "../agent/prompt/panel/security.txt"
import PROMPT_PERFORMANCE from "../agent/prompt/panel/performance.txt"
import PROMPT_ARCHITECTURE from "../agent/prompt/panel/architecture.txt"
import PROMPT_REPRO from "../agent/prompt/panel/repro.txt"

/**
 * V3.9 §C — the shared PANELIST RUNNER, extracted so BOTH the standalone Expert Panel entry
 * (`panel/consult.ts`) and the Goal Loop's `panel_approves` grader (`session/goal-loop-wiring.ts`)
 * convene panelists identically. A panelist is a lens-specialized reviewer subagent: it is driven with
 * that lens's differentiated system prompt (`agent/prompt/panel/<lens>.txt`, §C.3 — this is what makes
 * the panel genuinely differentiated rather than reviewer clones) and its structured `ReviewResult`
 * becomes a `PanelOpinion`. An absent / failed / malformed turn ⇒ `null` (§C.8 缺席, never a fabricated
 * opinion).
 *
 * The turn itself is injected as a `PanelTurnRunner` port so the caller supplies the real
 * child-session subagent runner (production) or a deterministic stub (tests) — this module owns ONLY
 * the panelist prompt + opinion mapping, never session creation.
 */

/** The differentiated per-lens system-prompt guidance appended to each panelist turn. */
const LENS_PROMPT: Record<PanelLens, string> = {
  correctness: PROMPT_CORRECTNESS,
  security: PROMPT_SECURITY,
  performance: PROMPT_PERFORMANCE,
  architecture: PROMPT_ARCHITECTURE,
  repro: PROMPT_REPRO,
}

/** JSON Schema forcing a structured ReviewResult final turn (shared with the reviewer_clean gate). */
export const REVIEWER_SCHEMA = ToolJsonSchema.fromSchema(ReviewResult) as unknown as Record<string, unknown>

/**
 * The minimal turn seam a panelist needs. Mirrors the goal-loop `SubagentTurnRunner` shape but is
 * declared here so this module does not depend on the goal-loop wiring (avoids a cycle: goal-loop-wiring
 * imports THIS). `structured` is the parsed schema output; absent when the turn produced none.
 */
export type PanelTurnRunner = (input: {
  readonly agentType: string
  readonly prompt: string
  readonly outputSchema?: Record<string, unknown>
}) => Effect.Effect<{ readonly structured: unknown | undefined }>

/** Parse a reviewer turn's structured output into a ReviewResult; malformed/absent ⇒ null (fail-closed). */
export const parseReviewResult = (structured: unknown): ReviewResult | null => {
  if (structured == null) return null
  try {
    return ReviewResult.make(structured as ReviewResult)
  } catch {
    // structured may already be a decoded object from a prior JSON round-trip; accept a shape-check.
    const anyVal = structured as { findings?: unknown; verdict?: unknown }
    if (Array.isArray(anyVal.findings) && typeof anyVal.verdict === "string") return anyVal as ReviewResult
    return null
  }
}

/** Map a reviewer turn output → the panel's PanelOpinion shape. */
export const opinionFromReview = (lens: PanelLens, review: ReviewResult | null): PanelOpinion | null => {
  if (review == null) return null
  // Confidence = max finding confidence (approve with no findings ⇒ full confidence in "approve").
  const confidence =
    review.findings.length === 0
      ? 1
      : review.findings.reduce((m, f) => Math.max(m, Number.isFinite(f.confidence) ? f.confidence : 0), 0)
  return { lens, verdict: review.verdict, findings: review.findings, confidence }
}

/**
 * Render the panelist turn prompt: the lens's differentiated system guidance, the frozen question, the
 * code refs to ground findings in, and (in debate rounds) the anonymized peer verdicts. §C.8: peers are
 * anonymized — no lens/seat identity crosses the boundary, only verdict/confidence.
 */
export const renderPanelistPrompt = (input: PanelistRunInput): string => {
  const parts = [
    LENS_PROMPT[input.spec.lens],
    "",
    `Question (frozen): ${input.question.question}`,
    input.question.codeRefs.length > 0 ? `Code references: ${input.question.codeRefs.join(", ")}` : "",
  ].filter((s) => s.length > 0)
  if (input.round > 1 && input.peers.length > 0) {
    parts.push(
      `Anonymized peer verdicts from the previous round: ${input.peers
        .map((p) => `${p.verdict}(${p.confidence.toFixed(2)})`)
        .join(", ")}. You may revise, but justify any change with reproducible evidence.`,
    )
  }
  return parts.join("\n")
}

/**
 * Build a `PanelistRunner` over an injected turn runner. Each seat is a lens-prompted reviewer subagent
 * whose structured ReviewResult becomes a PanelOpinion. Absent / failed / malformed ⇒ null (§C.8).
 */
export const buildPanelistRunner = (runTurn: PanelTurnRunner): PanelistRunner =>
  (input: PanelistRunInput) =>
    runTurn({
      agentType: "reviewer",
      prompt: renderPanelistPrompt(input),
      outputSchema: REVIEWER_SCHEMA,
    }).pipe(
      Effect.map((turn) => opinionFromReview(input.spec.lens, parseReviewResult(turn.structured))),
      Effect.catchCause(() => Effect.succeed(null as PanelOpinion | null)),
    )
