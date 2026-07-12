export * as Observability from "./observability"

import { Context, Effect, Layer } from "effect"
import { and, asc, eq, gt, gte, inArray, lte, or, sql } from "drizzle-orm"
import { Database } from "../database/database"
import { DeepAgentEventTable, DeepAgentEventDeliveryTable, DeepAgentEventDropTable } from "./deepagent-event-sql"
import { AgentPushLogTable } from "../im/push-log-sql"
import { HumanTakeoverTable } from "./human-takeover-sql"
import { SessionTable, MessageTable } from "../session/sql"
import { DeepAgentEvent } from "./deepagent-event"

// V4.0 §F — Observability. Read-only aggregation over the durable substrate this V4.0 work already
// writes (deepagent_event / deepagent_event_delivery / im_agent_push_logs). Two capabilities:
//   §F2 Trace   — given a correlationID, assemble the causal chain of events (the trace spine the
//                 Oversight "Event Trace" view renders: event → route → agent run → coordination → …).
//   §F1 Metrics — compute the §F1 counters over a time window (DLQ total, push-rejected-by-reason,
//                 agent-task success rate, conflict rate) for the Agent Dashboard.
//
// LAYERING: `core`. Pure reads — no dispatch/session. The HTTP/Oversight layer (deepagent-code) calls
// this and renders. Latency histograms (event_publish_latency_ms / event_to_agent_start_ms) ARE computed
// here now that the bus records publish_latency_ms on each row and agent.task.started carries the
// triggering event's id as causationID — nearest-rank percentiles over the window, workspace-scoped.

// One node in a §F2 trace. `kind` discriminates the two halves of the spine:
//   "event"   — a durable DeepAgentEvent on the correlation chain (event → route → coordination), with
//               its causal parent.
//   "session" — a CHILD SESSION an agent ran in that was stamped with this correlationID (the §F2
//               trace BACK-HALF). This is what makes the trace follow correlationID down into the child's
//               activity: the Multi-Agent / event runner stamps `metadata.correlationID` on the session it
//               creates, and `trace` reads it back here so the child (and its message/tool-call activity)
//               appears on the same spine as the triggering event.
// A "session" node reuses eventID/type/source (eventID=sessionID, type="session.activity", source="system")
// so an existing event-only projection encodes it unchanged; the session-specific detail rides the optional
// sessionID/title/messageCount fields.
export interface TraceNode {
  readonly kind: "event" | "session"
  readonly eventID: string
  readonly type: string
  readonly source: DeepAgentEvent.EventSource
  readonly causationID?: string
  readonly createdAt: number
  readonly payload?: unknown
  // §F2 back-half — present only on kind:"session" nodes.
  readonly sessionID?: string
  readonly title?: string
  // count of persisted messages in the child session (a light activity summary; 0 when none / unknown).
  readonly messageCount?: number
}

// §F1 metric snapshot over a window.
export interface Metrics {
  readonly windowFrom: number
  readonly windowTo: number
  // dlq_events_total — deliveries that exhausted retries (status=dead). Alarms in Oversight.
  readonly dlqEventsTotal: number
  // §A4 event_dropped_total — events the router SHED (backpressure) in the window, from the durable
  // deepagent_event_drop log. Decomposable by reason (mirrors agentPushRejectedByReason). Total is the
  // sum across reasons; the by-reason map keys on the DropReason string (currently "backpressure").
  readonly eventDroppedTotal: number
  readonly eventDroppedByReason: Readonly<Record<string, number>>
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
  // §F1 event_publish_latency_ms — P50/P95 of the per-event persist latency (bus writes publish_latency_ms
  // on each row). Nearest-rank percentiles over the window, workspace-scoped. null ⇒ no samples.
  readonly eventPublishLatencyMsP50: number | null
  readonly eventPublishLatencyMsP95: number | null
  // §F1 event_to_agent_start_ms — P50/P95 of (agent.task.started.created_at − triggering-event.created_at),
  // joined by the started event's causationID = the trigger event's id, workspace-scoped. null ⇒ no samples.
  readonly eventToAgentStartMsP50: number | null
  readonly eventToAgentStartMsP95: number | null
  // §F human_takeover_total — the count of human takeovers (a human pausing/reverting an agent or claiming
  // a branch/session) in the window, workspace-scoped. Backs the §D2 Takeover surface's headline count.
  readonly humanTakeoverTotal: number
}

