export * as Observability from "./observability"

import { Context, Effect, Layer } from "effect"
import { and, asc, eq, gt, gte, lte, sql } from "drizzle-orm"
import { Database } from "../database/database"
import { DeepAgentEventTable, DeepAgentEventDeliveryTable } from "./deepagent-event-sql"
import { AgentPushLogTable } from "../im/push-log-sql"
import { DeepAgentEvent } from "./deepagent-event"

// V4.0 §F — Observability. Read-only aggregation over the durable substrate this V4.0 work already
// writes (deepagent_event / deepagent_event_delivery / im_agent_push_logs). Two capabilities:
//   §F2 Trace   — given a correlationID, assemble the causal chain of events (the trace spine the
//                 Oversight "Event Trace" view renders: event → route → agent run → coordination → …).
//   §F1 Metrics — compute the §F1 counters over a time window (DLQ total, push-rejected-by-reason,
//                 agent-task success rate, conflict rate) for the Agent Dashboard.
//
// LAYERING: `core`. Pure reads — no dispatch/session. The HTTP/Oversight layer (deepagent-code) calls
// this and renders. Latency histograms (event_publish_latency_ms / event_to_agent_start_ms) need
// emission-time instrumentation and are NOT computed here (documented gap — this service reports the
// COUNT/RATE metrics derivable from the durable rows).

// One node in a §F2 trace — a durable event on the correlation chain, with its causal parent.
export interface TraceNode {
  readonly eventID: DeepAgentEvent.ID
  readonly type: string
  readonly source: DeepAgentEvent.EventSource
  readonly causationID?: string
  readonly createdAt: number
  readonly payload: unknown
}

// §F1 metric snapshot over a window.
export interface Metrics {
  readonly windowFrom: number
  readonly windowTo: number
  // dlq_events_total — deliveries that exhausted retries (status=dead). Alarms in Oversight.
  readonly dlqEventsTotal: number
  // agent_push_rejected_total, decomposable by reason (blocked:<reason>).
  readonly agentPushRejectedTotal: number
  readonly agentPushRejectedByReason: Readonly<Record<string, number>>
  // agent_task_success_rate — completed / (completed + GENUINE failures) in the window. GENUINE
  // failures = agent.task.blocked with reason "runner_failed" ONLY; policy blocks (no_capable_agent,
  // autonomy, security, suggestion_only, dependency_not_met, conflict_*) are normal outcomes, NOT
  // failures, and are excluded from the denominator. null ⇒ no task activity (distinct from 1.0).
  readonly agentTaskSuccessRate: number | null
  readonly agentTaskCompleted: number
  readonly agentTaskFailed: number
  // agent_conflict_rate — share of blocked subtasks whose block reason is a conflict, over all blocks.
  // null ⇒ no blocks in the window.
  readonly agentConflictRate: number | null
  readonly agentTaskBlockedTotal: number
  // total pushes (delivered + digest + blocked) in the window.
  readonly agentPushTotal: number
}

export interface Interface {
  /**
   * §F2 — the causal event chain for a correlationID within a workspace, oldest-first (created_at asc,
   * id asc). `workspaceID` is REQUIRED: correlationID is a free-form string a producer sets, so two
   * tenants can collide on the same value — scoping to the workspace prevents a cross-tenant trace leak.
   */
  readonly trace: (input: { workspaceID: string; correlationID: string }) => Effect.Effect<ReadonlyArray<TraceNode>>
  /** §F1 — metric snapshot for one workspace over [from, to] (to defaults to now). */
  readonly metrics: (input: { workspaceID: string; from: number; to?: number }) => Effect.Effect<Metrics>
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/Observability") {}

export interface LayerOptions {
  readonly now?: () => number
}

export const layerWith = (options?: LayerOptions) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const now = options?.now ?? Date.now

      const trace: Interface["trace"] = (input) =>
        db
          .select()
          .from(DeepAgentEventTable)
          .where(
            and(
              eq(DeepAgentEventTable.workspace_id, input.workspaceID),
              eq(DeepAgentEventTable.correlation_id, input.correlationID),
            ),
          )
          // stable causal order: created_at asc, id asc (ids are ascending-monotonic — matches the bus).
          .orderBy(asc(DeepAgentEventTable.created_at), asc(DeepAgentEventTable.id))
          .all()
          .pipe(
            Effect.orDie,
            Effect.map((rows) =>
              rows.map(
                (r): TraceNode => ({
                  eventID: r.id as DeepAgentEvent.ID,
                  type: r.type,
                  source: r.source as DeepAgentEvent.EventSource,
                  ...(r.causation_id != null ? { causationID: r.causation_id } : {}),
                  createdAt: r.created_at,
                  payload: r.payload ?? undefined,
                }),
              ),
            ),
          )

