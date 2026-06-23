// V3.1 agent-strength ladder. Monotonic: each strength adds exactly one capability.
//   general -> high (control plane + automatic micro-rounds) -> max (+ durable knowledge)
//   -> ultra (+ autonomy: supervisor auto-advances macro-rounds, human removed from the loop).
export type AgentMode = "general" | "high" | "max" | "ultra"

export type ActivationStage =
  | "first_fast_design"
  | "revision_minimal"
  | "diagnostic_minimal"
  | "knowledge_refresh"
  | "replan"

export type RunPhase =
  | "planning"
  | "executing"
  | "validating"
  | "diagnosing"
  | "checkpointed"
  | "paused"
  | "resuming"
  | "rolling_back"
  | "completed"
  | "failed"

export type RoundDecision = "continue" | "revise" | "rollback" | "escalate" | "complete" | "block"

export type ReviewDecision = "approve" | "revise" | "block"

// ultra inherits max's full capability set, including durable knowledge retrieval.
export const knowledgeEnabled = (mode: AgentMode) => mode === "max" || mode === "ultra"

// ultra is the only autonomous strength: its supervisor thread advances macro-rounds without a
// human. All other strengths require human approval to advance a macro-round.
export const isAutonomous = (mode: AgentMode) => mode === "ultra"

export const activationMode = (mode: AgentMode, round?: number, stage?: ActivationStage): ActivationStage => {
  if (round === undefined || round <= 1) return "first_fast_design"
  if (stage !== undefined) return stage
  return "revision_minimal"
}

// Only ultra has an autonomous round budget. Other strengths surface continuation to the human
// and rely on the normal model context/compaction path instead of a DeepAgent round cap.
export const defaultMaxRounds = (mode: AgentMode): number | null => (mode === "ultra" ? 8 : null)
