export * as SupervisorNotifier from "./supervisor-notifier"

import { Context, Deferred, Effect, Layer, Stream, Schedule, Duration, Cause } from "effect"
import { and, eq, isNull, inArray } from "drizzle-orm"
import { Database } from "@deepagent-code/core/database/database"
import { DeepAgentEventBus } from "@deepagent-code/core/deepagent/deepagent-event-bus"
import { DeepAgentEvent } from "@deepagent-code/core/deepagent/deepagent-event"
import { LMNEvents } from "@deepagent-code/core/deepagent/lmn-events"
import { GroupTable } from "@deepagent-code/core/im/sql"
import { AgentPush } from "./agent-push"
import { AgentPushPolicy } from "@deepagent-code/core/deepagent/agent-push-policy"
import { RuntimeFlags } from "@/effect/runtime-flags"
import * as Log from "@deepagent-code/core/util/log"

// V4.0 §B2/§L/§M — the SUPERVISOR NOTIFIER: the PRODUCTION caller of AgentPush.push.
//
// The §B2 push stack (policy gate, rate-limit, quiet-hours, content-safety, audit log) was fully built
// and tested but had NO production caller (v4.0beta_review §6 / §10 P2.8) — so nothing ever proactively
// pushed and `agent_push_rejected_total` read empty. This service is that caller. It subscribes to the
// Event Bus and, for every event that represents a TERMINAL outcome needing human attention (the SAME
// vocabulary the §D2 Approval Queue folds — agent.task.needs_human, goal.needs_human, goal.rolled_back,
// and a panel.verdict whose decision is needs_human), it PROACTIVELY pushes a notification into the
// workspace's IM group(s) via AgentPush.push. So a human supervisor is told "a run needs you" in IM,
// through the full §B2 policy gate, in addition to the Approval-Queue row the panel/runtime already writes.
//
// WHY THIS CALLER (not multi-agent-runtime.ts / panel-convene-consumer.ts): those are P2.9 / P2.7 hot
// files. A STANDALONE bus subscriber is the lowest-conflict, most natural producer of a supervisor-facing
// notification — §L §M explicitly say wiki/knowledge/panel/oversight events push to IM (docs §B/§L). It
// reuses the existing `shouldQueueForApproval` vocabulary rather than inventing a new trigger, so it can
// never drift from what the Approval Queue considers human-facing. It touches none of the P2 hot files.
//
// AUTHORIZATION: the push is authored by a SYSTEM pusher identity holding WORKSPACE PUSH PERMISSION —
// the §B2 policy's second authorization leg ("group member OR workspace push permission"). The notifier
// IS the runtime, so it legitimately holds workspace push permission; it need not be seeded as a member
// of every group. Quiet-hours, rate-limit and content-safety still apply (they run after the perm gate).
//
// DELIVERY DISCHARGE (§A3 at-least-once): grouped subscriber → `publish` records a durable `pending`
// delivery row per owed event. Every terminal path acks; only a transient push-runtime error nacks (the
// retry pump re-drives it). AgentPush's idempotencyKey (`notify:<eventID>:<groupID>`) makes a re-drive a
// no-op, so at-least-once never double-delivers.
//
// FLAG-GATED: v4AgentPushEnabled (default OFF). Off ⇒ the subscription still acks (discharges deliveries)
// but pushes NOTHING — inert, byte-identical to pre-§B2 behavior. AgentPush.push itself also fail-closes
// on the flag, so this is belt-and-suspenders.
//
// LAYERING: `deepagent-code`. Bridges the bus (core) to the AgentPush runtime (deepagent-code).

const log = Log.create({ service: "supervisor-notifier" })

export const NOTIFY_GROUP = "supervisor-notifier"
// §A3 retry-pump cadence (mirrors EventDispatcher / PanelConveneConsumer).
export const DEFAULT_RETRY_PUMP_INTERVAL_MS = 30_000

// The SYSTEM pusher identity. A stable, non-user agent id so the audit trail attributes proactive
// supervisor notifications to the runtime itself (not a masqueraded human/agent).
export const SYSTEM_PUSHER_AGENT_ID = "agent_system_notifier"

// The event types this notifier pushes on. TWO legs, kept deliberately distinct:
//   (a) §D2 human-attention terminal outcomes — EXACTLY the Approval-Queue candidates, via the shared
//       `shouldQueueForApproval` fold, so a new approval-queue type is automatically notified too.
//   (b) §A3 OPERATIONAL alerts — a dlq.alert (a delivery exhausted its retries → dead-letter). §A3's
//       whole point is "生成告警 instead of sitting silently in the DLQ view until someone queries it", so
//       a workspace operator SHOULD be told. Kept OUT of shouldQueueForApproval / APPROVAL_QUEUE_TYPES on
//       purpose: a dead-letter is an operational notice, NOT an approval-queue decision — folding it there
//       would wrongly create Approval-Queue rows. The producer's self-cascade guard (a dead dlq.alert never
//       re-alerts) + AgentPush's idempotencyKey keep this from looping or double-notifying.
const isNotifiable = (event: DeepAgentEvent.Event): boolean =>
  LMNEvents.shouldQueueForApproval({ type: event.type, payload: event.payload }) ||
  event.type === LMNEvents.DLQ_ALERT

