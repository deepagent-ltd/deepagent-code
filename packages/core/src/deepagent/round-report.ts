import type { ValidationResult } from "./round-state"

// V3.1 A4: the structured round report is the reconciliation contract between an execution
// turn and the wish/reviewer that decides the next macro-round. Its governing principle:
// MACHINE-READ DATA MUST BE STRUCTURED; LM-READ DATA MAY BE LOOSE. The report is machine-read
// (by reconcile() and the macro-round loop), so it is structured and carries two distinct
// provenance classes:
//
//   1. Model declarations  — written by the execution model; treated as CLAIMS TO BE CHECKED.
//   2. Runner ground truth — injected by the runner (validation exit codes, real git diff,
//                            changed-file list); NEVER written by the model; treated as TRUTH.
//
// reconcile() compares the two. A mismatch (model says "tests pass", runner says "fail") is the
// strongest signal and is detectable by a model of equal strength, because checking against
// ground truth is cheaper than producing — so no stronger/more-expensive reviewer is required.

export const ROUND_REPORT_SCHEMA_VERSION = "deepagent-code.round_report.v1"

// --- Provenance class 1: model declarations (claims) ---------------------------------------

export type ModelDeclarations = {
  // The model's own claim about whether the current goal is complete.
  readonly completion_claim: "complete" | "incomplete" | "blocked"
  // Free-form (LM-authored) description of the approach taken this round.
  readonly implementation_summary: string
  // Files the model claims it changed. Reconciled against the runner's real changed-file list.
  readonly claimed_change_surface: readonly string[]
  // Docs/logs the model claims it updated.
  readonly claimed_doc_updates: readonly string[]
  // The model's stated validation claim (e.g. "all tests pass"). Reconciled against real results.
  readonly claimed_validation_passed: boolean
}

// --- Provenance class 2: runner ground truth -----------------------------------------------

export type RunnerGroundTruth = {
  // Real validation results (exit-code derived). Never the model's word.
  readonly validations: readonly ValidationResult[]
  // Real changed-file list, from git status/diff.
  readonly changed_files: readonly string[]
  // Real unified-diff stat summary (or null if unavailable).
  readonly diff_stat: string | null
  // Deterministic task evidence emitted by the runtime. Unverified is not a runtime failure, but
  // it is not enough evidence for automatic completion of a deterministic query/status task.
  readonly deterministic_results?: readonly {
    readonly ref_id: string
    readonly verified_state: "verified" | "unverified" | "blocked" | "not_applicable"
    readonly task_kind: string
  }[]
}

export type ReconcileMismatch = {
  readonly field: "validation" | "change_surface" | "deterministic_result"
  readonly detail: string
}

export type RoundReport = {
  readonly schema_version: typeof ROUND_REPORT_SCHEMA_VERSION
  readonly run_id: string
  readonly session_id: string
  readonly round: number
  readonly declarations: ModelDeclarations
  readonly ground_truth: RunnerGroundTruth
  // Filled by reconcile(): the objective disagreement between claims and truth.
  readonly mismatches: readonly ReconcileMismatch[]
  // Objective convergence verdict derived from ground truth + reconciliation, NOT from the
  // model's completion_claim alone.
  readonly converged: boolean
  readonly created_at: string
}

export type BuildRoundReportInput = {
  readonly runId: string
  readonly sessionID: string
  readonly round: number
  readonly declarations: ModelDeclarations
  readonly groundTruth: RunnerGroundTruth
}

const allValidationsPassed = (results: readonly ValidationResult[]): boolean =>
  results.length > 0 && results.every((r) => r.passed)

// reconcile compares model claims against runner ground truth. The asymmetry is deliberate:
// ground truth always wins. A claim of success contradicted by a failing validation is the
// canonical "model lied / was wrong" signal.
export const reconcile = (
  declarations: ModelDeclarations,
  groundTruth: RunnerGroundTruth,
): readonly ReconcileMismatch[] => {
  const mismatches: ReconcileMismatch[] = []

  // Validation mismatch: model claims pass, runner observed a failure (or vice versa).
  const truthPassed = allValidationsPassed(groundTruth.validations)
  if (groundTruth.validations.length > 0 && declarations.claimed_validation_passed !== truthPassed) {
    const failed = groundTruth.validations.filter((r) => !r.passed).map((r) => r.command)
    mismatches.push({
      field: "validation",
      detail: declarations.claimed_validation_passed
        ? `model claimed validation passed but runner observed failures: ${failed.join(", ")}`
        : "model claimed validation did not pass but runner observed all passing",
    })
  }

  // Change-surface mismatch: model claims a file it did not actually touch. Only flag claimed
  // files absent from ground truth (extra real changes are not a model lie, just incompleteness
  // in the claim, which is less severe and not reconciled here).
  if (groundTruth.changed_files.length > 0) {
    const real = new Set(groundTruth.changed_files)
    const phantom = declarations.claimed_change_surface.filter((f) => !real.has(f))
    if (phantom.length > 0) {
      mismatches.push({
        field: "change_surface",
        detail: `model claimed changes to files not in the real diff: ${phantom.join(", ")}`,
      })
    }
  }

  const deterministicGaps = (groundTruth.deterministic_results ?? []).filter(
    (result) => result.verified_state === "unverified" || result.verified_state === "blocked",
  )
  if (declarations.completion_claim === "complete" && deterministicGaps.length > 0) {
    mismatches.push({
      field: "deterministic_result",
      detail: `model claimed completion but deterministic result refs are not verified: ${deterministicGaps.map((result) => `${result.ref_id}:${result.verified_state}`).join(", ")}`,
    })
  }

  return mismatches
}

