import type { AgentMode, RoundDecision } from "./mode"
import * as SessionState from "./session-state"
import * as Activation from "./activation-policy"
import * as Knowledge from "./knowledge-retriever"
import * as Diagnosis from "./diagnosis"
import * as Budget from "./budget"
import * as Validation from "./validation"
import type { PromptContext, EnvironmentContext, ToolContext, PreviousResults } from "./prompt-policy"
import type { ValidationResult } from "./round-state"

export type OrchestratorInput = {
  readonly sessionId: string
  readonly mode: AgentMode
  readonly environment: EnvironmentContext
  readonly tools: ToolContext
  readonly userRequest: string | null
  readonly workspacePath: string | null
}

export type PostTurnDecision = {
  readonly action: "continue" | "validate" | "diagnose" | "complete" | "budget_pause" | "escalate"
  readonly reason: string
  readonly validationCommands?: readonly string[]
  readonly diagnosisInput?: Diagnosis.DiagnosisInput
}

export const initSession = (input: OrchestratorInput): SessionState.SessionRunState => {
  const state = SessionState.getOrCreate(input.sessionId, input.mode)
  let changed = false
  if (input.userRequest && state.userRequest !== input.userRequest) { state.userRequest = input.userRequest; changed = true }
  if (input.workspacePath && state.workspacePath !== input.workspacePath) { state.workspacePath = input.workspacePath; changed = true }
  if (changed) SessionState.update(input.sessionId, { userRequest: state.userRequest, workspacePath: state.workspacePath })
  return state
}

// Lightweight session re-establishment for the multi-round driver (docs/16). The gateway
// prunes the orchestrator session when a turn completes; the driver calls this to ensure a
// session exists before running validation/diagnosis rounds, without needing full env/tools.
export const ensureSession = (sessionId: string, mode: AgentMode): void => {
  SessionState.getOrCreate(sessionId, mode)
}

export const buildPromptContext = (input: OrchestratorInput): PromptContext => {
  const state = SessionState.getOrCreate(input.sessionId, input.mode)
  const roundState = state.roundState
  const budgetCheck = Budget.check(roundState, state.budget)

  const activationCtx: Activation.ActivationContext = {
    mode: state.mode,
    round: roundState.round,
    stage: roundState.stage,
    previousValidationPassed: state.lastValidationResults.length > 0 && Validation.allPassed(state.lastValidationResults),
    previousDiagnosisAvailable: roundState.diagnoses.length > 0,
    userRequestedDeeper: false,
    budgetExhausted: Budget.shouldPause(budgetCheck),
  }
  const activation = Activation.decide(activationCtx)

  let knowledge = state.knowledgeSynthesis
  if (!knowledge && state.mode !== "general" && activation.allowKnowledgeRetrieval) {
    const failedCount = roundState.candidates.filter((c) => c.status === "failed").length
    // V3: feed diagnosis-blocked refs into retrieval so they are surfaced as do_not_use
    // and never re-injected (docs/30 §4 conflict/do_not_use; diagnosis -> retrieval link).
    const blockedRefs = roundState.diagnoses.flatMap((d) => d.evidence_refs ?? []).filter((r) => r.startsWith("strategy:") || r.startsWith("methodology:") || r.startsWith("memory:"))
    // V3 (P2-10): derive a real problem profile so domain packs can activate (docs/31 §2).
    // Signals come from the user request; a detected backend (e.g. cuda/rocm) raises the gpu
    // pack's detect score. domain is left null so the retrieval domain filter does not exclude
    // domain-pack docs — pack activation is decided by detect(profile), not a pinned domain.
    const signals = signalsFromRequest(state.userRequest)
    const backend = detectBackend(signals)
    const profile = { domain: null as string | null, signals, ...(backend ? { backend } : {}) }
    knowledge = Knowledge.retrieve({
      mode: state.mode,
      task: {
        userRequest: state.userRequest,
        taskType: "code_modification",
        domain: "code",
        goals: [],
        successCriteria: [],
        riskBoundaries: [],
        validationCommands: state.validationCommands,
      },
      tools: input.tools,
      round: roundState.round,
      previousFailures: failedCount,
      blockedRefs,
      profile,
      // docs/34 §8: scope durable retrieval to this workspace path (unions user-global +
      // this workspace's project-shared). null workspace => user-global only.
      ...(state.workspacePath ? { workspacePath: state.workspacePath } : {}),
    })
    if (knowledge) SessionState.update(input.sessionId, { knowledgeSynthesis: knowledge })
  }

  const previousResults: PreviousResults | null =
    roundState.round > 1 || state.lastValidationResults.length > 0
      ? {
          lastCandidate: roundState.candidates[roundState.candidates.length - 1] ?? null,
          lastDiagnosis: roundState.diagnoses[roundState.diagnoses.length - 1] ?? null,
          validationOutput: state.lastValidationOutput,
          bestCandidate: roundState.best_candidate,
        }
      : null

  return {
    mode: state.mode,
    round: roundState.round,
    activation,
    roundState,
    environment: input.environment,
    task: {
      userRequest: state.userRequest,
      taskType: "code_modification",
      domain: "code",
      goals: state.userRequest ? [`Complete: ${state.userRequest.slice(0, 200)}`] : ["Satisfy the user request"],
      successCriteria: ["Declared validation passes", "No unrelated changes"],
      riskBoundaries: ["Do not use destructive operations", "Do not commit secrets"],
      validationCommands: state.validationCommands,
    },
    tools: input.tools,
    knowledge,
    previousResults,
    userInstructions: null,
  }
}

