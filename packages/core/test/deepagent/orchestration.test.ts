import { describe, expect, test } from "bun:test"
import {
  buildOrchestrationSection,
  capConcurrency,
  capFanout,
  decideFanout,
  DEFAULT_MAX_CONCURRENCY,
  DEFAULT_MAX_FANOUT,
  estimateComplexity,
  estimateSignalsFromText,
  reviewerVotesForMode,
  resolveCaps,
  tierForMode,
} from "../../src/deepagent/orchestration"
import type { AgentMode } from "../../src/deepagent/mode"

// L2 (v3.8.0 §L2): fan-out decision is a PURE function of mode (档位) and complexity (复杂度).
describe("L2 orchestration fan-out decision", () => {
  test("tierForMode: general is 0 (off), ultra is 3", () => {
    expect(tierForMode("general")).toBe(0)
    expect(tierForMode("high")).toBe(1)
    expect(tierForMode("xhigh")).toBe(1)
    expect(tierForMode("max")).toBe(2)
    expect(tierForMode("ultra")).toBe(3)
  })

  test("reviewerVotesForMode matches the §L2 table", () => {
    expect(reviewerVotesForMode("general")).toBe(0)
    expect(reviewerVotesForMode("high")).toBe(1)
    expect(reviewerVotesForMode("xhigh")).toBe(1)
    expect(reviewerVotesForMode("max")).toBe(2)
    expect(reviewerVotesForMode("ultra")).toBe(3)
  })

  test("estimateComplexity: suppression signals hard-floor to 0", () => {
    expect(estimateComplexity({ trivialMechanical: true, fileOrModuleCount: 10, safetySensitive: true })).toBe(0)
    expect(estimateComplexity({ userRequestedFast: true, crossSubsystem: true })).toBe(0)
  })

  test("estimateComplexity: monotonically increases with number of fan-out signals", () => {
    expect(estimateComplexity({})).toBe(0)
    expect(estimateComplexity({ fileOrModuleCount: 3 })).toBe(1)
    expect(estimateComplexity({ fileOrModuleCount: 3, multipleApproaches: true })).toBe(2)
    expect(
      estimateComplexity({ fileOrModuleCount: 5, multipleApproaches: true, safetySensitive: true }),
    ).toBe(3)
  })

  test("merge rule level = min(tier, complexity): ultra + trivial task does NOT over-orchestrate", () => {
    const decision = decideFanout({ mode: "ultra", signals: { trivialMechanical: true } })
    expect(decision.tier).toBe(3)
    expect(decision.complexity).toBe(0)
    expect(decision.level).toBe(0)
    expect(decision.orchestrate).toBe(false)
    expect(decision.researchers).toBe(0)
    expect(decision.reviewers).toBe(0)
  })

  test("merge rule: high-complexity task at general (tier 0) still does NOT orchestrate by default", () => {
    const decision = decideFanout({
      mode: "general",
      signals: { fileOrModuleCount: 8, multipleApproaches: true, safetySensitive: true },
    })
    expect(decision.complexity).toBe(3)
    expect(decision.tier).toBe(0)
    expect(decision.level).toBe(0)
    expect(decision.orchestrate).toBe(false)
  })

  test("general + explicit user request (forceOrchestrate) DOES orchestrate with at least one reviewer", () => {
    const decision = decideFanout({
      mode: "general",
      signals: { fileOrModuleCount: 4 },
      forceOrchestrate: true,
    })
    expect(decision.orchestrate).toBe(true)
    expect(decision.researchers).toBeGreaterThanOrEqual(2)
    expect(decision.reviewers).toBeGreaterThanOrEqual(1)
  })

  test("max + complex task orchestrates with reviewers from the mode votes", () => {
    const decision = decideFanout({
      mode: "max",
      signals: { fileOrModuleCount: 4, multipleApproaches: true },
    })
    expect(decision.orchestrate).toBe(true)
    expect(decision.level).toBe(2)
    expect(decision.researchers).toBeGreaterThanOrEqual(2)
    expect(decision.reviewers).toBe(reviewerVotesForMode("max"))
  })
})

// The CRITICAL requirement: caps are enforced in CODE, configurable, with LENIENT defaults.
describe("L2 hard caps (code-layer, configurable, lenient default)", () => {
  test("resolveCaps: unset config yields the lenient defaults (not a tight number)", () => {
    expect(resolveCaps(undefined)).toEqual({
      maxFanout: DEFAULT_MAX_FANOUT,
      maxConcurrency: DEFAULT_MAX_CONCURRENCY,
    })
    // lenient means generous, not 1-2
    expect(DEFAULT_MAX_FANOUT).toBeGreaterThanOrEqual(5)
    expect(DEFAULT_MAX_CONCURRENCY).toBeGreaterThanOrEqual(3)
  })

  test("capFanout: an exaggerated request is clamped to the hard cap", () => {
    expect(capFanout(1000)).toBe(DEFAULT_MAX_FANOUT)
    expect(capConcurrency(1000)).toBe(DEFAULT_MAX_CONCURRENCY)
  })

  test("capFanout: caps are CONFIGURABLE — a deployment can set its own ceiling", () => {
    expect(capFanout(1000, { maxFanout: 3 })).toBe(3)
    expect(capConcurrency(1000, { maxConcurrency: 2 })).toBe(2)
    // and can loosen well past the default too
    expect(capFanout(30, { maxFanout: 50 })).toBe(30)
  })

  test("capFanout: negative / non-finite requests degrade to 0, never negative", () => {
    expect(capFanout(-5)).toBe(0)
    expect(capFanout(Number.NaN)).toBe(0)
  })

  test("decideFanout: total subagents never exceed the configured hard cap even for an extreme task", () => {
    const decision = decideFanout({
      mode: "ultra",
      signals: {
        fileOrModuleCount: 999,
        multipleApproaches: true,
        safetySensitive: true,
        crossSubsystem: true,
        userRequestedDepth: true,
      },
      caps: { maxFanout: 4 },
    })
    expect(decision.researchers + decision.reviewers).toBeLessThanOrEqual(4)
  })
})

