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

export type LearningEvidenceSnapshot = {
  readonly schema_version: "deepagent-code.learning_evidence.v1"
  readonly activity_id: string
  readonly plan_goal: string | null
  readonly document_refs: readonly string[]
  readonly changed_paths: readonly string[]
  readonly validations: readonly {
    readonly command_hash: string
    readonly passed: boolean
    readonly kind: string
    readonly exit_code: number
  }[]
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
  readonly evidence?: LearningEvidenceSnapshot
}): LearningExtraction => {
  const candidates: LearningCandidate[] = []
  const rejectionReasons: string[] = []
  const evidence = input.evidence

  const completedEvidence = evidence
    ? evidence.changed_paths.length > 0 &&
      evidence.validations.length > 0 &&
      evidence.validations.every((validation) => validation.passed)
    : undefined

  if (input.finalStatus === "completed" && completedEvidence && evidence) {
    const goal = evidence.plan_goal?.replace(/\s+/g, " ").trim().slice(0, 240)
    candidates.push({
      candidate_id: `memory:${input.runId}:validated-completion`,
      type: "memory",
      status: "staged",
      source_run_id: input.runId,
      source_round: input.totalRounds,
      summary:
        `${goal ? `Validated completion of "${goal}"` : "Validated task completion"}: ` +
        `${evidence.changed_paths.length} attributed file(s) changed and ` +
        `${evidence.validations.length} activity-bound check(s) passed.`,
      evidence_refs: [
        `activity:${evidence.activity_id}`,
        ...evidence.document_refs,
        ...evidence.changed_paths.map((file) => `path:${file}`),
        ...evidence.validations.map(
          (validation) => `validation:${validation.command_hash}:exit=${validation.exit_code}`,
        ),
      ],
      confidence: 0.85,
    })
  }

  // Older callers do not carry the immutable evidence snapshot. Preserve their extraction shape
  // for receipt compatibility, but every new V2 admission supplies evidence and therefore cannot
  // turn a bare "completed" signal into generic first-pass knowledge.
  if (input.finalStatus === "completed" && evidence === undefined && input.totalRounds === 1) {
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

  if (input.finalStatus === "completed" && input.totalRounds > 1 && completedEvidence !== false) {
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
    if (input.finalStatus === "completed" && evidence && evidence.changed_paths.length === 0)
      rejectionReasons.push("Completed run has no activity-attributed changed paths.")
    if (input.finalStatus === "completed" && evidence && evidence.validations.length === 0)
      rejectionReasons.push("Completed run has no activity-bound validation evidence.")
    if (input.finalStatus === "completed" && evidence?.validations.some((validation) => !validation.passed))
      rejectionReasons.push("Completed run contains failing activity-bound validation evidence.")
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