// A short machine reason + a human-readable body for the push, derived from the event. The body prefers
// a payload `reason`/`summary`/`question` when present (runtime/goal/panel all carry one), else a
// generic line naming the event. Kept small + pure.
const notifyContent = (event: DeepAgentEvent.Event): { reason: string; content: string } => {
  const p = (event.payload ?? {}) as Record<string, unknown>
  const detail =
    typeof p.reason === "string" && p.reason.length > 0
      ? p.reason
      : typeof p.summary === "string" && p.summary.length > 0
        ? p.summary
        : typeof p.question === "string" && p.question.length > 0
          ? p.question
          : ""
  const label =
    event.type === LMNEvents.PANEL_VERDICT
      ? "Expert Panel escalated to needs_human"
      : event.type === LMNEvents.GOAL_NEEDS_HUMAN
        ? "A goal run needs human attention"
        : event.type === LMNEvents.GOAL_ROLLED_BACK
          ? "A goal run was rolled back"
          : event.type === LMNEvents.AGENT_TASK_NEEDS_HUMAN
            ? "An agent task needs human attention"
            : event.type === LMNEvents.DLQ_ALERT
              ? "An event delivery hit the dead-letter queue"
              : `Event ${event.type} needs human attention`
  return {
    reason: event.type,
    content: detail ? `${label}: ${detail}` : `${label} (event ${event.id}).`,
  }
}

// Port: which IM group(s) in a workspace should receive supervisor notifications? Injected so tests pin
// a group and production queries the live im_groups. Production default: every non-deleted project/system
// group in the workspace (direct 1:1 groups are excluded — a proactive escalation is a team signal, not a
// private DM). Returns [] when the workspace has no such group (nothing to notify → the event still acks).
export type GroupResolver = (workspaceID: string) => Effect.Effect<ReadonlyArray<string>>

export interface Interface {
  /**
   * Handle ONE bus event and DISCHARGE its delivery. Flag off / not-notifiable / no target group → ack +
   * skip. Otherwise push a notification (priority "high" so a human-attention escalation punches through
   * quiet hours, per §E4) to each resolved group via AgentPush, then ack. A push-runtime failure (DB
   * error) → nack (transient). A policy REJECTION (blocked/digest) is NOT a failure — it is the gate
   * working as designed, so the event still acks. Returns the number of groups a push was ATTEMPTED for.
   * Exposed for deterministic testing; the background subscription calls it.
   */
  readonly handle: (event: DeepAgentEvent.Event) => Effect.Effect<number>
  /**
   * §A3 retry pump for THIS group. Re-drives pending deliveries whose backoff elapsed (a push that
   * errored, or a crash-orphaned delivery), reloading the event and re-running handle (idempotent via the
   * AgentPush idempotencyKey). Exposed for testing; the background loop calls it on a cadence.
   */
  readonly pumpRetries: (now?: number) => Effect.Effect<number>
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/SupervisorNotifier") {}

export interface LayerOptions {
  /** Override the target-group resolver (tests pin a group); defaults to the live im_groups query. */
  readonly resolveGroups?: GroupResolver
  /** Start the background bus subscription + retry pump. Default true; tests set false + call handle(). */
  readonly runLoop?: boolean
  readonly retryPumpIntervalMs?: number
  readonly now?: () => number
}

export const layerWith = (options?: LayerOptions) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const bus = yield* DeepAgentEventBus.Service
      const pushRuntime = yield* AgentPush.Service
      const flags = yield* RuntimeFlags.Service
      const runLoop = options?.runLoop ?? true
      const retryPumpIntervalMs = options?.retryPumpIntervalMs ?? DEFAULT_RETRY_PUMP_INTERVAL_MS

      const ack = (event: DeepAgentEvent.Event) => bus.ack(NOTIFY_GROUP, event.id)

      // default resolver: every live project/system group in the workspace. Uses the db directly (not
      // IMRepository.listGroups, which membership-scopes to a userID) — a supervisor notification targets
      // the group regardless of any single user's membership. A failure resolves to [] (skip → ack).
      const resolveGroups: GroupResolver =
        options?.resolveGroups ??
        ((workspaceID) =>
          db
            .select({ id: GroupTable.id })
            .from(GroupTable)
            .where(
              and(
                eq(GroupTable.workspace_id, workspaceID),
                isNull(GroupTable.deleted_at),
                inArray(GroupTable.type, ["project", "system"]),
              ),
            )
            .all()
            .pipe(
              Effect.map((rows) => rows.map((r) => r.id as string)),
              Effect.orElseSucceed(() => [] as ReadonlyArray<string>),
            ))

