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

/** V4.0 composer three-state control: Off maps to armed:false; Single/Multi map to armed:true + depth. */
export type PanelRounds = "single" | "multi"

/**
 * Set the per-session panel armed flag AND (when arming) the debate depth (the composer's three-state
 * control: Off / Single-round / Multi-round). Returns the effective armed state + depth.
 */
export const armPanel = async (
  client: PanelGoalClient,
  sessionID: string,
  armed: boolean,
  rounds?: PanelRounds,
): Promise<{ armed: boolean; rounds: PanelRounds }> => {
  const response = await client.client.request<{ sessionID: string; armed: boolean; rounds: PanelRounds }>({
    method: "POST",
    url: "/deepagent/panel/arm",
    body: { sessionID, armed, ...(rounds ? { rounds } : {}) },
    headers: JSON_HEADERS,
  })
  return { armed: response.data?.armed ?? armed, rounds: response.data?.rounds ?? rounds ?? "single" }
}

/**
 * Resolve the EFFECTIVE armed state + debate depth for a session: the explicit per-session toggle if
 * set, else the server's global expertPanelDefault. Lets the button seed from the server default
 * without the client guessing (the client setting is only a hint; the server is authoritative).
 */
export const fetchPanelStatus = async (
  client: PanelGoalClient,
  sessionID: string,
): Promise<{ armed: boolean; explicit: boolean; rounds: PanelRounds }> => {
  const response = await client.client.request<{ armed: boolean; explicit: boolean; rounds: PanelRounds }>({
    method: "GET",
    url: `/deepagent/panel/status?sessionID=${encodeURIComponent(sessionID)}`,
  })
  return {
    armed: response.data?.armed ?? false,
    explicit: response.data?.explicit ?? false,
    rounds: response.data?.rounds ?? "single",
  }
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
export type GoalPlanStatus = "pending" | "active" | "done" | "cancelled" | "blocked"

export type GoalPlanStepInput = {
  step_id?: string
  title: string
  status: GoalPlanStatus
  acceptance?: string | null
  assigned_agent?: string | null
  note?: string | null
}
export type GoalPlanWriteInput = {
  operation: "create" | "advance" | "replan"
  expected_plan_id: string | null
  expected_version: number | null
  replan_reason?: string
  goal: string
  steps: GoalPlanStepInput[]
  assumptions: string[]
  active_step_id: string | null
}

export type GoalPlanEditChallenge = {
  challenge_id: string
  candidate_hash: string
  expected_plan_id: string
  expected_version: number
  issued_at: string
  expires_at: string
}

export type GoalPlanEditFailure =
  | {
      kind: "validation"
      code: string
      offending_step_ids: string[]
      previous_plan_id: string | null
      previous_plan_version: number | null
    }
  | {
      kind: "conflict"
      expected_plan_id: string | null
      expected_version: number | null
      actual_plan_id: string | null
      actual_version: number | null
    }
  | { kind: "target_unavailable" | "runtime_error"; message: string }

export type GoalPlanEditReceipt = {
  state: "challenged" | "queued" | "applied" | "rejected" | "conflict" | "runtime_error"
  activity_id: string
  request_id: string
  candidate_hash: string
  challenge?: GoalPlanEditChallenge
  result?: { plan_id: string; doc_id: string; version: number; changed: boolean }
  failure?: GoalPlanEditFailure
}

export type GoalPlanEditDraft = {
  goal: string
  assumptions: string[]
  steps: GoalPlanStepInput[]
}

/**
 * Build a versioned write against the exact live-plan snapshot the user edited. Structural changes
 * are replans; a status/note-only update over the same ordered identities is an advance.
 */
export const buildGoalPlanWrite = (
  current: {
    plan_id: string
    plan_version: number
    goal: string
    assumptions: string[]
    steps: Array<{
      step_id: string
      title: string
      acceptance?: string | null
      assigned_agent?: string | null
    }>
  },
  draft: GoalPlanEditDraft,
  createStepID: () => string = () => `step_${globalThis.crypto.randomUUID()}`,
): GoalPlanWriteInput => {
  const goal = draft.goal.trim()
  const assumptions = draft.assumptions.map((value) => value.trim())
  if (!goal || !Number.isSafeInteger(current.plan_version) || current.plan_version < 0) {
    throw new Error("Plan edit requires a valid authority snapshot")
  }
  if (draft.steps.length === 0) throw new Error("Plan edit requires at least one step")

  const originalByID = new Map(current.steps.map((step) => [step.step_id, step] as const))
  const text = (value: string | null | undefined) => (value ?? "").trim()
  const sameIdentity = (left: GoalPlanStepInput, right: (typeof current.steps)[number]) =>
    text(left.title) === text(right.title) &&
    text(left.acceptance) === text(right.acceptance) &&
    text(left.assigned_agent) === text(right.assigned_agent)
  const structuralChange =
    goal !== current.goal.trim() ||
    JSON.stringify(assumptions) !== JSON.stringify(current.assumptions.map((value) => value.trim())) ||
    draft.steps.length !== current.steps.length ||
    draft.steps.some((step, index) => step.step_id !== current.steps[index]?.step_id || !sameIdentity(step, current.steps[index]))

  const used = new Set<string>()
  const freshStepID = () => {
    const id = createStepID().trim()
    if (!id || used.has(id) || originalByID.has(id)) throw new Error("Plan edit generated a duplicate step identity")
    return id
  }
  const steps = draft.steps.map((step) => {
    const original = step.step_id ? originalByID.get(step.step_id) : undefined
    const stepID = original && sameIdentity(step, original) ? original.step_id : freshStepID()
    if (used.has(stepID)) throw new Error("Plan edit contains a duplicate step identity")
    used.add(stepID)
    const title = step.title.trim()
    const note = text(step.note) || null
    if (!title) throw new Error("Plan edit step title cannot be empty")
    if (step.status === "blocked" && !note) throw new Error("Blocked plan steps require a note")
    return {
      step_id: stepID,
      title,
      status: step.status,
      acceptance: text(step.acceptance) || null,
      assigned_agent: text(step.assigned_agent) || null,
      note,
    }
  })
  const active = steps.filter((step) => step.status === "active")
  if (active.length > 1) throw new Error("Plan edit cannot contain multiple active steps")

  return {
    operation: structuralChange ? "replan" : "advance",
    expected_plan_id: current.plan_id,
    expected_version: current.plan_version,
    ...(structuralChange ? { replan_reason: "human_goal_edit" } : {}),
    goal,
    assumptions,
    steps,
    active_step_id: active[0]?.step_id ?? null,
  }
}

/** Admit a durable human plan-edit activity. Exact network retries reuse request_id. */
export const editPlanGoal = async (
  client: PanelGoalClient,
  input: {
    sessionID: string
    requestID: string
    planWrite: GoalPlanWriteInput
    qualityChallengeID?: string
  },
): Promise<GoalPlanEditReceipt | undefined> => {
  const response = await client.client.request<GoalPlanEditReceipt>({
    method: "POST",
    url: "/deepagent/goal/edit-plan",
    body: {
      sessionID: input.sessionID,
      request_id: input.requestID,
      plan_write: input.planWrite,
      ...(input.qualityChallengeID ? { quality_challenge_id: input.qualityChallengeID } : {}),
    },
    headers: JSON_HEADERS,
  })
  return response.data
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
