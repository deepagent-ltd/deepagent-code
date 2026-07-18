import type { ActivationStage, AgentMode, RoundDecision, RunPhase } from "./mode"

export type ValidationResult = {
  readonly command: string
  readonly passed: boolean
  // T1 (S1-v3.4): the raw process exit code, carried through for failure triage.
  // 127 = command not found, 126 = not executable, 124 = timeout, 137 = OOM/SIGKILL, etc.
  // These are the green/red dividing signals classifyFailure() needs; `passed` is still
  // exactly `exit_code === 0`, so existing assertions are unaffected.
  readonly exit_code: number
  readonly output: string
  readonly duration_ms: number
}

export type CandidateRef = {
  readonly round: number
  readonly attempt: number
  readonly ref: string
  readonly status: "generated" | "validated" | "failed" | "rolled_back"
  readonly metric: number | null
  readonly validations: readonly ValidationResult[]
}

export type DiagnosisRef = {
  readonly round: number
  readonly root_cause: string | null
  // Stable category of the root cause (e.g. "type_error"), used for cross-round repeat detection.
  // root_cause embeds counts/samples that vary between rounds, so equality on it is unreliable.
  readonly root_cause_category?: string | null
  readonly evidence_refs: readonly string[]
  readonly next_action: RoundDecision
}

export type RoundState = {
  round: number
  phase: RunPhase
  stage: ActivationStage
  mode: AgentMode
  candidates: CandidateRef[]
  diagnoses: DiagnosisRef[]
  best_candidate: CandidateRef | null
  total_input_tokens: number
  total_output_tokens: number
  budget_remaining_tokens: number | null
  started_at: string
  updated_at: string
}

export const createInitialRoundState = (mode: AgentMode, budgetTokens: number | null = null): RoundState => ({
  round: 1,
  phase: "planning",
  stage: "first_fast_design",
  mode,
  candidates: [],
  diagnoses: [],
  best_candidate: null,
  total_input_tokens: 0,
  total_output_tokens: 0,
  budget_remaining_tokens: budgetTokens,
  started_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
})

export const advanceRound = (state: RoundState, decision: RoundDecision): RoundState => {
  const nextRound = state.round + 1
  const nextStage = stageForDecision(decision, state.stage)
  return {
    ...state,
    round: nextRound,
    phase: decision === "complete" ? "completed" : decision === "block" ? "failed" : "planning",
    stage: nextStage,
    updated_at: new Date().toISOString(),
  }
}

const stageForDecision = (decision: RoundDecision, current: ActivationStage): ActivationStage => {
  switch (decision) {
    case "continue":
    case "revise":
      return "revision_minimal"
    case "escalate":
      return current === "diagnostic_minimal" ? "knowledge_refresh" : "diagnostic_minimal"
    case "rollback":
      return "replan"
    case "complete":
    case "block":
      return current
  }
}

// Identity of a candidate's evidence: same round + status + the same per-command exit outcomes. Keyed
// on exit_code (not output text) for the same reason validationFingerprint is — output carries volatile
// noise (durations/timestamps) that must not make identical evidence look distinct.
const candidateEvidenceKey = (c: CandidateRef): string =>
  `${c.round}|${c.status}|${[...c.validations].map((v) => `${v.command}=${v.exit_code}`).sort().join(",")}`

export const addCandidate = (state: RoundState, candidate: CandidateRef): RoundState => {
  // STALE-REHARVEST DEDUPE (single append site; covers BOTH the request-prep path and the micro-round
  // driver path, which used to bypass the request.ts fingerprint guard). extractValidationResults
  // re-scans the whole transcript every turn, so the same early validation result is re-recorded as a
  // "new" candidate each round; addCandidate previously appended unconditionally, so after N rounds the
  // list held N identical candidates and every candidate-walker (collectValidationFailureText, review)
  // emitted the same block N times. If the incoming candidate is evidence-identical to the LAST one,
  // skip the append — a genuinely new attempt (new round, changed exit outcome, or different status)
  // has a different key and still appends. Best-candidate is recomputed from the retained set, so a
  // dropped duplicate can never change it.
  const last = state.candidates[state.candidates.length - 1]
  if (last && candidateEvidenceKey(last) === candidateEvidenceKey(candidate)) {
    return state
  }
  const candidates = [...state.candidates, candidate]
  const best =
    candidate.status === "validated" &&
    (state.best_candidate === null || (candidate.metric ?? 0) > (state.best_candidate.metric ?? 0))
      ? candidate
      : state.best_candidate
  return { ...state, candidates, best_candidate: best, updated_at: new Date().toISOString() }
}

export const addDiagnosis = (state: RoundState, diagnosis: DiagnosisRef): RoundState => ({
  ...state,
  diagnoses: [...state.diagnoses, diagnosis],
  phase: "diagnosing",
  updated_at: new Date().toISOString(),
})

export const updateTokenUsage = (state: RoundState, input: number, output: number): RoundState => {
  const totalInput = state.total_input_tokens + input
  const totalOutput = state.total_output_tokens + output
  const budgetRemaining = state.budget_remaining_tokens !== null ? state.budget_remaining_tokens - input - output : null
  return {
    ...state,
    total_input_tokens: totalInput,
    total_output_tokens: totalOutput,
    budget_remaining_tokens: budgetRemaining,
  }
}

export const isBudgetExhausted = (state: RoundState): boolean =>
  state.budget_remaining_tokens !== null && state.budget_remaining_tokens <= 0
