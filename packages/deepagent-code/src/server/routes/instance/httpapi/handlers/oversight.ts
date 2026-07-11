import { Effect } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { WorkspaceRouteContext } from "../middleware/workspace-routing"
import { Observability } from "@deepagent-code/core/deepagent/observability"
import { ApprovalQueue } from "@deepagent-code/core/deepagent/approval-queue"

// V4.0 §D2/§F — Oversight handlers. Project the durable V4 substrate for the Dashboard: metrics + the
// causal trace (Observability) and the human Approval Queue (list pending + resolve). Workspace scope
// is the routed workspaceID (falling back to the routed directory, matching how IM derives
// workspace_id in the single-user / directory-routed model).

// The workspace key for scoping: the explicit workspaceID when routed with one, else the directory
// (the identity the request was routed with — never cross-tenant).
const workspaceKey = Effect.gen(function* () {
  const route = yield* WorkspaceRouteContext
  return route.workspaceID ?? route.directory
})

export const oversightHandlers = HttpApiBuilder.group(InstanceHttpApi, "oversight", (handlers) =>
  Effect.gen(function* () {
    const observability = yield* Observability.Service
    const approvals = yield* ApprovalQueue.Service

    const oversightMetrics = Effect.fn("OversightHttpApi.metrics")(function* (ctx) {
      const workspaceID = yield* workspaceKey
      // default window: last 24h up to now (the caller may narrow via from/to).
      const to = ctx.query.to ?? Date.now()
      const from = ctx.query.from ?? to - 24 * 60 * 60 * 1000
      return yield* observability.metrics({ workspaceID, from, to })
    })

    const oversightTrace = Effect.fn("OversightHttpApi.trace")(function* (ctx) {
      const workspaceID = yield* workspaceKey
      const nodes = yield* observability.trace({ workspaceID, correlationID: ctx.query.correlationID })
      // drop the raw payload from the wire projection (traces can be large / carry sensitive payloads);
      // the Dashboard renders the spine from type/source/timing + causal links.
      return {
        nodes: nodes.map((n) => ({
          eventID: n.eventID,
          type: n.type,
          source: n.source,
          ...(n.causationID != null ? { causationID: n.causationID } : {}),
          createdAt: n.createdAt,
        })),
      }
    })

    const oversightApprovals = Effect.fn("OversightHttpApi.approvals")(function* () {
      const workspaceID = yield* workspaceKey
      const items = yield* approvals.listPending(workspaceID)
      return { items }
    })

    const oversightResolve = Effect.fn("OversightHttpApi.resolve")(function* (ctx) {
      const workspaceID = yield* workspaceKey
      // resolve is workspace-scoped: it only touches an item BELONGING to this workspace (no cross-
      // tenant write/read). `resolvedBy` is the routed workspace identity (a richer principal can be
      // threaded later once the auth layer carries one).
      const item = yield* approvals.resolve({
        id: ctx.payload.id,
        workspaceID,
        decision: ctx.payload.decision,
        resolvedBy: workspaceID,
      })
      // null = no such pending item IN THIS WORKSPACE (unknown id, or another tenant's) → typed 404,
      // never a cross-tenant leak and never an untyped 500.
      if (!item) return yield* new HttpApiError.NotFound()
      return item
    })

    return handlers
      .handle("oversightMetrics", oversightMetrics)
      .handle("oversightTrace", oversightTrace)
      .handle("oversightApprovals", oversightApprovals)
      .handle("oversightResolve", oversightResolve)
  }),
)
