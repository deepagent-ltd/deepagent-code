import { describe, expect, test } from "bun:test"
import { AgentGateway } from "@deepagent-code/core/agent-gateway"
import { SessionReminders } from "../../src/session/reminders"

// Regression: a session can reach the plan-status injection point without the DeepAgent gateway
// ever having configured a storage root (configureGateway only runs on managed turns, and a
// general-mode/plain host may never run one). The renderer must SKIP the injection (return null)
// instead of throwing "plan-store: no runtime state dir" out of the request path.
//
// This file deliberately never calls AgentGateway.configure / SessionState.configure, so the
// plan-store root stays unconfigured for the whole process.

const plan = (sessionID: string) =>
  AgentGateway.DeepAgentPlanController.buildPlanFromInput(sessionID, {
    goal: "carry a plan pointer",
    steps: [{ step_id: "step_1", title: "do the thing", status: "active" as const }],
    active_step_id: "step_1",
  })

// Latch a plan pointer without going through the plan store: getPlan only delegates to the store
// once a plan_id is latched, which is exactly the state a session carries over from a previously
// managed turn.
const latchPlan = (sessionID: string, mode: "general" | "high") => {
  AgentGateway.DeepAgentSessionState.getOrCreate(sessionID, mode)
  AgentGateway.DeepAgentSessionState.bindPlan(sessionID, plan(sessionID), null)
}

describe("renderPlanStatus without a configured plan-store root", () => {
  test("returns null for the general-mode injection call (includeLightweight)", () => {
    const sessionID = `ses_planstatus_noroot_general_${crypto.randomUUID()}`
    latchPlan(sessionID, "general")
    expect(SessionReminders.renderPlanStatus(sessionID, "full", { includeLightweight: true })).toBeNull()
  })

  test("returns null for the default injection call", () => {
    const sessionID = `ses_planstatus_noroot_default_${crypto.randomUUID()}`
    latchPlan(sessionID, "high")
    expect(SessionReminders.renderPlanStatus(sessionID)).toBeNull()
  })
})