      const handle: Interface["handle"] = (event) =>
        Effect.gen(function* () {
          // §B2 fail-closed: flag off ⇒ never push. This group wildcard-subscribes ALL events, so a
          // skipped event MUST still ack (discharge the durable delivery row).
          if (!flags.v4AgentPushEnabled) {
            yield* ack(event)
            return 0
          }
          if (!isNotifiable(event)) {
            yield* ack(event)
            return 0
          }

          const groups = yield* resolveGroups(event.workspaceID)
          if (groups.length === 0) {
            yield* ack(event) // nowhere to notify — terminal, discharge it.
            return 0
          }

          const { reason, content } = notifyContent(event)

          // Push to each group. A DB error inside AgentPush surfaces as a defect → we catch the cause and
          // nack for retry (transient). A POLICY outcome (blocked/digest/deliver) is a success of the gate,
          // never a nack. The idempotencyKey pins one push per (event, group) so a retry never double-sends.
          let attempted = 0
          let failed = false
          for (const groupID of groups) {
            const request: AgentPushPolicy.AgentPushRequest = {
              workspaceID: event.workspaceID,
              groupID,
              agentID: SYSTEM_PUSHER_AGENT_ID,
              reason,
              // §E4 — human-attention escalations are urgent, so push at "high": they PUNCH THROUGH quiet
              // hours (deliver-with-requiresReason) rather than being held for a digest. The reason is
              // recorded on the audit row (§E4 requiresReason) as required.
              priority: "high",
              content,
              idempotencyKey: `notify:${event.id}:${groupID}`,
            }
            const outcome = yield* pushRuntime
              // §B2 — authorize via the workspace-push-permission leg (the notifier is the runtime, not a
              // group member). Quiet-hours + rate + content-safety still run inside push.
              .push(request, { hasWorkspacePushPermission: true })
              .pipe(
                Effect.map((r) => ({ ok: true as const, r })),
                Effect.catchCause((cause) => Effect.succeed({ ok: false as const, cause })),
              )
            attempted++
            if (!outcome.ok) {
              failed = true
              log.error("supervisor push failed", {
                eventID: event.id,
                groupID,
                cause: Cause.pretty(outcome.cause),
              })
            } else {
              log.info("supervisor notification pushed", {
                eventID: event.id,
                groupID,
                decision: outcome.r.decision,
              })
            }
          }

          if (failed) {
            // at least one group's push errored transiently — nack so the pump re-drives (idempotent).
            yield* bus.nack({ subscriptionGroup: NOTIFY_GROUP, eventID: event.id, reason: "supervisor push failed" })
            return attempted
          }
          yield* ack(event)
          return attempted
        })

      const pumpRetries: Interface["pumpRetries"] = (now) =>
        Effect.gen(function* () {
          const due = yield* bus.dueRetries(now)
          let redriven = 0
          for (const delivery of due) {
            if (delivery.subscriptionGroup !== NOTIFY_GROUP) continue // only OUR group's deliveries.
            const event = yield* bus.getByID(delivery.eventID)
            if (!event) {
              log.warn("retry: event missing for pending notify delivery", { eventID: delivery.eventID })
              continue
            }
            yield* handle(event) // re-runs the full ack/nack cycle (idempotent via AgentPush key).
            redriven++
          }
          return redriven
        })

      if (runLoop) {
        yield* bus.registerConsumerGroup(NOTIFY_GROUP)
        const ready = yield* Deferred.make<void>()
        yield* bus
          .subscribe({ group: NOTIFY_GROUP })
          .pipe(
            Stream.onStart(Deferred.succeed(ready, undefined)),
            Stream.runForEach((event) =>
              handle(event).pipe(
                Effect.asVoid,
                Effect.catchCause((cause) =>
                  Effect.sync(() => log.error("supervisor notify handle failed", { cause: Cause.pretty(cause) })),
                ),
              ),
            ),
            Effect.forkScoped,
          )
        yield* Deferred.await(ready)

        yield* pumpRetries()
          .pipe(
            Effect.catchCause((cause) =>
              Effect.sync(() => log.error("supervisor notify retry pump failed", { cause: Cause.pretty(cause) })).pipe(
                Effect.as(0),
              ),
            ),
            Effect.repeat(Schedule.spaced(Duration.millis(retryPumpIntervalMs))),
            Effect.forkScoped,
          )
      }

      return Service.of({ handle, pumpRetries })
    }),
  )

export const layer = layerWith()
