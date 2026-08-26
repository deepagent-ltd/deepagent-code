import type { ActivationStage, AgentMode } from "./mode"
import { knowledgeEnabled } from "./mode"
import type { RoundState } from "./round-state"

export type ActivationContext = {
  readonly mode: AgentMode
  readonly round: number
  readonly stage: ActivationStage
  readonly previousValidationPassed: boolean
  readonly previousDiagnosisAvailable: boolean
  readonly userRequestedDeeper: boolean
  readonly budgetExhausted: boolean
}

export type ActivationDecision = {
  readonly stage: ActivationStage
  readonly allowKnowledgeRetrieval: boolean
  readonly allowFullRedesign: boolean
  readonly maxPromptChars: number
  readonly maxInlineChars: number
  readonly requireValidation: boolean
  readonly suggestedReasoningEffort: "low" | "medium" | "high" | "max"
  readonly guidance: string
}

export const decide = (ctx: ActivationContext): ActivationDecision => {
  if (ctx.budgetExhausted) {
    return {
      stage: ctx.stage,
      allowKnowledgeRetrieval: false,
      allowFullRedesign: false,
      maxPromptChars: 6000,
      maxInlineChars: 3000,
      requireValidation: false,
      suggestedReasoningEffort: "low",
      guidance: "Budget exhausted. Produce the best result with current information and complete.",
    }
  }

  switch (ctx.stage) {
    case "first_fast_design":
      return firstFastDesign(ctx)
    case "revision_minimal":
      return revisionMinimal(ctx)
    case "diagnostic_minimal":
      return diagnosticMinimal(ctx)
    case "knowledge_refresh":
      return knowledgeRefresh(ctx)
    case "replan":
      return replan(ctx)
  }
}

const firstFastDesign = (ctx: ActivationContext): ActivationDecision => ({
  stage: "first_fast_design",
  // docs/39 §3.3: non-general modes retrieve skills + context memory on round 1 so that
  // cross-session context is available from the very first turn of a new conversation.
  allowKnowledgeRetrieval: ctx.mode !== "general",
  allowFullRedesign: false,
  maxPromptChars: 12000,
  maxInlineChars: 6000,
  requireValidation: true,
  suggestedReasoningEffort: "medium",
  guidance: [
    "## Role: Architect → Editor → Judge",
    "",
    "First round operates in three phases within this turn:",
    "",
    "**Architect phase**: Understand the request, identify constraints, form a short design.",
    "- What files are involved? What's the minimal change?",
    "- What could go wrong? What validation will prove correctness?",
    "",
    "**Editor phase**: Execute the design using tools (read, edit, write, shell).",
    "- Make scoped, minimal changes that implement the design.",
    "- Do not over-engineer or add unrelated improvements.",
    "",
    "**Judge phase**: Validate the result.",
    "- Run the declared validation commands (typecheck, test, lint).",
    "- If all pass: task complete. If any fail: report clearly.",
    "",
    "Do NOT load full knowledge bases or do extensive reasoning upfront.",
    "If validation passes on first attempt, the task is complete.",
  ].join("\n"),
})

const revisionMinimal = (ctx: ActivationContext): ActivationDecision => ({
  stage: "revision_minimal",
  allowKnowledgeRetrieval: false,
  allowFullRedesign: false,
  maxPromptChars: 10000,
  maxInlineChars: 5000,
  requireValidation: true,
  suggestedReasoningEffort: "medium",
  guidance: [
    `## Role: Judge → Editor → Judge (Round ${ctx.round})`,
    "",
    "**Judge phase**: Review the previous failure evidence.",
    ctx.previousDiagnosisAvailable
      ? "- A diagnosis is available — use its root cause and evidence."
      : "- No formal diagnosis — carefully read the validation output.",
    "",
    "**Editor phase**: Apply a SCOPED correction.",
    "- Fix only what the evidence identified. Do NOT rewrite unrelated code.",
    "- Make the minimal change that addresses the root cause.",
    "",
    "**Judge phase**: Run validation again.",
    "- If pass: complete. If fail: report for next diagnosis cycle.",
  ].join("\n"),
})

const diagnosticMinimal = (ctx: ActivationContext): ActivationDecision => ({
  stage: "diagnostic_minimal",
  allowKnowledgeRetrieval: false,
  allowFullRedesign: false,
  maxPromptChars: 10000,
  maxInlineChars: 5000,
  requireValidation: true,
  suggestedReasoningEffort: "high",
  guidance: [
    `## Role: Judge (Diagnostic) → Editor → Judge (Round ${ctx.round})`,
    "",
    "**Judge (Diagnostic) phase**: Previous fix did not resolve the issue. Diagnose deeply.",
    "- Analyze the error output systematically.",
    "- Identify the actual root cause (not symptoms).",
    "- If evidence is insufficient, use tools to gather more (read logs, run tests in isolation, inspect state).",
    "- Do NOT guess or blindly retry the same approach.",
    "",
    "**Editor phase**: Once root cause is clear, apply a targeted fix.",
    "",
    "**Judge phase**: Validate the fix.",
  ].join("\n"),
})

const knowledgeRefresh = (ctx: ActivationContext): ActivationDecision => ({
  stage: "knowledge_refresh",
  allowKnowledgeRetrieval: knowledgeEnabled(ctx.mode),
  allowFullRedesign: false,
  maxPromptChars: 14000,
  maxInlineChars: 7000,
  requireValidation: true,
  suggestedReasoningEffort: "high",
  guidance: [
    `Round ${ctx.round}: refresh knowledge and attempt an informed solution.`,
    knowledgeEnabled(ctx.mode)
      ? ctx.mode === "max" || ctx.mode === "ultra"
        ? "Knowledge retrieval is enabled. Use strategy synthesis and methodology refs to guide the approach."
        : "Knowledge retrieval is enabled. Use skill and memory refs to guide the approach."
      : "Knowledge retrieval not available in this mode. Use diagnostic evidence and general expertise.",
    "After applying the fix, run validation.",
  ].join("\n"),
})

const replan = (ctx: ActivationContext): ActivationDecision => ({
  stage: "replan",
  allowKnowledgeRetrieval: knowledgeEnabled(ctx.mode),
  allowFullRedesign: true,
  maxPromptChars: 14000,
  maxInlineChars: 7000,
  requireValidation: true,
  suggestedReasoningEffort: "max",
  guidance: [
    `Round ${ctx.round}: previous approaches failed. Replan from scratch.`,
    "Review all previous candidates and diagnoses.",
    "Choose a fundamentally different approach if the current direction is blocked.",
    "Full redesign is allowed but must still be scoped and validated.",
  ].join("\n"),
})

export const shouldEscalateToMax = (state: RoundState): boolean =>
  state.mode === "high" && state.round >= 3 && state.best_candidate === null

export const nextStageAfterValidation = (passed: boolean, state: RoundState): ActivationStage => {
  if (passed) return state.stage
  if (state.stage === "first_fast_design") return "revision_minimal"
  if (state.stage === "revision_minimal" && state.round >= 2) return "diagnostic_minimal"
  if (state.stage === "diagnostic_minimal") return "knowledge_refresh"
  return "replan"
}
