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

  test("armPanel POSTs /deepagent/panel/arm and returns the effective armed state", async () => {
    const calls: Recorded[] = []
    const armed = await armPanel(client(calls, { sessionID: "ses_1", armed: true }), "ses_1", true)
    expect(calls).toEqual([
      { method: "POST", url: "/deepagent/panel/arm", body: { sessionID: "ses_1", armed: true }, headers: JSON_HEADERS },
    ])
    expect(armed).toBe(true)
  })

  test("fetchPanelStatus GETs /deepagent/panel/status and reports armed + explicit", async () => {
    const calls: Recorded[] = []
    const status = await fetchPanelStatus(client(calls, { armed: true, explicit: false }), "ses 1")
    expect(calls).toEqual([{ method: "GET", url: "/deepagent/panel/status?sessionID=ses%201" }])
    expect(status).toEqual({ armed: true, explicit: false })
  })

  test("fetchPanelStatus tolerates a missing body (disarmed, not explicit)", async () => {
    const calls: Recorded[] = []
    expect(await fetchPanelStatus(client(calls, {}), "ses_1")).toEqual({ armed: false, explicit: false })
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

  test("editPlanGoal POSTs /deepagent/goal/edit-plan with { sessionID, plan } and returns ok", async () => {
    const calls: Recorded[] = []
    const plan = {
      goal: "ship it",
      steps: [
        { step_id: "step_1", title: "revised", status: "pending" },
        { title: "new step" },
      ],
    }
    const ok = await editPlanGoal(client(calls, { ok: true }), "ses_1", plan)
    expect(calls).toEqual([
      { method: "POST", url: "/deepagent/goal/edit-plan", body: { sessionID: "ses_1", plan }, headers: JSON_HEADERS },
    ])
    expect(ok).toBe(true)
  })

  test("editPlanGoal returns false when the server refuses (no goal / terminal)", async () => {
    const calls: Recorded[] = []
    expect(await editPlanGoal(client(calls, { ok: false }), "ses_1", { goal: "g", steps: [] })).toBe(false)
    // ...and tolerates a missing body (older server) as false.
    expect(await editPlanGoal(client(calls, {}), "ses_1", { goal: "g", steps: [] })).toBe(false)
  })
})

describe("capabilities gating", () => {
  test("fetchCapabilities GETs /global/capabilities and reads the feature flags", async () => {
    const calls: Recorded[] = []
    const caps = await fetchCapabilities(client(calls, { features: { expertPanel: true, goalLoop: false, wiki: true } }))
    expect(calls).toEqual([{ method: "GET", url: "/global/capabilities" }])
    expect(caps).toEqual({ expertPanel: true, goalLoop: false, wiki: true })
  })

  test("fetchCapabilities treats a server that omits the fields as disabled", async () => {
    const calls: Recorded[] = []
    expect(await fetchCapabilities(client(calls, { features: {} }))).toEqual({
      expertPanel: false,
      goalLoop: false,
      wiki: false,
    })
    // and a server with no features object at all
    expect(await fetchCapabilities(client(calls, {}))).toEqual({ expertPanel: false, goalLoop: false, wiki: false })
  })
})
