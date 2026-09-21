import { describe, expect, test } from "bun:test"
import { check, defaultBudget } from "../../src/deepagent/budget"
import {
  knowledgeEnabled,
  strategyMethodologyEnabled,
  domainKnowledgeEnabled,
  isAutonomous,
  defaultMaxRounds,
  type AgentMode,
} from "../../src/deepagent/mode"
import { createInitialRoundState } from "../../src/deepagent/round-state"
import * as SessionState from "../../src/deepagent/session-state"

// docs/39 §3: the strength ladder is monotonic — each strength adds exactly one capability.
describe("V3.2 agent-strength ladder (docs/39)", () => {
  test("knowledgeEnabled: all non-general modes have durable retrieval", () => {
    expect(knowledgeEnabled("general")).toBe(false)
    expect(knowledgeEnabled("high")).toBe(true)
    expect(knowledgeEnabled("xhigh")).toBe(true)
    expect(knowledgeEnabled("max")).toBe(true)
    expect(knowledgeEnabled("ultra")).toBe(true)
  })

  test("strategyMethodologyEnabled: only max/ultra may inject strategies/methodologies", () => {
    expect(strategyMethodologyEnabled("general")).toBe(false)
    expect(strategyMethodologyEnabled("high")).toBe(false)
    expect(strategyMethodologyEnabled("xhigh")).toBe(false)
    expect(strategyMethodologyEnabled("max")).toBe(true)
    expect(strategyMethodologyEnabled("ultra")).toBe(true)
  })

  test("domainKnowledgeEnabled: xhigh and above see domain knowledge docs", () => {
    expect(domainKnowledgeEnabled("general")).toBe(false)
    expect(domainKnowledgeEnabled("high")).toBe(false)
    expect(domainKnowledgeEnabled("xhigh")).toBe(true)
    expect(domainKnowledgeEnabled("max")).toBe(true)
    expect(domainKnowledgeEnabled("ultra")).toBe(true)
  })

  test("ultra is the only autonomous strength", () => {
    expect((["general", "high", "xhigh", "max"] as AgentMode[]).some(isAutonomous)).toBe(false)
    expect(isAutonomous("ultra")).toBe(true)
  })

  test("only ultra has an autonomous round budget", () => {
    expect(defaultMaxRounds("general")).toBeNull()
    expect(defaultMaxRounds("high")).toBeNull()
    expect(defaultMaxRounds("xhigh")).toBeNull()
    expect(defaultMaxRounds("max")).toBeNull()
    expect(defaultMaxRounds("ultra")).toBe(8)
  })

  test("non-ultra session budgets do not cap rounds or total tokens", () => {
    expect(defaultBudget("high")).toMatchObject({ maxRounds: null, maxTotalTokens: null })
    expect(defaultBudget("xhigh")).toMatchObject({ maxRounds: null, maxTotalTokens: null })
    expect(defaultBudget("max")).toMatchObject({ maxRounds: null, maxTotalTokens: null })
    expect(defaultBudget("ultra")).toMatchObject({ maxRounds: 8, maxTotalTokens: null })
  })

  test("non-ultra budget checks ignore accumulated round count", () => {
    expect(check({ ...createInitialRoundState("max"), round: 999 }, defaultBudget("max"))).toMatchObject({
      status: "ok",
      roundsRemaining: null,
    })
    expect(check({ ...createInitialRoundState("ultra"), round: 9 }, defaultBudget("ultra"))).toMatchObject({
      status: "exceeded",
      message: "Max rounds exceeded.",
    })
  })

  test("existing non-ultra session state is normalized away from old round budgets", () => {
    const sessionID = `budget-migration-${crypto.randomUUID()}`
    SessionState.getOrCreate(sessionID, "max")
    SessionState.update(sessionID, {
      budget: { ...defaultBudget("max"), maxRounds: 1, maxTotalTokens: 1 },
      roundState: { ...createInitialRoundState("max"), round: 999, total_input_tokens: 100, total_output_tokens: 100 },
    })

    // Non-ultra modes never cap ROUNDS: the legacy maxRounds is still reset. B4 (design §7.3):
    // an explicitly configured TOKEN ceiling is now PRESERVED (the old reset made every budget
    // warning unreachable), so with usage past it the exhausted branch is reachable.
    expect(SessionState.getOrCreate(sessionID, "max").budget).toMatchObject({ maxRounds: null, maxTotalTokens: 1 })
    expect(SessionState.budgetStatus(sessionID)).toMatchObject({
      status: "exhausted",
      roundsRemaining: null,
      tokensRemaining: 0,
    })
    SessionState.cleanup(sessionID)
  })
})
