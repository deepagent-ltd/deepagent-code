import { describe, expect, test } from "bun:test"
import {
  consultPanel,
  armPanel,
  fetchPanelStatus,
  startGoal,
  pauseGoal,
  resumeGoal,
  stopGoal,
  goalStatus,
  buildGoalPlanWrite,
  editPlanGoal,
  fetchCapabilities,
} from "./panel-goal.api"

// V3.9 §C/§D route contract: the Expert Panel + Goal Loop UI talks to the raw-request escape-hatch
// routes (NOT the generated SDK). These lock the exact method/url/body so a backend rename of
// /deepagent/panel/* or /deepagent/goal/* breaks CI here instead of shipping a dead UI. Mirrors the
// backend group schemas in server/routes/instance/httpapi/groups/deepagent.ts.
type Recorded = { method: string; url: string; body?: unknown; headers?: Record<string, string> }

function client(calls: Recorded[], data: unknown) {
  return {
    client: {
      request: async <TData>(options: Recorded): Promise<{ data?: TData }> => {
        calls.push(options)
        return { data: data as TData }
      },
    },
  }
}

const JSON_HEADERS = { "Content-Type": "application/json" }

describe("Expert Panel route contract (§C)", () => {
  test("consultPanel POSTs /deepagent/panel/consult with the frozen question", async () => {
    const calls: Recorded[] = []
    const verdict = { decision: "approve" as const, confidence: 0.9, rounds: 1, evidence: [], dissent: [] }
    const result = await consultPanel(client(calls, verdict), {
      sessionID: "ses_1",
      question: "safe?",
      lenses: ["security"],
      policy: "security",
    })
    expect(calls).toEqual([
      {
        method: "POST",
        url: "/deepagent/panel/consult",
        body: { sessionID: "ses_1", question: "safe?", lenses: ["security"], policy: "security" },
        headers: JSON_HEADERS,
      },
    ])
    expect(result).toEqual(verdict)
  })

  test("armPanel POSTs /deepagent/panel/arm with rounds and returns the effective armed state + depth", async () => {
    const calls: Recorded[] = []
    const result = await armPanel(
      client(calls, { sessionID: "ses_1", armed: true, rounds: "multi" }),
      "ses_1",
      true,
      "multi",
    )
    expect(calls).toEqual([
      {
        method: "POST",
        url: "/deepagent/panel/arm",
        body: { sessionID: "ses_1", armed: true, rounds: "multi" },
        headers: JSON_HEADERS,
      },
    ])
    expect(result).toEqual({ armed: true, rounds: "multi" })
  })

  test("fetchPanelStatus GETs /deepagent/panel/status and reports armed + explicit + rounds", async () => {
    const calls: Recorded[] = []
    const status = await fetchPanelStatus(client(calls, { armed: true, explicit: false, rounds: "multi" }), "ses 1")
    expect(calls).toEqual([{ method: "GET", url: "/deepagent/panel/status?sessionID=ses%201" }])
    expect(status).toEqual({ armed: true, explicit: false, rounds: "multi" })
  })

  test("fetchPanelStatus tolerates a missing body (disarmed, not explicit, single-round default)", async () => {
    const calls: Recorded[] = []
    expect(await fetchPanelStatus(client(calls, {}), "ses_1")).toEqual({
      armed: false,
      explicit: false,
      rounds: "single",
    })
  })
})

