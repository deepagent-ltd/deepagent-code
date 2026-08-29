import { beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { DeepAgentPlanStore, DeepAgentSessionState } from "../../src/deepagent"

const plan = (sessionId: string, planId: string, goal: string) => ({
  plan_id: planId,
  session_id: sessionId,
  goal,
  assumptions: [],
  steps: [{ step_id: "step_1", title: goal, status: "active" as const }],
  active_step_id: "step_1",
  created_at: new Date().toISOString(),
})

describe("DeepAgent activity lifecycle", () => {
  beforeEach(() => {
    DeepAgentSessionState.configure(mkdtempSync(path.join(tmpdir(), "deepagent-activity-")))
  })

  test("a new admission reopens completed activity state without deleting plan history", () => {
    const sessionId = "activity-reopen"
    const state = DeepAgentSessionState.getOrCreate(sessionId, "high")
    expect(DeepAgentSessionState.observeUserAdmission(sessionId, "msg_a")).toBe("initial")
    DeepAgentSessionState.setPlan(sessionId, plan(sessionId, "plan_old", "old task"))
    DeepAgentSessionState.advanceToNextRound(sessionId, "continue")
    DeepAgentSessionState.recordValidation(
      sessionId,
      [
        {
          command: "bun test",
          passed: false,
          kind: "command_exit",
          exit_code: 1,
          output: "failed",
          duration_ms: 1,
        },
      ],
      "failed",
    )
    DeepAgentSessionState.suppressValidation(sessionId, "bun test", 1, "old activity")
    DeepAgentSessionState.complete(sessionId)
    const oldRunId = state.runId

    expect(DeepAgentSessionState.observeUserAdmission(sessionId, "msg_b")).toBe("reopened")
    const reopened = DeepAgentSessionState.get(sessionId)!
    expect(reopened.roundState).toMatchObject({ round: 1, phase: "planning", stage: "first_fast_design" })
    expect(reopened.lastValidationResults).toEqual([])
    expect(reopened.lastValidationOutput).toBeNull()
    expect(reopened.suppressedValidations).toEqual([])
    expect(reopened.completedAt).toBeNull()
    expect(reopened.runId).not.toBe(oldRunId)
    expect(reopened.planLatch).toMatchObject({ plan_id: null, latch: "fresh", stale_reason: null })
    expect(DeepAgentSessionState.getPlan(sessionId)).toBeNull()
    expect(DeepAgentPlanStore.getPlanDoc(sessionId)?.plan_id).toBe("plan_old")

    DeepAgentSessionState.setPlan(sessionId, plan(sessionId, "plan_new", "new task"))
    expect(DeepAgentSessionState.getPlan(sessionId)?.goal).toBe("new task")
  })

  test("the same admission never reopens a just-completed activity", () => {
    const sessionId = "activity-same-admission"
    DeepAgentSessionState.getOrCreate(sessionId, "high")
    expect(DeepAgentSessionState.observeUserAdmission(sessionId, "msg_a")).toBe("initial")
    DeepAgentSessionState.complete(sessionId)

    expect(DeepAgentSessionState.observeUserAdmission(sessionId, "msg_a")).toBe("same")
    expect(DeepAgentSessionState.get(sessionId)?.roundState.phase).toBe("completed")
  })

  test("a new admission during a live activity remains a steer signal", () => {
    const sessionId = "activity-steer"
    DeepAgentSessionState.getOrCreate(sessionId, "high")
    DeepAgentSessionState.observeUserAdmission(sessionId, "msg_a")
    DeepAgentSessionState.advanceToNextRound(sessionId, "continue")

    expect(DeepAgentSessionState.observeUserAdmission(sessionId, "msg_b")).toBe("new")
    expect(DeepAgentSessionState.get(sessionId)?.roundState.round).toBe(2)
  })
})