describe("L2 orchestration prompt section (single source, both paths)", () => {
  test("general (tier 0): section says do NOT auto-orchestrate", () => {
    const section = buildOrchestrationSection("general")
    expect(section).not.toBeNull()
    expect(section).toContain("默认不自动编排")
  })

  test("high/max/ultra: section gives the fan-out procedure and reviewer votes", () => {
    for (const mode of ["high", "max", "ultra"] as AgentMode[]) {
      const section = buildOrchestrationSection(mode)!
      expect(section).toContain("扇出判据")
      expect(section).toContain("researcher")
      expect(section).toContain("reviewer")
      expect(section).toContain("output_schema")
      // reviewer vote count is embedded
      expect(section).toContain(String(reviewerVotesForMode(mode)))
    }
  })

  test("ultra adds the multi-round hint", () => {
    expect(buildOrchestrationSection("ultra")).toContain("ultra")
  })
})

// §5b: the lightweight text heuristic that produces ComplexitySignals for the runtime decision.
describe("§5b estimateSignalsFromText (lightweight heuristic)", () => {
  test("empty / no request ⇒ no signals set", () => {
    expect(estimateSignalsFromText({ userRequest: null })).toEqual({})
    expect(estimateSignalsFromText({ userRequest: "" })).toEqual({})
  })

  test("single-file typo ⇒ trivialMechanical (suppresses fan-out)", () => {
    const signals = estimateSignalsFromText({ userRequest: "fix a typo in utils.ts" })
    expect(signals.trivialMechanical).toBe(true)
    expect(estimateComplexity(signals)).toBe(0)
  })

  test('"quick" / "just" ⇒ userRequestedFast (suppresses fan-out)', () => {
    expect(estimateSignalsFromText({ userRequest: "just quickly rename this" }).userRequestedFast).toBe(true)
  })

  test("depth/review keywords ⇒ userRequestedDepth", () => {
    expect(estimateSignalsFromText({ userRequest: "do a thorough review of the auth flow" }).userRequestedDepth).toBe(
      true,
    )
    expect(estimateSignalsFromText({ userRequest: "深入分析这个模块" }).userRequestedDepth).toBe(true)
  })

  test("safety-sensitive keywords ⇒ safetySensitive", () => {
    expect(estimateSignalsFromText({ userRequest: "add a database migration" }).safetySensitive).toBe(true)
    expect(estimateSignalsFromText({ userRequest: "harden the auth check" }).safetySensitive).toBe(true)
  })

  test("cross-subsystem keywords ⇒ crossSubsystem", () => {
    expect(estimateSignalsFromText({ userRequest: "change the interface across subsystems" }).crossSubsystem).toBe(
      true,
    )
  })

  test("caller-supplied fileOrModuleCount is threaded through", () => {
    expect(estimateSignalsFromText({ userRequest: "refactor", fileOrModuleCount: 4 }).fileOrModuleCount).toBe(4)
  })
})

// §5b: the runtime decision is injected into the prompt as concrete, task-specific numbers.
describe("§5b decision injection into the prompt section", () => {
  test("single-file typo at high (trivial) ⇒ section says NOT to fan out", () => {
    const signals = estimateSignalsFromText({ userRequest: "fix the typo in foo.ts" })
    const decision = decideFanout({ mode: "high", signals })
    expect(decision.orchestrate).toBe(false)
    const section = buildOrchestrationSection("high", decision)!
    expect(section).toContain("不建议扇出")
  })

  test("cross ≥3-module safety task at max ⇒ section recommends researchers + reviewers with numbers", () => {
    const signals = estimateSignalsFromText({
      userRequest: "migrate the auth interface across subsystems and review it thoroughly",
      fileOrModuleCount: 4,
    })
    const decision = decideFanout({ mode: "max", signals })
    expect(decision.orchestrate).toBe(true)
    expect(decision.researchers).toBeGreaterThanOrEqual(2)
    const section = buildOrchestrationSection("max", decision)!
    expect(section).toContain("本轮调度判定")
    expect(section).toContain(`建议扇出约 ${decision.researchers} 个 researcher`)
    // the per-round concurrency number reflects the decision's cap
    expect(section).toContain(`单轮并行上限 ${decision.maxConcurrency}`)
  })

  test("decision maxConcurrency drives the section's self-limit number (configurable)", () => {
    const signals = estimateSignalsFromText({
      userRequest: "review multiple approaches across subsystems",
      fileOrModuleCount: 5,
    })
    const decision = decideFanout({ mode: "ultra", signals, caps: { maxConcurrency: 2 } })
    const section = buildOrchestrationSection("ultra", decision)!
    expect(section).toContain("单轮并行不超过 2 个")
  })

  test("omitting the decision keeps the generic guidance (backward-compatible)", () => {
    const section = buildOrchestrationSection("high")!
    expect(section).toContain("扇出判据")
    expect(section).not.toContain("本轮调度判定")
  })
})
