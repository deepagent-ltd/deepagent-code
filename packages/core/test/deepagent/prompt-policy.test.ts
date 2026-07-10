import { describe, expect, test } from "bun:test"
import { buildSystemPrompt, buildVolatileRoundContext, type PromptContext } from "../../src/deepagent/prompt-policy"
import type { ActivationDecision } from "../../src/deepagent/activation-policy"
import type { RoundState } from "../../src/deepagent/round-state"

// Prompt-cache regression guard (docs/deepagent-cache-hit-fix-plan.md). The DeepAgent system prompt is
// the cached Anthropic prefix; it MUST be byte-stable across turns of a session. Per-turn volatile
// state (round, stage, previous-round results, budget, fan-out verdict) belongs in the tail-appended
// volatile round context, never in buildSystemPrompt.

type ActivationStage = ActivationDecision["stage"]

const activation = (stage: ActivationStage): ActivationDecision => ({
  stage,
  allowKnowledgeRetrieval: false,
  allowFullRedesign: false,
  maxPromptChars: 10000,
  maxInlineChars: 2000,
  requireValidation: true,
  suggestedReasoningEffort: "high",
  // NOTE: guidance is intentionally the SAME across rounds — it is stage-derived, not round-derived.
  guidance: "Work in short design → edit → validate loops.",
})

const roundState = (round: number, budget: number | null): RoundState => ({
  round,
  phase: "planning",
  stage: "first_fast_design",
  mode: "high",
  candidates: [],
  diagnoses: [],
  best_candidate: null,
  total_input_tokens: 0,
  total_output_tokens: 0,
  budget_remaining_tokens: budget,
  started_at: "2026-07-10T00:00:00.000Z",
  updated_at: "2026-07-10T00:00:00.000Z",
})

const ctxAt = (round: number, budget: number | null, stage: ActivationStage = "first_fast_design"): PromptContext => ({
  mode: "high",
  round,
  activation: activation(stage),
  roundState: roundState(round, budget),
  environment: {
    os: "macOS",
    shell: "/bin/zsh",
    cwd: "/repo",
    homedir: "/home/u",
    gitBranch: "main",
    gitRoot: "/repo",
    isGitRepo: true,
    date: "Jul 10, 2026",
    platform: "darwin",
  },
  task: {
    userRequest: "fix the bug",
    taskType: "code_modification",
    domain: "code",
    goals: ["Complete: fix the bug"],
    successCriteria: ["Declared validation passes"],
    riskBoundaries: ["Do not use destructive operations"],
    validationCommands: ["bun test"],
  },
  tools: { availableTools: [{ name: "edit", source: "builtin" }], mcpServers: [], totalToolCount: 1 },
  knowledge: null,
  previousResults: null,
  userInstructions: null,
})

describe("buildSystemPrompt prompt-cache stability", () => {
  test("byte-stable across rounds (round number differs, prefix must not)", () => {
    const r1 = buildSystemPrompt(ctxAt(1, 100_000))
    const r3 = buildSystemPrompt(ctxAt(3, 40_000))
    expect(r3).toBe(r1)
  })

  test("stable even when previous-round results appear (they live in the volatile tail)", () => {
    const base = ctxAt(2, 90_000)
    const withPrev: PromptContext = {
      ...base,
      previousResults: {
        lastCandidate: null,
        lastDiagnosis: { round: 1, root_cause: "type_error", evidence_refs: [], next_action: "revise" },
        validationOutput: "0/64 passed",
        bestCandidate: null,
      },
    }
    expect(buildSystemPrompt(withPrev)).toBe(buildSystemPrompt(base))
  })

  test("does NOT contain round number, previous-round results, or token budget", () => {
    const sys = buildSystemPrompt(ctxAt(5, 12_000))
    expect(sys).not.toContain("第 5 轮")
    expect(sys).not.toContain("Previous Round Results")
    expect(sys).not.toContain("Token budget remaining")
  })

  test("stable even when the task objective / activation stage changes (they are in the tail)", () => {
    const base = ctxAt(2, 90_000, "first_fast_design")
    const advanced: PromptContext = {
      ...ctxAt(3, 60_000, "revision_minimal"),
      task: { ...base.task, userRequest: "a totally different objective", goals: ["Complete: something else"] },
    }
    expect(buildSystemPrompt(advanced)).toBe(buildSystemPrompt(base))
  })
})

describe("buildVolatileRoundContext", () => {
  test("carries round, stage and budget, wrapped in the tail marker", () => {
    const vol = buildVolatileRoundContext(ctxAt(3, 40_000))
    expect(vol).toContain("<deepagent-round-context>")
    expect(vol).toContain("</deepagent-round-context>")
    expect(vol).toContain("第 3 轮")
    expect(vol).toContain("Token budget remaining: ~40k")
  })

  test("changes between rounds (that is its whole purpose)", () => {
    expect(buildVolatileRoundContext(ctxAt(1, 100_000))).not.toBe(buildVolatileRoundContext(ctxAt(2, 80_000)))
  })

  test("null budget omits the budget block", () => {
    const vol = buildVolatileRoundContext(ctxAt(1, null))
    expect(vol).not.toContain("Token budget remaining")
    // still non-empty: round/stage are always present
    expect(vol).toContain("第 1 轮")
  })
})
