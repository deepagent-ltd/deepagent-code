import { beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { DeepAgentBudget, DeepAgentSessionState } from "../../src/deepagent"
import { tmpRoot } from "../fixture/tmpdir"

// B4 (design §7.3, DeepAgent budget track): normalizeState used to reset maxTotalTokens to the
// null default on EVERY load, so Budget.check's warning/exhausted branches were unreachable.
// An explicitly configured ceiling must now survive both the in-memory normalize path and a
// disk reload; an unconfigured session keeps the null default.
describe("DeepAgent session-state budget ceiling", () => {
  beforeEach(() => {
    DeepAgentSessionState.configure(mkdtempSync(tmpRoot()))
  })

  test("an unconfigured session keeps the null token ceiling", () => {
    DeepAgentSessionState.getOrCreate("budget-fresh", "high")
    expect(DeepAgentSessionState.get("budget-fresh")?.budget.maxTotalTokens).toBeNull()
    // The normalize path on an existing session must not invent a ceiling either.
    expect(DeepAgentSessionState.getOrCreate("budget-fresh", "high").budget.maxTotalTokens).toBeNull()
  })

  test("normalizeState preserves an explicitly configured maxTotalTokens and the warning fires", () => {
    const sessionId = "budget-explicit"
    DeepAgentSessionState.getOrCreate(sessionId, "high")
    const state = DeepAgentSessionState.get(sessionId)!
    DeepAgentSessionState.update(sessionId, { budget: { ...state.budget, maxTotalTokens: 100 } })

    // In-memory normalize path: getOrCreate on an existing session runs normalizeState, which
    // previously reset the ceiling to null.
    expect(DeepAgentSessionState.getOrCreate(sessionId, "high").budget.maxTotalTokens).toBe(100)

    // The warning path is reachable now: usage past warnAtPercent (90) of the ceiling warns.
    DeepAgentSessionState.recordTokenUsage(sessionId, 95, 0)
    const check = DeepAgentSessionState.budgetStatus(sessionId)
    if (check === undefined) throw new Error("expected a budget status")
    expect(check.status).toBe("warning")
    expect(check.tokensRemaining).toBe(5)
    expect(DeepAgentBudget.shouldWarn(check)).toBe(true)
  })

  test("the configured ceiling survives a disk reload", () => {
    const dir = mkdtempSync(tmpRoot())
    DeepAgentSessionState.configure(dir)
    const sessionId = "budget-reload"
    DeepAgentSessionState.getOrCreate(sessionId, "high")
    const state = DeepAgentSessionState.get(sessionId)!
    DeepAgentSessionState.update(sessionId, { budget: { ...state.budget, maxTotalTokens: 123_000 } })

    // Reconfiguring the same dir clears the in-memory map and re-loads sessions.json through
    // normalizeState — the reset-to-null bug lived exactly on this path.
    DeepAgentSessionState.configure(dir)
    expect(DeepAgentSessionState.get(sessionId)?.budget.maxTotalTokens).toBe(123_000)
    // Mode-derived fields keep their re-derived defaults (maxRounds behavior is unchanged).
    expect(DeepAgentSessionState.get(sessionId)?.budget.maxRounds).toBeNull()
  })
})
