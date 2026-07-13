// Pure HTTP client functions + types for the V3.9 Expert Panel (§C) + Goal Loop (§D) UI. Split from
// any .tsx so it carries NO UI imports (the route-contract test imports THIS module). Mirrors the
// review dialog's raw-request pattern (client.client.request by path; POST bodies via `body`).

export type PanelLens = "correctness" | "security" | "performance" | "architecture" | "repro"

export type PanelFinding = {
  severity: string
  category: string
  file?: string | null
  line?: number | null
  summary: string
  failureScenario: string
  confidence: number
}
export type PanelDissent = {
  lens: string
  verdict: string
  confidence: number
  findings: PanelFinding[]
}
export type PanelVerdict = {
  decision: "approve" | "revise" | "block" | "needs_human"
  confidence: number
  rounds: number
  evidence: string[]
  dissent: PanelDissent[]
}

export type GoalSnapshot = {
  goalId: string
  planDocId: string
  phase: string
  running: boolean
}

type RawSdkClient = {
  client: {
    request<TData>(options: {
      method: string
      url: string
      body?: unknown
      headers?: Record<string, string>
    }): Promise<{ data?: TData }>
  }
}

export type PanelGoalClient = RawSdkClient

/** Which V3.9/V4 subsystems this server has enabled (from /global/capabilities.features). */
export type DeepAgentCapabilities = {
  expertPanel: boolean
  goalLoop: boolean
  wiki: boolean
  // V4.0 §D2 — the Multi-Agent Runtime flag gates the Oversight Approval Queue's PRODUCERS
  // (goal-manager / panel-convene-consumer). When it is OFF the queue can never be fed, so the client
  // hides the Oversight entry rather than showing a permanently-empty dead-end (T1.1). Default OFF.
  v4MultiAgentRuntime: boolean
}

/**
 * Read the server's experimental capabilities so the UI can independently gate the panel button and
 * goal mode. Fetched via the raw path (no SDK regen); tolerant of an older server that omits the
 * fields (treated as disabled).
 */
export const fetchCapabilities = async (client: PanelGoalClient): Promise<DeepAgentCapabilities> => {
  const response = await client.client.request<{ features?: Partial<DeepAgentCapabilities> }>({
    method: "GET",
    url: "/global/capabilities",
  })
  return {
    expertPanel: response.data?.features?.expertPanel ?? false,
    goalLoop: response.data?.features?.goalLoop ?? false,
    wiki: response.data?.features?.wiki ?? false,
    v4MultiAgentRuntime: response.data?.features?.v4MultiAgentRuntime ?? false,
  }
}

const JSON_HEADERS = { "Content-Type": "application/json" }

// ── Expert Panel (§C) ────────────────────────────────────────────────────────

/** Convene the Expert Panel on the current session context; returns the deterministic verdict. */
export const consultPanel = async (
  client: PanelGoalClient,
  input: {
    sessionID: string
    question?: string
    codeRefs?: string[]
    lenses?: PanelLens[]
    maxRounds?: number
    policy?: "default" | "security"
  },
): Promise<PanelVerdict | undefined> => {
  const response = await client.client.request<PanelVerdict>({
    method: "POST",
    url: "/deepagent/panel/consult",
    body: input,
    headers: JSON_HEADERS,
  })
  return response.data
}

/** Set the per-session panel armed flag (the button toggle). Returns the effective armed state. */
export const armPanel = async (
  client: PanelGoalClient,
  sessionID: string,
  armed: boolean,
): Promise<boolean> => {
  const response = await client.client.request<{ sessionID: string; armed: boolean }>({
    method: "POST",
    url: "/deepagent/panel/arm",
    body: { sessionID, armed },
    headers: JSON_HEADERS,
  })
  return response.data?.armed ?? armed
}

/**
 * Resolve the EFFECTIVE armed state for a session: the explicit per-session toggle if set, else the
 * server's global expertPanelDefault. Lets the button seed from the server default without the client
 * guessing (the client setting is only a hint; the server is authoritative).
 */