// Convergence is objective: the goal is converged only when the runner's validations all pass
// AND there is no reconciliation mismatch. The model's own completion_claim is necessary (it
// must say "complete") but never sufficient — it cannot override failing ground truth.
export const isConverged = (
  declarations: ModelDeclarations,
  groundTruth: RunnerGroundTruth,
  mismatches: readonly ReconcileMismatch[],
): boolean => {
  if (mismatches.length > 0) return false
  if (declarations.completion_claim !== "complete") return false
  // If validations exist, they must all pass. If none exist, fall back to the model's claim
  // (nothing objective to contradict it).
  if (groundTruth.validations.length > 0) return allValidationsPassed(groundTruth.validations)
  return true
}

export const buildRoundReport = (input: BuildRoundReportInput): RoundReport => {
  const mismatches = reconcile(input.declarations, input.groundTruth)
  return {
    schema_version: ROUND_REPORT_SCHEMA_VERSION,
    run_id: input.runId,
    session_id: input.sessionID,
    round: input.round,
    declarations: input.declarations,
    ground_truth: input.groundTruth,
    mismatches,
    converged: isConverged(input.declarations, input.groundTruth, mismatches),
    created_at: new Date().toISOString(),
  }
}

// --- Macro-round suggestion envelope -------------------------------------------------------
//
// The wish next-round suggestion is `{ status, body }`: `status` is the only structured field
// (machine-read, controls the loop) and `body` is free-form prose (LM-read, shown in the input
// box). `deriveStatus` computes status OBJECTIVELY from the report, never from the model's
// self-report, so the loop cannot be talked into continuing or stopping by the model alone.

export type SuggestionStatus = "done" | "continue" | "needs_human"

export type NextRoundSuggestion = {
  readonly status: SuggestionStatus
  readonly body: string
}

export const deriveStatus = (report: RoundReport): SuggestionStatus => {
  // A reconciliation mismatch means the model's account disagrees with reality: never auto-done,
  // and not a clean "continue" either — surface it for human attention.
  if (report.mismatches.length > 0) return "needs_human"
  // P2-C: "done" requires OBJECTIVE evidence. isConverged falls back to trusting the model's
  // completion_claim when zero validations ran (nothing to contradict it), but a completion claim
  // with no validation evidence is exactly the unverified-self-report case the round report exists
  // to guard against. So a convergence reached with an empty validation set is escalated to a human
  // rather than auto-marked done — only validations that actually ran and passed yield "done".
  if (report.converged) {
    return report.ground_truth.validations.length > 0 ? "done" : "needs_human"
  }
  // The model explicitly reported a hard block it cannot resolve: escalate.
  if (report.declarations.completion_claim === "blocked") return "needs_human"
  return "continue"
}

// summarizeForSuggestion builds the free-form `body` prose shown in the input box (LM-read).
// It is intentionally loose (no structure): it states the objective situation so the user — or,
// for ultra, the supervisor — can decide the next macro-round. It never asserts success the
// ground truth contradicts.
export const summarizeForSuggestion = (report: RoundReport): string => {
  const status = deriveStatus(report)
  const failed = report.ground_truth.validations.filter((r) => !r.passed).map((r) => r.command)
  if (status === "done") {
    return "Current goal looks complete: all validations passed and the model's report matches the runner's ground truth. Continue with the next goal, or stop here."
  }
  if (report.mismatches.length > 0) {
    return [
      "The model's report disagrees with the runner's ground truth, so this needs a human decision:",
      ...report.mismatches.map((m) => `- ${m.field}: ${m.detail}`),
    ].join("\n")
  }
  if (status === "needs_human") {
    // Two ways to reach needs_human here (mismatch already handled above): the model declared a
    // hard block, or it claimed completion with no validation evidence to confirm it (P2-C).
    if (report.declarations.completion_claim === "blocked") {
      return `The model reported it is blocked: ${report.declarations.implementation_summary || "no further detail provided"}. Human input needed.`
    }
    return "The model reports the goal is complete, but no validations ran to confirm it. Configure validation commands (typecheck/test) or confirm completion manually before continuing."
  }
  // continue
  return failed.length > 0
    ? `Validation still failing (${failed.join(", ")}). Next round should diagnose and fix these, then re-validate.`
    : "Goal not yet complete. Continue with another round toward the current goal."
}
