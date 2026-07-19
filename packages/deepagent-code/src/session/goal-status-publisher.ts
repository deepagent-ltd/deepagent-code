export * as GoalStatusPublisher from "./goal-status-publisher"

import { Effect } from "effect"
import { AgentGateway } from "@deepagent-code/core/agent-gateway"
import { DocumentStore } from "@deepagent-code/core/deepagent/document-store"
import type { PlanDoc } from "@deepagent-code/core/deepagent/plan-controller"
import type { GoalStatus } from "@deepagent-code/core/deepagent/goal-loop"
import { DeepAgentEventBus } from "@deepagent-code/core/deepagent/deepagent-event-bus"
import { ApprovalQueue } from "@deepagent-code/core/deepagent/approval-queue"
import { LMNEvents } from "@deepagent-code/core/deepagent/lmn-events"
import type { EventV2 } from "@deepagent-code/core/event"
import type { Session } from "./session"
import { SessionID } from "./schema"
import { GoalEvent } from "./goal-event"
import { PlanEvent } from "../tool/plan-write"

/**
 * V4.1 §N — the SHARED goal-status PUBLISHER. Historically `publishStatus` / `emitGoalLifecycleEvent` /
 * `mirrorGoalPlanToSession` lived as closures inside `goal-manager.ts`'s `layer`. When the event-driven
 * GoalTickConsumer's production port (`makeGoalTickPort`) reconstructs the goal wiring on a COLD fiber, it
 * needs the SAME onStatus behaviour — mirror the plan into session-state, publish `goal.updated` over the
 * SSE bridge, and (flag-on) mirror the lifecycle onto the Event Bus + Approval Queue. Duplicating that
 * closure in two places would drift (e.g. one path forgets the approval-queue escalation). This module is
 * the single implementation both drivers call, parameterized by injected services.
 *
 * The ONLY goal-manager-specific behaviour is caching the last-known ledger on the in-memory `controls`
 * map (so a pause/resume/stop can publish the real ledger immediately). The cold consumer has no such map,
 * so that step is an optional `cacheStatus` callback — omitted on the cold path, provided by goal-manager.
 *
 * The store-root resolver is INJECTED (`goalStoreRoot`) so this module has no path opinion — both callers
 * pass goal-manager's canonical `goalStoreRoot` so the cold consumer opens a fresh store over the SAME path.
 */

export type GoalStatusPublisherDeps = {
  /** The SSE bridge (goal.updated / plan.updated) — production: EventV2Bridge; cold path: same. */
  readonly events: EventV2.Interface
  /** Session lookup (to derive the Approval-Queue workspace key from directory/workspaceID). */
  readonly sessions: Session.Interface
  /** The DeepAgent Event Bus — the §N lifecycle mirror + approval-queue escalation ride it. */
  readonly eventBus: DeepAgentEventBus.Interface
  /** The §D2 Approval Queue — a terminal escalation (needs_human / rolled_back) offers into it. */
  readonly approvalQueue: ApprovalQueue.Interface
  /** Whether the V4 event-driven layer is on (gates the bus + approval-queue mirror; default V3.9 path is unchanged). */
  readonly v4MultiAgentRuntime: boolean
  /** Whether the goal-tick event-driven chain is on independently of v4MultiAgentRuntime. */
  readonly v4GoalTickEventDriven: boolean
  /** The store-root resolver for the goal's plan doc (mirrorGoalPlanToSession reads it). */
  readonly goalStoreRoot: (sessionID: string) => string
  /**
   * Optional: cache the tick's ledger/stall/gaps somewhere the caller controls (goal-manager's in-memory
   * control map). Called on every status BEFORE publishing. Omitted on the cold consumer path (no map).
   */
  readonly cacheStatus?: (
    sessionID: string,
    cached: { ledger: { ticks: number; tokens: number; cost: number; wallclockMs: number }; stallCount: number; gaps: readonly string[] },
  ) => Effect.Effect<void>
}

export type GoalStatusPublisher = {
  /** Emit a raw goal.updated (used for start-seed + control transitions). Best-effort. */
  readonly publishGoalEvent: (
    sessionID: string,
    payload: {
      goalId: string
      planDocId: string
      phase: string
      ledger: { ticks: number; tokens: number; cost: number; wallclockMs: number }
      stallCount: number
      gaps: readonly string[]
    },
  ) => Effect.Effect<void>
  /** The full onStatus port: mirror plan → session-state, publish goal.updated, (flag-on) mirror to bus + approval queue. */
  readonly publishStatus: (sessionID: string, status: GoalStatus) => Effect.Effect<void>
}

