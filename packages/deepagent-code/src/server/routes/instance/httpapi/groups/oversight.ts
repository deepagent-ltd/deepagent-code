import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery, WorkspaceRoutingQueryFields } from "../middleware/workspace-routing"
import { described } from "./metadata"

// V4.0 §D2/§F — Oversight HTTP surface. Read-only observability (metrics + trace) + the Approval
// Queue (list pending + resolve) backing the Oversight Dashboard. All workspace-scoped via the same
// WorkspaceRoutingQuery the rest of the instance API uses. These project the durable V4 substrate
// (deepagent_event / delivery / approval_queue) — no new source of truth.

const root = "/oversight"

// ── §F metrics ──────────────────────────────────────────────────────────────────────────────────
export const OversightMetrics = Schema.Struct({
  windowFrom: Schema.Number,
  windowTo: Schema.Number,
  dlqEventsTotal: Schema.Number,
  agentPushRejectedTotal: Schema.Number,
  agentPushRejectedByReason: Schema.Record(Schema.String, Schema.Number),
  agentTaskSuccessRate: Schema.NullOr(Schema.Number),
  agentTaskCompleted: Schema.Number,
  agentTaskFailed: Schema.Number,
  agentConflictRate: Schema.NullOr(Schema.Number),
  agentTaskBlockedTotal: Schema.Number,
  agentPushTotal: Schema.Number,
  // §F1 latency histograms (P50/P95). Optional + nullable (null ⇒ no samples in the window) — ADDITIVE,
  // so an older client that ignores them is unaffected.
  eventPublishLatencyMsP50: Schema.optional(Schema.NullOr(Schema.Number)),
  eventPublishLatencyMsP95: Schema.optional(Schema.NullOr(Schema.Number)),
  eventToAgentStartMsP50: Schema.optional(Schema.NullOr(Schema.Number)),
  eventToAgentStartMsP95: Schema.optional(Schema.NullOr(Schema.Number)),
  // §F human_takeover_total — count of human takeovers in the window (backs the §D2 Takeover surface).
  // Optional so an older client that ignores it is unaffected (ADDITIVE).
  humanTakeoverTotal: Schema.optional(Schema.Number),
})

// ── §F2 trace ───────────────────────────────────────────────────────────────────────────────────
// A node is either an "event" on the correlation chain or a "session" the trace followed correlationID
// INTO (the §F2 back-half). `kind` discriminates; session nodes carry the extra sessionID/title/count.
export const OversightTraceNode = Schema.Struct({
  kind: Schema.optional(Schema.Literals(["event", "session"])),
  eventID: Schema.String,
  type: Schema.String,
  source: Schema.String,
  causationID: Schema.optional(Schema.String),
  createdAt: Schema.Number,
  // §F2 back-half — present on kind:"session" nodes (the child session an agent ran in for this trace).
  sessionID: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  messageCount: Schema.optional(Schema.Number),
})
export const OversightTrace = Schema.Struct({ nodes: Schema.Array(OversightTraceNode) })

// ── §D2 approval queue ──────────────────────────────────────────────────────────────────────────
export const OversightApprovalItem = Schema.Struct({
  id: Schema.String,
  workspaceID: Schema.String,
  eventID: Schema.String,
  eventType: Schema.String,
  correlationID: Schema.optional(Schema.String),
  summary: Schema.String,
  status: Schema.Literals(["pending", "resolved"]),
  decision: Schema.optional(Schema.Literals(["approved", "rejected", "acknowledged"])),
  resolvedBy: Schema.optional(Schema.String),
  resolvedAt: Schema.optional(Schema.Number),
  createdAt: Schema.Number,
})
export const OversightApprovalList = Schema.Struct({ items: Schema.Array(OversightApprovalItem) })
export const OversightResolveInput = Schema.Struct({
  id: Schema.String,
  decision: Schema.Literals(["approved", "rejected", "acknowledged"]),
})

// ── §D2 human takeover ────────────────────────────────────────────────────────────────────────────
// A takeover is the FACT a human stepped in over an agent (paused/reverted its session, or claimed a
// branch/session it was driving). Recording one appends an audit row + feeds the §F human_takeover_total
// metric. The actor is the routed workspace identity (never client-supplied → no spoofing).
export const OversightTakeoverRecord = Schema.Struct({
  id: Schema.String,
  workspaceID: Schema.String,
  sessionID: Schema.optional(Schema.String),
  agentID: Schema.optional(Schema.String),
  actorID: Schema.optional(Schema.String),
  reason: Schema.optional(Schema.String),
  createdAt: Schema.Number,
})
export const OversightTakeoverInput = Schema.Struct({
  sessionID: Schema.optional(Schema.String),
  agentID: Schema.optional(Schema.String),
  reason: Schema.optional(Schema.String),
})

// metrics/trace query params extend the workspace routing query (spread the shared fields, matching
// the debug group's idiom — this Schema build has no `Schema.extend`).
const MetricsQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  from: Schema.optional(Schema.NumberFromString),
  to: Schema.optional(Schema.NumberFromString),
})
const TraceQuery = Schema.Struct({ ...WorkspaceRoutingQueryFields, correlationID: Schema.String })

export const OversightApi = HttpApi.make("oversight").add(
  HttpApiGroup.make("oversight")
    .add(
      HttpApiEndpoint.get("oversightMetrics", `${root}/metrics`, {
        query: MetricsQuery,
        success: described(OversightMetrics, "§F1 metric snapshot for the workspace over the window"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "oversight.metrics",
          summary: "Agent Dashboard metrics",
          description: "V4.0 §F1: DLQ total, push-rejected-by-reason, task success rate, conflict rate.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.get("oversightTrace", `${root}/trace`, {
        query: TraceQuery,
        success: described(OversightTrace, "§F2 causal event chain for a correlationID"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "oversight.trace",
          summary: "Event trace",
          description: "V4.0 §F2: the causal event chain (event → route → agent → coordination) for a correlationID.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.get("oversightApprovals", `${root}/approvals`, {
        query: WorkspaceRoutingQuery,
        success: described(OversightApprovalList, "§D2 pending Approval Queue items for the workspace"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "oversight.approvals",
          summary: "Approval Queue (pending)",
          description: "V4.0 §D2: pending human-decision items (goal escalations, rollbacks, panel verdicts).",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("oversightResolve", `${root}/approvals/resolve`, {
        query: WorkspaceRoutingQuery,
        payload: OversightResolveInput,
        success: described(OversightApprovalItem, "The resolved Approval Queue item"),
        error: HttpApiError.NotFound,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "oversight.approvals.resolve",
          summary: "Resolve an Approval Queue item",
          description: "V4.0 §D2: a human approves / rejects / acknowledges a pending item (first resolution wins).",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("oversightTakeover", `${root}/takeover`, {
        query: WorkspaceRoutingQuery,
        payload: OversightTakeoverInput,
        success: described(OversightTakeoverRecord, "The recorded human-takeover audit row"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "oversight.takeover",
          summary: "Record a human takeover",
          description: "V4.0 §D2: record that a human stepped in over an agent (pause/revert/claim). Feeds §F human_takeover_total.",
        }),
      ),
    )
    .annotateMerge(OpenApi.annotations({ title: "oversight", description: "V4.0 Oversight: observability + approval queue." }))
    .middleware(InstanceContextMiddleware)
    .middleware(WorkspaceRoutingMiddleware)
    .middleware(Authorization),
)
