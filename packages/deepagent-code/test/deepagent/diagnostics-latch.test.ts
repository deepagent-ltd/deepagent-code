import { describe, expect, test } from "bun:test"
import { AgentGateway } from "@deepagent-code/core/agent-gateway"
import { Effect } from "effect"
import { latchPlanOnDiagnosticsError } from "../../src/tool/diagnostics-latch"

// L4 (S1-v3.4) acceptance (e): post-edit diagnostics derive a plan-stale latch in high+,
// but NEVER in lightweight (general/direct) modes — the default agent must not regress.

const errorDiag = {
  "/x.ts": [
    {
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
      severity: 1,
      message: "boom",
    } as any,
  ],
}
const cleanDiag = {
  "/x.ts": [
    {
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
      severity: 2,
      message: "warn",
    } as any,
  ],
}

describe("L4 diagnostics → plan latch", () => {
  test("high mode: error diagnostics mark the plan stale with diagnostics_error", async () => {
    AgentGateway.configure({ enabled: true, agentMode: "high" })
    const sessionID = `ses_diag_latch_high_${crypto.randomUUID()}`
    AgentGateway.DeepAgentSessionState.getOrCreate(sessionID, "high")
    await Effect.runPromise(latchPlanOnDiagnosticsError(sessionID, errorDiag))
    const latch = AgentGateway.DeepAgentSessionState.planLatch(sessionID)
    expect(latch?.latch).toBe("stale")
    expect(latch?.stale_reason).toBe("diagnostics_error")
  })

  test("general mode: error diagnostics do NOT touch the latch (no regression)", async () => {
    AgentGateway.configure({ enabled: true, agentMode: "general" })
    const sessionID = `ses_diag_latch_general_${crypto.randomUUID()}`
    AgentGateway.DeepAgentSessionState.getOrCreate(sessionID, "general")
    await Effect.runPromise(latchPlanOnDiagnosticsError(sessionID, errorDiag))
    const latch = AgentGateway.DeepAgentSessionState.planLatch(sessionID)
    expect(latch?.latch).toBe("fresh")
    AgentGateway.configure({ enabled: false, agentMode: "high" })
  })

  test("high mode: clean (non-error) diagnostics do not mark stale", async () => {
    AgentGateway.configure({ enabled: true, agentMode: "high" })
    const sessionID = `ses_diag_latch_clean_${crypto.randomUUID()}`
    AgentGateway.DeepAgentSessionState.getOrCreate(sessionID, "high")
    await Effect.runPromise(latchPlanOnDiagnosticsError(sessionID, cleanDiag))
    const latch = AgentGateway.DeepAgentSessionState.planLatch(sessionID)
    expect(latch?.latch).toBe("fresh")
  })
})