export const makeGoalStatusPublisher = (deps: GoalStatusPublisherDeps): GoalStatusPublisher => {
  // Low-level publisher: emit a goal.updated event over the SSE bridge. Best-effort (ignore) so a
  // publish failure never crashes the caller (start route or background/cold driver tick).
  const publishGoalEvent: GoalStatusPublisher["publishGoalEvent"] = (sessionID, payload) =>
    deps.events
      .publish(GoalEvent.Updated, {
        sessionID: SessionID.make(sessionID),
        goalId: payload.goalId,
        planDocId: payload.planDocId,
        phase: payload.phase,
        ledger: payload.ledger,
        stallCount: payload.stallCount,
        gaps: [...payload.gaps],
      })
      .pipe(Effect.ignore)

  // Mirror the goal's plan doc INTO the parent session's live plan state + emit plan.updated, so the
  // client's session_plan reflects the running goal's progress tick-by-tick. Best-effort.
  const mirrorGoalPlanToSession = (sessionID: string, planDocId: string) =>
    Effect.gen(function* () {
      const store = new DocumentStore(deps.goalStoreRoot(sessionID))
      const doc = store.get(planDocId)
      if (!doc) return
      let plan: PlanDoc
      try {
        plan = JSON.parse(doc.body) as PlanDoc
      } catch {
        return
      }
      AgentGateway.DeepAgentSessionState.setPlan(sessionID, plan as never)
      const { done, total } = AgentGateway.DeepAgentPlanController.planProgress(plan)
      yield* deps.events
        .publish(PlanEvent.Updated, {
          sessionID: SessionID.make(sessionID),
          plan_id: plan.plan_id,
          goal: plan.goal,
          active_step_id: plan.active_step_id,
          steps: plan.steps.map((s) => ({
            step_id: s.step_id,
            title: s.title,
            status: s.status,
            acceptance: s.acceptance ?? null,
            assigned_agent: s.assigned_agent ?? null,
            note: s.note ?? null,
          })),
          done,
          total,
        })
        .pipe(Effect.ignore)
    }).pipe(Effect.catchCause(() => Effect.void))

  // §N — publish the discrete goal lifecycle event (goal.tick for a running tick, or the terminal type)
  // and, for a terminal escalation (needs_human / rolled_back), offer it to the Approval Queue.
  const emitGoalLifecycleEvent = (sessionID: string, status: GoalStatus, phase: string) =>
    Effect.gen(function* () {
      const session = yield* deps.sessions.get(SessionID.make(sessionID)).pipe(Effect.orElseSucceed(() => undefined))
      const workspaceID = ApprovalQueue.deriveWorkspaceKey({
        workspaceID: session?.workspaceID,
        directory: session?.directory,
        fallback: sessionID,
      })
      const eventType = LMNEvents.goalPhaseToEventType(phase) ?? LMNEvents.GOAL_TICK
      const idempotencyKey = `goal:${status.goalId}:${phase}:${status.ledger.ticks}`
      const priority = LMNEvents.isApprovalQueueCandidate(eventType) ? "high" : "normal"
      const outcome = yield* deps.eventBus.tryPublish({
        type: eventType,
        source: "system",
        workspaceID,
        actorID: sessionID,
        correlationID: status.goalId,
        idempotencyKey,
        priority,
        payload: {
          goalId: status.goalId,
          planDocId: status.planDocId,
          phase,
          gaps: status.gaps,
          sessionID,
          workspacePath: session?.directory,
        },
      })
      if ("dropped" in outcome) {
        yield* Effect.logWarning("goal lifecycle event dropped by publish rate gate").pipe(
          Effect.annotateLogs({
            reason: "event_dropped",
            cause: "rate_limited",
            workspaceID,
            goalId: status.goalId,
            phase,
          }),
        )
        return
      }
      yield* deps.approvalQueue.offer(outcome.published)
    })

  // Publish a driver status → the goal.updated event, the session-state active-goal pointer, AND (via the
  // optional cacheStatus) the caller's cached last-known status.
  const publishStatus: GoalStatusPublisher["publishStatus"] = (sessionID, status) =>
    Effect.gen(function* () {
      const phase = status.phase as string
      AgentGateway.DeepAgentSessionState.setActiveGoalPhase(sessionID, phase as never)
      yield* mirrorGoalPlanToSession(sessionID, status.planDocId)
      const ledger = {
        ticks: status.ledger.ticks,
        tokens: status.ledger.tokens,
        cost: status.ledger.cost,
        wallclockMs: status.ledger.wallclockMs,
      }
      if (deps.cacheStatus) {
        yield* deps.cacheStatus(sessionID, { ledger, stallCount: status.stallCount, gaps: status.gaps })
      }
      yield* publishGoalEvent(sessionID, {
        goalId: status.goalId,
        planDocId: status.planDocId,
        phase,
        ledger,
        stallCount: status.stallCount,
        gaps: status.gaps,
      })
      if (deps.v4MultiAgentRuntime) {
        yield* emitGoalLifecycleEvent(sessionID, status, phase).pipe(Effect.catchCause(() => Effect.void))
      }
    })

  return { publishGoalEvent, publishStatus }
}
