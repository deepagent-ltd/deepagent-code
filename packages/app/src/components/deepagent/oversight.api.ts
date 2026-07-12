// Pure HTTP client functions + types for the V4.0 §D2/§F Oversight Dashboard (metrics + trace + the
// human Approval Queue) and the §D2 human-takeover control. Split from any .tsx so it carries NO UI
// imports. Mirrors panel-goal.api.ts: raw `client.client.request` by path (the oversight routes are
// NOT in the generated SDK — hand-writing the calls avoids the SDK-regen trap). The dir-scoped SDK
// client injects the `directory` routing the workspace middleware reads, exactly as the panel/goal
// routes rely on.

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

export type OversightClient = RawSdkClient

const JSON_HEADERS = { "Content-Type": "application/json" }

// ── §F1 metrics ───────────────────────────────────────────────────────────────
// Mirrors `OversightMetrics` (groups/oversight.ts). Latency + human-takeover fields are OPTIONAL:
// an older server omits latency (§F1) and the takeover counter (P3.10) — the UI feature-detects them.
export type OversightMetrics = {
  windowFrom: number
  windowTo: number
  dlqEventsTotal: number
  agentPushRejectedTotal: number
  agentPushRejectedByReason: Record<string, number>
  agentTaskSuccessRate: number | null
  agentTaskCompleted: number
  agentTaskFailed: number
  agentConflictRate: number | null
  agentTaskBlockedTotal: number
  agentPushTotal: number
  eventPublishLatencyMsP50?: number | null
  eventPublishLatencyMsP95?: number | null
  eventToAgentStartMsP50?: number | null
  eventToAgentStartMsP95?: number | null
  // P3.10 (parallel) ADDS this to the metrics projection. Optional so this UI type-checks + renders
  // against a server that hasn't merged P3.10 yet (rendered only when present).
  humanTakeoverTotal?: number | null
}

// ── §F2 trace ─────────────────────────────────────────────────────────────────
export type OversightTraceNode = {
  eventID: string
  type: string
  source: string
  causationID?: string
  createdAt: number
}
export type OversightTrace = { nodes: OversightTraceNode[] }

// ── §D2 approval queue ──────────────────────────────────────────────────────────
export type OversightApprovalDecision = "approved" | "rejected" | "acknowledged"
export type OversightApprovalItem = {
  id: string
  workspaceID: string
  eventID: string
  eventType: string
  correlationID?: string
  summary: string
  status: "pending" | "resolved"
  decision?: OversightApprovalDecision
  resolvedBy?: string
  resolvedAt?: number
  createdAt: number
}

/**
 * §F1: fetch the Agent Dashboard metric snapshot for the routed workspace over an optional window.
 * The server defaults to the last 24h when `from`/`to` are omitted.
 */
export const fetchOversightMetrics = async (
  client: OversightClient,
  window?: { from?: number; to?: number },
): Promise<OversightMetrics | undefined> => {
  const query = new URLSearchParams()
  if (window?.from !== undefined) query.set("from", String(window.from))
  if (window?.to !== undefined) query.set("to", String(window.to))
  const qs = query.toString()
  const response = await client.client.request<OversightMetrics>({
    method: "GET",
    url: `/oversight/metrics${qs ? `?${qs}` : ""}`,
  })
  return response.data
}

/** §F2: fetch the causal event chain (event → route → agent → artifacts) for a correlationID. */
export const fetchOversightTrace = async (
  client: OversightClient,
  correlationID: string,
): Promise<OversightTraceNode[]> => {
  const response = await client.client.request<OversightTrace>({
    method: "GET",
    url: `/oversight/trace?correlationID=${encodeURIComponent(correlationID)}`,
  })
  return response.data?.nodes ?? []
}

/** §D2: list the workspace's PENDING Approval Queue items. */
export const fetchOversightApprovals = async (
  client: OversightClient,
): Promise<OversightApprovalItem[]> => {
  const response = await client.client.request<{ items: OversightApprovalItem[] }>({
    method: "GET",
    url: `/oversight/approvals`,
  })
  return response.data?.items ?? []
}

/** §D2: a human resolves a pending item (approve / reject / acknowledge). First resolution wins. */
export const resolveOversightApproval = async (
  client: OversightClient,
  input: { id: string; decision: OversightApprovalDecision },
): Promise<OversightApprovalItem | undefined> => {
  const response = await client.client.request<OversightApprovalItem>({
    method: "POST",
    url: `/oversight/approvals/resolve`,
    body: input,
    headers: JSON_HEADERS,
  })
  return response.data
}

// ── §D2 human takeover (P3.10, merged by the parent) ───────────────────────────
export type HumanTakeoverRecord = {
  id: string
  workspaceID: string
  reason: string
  scope?: string
  createdAt: number
}

/**
 * §D2: record a human taking over from the autonomous agents. The backend endpoint is added by P3.10
 * (parallel work the PARENT merges) — this build tolerates its absence:
 *   - `probeTakeoverSupported` feature-detects it (a 404 ⇒ not merged yet).
 *   - `recordHumanTakeover` calls it; the caller surfaces a "activates once P3.10 lands" hint on 404.
 * We intentionally hand-write the call (never the generated SDK, which can't know a not-yet-merged
 * route) so the UI is fully wired the moment the endpoint exists — no frontend change required then.
 */
export const recordHumanTakeover = async (
  client: OversightClient,
  input: { reason: string; scope?: string },
): Promise<{ ok: true; record?: HumanTakeoverRecord } | { ok: false; unsupported: boolean; error: string }> => {
  try {
    const response = await client.client.request<HumanTakeoverRecord>({
      method: "POST",
      url: `/oversight/takeover`,
      body: input,
      headers: JSON_HEADERS,
    })
    return { ok: true, record: response.data }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // A 404 (route absent) ⇒ P3.10's endpoint hasn't been merged yet. Treat as "unsupported" so the UI
    // can explain rather than show a hard error.
    const unsupported = /\b404\b/.test(message) || /not\s*found/i.test(message)
    return { ok: false, unsupported, error: message }
  }
}