      const metrics: Interface["metrics"] = (input) =>
        Effect.gen(function* () {
          const from = input.from
          const to = input.to ?? now()
          const ws = input.workspaceID

          // dlq_events_total — DISTINCT events that dead-lettered in the window, scoped to the workspace
          // via a join to the event log. count(distinct event_id) so an event dead across N groups
          // counts once (the metric is "events", not delivery rows).
          const dlqRow = yield* db
            .select({ n: sql<number>`count(distinct ${DeepAgentEventDeliveryTable.event_id})` })
            .from(DeepAgentEventDeliveryTable)
            .innerJoin(DeepAgentEventTable, eq(DeepAgentEventTable.id, DeepAgentEventDeliveryTable.event_id))
            .where(
              and(
                eq(DeepAgentEventTable.workspace_id, ws),
                eq(DeepAgentEventDeliveryTable.status, "dead"),
                gte(DeepAgentEventDeliveryTable.updated_at, from),
                lte(DeepAgentEventDeliveryTable.updated_at, to),
              ),
            )
            .get()
            .pipe(Effect.orDie)

          // agent_push_* — from im_agent_push_logs in the window, scoped to the workspace.
          const pushRows = yield* db
            .select({ decision: AgentPushLogTable.decision, n: sql<number>`count(*)` })
            .from(AgentPushLogTable)
            .where(
              and(
                eq(AgentPushLogTable.workspace_id, ws),
                gte(AgentPushLogTable.created_at, from),
                lte(AgentPushLogTable.created_at, to),
              ),
            )
            .groupBy(AgentPushLogTable.decision)
            .all()
            .pipe(Effect.orDie)

          let agentPushTotal = 0
          let agentPushRejectedTotal = 0
          const agentPushRejectedByReason: Record<string, number> = {}
          for (const row of pushRows) {
            agentPushTotal += row.n
            if (row.decision.startsWith("blocked:")) {
              agentPushRejectedTotal += row.n
              const reason = row.decision.slice("blocked:".length)
              agentPushRejectedByReason[reason] = (agentPushRejectedByReason[reason] ?? 0) + row.n
            }
          }

          // agent task outcomes — read the coordination events (workspace-scoped) and classify by the
          // block REASON in the payload (not just the type). completed = success; blocked splits into
          // GENUINE failure (runner_failed) vs normal policy block (everything else); conflict blocks
          // feed the conflict rate.
          const outcomeRows = yield* db
            .select({ type: DeepAgentEventTable.type, payload: DeepAgentEventTable.payload })
            .from(DeepAgentEventTable)
            .where(
              and(
                eq(DeepAgentEventTable.workspace_id, ws),
                gte(DeepAgentEventTable.created_at, from),
                lte(DeepAgentEventTable.created_at, to),
                sql`${DeepAgentEventTable.type} in ('agent.task.completed', 'agent.task.blocked')`,
              ),
            )
            .all()
            .pipe(Effect.orDie)

          let agentTaskCompleted = 0
          let agentTaskFailed = 0 // genuine failures (runner_failed) only
          let agentTaskBlockedTotal = 0
          let conflictBlocks = 0
          for (const row of outcomeRows) {
            if (row.type === "agent.task.completed") {
              agentTaskCompleted++
              continue
            }
            agentTaskBlockedTotal++
            const reason = (row.payload as { reason?: string } | null)?.reason ?? ""
            if (reason === "runner_failed") agentTaskFailed++
            if (reason.startsWith("conflict")) conflictBlocks++
          }
          const denom = agentTaskCompleted + agentTaskFailed
          const agentTaskSuccessRate = denom === 0 ? null : agentTaskCompleted / denom
          const agentConflictRate = agentTaskBlockedTotal === 0 ? null : conflictBlocks / agentTaskBlockedTotal

          return {
            windowFrom: from,
            windowTo: to,
            dlqEventsTotal: dlqRow?.n ?? 0,
            agentPushRejectedTotal,
            agentPushRejectedByReason,
            agentTaskSuccessRate,
            agentTaskCompleted,
            agentTaskFailed,
            agentConflictRate,
            agentTaskBlockedTotal,
            agentPushTotal,
          }
        })

      return Service.of({ trace, metrics })
    }),
  )

export const layer = layerWith()

export const defaultLayer = layer.pipe(Layer.provide(Database.defaultLayer))