export const onTokenUsage = (sessionId: string, inputTokens: number, outputTokens: number): void => {
  SessionState.recordTokenUsage(sessionId, inputTokens, outputTokens)
}

export const onValidationComplete = (sessionId: string, results: ValidationResult[]): PostTurnDecision => {
  const output = Validation.summarizeResults(results)
  SessionState.recordValidation(sessionId, results, output)

  const allPass = Validation.allPassed(results)
  if (allPass) {
    SessionState.recordCandidate(sessionId, {
      round: SessionState.get(sessionId)!.roundState.round,
      attempt: 1,
      ref: `candidate:validated:r${SessionState.get(sessionId)!.roundState.round}`,
      status: "validated",
      metric: 1.0,
      validations: results,
    })
    SessionState.complete(sessionId)
    return { action: "complete", reason: "All validations passed." }
  }

  SessionState.recordCandidate(sessionId, {
    round: SessionState.get(sessionId)!.roundState.round,
    attempt: 1,
    ref: `candidate:failed:r${SessionState.get(sessionId)!.roundState.round}`,
    status: "failed",
    metric: 0,
    validations: results,
  })

  return { action: "diagnose", reason: `Validation failed: ${output}`, diagnosisInput: buildDiagnosisInput(sessionId, results) }
}

export const onDiagnosisComplete = (sessionId: string, result: Diagnosis.DiagnosisResult): PostTurnDecision => {
  SessionState.recordDiagnosis(sessionId, result.diagnosis)

  const state = SessionState.get(sessionId)!
  const budgetCheck = Budget.check(state.roundState, state.budget)
  if (Budget.shouldPause(budgetCheck)) {
    SessionState.fail(sessionId)
    return { action: "budget_pause", reason: budgetCheck.message ?? "Budget exhausted" }
  }

  if (result.suggestedAction === "rollback" || result.suggestedAction === "block") {
    SessionState.fail(sessionId)
    return { action: "complete", reason: `Diagnosis suggests ${result.suggestedAction}: ${result.evidenceSummary}` }
  }

  if (result.suggestedAction === "escalate") {
    if (Activation.shouldEscalateToMax(state.roundState)) {
      return { action: "escalate", reason: "Repeated failures suggest escalation to max mode." }
    }
  }

  SessionState.advanceToNextRound(sessionId, result.suggestedAction)
  const advanced = SessionState.get(sessionId)!
  return { action: "continue", reason: `Advancing to round ${advanced.roundState.round}: ${result.evidenceSummary}` }
}

// V3.2 P0-1: session-complete bookkeeping ONLY. Learning writeback is the single LearningWorker
// path (gateway runBackgroundLearning -> durable DocumentStore with the sensitivity gate). This used
// to also persist + auto-approve every candidate ungated (the sensitivity-bypass hole) AND, later,
// recompute a LearningExtraction whose result the sole caller discarded (P2-4 dead compute). Both
// removed: this now only prunes completed sessions.
export const onSessionComplete = (sessionId: string): void => {
  if (!SessionState.get(sessionId)) return
  SessionState.pruneCompleted()
}

export const processValidationResults = (sessionId: string, results: ValidationResult[]): PostTurnDecision => {
  const decision = onValidationComplete(sessionId, results)
  if (decision.action === "diagnose" && decision.diagnosisInput) {
    const diagResult = Diagnosis.diagnose(decision.diagnosisInput)
    return onDiagnosisComplete(sessionId, diagResult)
  }
  return decision
}

export const shouldRunValidation = (sessionId: string): { should: boolean; commands: string[] } => {
  const state = SessionState.get(sessionId)
  if (!state) return { should: false, commands: [] }
  if (state.validationCommands.length === 0) return { should: false, commands: [] }
  return { should: true, commands: [...state.validationCommands] }
}

export const setValidationCommands = (sessionId: string, commands: string[]): void => {
  const state = SessionState.get(sessionId)
  if (!state) return
  state.validationCommands = commands
}

export const getBudgetStatus = (sessionId: string): Budget.BudgetCheck | null => {
  const state = SessionState.get(sessionId)
  if (!state) return null
  return Budget.check(state.roundState, state.budget)
}

const buildDiagnosisInput = (sessionId: string, results: ValidationResult[]): Diagnosis.DiagnosisInput => {
  const state = SessionState.get(sessionId)!
  return {
    round: state.roundState.round,
    validationResults: results,
    previousDiagnoses: state.roundState.diagnoses,
    errorOutput: state.lastValidationOutput,
  }
}

// Extract domain-activation signals from the user request (docs/31 §2 detection).
const signalsFromRequest = (request: string | null): readonly string[] => {
  if (!request) return []
  return request
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3)
    .slice(0, 24)
}

// P2-10: detect a compute backend from request signals so domain packs (e.g. gpu_kernel) reach
// their activation threshold. Returns undefined when no backend signal is present.
const detectBackend = (signals: readonly string[]): string | undefined => {
  const set = new Set(signals)
  if (set.has("cuda") || set.has("nvcc") || set.has("cudnn")) return "cuda"
  if (set.has("rocm") || set.has("hip")) return "rocm"
  return undefined
}
