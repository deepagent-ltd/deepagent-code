// V3.2 agent-strength ladder. Monotonic: each strength adds exactly one capability.
//   general -> high  (control plane + micro-rounds + skills + project context/fact memory)
//           -> xhigh (+ domain knowledge + cross-project fact memory)
//           -> max   (+ strategies/methodologies)
//           -> ultra (+ autonomous workspace + auto macro-rounds)
export type AgentMode = "general" | "high" | "xhigh" | "max" | "ultra"

// Single source of truth for the monotonic strength ordering (weakest -> strongest).
// Used for tier arithmetic (rank / downgrade); keep aligned with the AgentMode union above.
export const MODE_ORDER: readonly AgentMode[] = ["general", "high", "xhigh", "max", "ultra"]

// Index of `mode` within MODE_ORDER, or -1 for an unknown value.
export const modeRank = (mode: AgentMode): number => MODE_ORDER.indexOf(mode)

// Pure helper for "child agent downgrade inheritance": a child that inherits-then-downgrades runs
// exactly one strength below its parent. ultra -> max -> xhigh -> high -> general; general -> general
// (already the floor, cannot descend further).
//
// Robustness: an unknown input (rank -1) has no defined tier, so we fail safe to the weakest mode
// ("general") rather than returning the unrecognized value unchanged — a downgrade must never hand
// back an equal-or-higher strength than intended.
export const downgradeOneLevel = (mode: AgentMode): AgentMode => {
  const rank = modeRank(mode)
  if (rank < 0) return "general"
  if (rank === 0) return "general"
  return MODE_ORDER[rank - 1]
}

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

// Any durable retrieval is enabled for all non-general modes (docs/39 §3).
// high: skills + project context/fact memory.
// xhigh: + domain knowledge + cross-project fact memory.
// max/ultra: + strategies/methodologies.
export const knowledgeEnabled = (mode: AgentMode) => mode !== "general"

// Strategies and methodologies are injected only for max/ultra; they are the most powerful but
// also most likely to mislead the model on wrong task contexts (docs/39 §3.1).
export const strategyMethodologyEnabled = (mode: AgentMode) => mode === "max" || mode === "ultra"

// Domain knowledge docs are available from xhigh onwards (docs/39 §3.1).
export const domainKnowledgeEnabled = (mode: AgentMode) => mode === "xhigh" || mode === "max" || mode === "ultra"

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
