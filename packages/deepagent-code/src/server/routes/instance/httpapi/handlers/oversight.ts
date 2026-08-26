import { Effect } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { WorkspaceRouteContext } from "../middleware/workspace-routing"
import { Observability } from "@deepagent-code/core/deepagent/observability"
import { ApprovalQueue } from "@deepagent-code/core/deepagent/approval-queue"
import { HumanTakeover } from "@deepagent-code/core/deepagent/human-takeover"
import { RollbackAudit } from "@deepagent-code/core/deepagent/rollback-audit"
import { Session } from "@/session/session"
import { SessionRevert } from "@/session/revert"
import { SessionID, MessageID } from "@/session/schema"

// V4.0 §D2/§F — Oversight handlers. Project the durable V4 substrate for the Dashboard: metrics + the
// causal trace (Observability) and the human Approval Queue (list pending + resolve). Workspace scope
// is the routed workspaceID (falling back to the routed directory, matching how IM derives
// workspace_id in the single-user / directory-routed model).

// The workspace key for scoping. MUST match the PRODUCE side (goal-manager / multi-agent-runtime) exactly
// or an enqueued approval item is invisible here — so it derives the key via the SAME canonical rule
// (ApprovalQueue.deriveWorkspaceKey): a genuine wrk_ workspaceID wins, else the routed directory. Never
// cross-tenant: the key is only ever the identity the request was routed with.
const workspaceKey = Effect.gen(function* () {
  const route = yield* WorkspaceRouteContext
  return ApprovalQueue.deriveWorkspaceKey({ workspaceID: route.workspaceID, directory: route.directory })
})

export const oversightHandlers = HttpApiBuilder.group(InstanceHttpApi, "oversight", (handlers) =>
  Effect.gen(function* () {
    const observability = yield* Observability.Service
    const approvals = yield* ApprovalQueue.Service
    const takeovers = yield* HumanTakeover.Service
    const rollbacks = yield* RollbackAudit.Service
    const sessions = yield* Session.Service
    const revertSvc = yield* SessionRevert.Service

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
      // the Dashboard renders the spine from type/source/timing + causal links. §F2 back-half: a "session"
      // node carries the child session an agent ran in (sessionID/title/messageCount) so the trace view can
      // pivot from the triggering event into that session's activity.
      return {
        nodes: nodes.map((n) => ({
          kind: n.kind,
          eventID: n.eventID,
          type: n.type,
          source: n.source,
          ...(n.causationID != null ? { causationID: n.causationID } : {}),
          createdAt: n.createdAt,
          ...(n.sessionID != null ? { sessionID: n.sessionID } : {}),
          ...(n.title != null ? { title: n.title } : {}),
          ...(n.messageCount != null ? { messageCount: n.messageCount } : {}),
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

    const oversightTakeover = Effect.fn("OversightHttpApi.takeover")(function* (ctx) {
      const workspaceID = yield* workspaceKey
      // §D2 — record a human takeover. The actor is the routed workspace identity (never client-supplied,
      // so a caller can't spoof who took over). The client optionally names the session/agent it took over
      // and a short reason. This appends an audit row + increments the §F human_takeover_total metric.
      return yield* takeovers.record({
        workspaceID,
        actorID: workspaceID,
        ...(ctx.payload.sessionID != null ? { sessionID: ctx.payload.sessionID } : {}),
        ...(ctx.payload.agentID != null ? { agentID: ctx.payload.agentID } : {}),
        ...(ctx.payload.reason != null ? { reason: ctx.payload.reason } : {}),
      })
    })

    const oversightRollback = Effect.fn("OversightHttpApi.rollback")(function* (ctx) {
      const workspaceID = yield* workspaceKey
      // §D2 — roll back a session's agent-produced changes. The target session MUST belong to the routed
      // workspace: resolve it, then derive ITS workspace key by the SAME canonical rule and compare. An
      // unknown session, or one in another tenant, is indistinguishable → typed 404 (never a cross-tenant
      // revert, never an untyped 500). This is the security boundary — no cross-workspace revert.
      const session = yield* sessions
        .get(SessionID.make(ctx.payload.sessionID))
        .pipe(Effect.catchCause(() => Effect.succeed(null)))
      if (!session) return yield* new HttpApiError.NotFound()
      const sessionKey = ApprovalQueue.deriveWorkspaceKey({
        workspaceID: session.workspaceID,
        directory: session.directory,
      })
      if (sessionKey !== workspaceID) return yield* new HttpApiError.NotFound()

      // Invoke SessionRevert — the SAME primitive the goal loop's production rollback port uses
      // (goal-loop-wiring.ts liveRollback): revert to the last message. Best-effort: if the session is
      // busy or there is nothing to revert, the outcome is "noop" (never a 500 — a rollback is recorded
      // either way as an audit fact). A revert only happens when there is a message to revert to.
      const messages = yield* sessions
        .messages({ sessionID: SessionID.make(ctx.payload.sessionID) })
        .pipe(Effect.orElseSucceed(() => []))
      const latestMessageID = messages.at(-1)?.info.id ?? null
      const outcome: RollbackAudit.RollbackOutcome =
        latestMessageID == null
          ? "noop"
          : yield* revertSvc
              .revert({
                sessionID: SessionID.make(ctx.payload.sessionID),
                messageID: MessageID.make(latestMessageID),
              })
              .pipe(
                Effect.as<RollbackAudit.RollbackOutcome>("reverted"),
                Effect.catchCause(() => Effect.succeed<RollbackAudit.RollbackOutcome>("noop")),
              )

      // Append the audit row + feed the §F rollback_total metric. The actor is the routed workspace
      // identity (never client-supplied → a caller can't spoof who rolled back).
      return yield* rollbacks.record({
        workspaceID,
        sessionID: ctx.payload.sessionID,
        actorID: workspaceID,
        outcome,
        ...(ctx.payload.reason != null ? { reason: ctx.payload.reason } : {}),
      })
    })

    return handlers
      .handle("oversightMetrics", oversightMetrics)
      .handle("oversightTrace", oversightTrace)
      .handle("oversightApprovals", oversightApprovals)
      .handle("oversightResolve", oversightResolve)
      .handle("oversightTakeover", oversightTakeover)
      .handle("oversightRollback", oversightRollback)
  }),
)