describe("Goal Loop route contract (§D)", () => {
  test("startGoal POSTs /deepagent/goal/start and returns the snapshot", async () => {
    const calls: Recorded[] = []
    const snap = { goalId: "goal_1", planDocId: "plan_1", phase: "running", running: true }
    const result = await startGoal(client(calls, snap), { sessionID: "ses_1" })
    expect(calls).toEqual([
      { method: "POST", url: "/deepagent/goal/start", body: { sessionID: "ses_1" }, headers: JSON_HEADERS },
    ])
    expect(result).toEqual(snap)
  })

  test("pause/resume/stop POST the matching lifecycle route with { sessionID }", async () => {
    for (const [fn, action] of [
      [pauseGoal, "pause"],
      [resumeGoal, "resume"],
      [stopGoal, "stop"],
    ] as const) {
      const calls: Recorded[] = []
      const ok = await fn(client(calls, { ok: true }), "ses_1")
      expect(calls).toEqual([
        { method: "POST", url: `/deepagent/goal/${action}`, body: { sessionID: "ses_1" }, headers: JSON_HEADERS },
      ])
      expect(ok).toBe(true)
    }
  })

  test("goalStatus GETs /deepagent/goal/status with the sessionID query and unwraps goal", async () => {
    const calls: Recorded[] = []
    const snap = { goalId: "goal_1", planDocId: "plan_1", phase: "paused", running: false }
    const result = await goalStatus(client(calls, { goal: snap }), "ses 1")
    expect(calls).toEqual([{ method: "GET", url: "/deepagent/goal/status?sessionID=ses%201" }])
    expect(result).toEqual(snap)
  })

  test("goalStatus tolerates a null goal", async () => {
    const calls: Recorded[] = []
    expect(await goalStatus(client(calls, { goal: null }), "ses_1")).toBeNull()
  })

  test("editPlanGoal POSTs the strict durable admission envelope and returns its receipt", async () => {
    const calls: Recorded[] = []
    const planWrite = {
      operation: "advance" as const,
      expected_plan_id: "plan_1",
      expected_version: 7,
      goal: "ship it",
      assumptions: ["CI is available"],
      steps: [{ step_id: "step_1", title: "verify", status: "active" as const }],
      active_step_id: "step_1",
    }
    const receipt = {
      state: "queued" as const,
      activity_id: "activity_1",
      request_id: "request_1",
      candidate_hash: `sha256:${"a".repeat(64)}`,
    }
    const result = await editPlanGoal(client(calls, receipt), {
      sessionID: "ses_1",
      requestID: "request_1",
      planWrite,
      qualityChallengeID: "challenge_1",
    })
    expect(calls).toEqual([
      {
        method: "POST",
        url: "/deepagent/goal/edit-plan",
        body: {
          sessionID: "ses_1",
          request_id: "request_1",
          plan_write: planWrite,
          quality_challenge_id: "challenge_1",
        },
        headers: JSON_HEADERS,
      },
    ])
    expect(result).toEqual(receipt)
  })

  test("editPlanGoal leaves a missing response body explicit", async () => {
    const calls: Recorded[] = []
    expect(
      await editPlanGoal(client(calls, undefined), {
        sessionID: "ses_1",
        requestID: "request_1",
        planWrite: {
          operation: "advance",
          expected_plan_id: "plan_1",
          expected_version: 1,
          goal: "g",
          assumptions: [],
          steps: [{ step_id: "step_1", title: "step", status: "active" }],
          active_step_id: "step_1",
        },
      }),
    ).toBeUndefined()
  })

  test("buildGoalPlanWrite emits advance for status and blocker-note changes", () => {
    const result = buildGoalPlanWrite(
      {
        plan_id: "plan_1",
        plan_version: 4,
        goal: "ship",
        assumptions: ["CI"],
        steps: [
          { step_id: "step_a", title: "Implement", acceptance: "tests pass", assigned_agent: "build" },
          { step_id: "step_b", title: "Review", acceptance: "approved", assigned_agent: "review" },
        ],
      },
      {
        goal: "ship",
        assumptions: ["CI"],
        steps: [
          {
            step_id: "step_a",
            title: "Implement",
            acceptance: "tests pass",
            assigned_agent: "build",
            status: "done",
          },
          {
            step_id: "step_b",
            title: "Review",
            acceptance: "approved",
            assigned_agent: "review",
            status: "blocked",
            note: "waiting for owner",
          },
        ],
      },
    )

    expect(result.operation).toBe("advance")
    expect(result.expected_plan_id).toBe("plan_1")
    expect(result.expected_version).toBe(4)
    expect(result.steps.map((step) => step.step_id)).toEqual(["step_a", "step_b"])
    expect(result.active_step_id).toBeNull()
    expect(result.steps[0]).toMatchObject({ acceptance: "tests pass", assigned_agent: "build", note: null })
    expect(result.steps[1]).toMatchObject({
      acceptance: "approved",
      assigned_agent: "review",
      note: "waiting for owner",
    })
  })

  test("buildGoalPlanWrite keeps absent optional fields as explicit wire nulls", () => {
    const result = buildGoalPlanWrite(
      {
        plan_id: "plan_1",
        plan_version: 1,
        goal: "ship",
        assumptions: [],
        steps: [{ step_id: "step_a", title: "Implement" }],
      },
      {
        goal: "ship",
        assumptions: [],
        steps: [{ step_id: "step_a", title: "Implement", status: "active" }],
      },
    )

    expect(result.steps[0]).toEqual({
      step_id: "step_a",
      title: "Implement",
      status: "active",
      acceptance: null,
      assigned_agent: null,
      note: null,
    })
  })

  test("buildGoalPlanWrite replans structural edits without rebinding a renamed step identity", () => {
    const ids = ["step_fresh"]
    const result = buildGoalPlanWrite(
      {
        plan_id: "plan_1",
        plan_version: 9,
        goal: "ship",
        assumptions: [],
        steps: [
          { step_id: "step_a", title: "Implement", acceptance: "tests pass" },
          { step_id: "step_b", title: "Review", acceptance: "approved" },
        ],
      },
      {
        goal: "ship",
        assumptions: [],
        steps: [
          { step_id: "step_b", title: "Review", acceptance: "approved", status: "pending" },
          { step_id: "step_a", title: "Implement and deploy", acceptance: "tests pass", status: "active" },
        ],
      },
      () => ids.shift() ?? "unexpected",
    )

    expect(result.operation).toBe("replan")
    expect(result.replan_reason).toBe("human_goal_edit")
    expect(result.steps.map((step) => step.step_id)).toEqual(["step_b", "step_fresh"])
    expect(result.active_step_id).toBe("step_fresh")
  })
})

describe("capabilities gating", () => {
  test("fetchCapabilities GETs /global/capabilities and reads the feature flags", async () => {
    const calls: Recorded[] = []
    const caps = await fetchCapabilities(
      client(calls, { features: { expertPanel: true, goalLoop: false, wiki: true, v4MultiAgentRuntime: true } }),
    )
    expect(calls).toEqual([{ method: "GET", url: "/global/capabilities" }])
    expect(caps).toEqual({ expertPanel: true, goalLoop: false, wiki: true, v4MultiAgentRuntime: true })
  })

  test("fetchCapabilities treats a server that omits the fields as disabled", async () => {
    const calls: Recorded[] = []
    expect(await fetchCapabilities(client(calls, { features: {} }))).toEqual({
      expertPanel: false,
      goalLoop: false,
      wiki: false,
      v4MultiAgentRuntime: false,
    })
    // and a server with no features object at all
    expect(await fetchCapabilities(client(calls, {}))).toEqual({
      expertPanel: false,
      goalLoop: false,
      wiki: false,
      v4MultiAgentRuntime: false,
    })
  })
})
