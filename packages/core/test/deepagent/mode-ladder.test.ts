import { describe, expect, test } from "bun:test"
import { check, defaultBudget } from "../../src/deepagent/budget"
import { knowledgeEnabled, isAutonomous, defaultMaxRounds, type AgentMode } from "../../src/deepagent/mode"
import { createInitialRoundState } from "../../src/deepagent/round-state"
import * as SessionState from "../../src/deepagent/session-state"

// C4: the strength ladder is monotonic — each strength adds exactly one capability.
describe("V3.1 agent-strength ladder (ultra)", () => {
  test("knowledge is enabled for max and ultra only", () => {
    expect(knowledgeEnabled("general")).toBe(false)
    expect(knowledgeEnabled("high")).toBe(false)
    expect(knowledgeEnabled("max")).toBe(true)
    expect(knowledgeEnabled("ultra")).toBe(true)
  })

  test("ultra is the only autonomous strength", () => {
    expect((["general", "high", "max"] as AgentMode[]).some(isAutonomous)).toBe(false)
    expect(isAutonomous("ultra")).toBe(true)
  })

  test("only ultra has an autonomous round budget", () => {
    expect(defaultMaxRounds("general")).toBeNull()
    expect(defaultMaxRounds("high")).toBeNull()
    expect(defaultMaxRounds("max")).toBeNull()
    expect(defaultMaxRounds("ultra")).toBe(8)
  })

  test("non-ultra session budgets do not cap rounds or total tokens", () => {
    expect(defaultBudget("high")).toMatchObject({ maxRounds: null, maxTotalTokens: null })
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

    expect(SessionState.getOrCreate(sessionID, "max").budget).toMatchObject({ maxRounds: null, maxTotalTokens: null })
    expect(SessionState.budgetStatus(sessionID)).toMatchObject({ status: "ok", roundsRemaining: null, tokensRemaining: null })
    SessionState.cleanup(sessionID)
  })
})