export const fetchPanelStatus = async (
  client: PanelGoalClient,
  sessionID: string,
): Promise<{ armed: boolean; explicit: boolean }> => {
  const response = await client.client.request<{ armed: boolean; explicit: boolean }>({
    method: "GET",
    url: `/deepagent/panel/status?sessionID=${encodeURIComponent(sessionID)}`,
  })
  return { armed: response.data?.armed ?? false, explicit: response.data?.explicit ?? false }
}

// ── Goal Loop (§D) ───────────────────────────────────────────────────────────

export const startGoal = async (
  client: PanelGoalClient,
  input: {
    sessionID: string
    criteria?: { kind: string; commands?: string[]; maxSeverity?: string; severityAtMost?: string }[]
    limits?: { maxTicks?: number; maxTokens?: number; maxWallclockMs?: number; maxCost?: number }
    stallThreshold?: number
  },
): Promise<GoalSnapshot | undefined> => {
  const response = await client.client.request<GoalSnapshot>({
    method: "POST",
    url: "/deepagent/goal/start",
    body: input,
    headers: JSON_HEADERS,
  })
  return response.data
}

const goalMutate = async (
  client: PanelGoalClient,
  action: "pause" | "resume" | "stop",
  sessionID: string,
): Promise<boolean> => {
  const response = await client.client.request<{ ok: boolean }>({
    method: "POST",
    url: `/deepagent/goal/${action}`,
    body: { sessionID },
    headers: JSON_HEADERS,
  })
  return response.data?.ok ?? false
}

export const pauseGoal = (client: PanelGoalClient, sessionID: string) => goalMutate(client, "pause", sessionID)
export const resumeGoal = (client: PanelGoalClient, sessionID: string) => goalMutate(client, "resume", sessionID)
export const stopGoal = (client: PanelGoalClient, sessionID: string) => goalMutate(client, "stop", sessionID)

/** A plan step as the edit-plan payload carries it (loose input: step_id/status optional, mirroring the
 * backend PlanInput — evidence is runtime-owned and never sent from the client). */
export type GoalPlanStepInput = {
  step_id?: string
  title: string
  status?: string
  acceptance?: string | null
  assigned_agent?: string | null
  note?: string | null
}
export type GoalPlanInput = {
  goal: string
  steps: GoalPlanStepInput[]
  assumptions?: string[]
  active_step_id?: string | null
}

/**
 * V4.1 §S2 — hot-edit the plan of a RUNNING or PAUSED goal. POSTs the revised plan on the goal control
 * channel; the driver applies it between ticks (durable-doc upsert + stall re-baseline). Returns false
 * when no goal is running or it reached a terminal phase (the server's orphan guard).
 */
export const editPlanGoal = async (
  client: PanelGoalClient,
  sessionID: string,
  plan: GoalPlanInput,
): Promise<boolean> => {
  const response = await client.client.request<{ ok: boolean }>({
    method: "POST",
    url: "/deepagent/goal/edit-plan",
    body: { sessionID, plan },
    headers: JSON_HEADERS,
  })
  return response.data?.ok ?? false
}

export const goalStatus = async (
  client: PanelGoalClient,
  sessionID: string,
): Promise<GoalSnapshot | null> => {
  const response = await client.client.request<{ goal: GoalSnapshot | null }>({
    method: "GET",
    url: `/deepagent/goal/status?sessionID=${encodeURIComponent(sessionID)}`,
  })
  return response.data?.goal ?? null
}

export type GoalStartable = { startable: boolean; source: "plan" | "file" | "none" }

/**
 * Whether a goal can be started for this session right now, resolved SERVER-SIDE with the same plan
 * precedence start() uses (session_plan → repo goal+plan.md → none). The button gates on this instead
 * of reading session_plan directly, because loop/design modes author the plan as the repo file (never
 * touching session_plan), so a client-only hasPlan() check would hide the button in exactly the modes
 * where it belongs. Tolerant of an older server that lacks the route (treated as not-startable).
 */
export const fetchGoalStartable = async (
  client: PanelGoalClient,
  sessionID: string,
): Promise<GoalStartable> => {
  const response = await client.client.request<GoalStartable>({
    method: "GET",
    url: `/deepagent/goal/startable?sessionID=${encodeURIComponent(sessionID)}`,
  })
  return {
    startable: response.data?.startable ?? false,
    source: response.data?.source ?? "none",
  }
}
