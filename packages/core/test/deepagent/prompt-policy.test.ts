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

  test("T4.4: the fan-out verdict does NOT enter the system prefix (it is task-complexity-derived, per-turn)", () => {
    const base = ctxAt(2, 90_000)
    // A concrete fan-out decision — the exact vector the orchestrator stamps per turn. It changes with
    // the user request every turn, so leaking it into the cached prefix would bust the prompt cache.
    const withFanout: PromptContext = {
      ...base,
      fanoutDecision: {
        orchestrate: true,
        level: 2,
        tier: 3,
        complexity: 2,
        researchers: 3,
        reviewers: 1,
        maxConcurrency: 4,
      },
    }
    // Prefix is byte-identical with/without the fan-out verdict …
    expect(buildSystemPrompt(withFanout)).toBe(buildSystemPrompt(base))
    // … and the verdict lands in the VOLATILE tail instead (proving it is emitted, just in the right place).
    const tail = buildVolatileRoundContext(withFanout)
    expect(tail).toContain("orchestration verdict")
    expect(buildVolatileRoundContext(base)).not.toContain("orchestration verdict")
  })

  test("BUG #5: lazily-retrieved knowledge does NOT enter the system prefix (it appears mid-session)", () => {
    // Round 1 on a fresh/empty store retrieves no knowledge (null); a later retrieval-enabled round
    // returns a synthesis. If knowledge sat in the cached prefix, that late appearance would bust the
    // prompt cache for the rest of the session (~10× cost). The prefix must be byte-identical either way.
    const base: PromptContext = { ...ctxAt(1, 100_000), mode: "max" } // knowledge is gated to max/ultra
    const withKnowledge: PromptContext = {
      ...ctxAt(4, 40_000),
      mode: "max",
      knowledge: {
        synthesis: "prefer parameterized queries; the ORM escapes inputs",
        strategyRefs: ["strat-1"],
        methodologyRefs: ["meth-2"],
        memoryRefs: [],
        conflicts: [],
      },
    }
    // Prefix is byte-identical with/without the (late) knowledge synthesis …
    expect(buildSystemPrompt(withKnowledge)).toBe(buildSystemPrompt(base))
    // … and the synthesis lands in the VOLATILE tail instead (proving it still reaches the model).
    const tail = buildVolatileRoundContext(withKnowledge)
    expect(tail).toContain("参考知识")
    expect(tail).toContain("prefer parameterized queries")
    expect(buildVolatileRoundContext(base)).not.toContain("参考知识")
  })

  test("MEDIUM: the current date does NOT enter the system prefix (it advances at midnight)", () => {
    // Baking the date into the cached prefix busts the whole prefix once per day. Two different dates
    // must yield a byte-identical prefix, with the date rendered in the volatile tail instead.
    const day1 = { ...ctxAt(2, 90_000), environment: { ...ctxAt(2, 90_000).environment, date: "Jul 10, 2026" } }
    const day2 = { ...ctxAt(2, 90_000), environment: { ...ctxAt(2, 90_000).environment, date: "Jul 11, 2026" } }
    expect(buildSystemPrompt(day2)).toBe(buildSystemPrompt(day1))
    expect(buildSystemPrompt(day1)).not.toContain("Jul 10, 2026")
    // … and the date still reaches the model via the volatile tail.
    expect(buildVolatileRoundContext(day1)).toContain("Jul 10, 2026")
    expect(buildVolatileRoundContext(day2)).toContain("Jul 11, 2026")
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