// Nearest-rank percentile (§F1 histograms computed in-code, no SQL percentile fn). `p` in [0,1].
// Returns null for an empty sample set. Sorts ascending; rank = ceil(p·n), clamped to [1,n].
const percentile = (samples: ReadonlyArray<number>, p: number): number | null => {
  if (samples.length === 0) return null
  const sorted = [...samples].sort((a, b) => a - b)
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil(p * sorted.length)))
  return sorted[rank - 1]
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
        Effect.gen(function* () {
          // ── front-half: the durable event chain (event → route → coordination) for this correlationID.
          const eventRows = yield* db
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
            .pipe(Effect.orDie)

          const eventNodes = eventRows.map(
            (r): TraceNode => ({
              kind: "event",
              eventID: r.id as string,
              type: r.type,
              source: r.source as DeepAgentEvent.EventSource,
              ...(r.causation_id != null ? { causationID: r.causation_id } : {}),
              createdAt: r.created_at,
              payload: r.payload ?? undefined,
            }),
          )

          // ── §F2 BACK-HALF: the CHILD SESSIONS an agent ran in that were stamped with this correlationID.
          // The event/goal runner writes `metadata.correlationID` onto the child session it creates; here we
          // read it back so the trace follows correlationID DOWN into the child's activity (its message /
          // tool-call turns), not just the coordination events. SessionTable.metadata is a JSON column →
          // json_extract('$.correlationID'). Scope to the same routing key the front-half used: an
          // event-driven child stores workspace_id ONLY for a genuine "wrk"-id but always stores a
          // directory, while the trace's workspaceID param is `route.workspaceID ?? route.directory` — so
          // match EITHER column to cover both the workspace- and directory-routed models without leaking
          // across the tenant boundary (both columns are the routed identity). FAIL SAFE: any failure here
          // resolves to NO session nodes so the front-half event chain is still returned (never crash the
          // trace). A best-effort per-session message count gives a light activity summary.
          const sessionNodes = yield* Effect.gen(function* () {
            const sessionRows = yield* db
              .select({
                id: SessionTable.id,
                title: SessionTable.title,
                createdAt: SessionTable.time_created,
              })
              .from(SessionTable)
              .where(
                and(
                  or(
                    eq(SessionTable.workspace_id, input.workspaceID as never),
                    // compare `directory` via raw sql: the column's custom type encodes the compared value
                    // through an absolute-path validator that THROWS on a non-path routing key (e.g. a
                    // "wrk_"-id) at query-build time — binding the value as a plain string sidesteps that.
                    sql`${SessionTable.directory} = ${input.workspaceID}`,
                  ),
                  eq(sql`json_extract(${SessionTable.metadata}, '$.correlationID')`, input.correlationID),
                ),
              )
              .orderBy(asc(SessionTable.time_created), asc(SessionTable.id))
              .all()
            if (sessionRows.length === 0) return [] as TraceNode[]

            // per-session message count (a light activity summary) via ONE grouped query over the matched
            // sessions — avoids a correlated subquery and stays cheap.
            const ids = sessionRows.map((r) => r.id as string)
            const countRows = yield* db
              .select({ sessionID: MessageTable.session_id, n: sql<number>`count(*)` })
              .from(MessageTable)
              .where(inArray(MessageTable.session_id, ids as never))
              .groupBy(MessageTable.session_id)
              .all()
            const countBySession = new Map(countRows.map((r) => [r.sessionID as string, Number(r.n ?? 0)]))

            return sessionRows.map(
              (r): TraceNode => ({
                kind: "session",
                // reuse eventID/type/source so an event-only projection renders this node unchanged.
                eventID: r.id as string,
                type: "session.activity",
                source: "system",
                createdAt: r.createdAt,
                sessionID: r.id as string,
                title: r.title,
                messageCount: countBySession.get(r.id as string) ?? 0,
              }),
            )
          }).pipe(
            // fail-safe: a missing session table / json_extract quirk must not crash the trace — just
            // return the front-half event chain with no session nodes appended.
            Effect.catchCause(() => Effect.succeed([] as TraceNode[])),
          )

          // merge both halves into one causally-ordered spine (created_at asc; session nodes interleave at
          // their creation time — a child session created after its trigger event sorts after it).
          return [...eventNodes, ...sessionNodes].sort((a, b) => a.createdAt - b.createdAt)
        })

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

          // §A4 event_dropped_total — router-shed events (backpressure) in the window, grouped by reason,
          // from the durable deepagent_event_drop log. Workspace-scoped, windowed on the drop's created_at.
          // Mirrors the dlq_events_total pattern (a persisted signal, not a log line).
          const dropRows = yield* db
            .select({ reason: DeepAgentEventDropTable.reason, n: sql<number>`count(*)` })
            .from(DeepAgentEventDropTable)
            .where(
              and(
                eq(DeepAgentEventDropTable.workspace_id, ws),
                gte(DeepAgentEventDropTable.created_at, from),
                lte(DeepAgentEventDropTable.created_at, to),
              ),
            )
            .groupBy(DeepAgentEventDropTable.reason)
            .all()
            .pipe(Effect.orDie)
          let eventDroppedTotal = 0
          const eventDroppedByReason: Record<string, number> = {}
          for (const row of dropRows) {
            eventDroppedTotal += row.n
            eventDroppedByReason[row.reason] = (eventDroppedByReason[row.reason] ?? 0) + row.n
          }

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

          // §F1 event_publish_latency_ms — the bus writes publish_latency_ms on each event row; read the
          // non-null samples in the window (workspace-scoped) and compute nearest-rank P50/P95 in-code.
          const latencyRows = yield* db
            .select({ ms: DeepAgentEventTable.publish_latency_ms })
            .from(DeepAgentEventTable)
            .where(
              and(
                eq(DeepAgentEventTable.workspace_id, ws),
                gte(DeepAgentEventTable.created_at, from),
                lte(DeepAgentEventTable.created_at, to),
                sql`${DeepAgentEventTable.publish_latency_ms} is not null`,
              ),
            )
            .all()
            .pipe(Effect.orDie)
          const latencySamples = latencyRows.map((r) => r.ms as number)
          const eventPublishLatencyMsP50 = percentile(latencySamples, 0.5)
          const eventPublishLatencyMsP95 = percentile(latencySamples, 0.95)

          // §F1 event_to_agent_start_ms — for each agent.task.started event in the window, the delay from
          // its TRIGGER (the event whose id == the started event's causationID) to the start. We read the
          // started rows, then resolve each causationID to its trigger's created_at via a workspace-scoped
          // id→created_at map; sample = started.created_at − trigger.created_at. Joining in-code (rather
          // than a correlated self-join on the same physical table) keeps the query unambiguous and
          // mirrors the in-code percentile idiom.
          const startedRows = yield* db
            .select({ createdAt: DeepAgentEventTable.created_at, causationID: DeepAgentEventTable.causation_id })
            .from(DeepAgentEventTable)
            .where(
              and(
                eq(DeepAgentEventTable.workspace_id, ws),
                eq(DeepAgentEventTable.type, "agent.task.started"),
                gte(DeepAgentEventTable.created_at, from),
                lte(DeepAgentEventTable.created_at, to),
                sql`${DeepAgentEventTable.causation_id} is not null`,
              ),
            )
            .all()
            .pipe(Effect.orDie)

          const startSamples: number[] = []
          const triggerIDs = [...new Set(startedRows.map((r) => r.causationID).filter((c): c is string => c != null))]
          if (triggerIDs.length > 0) {
            // resolve trigger created_at, scoped to THIS workspace so a cross-tenant id collision can't
            // pair a started event to another tenant's trigger.
            const triggerRows = yield* db
              .select({ id: DeepAgentEventTable.id, createdAt: DeepAgentEventTable.created_at })
              .from(DeepAgentEventTable)
              .where(
                and(
                  eq(DeepAgentEventTable.workspace_id, ws),
                  inArray(DeepAgentEventTable.id, triggerIDs as DeepAgentEvent.ID[]),
                ),
              )
              .all()
              .pipe(Effect.orDie)
            const triggerAt = new Map(triggerRows.map((r) => [r.id as string, r.createdAt]))
            for (const r of startedRows) {
              const t = r.causationID != null ? triggerAt.get(r.causationID) : undefined
              // only pair to a trigger that exists in this workspace, and never emit a negative sample.
              if (t != null && r.createdAt >= t) startSamples.push(r.createdAt - t)
            }
          }
          const eventToAgentStartMsP50 = percentile(startSamples, 0.5)
          const eventToAgentStartMsP95 = percentile(startSamples, 0.95)

          // §F human_takeover_total — count the human-takeover audit rows in the window (workspace-scoped).
          // The takeover log is its own table (deepagent_human_takeover) written by the §D2 Takeover
          // endpoint; a fresh workspace with no takeovers reads 0 (never null — a takeover is a plain count).
          const takeoverRow = yield* db
            .select({ n: sql<number>`count(*)` })
            .from(HumanTakeoverTable)
            .where(
              and(
                eq(HumanTakeoverTable.workspace_id, ws),
                gte(HumanTakeoverTable.created_at, from),
                lte(HumanTakeoverTable.created_at, to),
              ),
            )
            .get()
            .pipe(Effect.orDie)

          return {
            windowFrom: from,
            windowTo: to,
            dlqEventsTotal: dlqRow?.n ?? 0,
            eventDroppedTotal,
            eventDroppedByReason,
            agentPushRejectedTotal,
            agentPushRejectedByReason,
            agentTaskSuccessRate,
            agentTaskCompleted,
            agentTaskFailed,
            agentConflictRate,
            agentTaskBlockedTotal,
            agentPushTotal,
            eventPublishLatencyMsP50,
            eventPublishLatencyMsP95,
            eventToAgentStartMsP50,
            eventToAgentStartMsP95,
            humanTakeoverTotal: takeoverRow?.n ?? 0,
          }
        })

      return Service.of({ trace, metrics })
    }),
  )

export const layer = layerWith()

export const defaultLayer = layer.pipe(Layer.provide(Database.defaultLayer))
