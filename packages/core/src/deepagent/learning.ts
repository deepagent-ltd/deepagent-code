import type { RoundState, CandidateRef, DiagnosisRef } from "./round-state"
import type { AgentMode } from "./mode"

export type LearningCandidate = {
  readonly candidate_id: string
  readonly type: "memory" | "strategy" | "methodology" | "anti_pattern"
  readonly status: "staged" | "rejected"
  readonly source_run_id: string
  readonly source_round: number
  readonly summary: string
  readonly evidence_refs: readonly string[]
  readonly confidence: number
}

export type LearningExtraction = {
  readonly candidates: readonly LearningCandidate[]
  readonly promotion_decision: "staged" | "rejected" | "needs_review"
  readonly rejection_reasons: readonly string[]
}

export const extract = (input: {
  readonly runId: string
  readonly mode: AgentMode
  readonly roundState: RoundState
  readonly totalRounds: number
  readonly finalStatus: "completed" | "failed"
}): LearningExtraction => {
  const candidates: LearningCandidate[] = []
  const rejectionReasons: string[] = []

  if (input.finalStatus === "completed" && input.totalRounds === 1) {
    candidates.push({
      candidate_id: `memory:${input.runId}:first-pass-success`,
      type: "memory",
      status: "staged",
      source_run_id: input.runId,
      source_round: 1,
      summary: "Task completed in first round without diagnosis or retry.",
      evidence_refs: [`run:${input.runId}`],
      confidence: 0.6,
    })
  }

  if (input.finalStatus === "completed" && input.totalRounds > 1) {
    const successfulDiagnoses = input.roundState.diagnoses.filter((d) => d.root_cause && d.next_action === "revise")
    for (const diag of successfulDiagnoses) {
      candidates.push({
        candidate_id: `strategy:${input.runId}:diagnosis-led-fix:r${diag.round}`,
        type: "strategy",
        status: "staged",
        source_run_id: input.runId,
        source_round: diag.round,
        summary: `Diagnosis identified "${diag.root_cause}" which led to successful fix.`,
        evidence_refs: diag.evidence_refs,
        confidence: 0.7,
      })
    }
  }

  if (input.finalStatus === "failed") {
    const repeatedFailures = findRepeatedPatterns(input.roundState.diagnoses)
    for (const pattern of repeatedFailures) {
      candidates.push({
        candidate_id: `anti_pattern:${input.runId}:repeated-failure:${pattern.round}`,
        type: "anti_pattern",
        status: "staged",
        source_run_id: input.runId,
        source_round: pattern.round,
        summary: `Repeated failure pattern: "${pattern.root_cause}". Approach did not work after ${input.totalRounds} rounds.`,
        evidence_refs: pattern.evidence_refs,
        confidence: 0.75,
      })
    }
  }

  if (candidates.length === 0) {
    rejectionReasons.push("No actionable learning candidates identified from this run.")
    return { candidates: [], promotion_decision: "rejected", rejection_reasons: rejectionReasons }
  }

  return {
    candidates,
    promotion_decision: "needs_review",
    rejection_reasons: [],
  }
}

const findRepeatedPatterns = (diagnoses: readonly DiagnosisRef[]): DiagnosisRef[] => {
  // P2-A: group on the STABLE root_cause_category, not the human-readable root_cause string.
  // root_cause embeds per-round counts/samples (e.g. "Type errors (3 occurrences): ...") that vary
  // every round, so grouping on it almost never reaches the >=2 repeat threshold — the failed-run
  // anti_pattern channel was effectively dead. Falling back to root_cause only for legacy diagnoses
  // that predate the category field. This mirrors diagnosis.ts determineAction's repeat detection.
  const key = (d: DiagnosisRef): string | null => d.root_cause_category ?? d.root_cause
  const counts = new Map<string, number>()
  for (const d of diagnoses) {
    const k = key(d)
    if (k) counts.set(k, (counts.get(k) ?? 0) + 1)
  }
  return diagnoses.filter((d) => {
    const k = key(d)
    return Boolean(k) && (counts.get(k!) ?? 0) >= 2
  })
}

export const shouldPromote = (candidate: LearningCandidate): boolean =>
  candidate.confidence >= 0.8 && candidate.type !== "anti_pattern"

export const formatManifest = (extraction: LearningExtraction, runId: string): Record<string, unknown> => ({
  schema_version: "learning_writeback_manifest.v1",
  writeback_id: `writeback_${runId}`,
  source_run_id: runId,
  eval_mode: "production_user_task",
  created_at: new Date().toISOString(),
  candidates: extraction.candidates,
  promotion_decision: extraction.promotion_decision,
  rejection_reasons: extraction.rejection_reasons,
  policy_checks: [
    { check_id: "no_hidden_lineage", status: "pass" },
    {
      check_id: "review_required_before_active_promotion",
      status: extraction.promotion_decision === "needs_review" ? "needs_review" : "pass",
    },
  ],
})
