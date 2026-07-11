export * as ApprovalQueue from "./approval-queue"

import { Context, Effect, Layer } from "effect"
import { and, desc, eq } from "drizzle-orm"
import { Database } from "../database/database"
import { ApprovalQueueTable } from "./approval-queue-sql"
import { DeepAgentEvent } from "./deepagent-event"
import { LMNEvents } from "./lmn-events"
import { Identifier } from "../util/identifier"

// V4.0 §D2 — the Approval Queue service. The durable sink the Oversight Dashboard reads: escalating
// events (goal.needs_human / goal.rolled_back / panel.verdict[needs_human]) enqueue here for a human
// decision. `offer` folds the §M/§N `shouldQueueForApproval` gate so only genuinely-escalating events
// queue (a panel verdict that resolved autonomously never lands here). `resolve` records the human's
// decision. UNIQUE(event_id) makes offer idempotent — a re-delivered event never double-queues.
//
// LAYERING: `core`. Pure durable state; the bus wiring (deepagent-code) subscribes and calls `offer`,
// the HTTP/Oversight layer calls `list`/`resolve`.

export interface ApprovalItem {
  readonly id: string
  readonly workspaceID: string
  readonly eventID: string
  readonly eventType: string
  readonly correlationID?: string
  readonly summary: string
  readonly status: "pending" | "resolved"
  readonly decision?: "approved" | "rejected" | "acknowledged"
  readonly resolvedBy?: string
  readonly resolvedAt?: number
  readonly createdAt: number
}

export interface Interface {
  /**
   * §D2 — offer an event to the queue. Enqueues IFF `shouldQueueForApproval` says it escalates (folds
   * the PANEL_VERDICT needs_human payload gate). Idempotent via UNIQUE(event_id). Returns the queued
   * item, or null if the event does not require approval (or was already queued).
   */
  readonly offer: (event: DeepAgentEvent.Event) => Effect.Effect<ApprovalItem | null>
  /** §D2 — a workspace's pending items, newest first (the Dashboard view). */
  readonly listPending: (workspaceID: string) => Effect.Effect<ReadonlyArray<ApprovalItem>>
  /**
   * §D2 — a human resolves a pending item. REQUIRES `workspaceID`: the resolve is scoped to it so a
   * caller can never resolve (write) or read back an item belonging to a DIFFERENT workspace by id
   * (tenant isolation). Returns null if no PENDING item with that id exists IN THAT workspace. Idempotent:
   * an already-resolved item is unchanged and its row is returned.
   */
  readonly resolve: (input: {
    readonly id: string
    readonly workspaceID: string
    readonly decision: "approved" | "rejected" | "acknowledged"
    readonly resolvedBy: string
  }) => Effect.Effect<ApprovalItem | null>
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/ApprovalQueue") {}

export interface LayerOptions {
  readonly now?: () => number
}

// a short human-facing summary from the raising event.
const summarize = (event: DeepAgentEvent.Event): string => {
  const p = (event.payload ?? {}) as Record<string, unknown>
  switch (event.type) {
    case LMNEvents.GOAL_NEEDS_HUMAN:
      return `Goal escalated for human review${p.goalId ? ` (${String(p.goalId)})` : ""}`
    case LMNEvents.GOAL_ROLLED_BACK:
      return `Goal rolled back${p.reason ? `: ${String(p.reason)}` : ""}`
    case LMNEvents.PANEL_VERDICT:
      return `Expert panel needs human decision${p.question ? `: ${String(p.question)}` : ""}`
    default:
      return `${event.type} requires approval`
  }
}

const decode = (row: {
  id: string
  workspace_id: string
  event_id: string
  event_type: string
  correlation_id: string | null
  summary: string
  status: string
  decision: string | null
  resolved_by: string | null
  resolved_at: number | null
  created_at: number
}): ApprovalItem => ({
  id: row.id,
  workspaceID: row.workspace_id,
  eventID: row.event_id,
  eventType: row.event_type,
  ...(row.correlation_id != null ? { correlationID: row.correlation_id } : {}),
  summary: row.summary,
  status: row.status as ApprovalItem["status"],
  ...(row.decision != null ? { decision: row.decision as ApprovalItem["decision"] } : {}),
  ...(row.resolved_by != null ? { resolvedBy: row.resolved_by } : {}),
  ...(row.resolved_at != null ? { resolvedAt: row.resolved_at } : {}),
  createdAt: row.created_at,
})

export const layerWith = (options?: LayerOptions) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const now = options?.now ?? Date.now

      const offer: Interface["offer"] = (event) =>
        Effect.gen(function* () {
          // §M/§N gate: only genuinely-escalating events queue (folds the PANEL_VERDICT payload check).
          if (!LMNEvents.shouldQueueForApproval(event)) return null

          const at = now()
          const item = {
            id: "apq_" + Identifier.ascending(),
            workspace_id: event.workspaceID,
            event_id: event.id,
            event_type: event.type,
            correlation_id: event.correlationID ?? null,
            summary: summarize(event),
            status: "pending" as const,
            decision: null,
            resolved_by: null,
            resolved_at: null,
            created_at: at,
          }
          // idempotent enqueue: UNIQUE(event_id) means a re-delivered event doesn't double-queue.
          yield* db.insert(ApprovalQueueTable).values([item]).onConflictDoNothing().run().pipe(Effect.orDie)
          // return the authoritative row (the winner if we raced a duplicate).
          const row = yield* db
            .select()
            .from(ApprovalQueueTable)
            .where(eq(ApprovalQueueTable.event_id, event.id))
            .get()
            .pipe(Effect.orDie)
          return row ? decode(row) : null
        })

      const listPending: Interface["listPending"] = (workspaceID) =>
        db
          .select()
          .from(ApprovalQueueTable)
          .where(and(eq(ApprovalQueueTable.workspace_id, workspaceID), eq(ApprovalQueueTable.status, "pending")))
          .orderBy(desc(ApprovalQueueTable.created_at))
          .all()
          .pipe(Effect.orDie, Effect.map((rows) => rows.map(decode)))

      const resolve: Interface["resolve"] = (input) =>
        Effect.gen(function* () {
          const at = now()
          // only a PENDING item IN THIS WORKSPACE transitions — the workspace_id predicate prevents a
          // cross-tenant write (resolving another workspace's item by id). Already-resolved = no-op.
          yield* db
            .update(ApprovalQueueTable)
            .set({ status: "resolved", decision: input.decision, resolved_by: input.resolvedBy, resolved_at: at })
            .where(
              and(
                eq(ApprovalQueueTable.id, input.id),
                eq(ApprovalQueueTable.workspace_id, input.workspaceID),
                eq(ApprovalQueueTable.status, "pending"),
              ),
            )
            .run()
            .pipe(Effect.orDie)
          // re-select is ALSO workspace-scoped: a row belonging to another workspace is never returned
          // (no cross-tenant read-back), so an unknown/foreign id yields null.
          const row = yield* db
            .select()
            .from(ApprovalQueueTable)
            .where(and(eq(ApprovalQueueTable.id, input.id), eq(ApprovalQueueTable.workspace_id, input.workspaceID)))
            .get()
            .pipe(Effect.orDie)
          return row ? decode(row) : null
        })

      return Service.of({ offer, listPending, resolve })
    }),
  )

export const layer = layerWith()

export const defaultLayer = layer.pipe(Layer.provide(Database.defaultLayer))
