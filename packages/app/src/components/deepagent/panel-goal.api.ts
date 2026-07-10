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

/** Which V3.9 experimental subsystems this server has enabled (from /global/capabilities.features). */
export type DeepAgentCapabilities = {
  expertPanel: boolean
  goalLoop: boolean
  wiki: boolean
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
