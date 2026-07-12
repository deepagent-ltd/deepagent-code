export * as EventDispatcher from "./event-dispatcher"

import { Context, Effect, Layer, Stream, Schedule, Duration, Cause, Deferred, Option } from "effect"
import { DeepAgentEventBus } from "@deepagent-code/core/deepagent/deepagent-event-bus"
import { EventRouter } from "@deepagent-code/core/deepagent/event-router"
import { Scheduler } from "@deepagent-code/core/deepagent/scheduler"
import { DeepAgentEvent } from "@deepagent-code/core/deepagent/deepagent-event"
import { QuietHours } from "@deepagent-code/core/deepagent/quiet-hours"
import { WorkspaceConfig } from "@deepagent-code/core/deepagent/workspace-config"
import type { AgentDescriptor } from "@deepagent-code/core/im/mention-parser"
import { AgentListProviderService } from "@deepagent-code/core/im/agent-list-provider"
import { RuntimeFlags } from "@/effect/runtime-flags"
import * as Log from "@deepagent-code/core/util/log"

// V4.0 §A4 — the Event Router + Scheduler RUNTIME WIRING (Wave 2b). This is the deepagent-code half
// that core (event-router.ts / scheduler.ts) deliberately cannot be: it reads feature flags, resolves
// the permission-filtered agent registry, drives the bus subscription, and runs the scheduler tick
// loop. The pure decision (route) and durable state (schedule rows) stay in core; this module is the
// only place the two touch RuntimeFlags, the agent registry, and — via an injected DispatchPort — the
// session runtime.
//
// DISPATCH BOUNDARY: this service does NOT itself drive a session. When `route` returns `dispatch` it
// hands the (event, targets, priority) to a `DispatchPort`. The real port — which starts/queues an
// agent turn per target — is assembled by the Multi-Agent Runtime (Wave 3). Until then the default
// port is observe-only (logs the decision), so turning the flags on before Wave 3 lands can route +
// trace WITHOUT actually executing an agent. This mirrors goal-loop-wiring's StepExecutor port.

const log = Log.create({ service: "event-dispatcher" })

// The subscription group this dispatcher consumes under (§A3 at-least-once: publish records a durable
// pending delivery for this group, so a crash mid-dispatch is recoverable via the bus retry scan).
export const DISPATCH_GROUP = "router"

// §A4 回压 default queue ceiling. Lenient per the standing "don't over-restrict rate/length" constraint
// — high/critical always bypass it. Overridable via layer options.
export const DEFAULT_MAX_QUEUE_DEPTH = 1000
// §A4 去重窗口 — how far back recentByType looks for the low-priority dedupe merge.
export const DEFAULT_DEDUPE_WINDOW_MS = 10_000
// scheduler tick cadence.
export const DEFAULT_TICK_INTERVAL_MS = 1000
// §A3 retry-pump cadence — how often nacked/orphaned deliveries whose backoff elapsed are re-driven.
export const DEFAULT_RETRY_PUMP_INTERVAL_MS = 5000

// What the router decided to dispatch — handed to the DispatchPort.
export interface DispatchRequest {
  readonly event: DeepAgentEvent.Event
  readonly priority: DeepAgentEvent.EventPriority
  readonly targets: ReadonlyArray<AgentDescriptor>
}

// The seam to the session runtime. Implementations start/queue an agent turn per target. Returning
// normally = the dispatch was accepted (the dispatcher then acks the bus delivery); throwing/failing =
// the dispatcher nacks so the bus schedules a retry.
export interface DispatchPort {
  // May fail: a failed dispatch causes the dispatcher to nack (§A3 retry). The error type is `unknown`
  // so implementations aren't forced into a single error channel — `handle` catches the whole cause.
  readonly dispatch: (request: DispatchRequest) => Effect.Effect<void, unknown>
}

// Observe-only default: log the routing decision, accept the delivery. Used until Wave 3 provides a
// session-driving port. Safe to enable the flags with this in place — routes + traces, never executes.
export const observeOnlyDispatchPort: DispatchPort = {
  dispatch: (request) =>
    Effect.sync(() =>
      log.info("route.dispatch (observe-only)", {
        eventType: request.event.type,
        eventID: request.event.id,
        priority: request.priority,
        targets: request.targets.map((t) => t.id).join(","),
      }),
    ),
}

// Map an event type to the feature flag that gates its dispatch path (fail-closed: flag OFF ⇒ dropped).
//   im.*            → v4EventDrivenIm     (route IM messages through the bus vs the legacy sync path)
//   agent.push.*    → v4AgentPushEnabled  (proactive agent-initiated push)
//   everything else → v4MultiAgentRuntime (git/ci/pr/monitor/schedule are the multi-agent domain)
export const flagForEventType = (flags: RuntimeFlags.Info, eventType: string): boolean => {
  if (eventType.startsWith("im.")) return flags.v4EventDrivenIm
  if (eventType.startsWith("agent.push")) return flags.v4AgentPushEnabled
  return flags.v4MultiAgentRuntime
}

// The principal used to scope the agent-registry lookup. Actor-originated events use the actor; events
// with no human actor (git/ci/monitor/schedule/system) resolve against the SYSTEM principal, which a
// permission-aware provider scopes to workspace-visible agents only (never a superuser catch-all).
export const SYSTEM_PRINCIPAL = "system"
export const actorPrincipal = (event: DeepAgentEvent.Event): string => event.actorID ?? SYSTEM_PRINCIPAL

export interface Interface {
  /** The subscription group this dispatcher consumes under. */
  readonly group: string
  /**
   * Handle ONE event end-to-end: resolve the flag gate + permission-filtered agents + recent same-type
   * events, run the pure router, and on `dispatch` hand off to the DispatchPort then ack; on `dropped`
   * ack (the event is durably logged for the trace regardless). Exposed for deterministic testing; the
   * background subscription calls this per event.
   */
  readonly handle: (event: DeepAgentEvent.Event) => Effect.Effect<EventRouter.RouteDecision>
  /**
   * Run ONE scheduler tick: fetch due schedules, publish each one's templated event through the bus,
   * and advance its state (markFired). Returns the number of schedules fired. Exposed for testing; the
   * background loop calls this on a cadence.
   */
  readonly tick: (now?: number) => Effect.Effect<number>
  /**
   * §A3 retry pump — one pass: fetch deliveries whose backoff has elapsed (`bus.dueRetries`), reload
   * each event from the durable log, and re-run `handle` (which re-acks on success / re-nacks with a
   * longer backoff / lands in the DLQ past the cap). This is what makes at-least-once real: the live
   * PubSub replays nothing, so a nacked or crash-orphaned delivery is ONLY recovered here. Returns the
   * number re-driven. Exposed for testing; the background loop calls it on a cadence.
   */
  readonly pumpRetries: (now?: number) => Effect.Effect<number>
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/EventDispatcher") {}

export interface LayerOptions {
  readonly dispatchPort?: DispatchPort
  readonly maxQueueDepth?: number
  readonly dedupeWindowMs?: number
  readonly tickIntervalMs?: number
  readonly retryPumpIntervalMs?: number
  // live dispatch-queue depth for §A4 回压 admission (Wave 3 supplies it; defaults to 0 = inert).
  readonly queueDepth?: () => number
  readonly now?: () => number
  // start the background subscription + tick + retry-pump loops as scoped daemon fibers. Default true;
  // tests set false and call handle()/tick()/pumpRetries() directly for determinism.
  readonly runLoops?: boolean
}

export const layerWith = (options?: LayerOptions) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const bus = yield* DeepAgentEventBus.Service
      const scheduler = yield* Scheduler.Service
      const agentList = yield* AgentListProviderService
      const flags = yield* RuntimeFlags.Service
      // §E4/§N — quiet-hours filter for the scheduler tick. WorkspaceConfig is OPTIONAL (mirrors
      // agent-push): absent ⇒ never quiet (the correct fail-safe), so the dispatcher stays testable with
      // just Bus + Scheduler + AgentList + Flags. When present, a CONFIGURED window defers a low/normal
      // scheduled fire past the window; high/critical always fire (§E4 允许即时送达).
      const workspaceConfig = yield* Effect.serviceOption(WorkspaceConfig.Service)
      const port = options?.dispatchPort ?? observeOnlyDispatchPort
      const maxQueueDepth = options?.maxQueueDepth ?? DEFAULT_MAX_QUEUE_DEPTH
      const dedupeWindowMs = options?.dedupeWindowMs ?? DEFAULT_DEDUPE_WINDOW_MS
      const tickIntervalMs = options?.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS
      const now = options?.now ?? Date.now
      const runLoops = options?.runLoops ?? true
      const retryPumpIntervalMs = options?.retryPumpIntervalMs ?? DEFAULT_RETRY_PUMP_INTERVAL_MS
      // §A4 回压 — the live queue depth is a signal the SESSION RUNTIME owns (its dispatch backlog), not
      // something this wiring can observe from the durable bus. Wave 3 supplies it via `queueDepth`;
      // until then it defaults to 0, so backpressure is WIRED (route gets the value, a backpressure drop
      // correctly nacks — see handle) but INERT (never trips) — matching the observe-only default.
      const queueDepth = options?.queueDepth ?? (() => 0)

      const nack = (event: DeepAgentEvent.Event, reason: string) =>
        bus.nack({ subscriptionGroup: DISPATCH_GROUP, eventID: event.id, reason })

      // §E4/§N — resolve whether `at` falls in the workspace's configured quiet window + the window's END
      // (epoch ms) so a deferred tick can be rescheduled PAST the window. Returns { quiet:false } when no
      // config service, no configured window, or a lookup fails (fail-safe: never quiet ⇒ fire normally).
      // `endAt`: the next instant at/after `at` where the local hour leaves [startHour,endHour) — computed
      // arithmetically from the same tz math QuietHours.isWithinQuietHours uses, so the two never disagree.
      const resolveQuietHours = (
        workspaceID: string,
        at: number,
      ): Effect.Effect<{ readonly quiet: boolean; readonly endAt?: number }> =>
        Option.isNone(workspaceConfig)
          ? Effect.succeed({ quiet: false })
          : workspaceConfig.value.get(workspaceID).pipe(
              Effect.map((resolved) => {
                const qh = resolved.quietHours
                if (qh == null) return { quiet: false as const }
                if (!QuietHours.isWithinQuietHours(at, qh.startHour, qh.endHour, qh.tzOffsetMinutes))
                  return { quiet: false as const }
                // Walk forward hour-by-hour to the first instant NOT in the window (bounded: ≤ 24 steps
                // since the window is < 24h). Align to the next whole local-hour boundary first so the
                // reschedule lands cleanly on the window's end rather than mid-hour.
                const hourMs = 3_600_000
                const localMs = at + qh.tzOffsetMinutes * 60_000
                let boundary = Math.ceil(localMs / hourMs) * hourMs // next local-hour boundary (local ms)
                for (let i = 0; i < 25; i++) {
                  const hour = ((Math.floor(boundary / hourMs) % 24) + 24) % 24
                  const inWindow =
                    qh.startHour < qh.endHour
                      ? hour >= qh.startHour && hour < qh.endHour
                      : hour >= qh.startHour || hour < qh.endHour
                  if (!inWindow) break
                  boundary += hourMs
                }
                // convert the local-ms boundary back to epoch ms.
                return { quiet: true as const, endAt: boundary - qh.tzOffsetMinutes * 60_000 }
              }),
              Effect.orElseSucceed(() => ({ quiet: false as const })),
            )

      const handle: Interface["handle"] = (event) =>
        Effect.gen(function* () {
          const flagEnabled = flagForEventType(flags, event.type)

          // resolve candidate agents (permission scoping is the provider's job — the router matches
          // triggers within whatever set it returns). Skip the lookup entirely when the flag is off.
          let agents: ReadonlyArray<AgentDescriptor> = []
          let recentSameType: ReadonlyArray<DeepAgentEvent.Event> = []
          if (flagEnabled) {
            // A provider ERROR is transient (DB down) and must NOT be silently treated as "no agents"
            // (which would drop+ack the event forever). Catch it, nack for retry, and stop here.
            const agentsExit = yield* agentList
              .listAgents({ workspaceID: event.workspaceID, userID: actorPrincipal(event) })
              .pipe(Effect.exit)
            if (agentsExit._tag === "Failure") {
              log.error("agent registry lookup failed; nacking for retry", {
                eventID: event.id,
                cause: Cause.pretty(agentsExit.cause),
              })
              yield* nack(event, "agent registry lookup failed")
              return { type: "dropped", reason: "no_match" } as EventRouter.RouteDecision
            }
            agents = agentsExit.value
            // §A4 去重窗口 — scoped to this event's workspace (never cross-tenant). Anchor the window on
            // the event's own createdAt (not handle-time now()) so delivery lag can't skew the merge.
            recentSameType = yield* bus.recentByType({
              type: event.type,
              workspaceID: event.workspaceID,
              windowMs: dedupeWindowMs,
              now: event.createdAt,
            })
          }

          const decision = EventRouter.route({
            event,
            agents,
            flagEnabled,
            queueDepth: queueDepth(),
            maxQueueDepth,
            recentSameType,
          })

          if (decision.type === "dispatch") {
            // hand to the runtime; on failure nack so the bus retries (§A3), on success ack.
            const outcome = yield* port.dispatch({ event, priority: decision.priority, targets: decision.targets }).pipe(
              Effect.as("ok" as const),
              Effect.catchCause((cause) => {
                log.error("dispatch failed; nacking for retry", {
                  eventID: event.id,
                  cause: Cause.pretty(cause),
                })
                return Effect.succeed("fail" as const)
              }),
            )
            if (outcome === "ok") yield* bus.ack(DISPATCH_GROUP, event.id)
            else yield* nack(event, "dispatch port failed")
          } else if (decision.reason === "backpressure") {
            // §A4 回压: a backpressure drop is TRANSIENT — the queue is momentarily full. NACK so the
            // bus retries when it drains, rather than acking (which would permanently lose the event).
            // Record it as a PERSISTED §A4 event_dropped signal (by reason) so Oversight can report the
            // shed rate, not just a log line. Best-effort (recordDrop never fails) — ordered before the
            // nack so a shed is always counted even if the nack write later hiccups.
            log.info("route.backpressure; nacking for retry", { eventType: event.type, eventID: event.id })
            yield* bus.recordDrop({ event, reason: decision.reason })
            yield* nack(event, "backpressure")
          } else {
            // terminal drop (flag_disabled / no_match / deduped) — ack the delivery (the durable event
            // log keeps it for the §F2 trace) and record WHY as an observability signal (§A4 event_dropped).
            log.info("route.dropped", { eventType: event.type, eventID: event.id, reason: decision.reason })
            yield* bus.ack(DISPATCH_GROUP, event.id)
          }

          return decision
        })

      const fireSchedule = (schedule: Scheduler.Schedule, at: number) =>
        Effect.gen(function* () {
          const template = schedule.eventTemplate
          // Idempotency key anchored on the STABLE logical fire time, not the tick's wall clock: if a
          // tick publishes but crashes before markFired, the next tick re-fires the SAME logical fire
          // and the bus dedupes on this key (no duplicate event). For a cadence-less condition (null
          // fireAt) there is no stable logical time, so fall back to the tick's `at` — every-tick
          // evaluation genuinely wants a distinct fire per tick.
          const logical = schedule.fireAt ?? at
          const idempotencyKey = `sched:${schedule.id}:${logical}`
          yield* bus
            .publish({ ...template, idempotencyKey })
            .pipe(
              Effect.catchCause((cause) =>
                Effect.sync(() =>
                  log.error("schedule publish failed", { scheduleID: schedule.id, cause: Cause.pretty(cause) }),
                ),
              ),
            )
          yield* scheduler.markFired(schedule.id, at)
        })

      // §E4/§N — fire a due schedule UNLESS it is a side-effecting low/normal fire during the workspace's
      // quiet hours, in which case DEFER it past the window (reschedule fire_at = the window end via
      // recheckCondition — works for every kind: it pushes the next eligibility without marking fired).
      // high/critical schedules ALWAYS fire (§E4 允许即时送达). Returns whether it actually fired.
      const fireOrDefer = (schedule: Scheduler.Schedule, at: number): Effect.Effect<boolean> =>
        Effect.gen(function* () {
          const priority = schedule.eventTemplate.priority ?? "normal"
          if (priority !== "high" && priority !== "critical") {
            const qh = yield* resolveQuietHours(schedule.workspaceID, at)
            if (qh.quiet) {
              // defer to the window end (fail-safe: if endAt is somehow ≤ now, nudge by 1ms so it's future).
              const nextAt = qh.endAt != null && qh.endAt > at ? qh.endAt : at + 1
              log.info("schedule deferred by quiet hours", {
                scheduleID: schedule.id,
                workspaceID: schedule.workspaceID,
                deferUntil: nextAt,
              })
              yield* scheduler.recheckCondition(schedule.id, nextAt)
              return false
            }
          }
          yield* fireSchedule(schedule, at)
          return true
        })

      const tick: Interface["tick"] = (nowArg) =>
        Effect.gen(function* () {
          const at = nowArg ?? now()
          const due = yield* scheduler.due(at)
          let fired = 0
          for (const schedule of due) {
            if (schedule.kind === "condition" && schedule.condition) {
              // §A4 条件触发: fire ONLY when the threshold of trigger events is met in the window; else
              // reschedule the next re-check WITHOUT publishing (and without leaving it hot-looping).
              const spec = schedule.condition
              // §A4 跨 workspace 计数: a crossWorkspace condition (e.g. the SYSTEM-level "3× CI failure →
              // repair" trigger) counts trigger events across ALL workspaces — so it observes CI failures
              // that land in per-project workspaces, not just its own. recentByType omits the workspaceID
              // filter when it's undefined (bus counts cross-tenant). Non-crossWorkspace conditions keep
              // the historical per-workspace scoping (pass the schedule's own workspaceID).
              const recent = yield* bus.recentByType({
                type: spec.eventType,
                ...(spec.crossWorkspace ? {} : { workspaceID: schedule.workspaceID }),
                windowMs: spec.windowMs,
                now: at,
              })
              if (Scheduler.conditionMet(spec, recent.length)) {
                // §E4 — fireOrDefer holds the fire for quiet hours (low/normal) and reschedules it past
                // the window; a deferred fire already advanced fire_at, so skip the recheck below.
                const didFire = yield* fireOrDefer(schedule, at)
                if (didFire) {
                  // advance the recheck so a still-satisfied window doesn't refire next tick (markFired
                  // already advanced fireAt when a cadence exists; for cadence-less, push it forward here).
                  if (schedule.intervalMs == null)
                    yield* scheduler.recheckCondition(schedule.id, at + (spec.windowMs || 1))
                  fired++
                }
              } else {
                const nextCheck = at + (schedule.intervalMs ?? (spec.windowMs || 1))
                yield* scheduler.recheckCondition(schedule.id, nextCheck)
              }
              continue
            }
            if (yield* fireOrDefer(schedule, at)) fired++
          }
          return fired
        })

      const pumpRetries: Interface["pumpRetries"] = (nowArg) =>
        Effect.gen(function* () {
          const at = nowArg ?? now()
          const due = yield* bus.dueRetries(at)
          let redriven = 0
          for (const delivery of due) {
            // only our own group's deliveries — dueRetries is global across groups.
            if (delivery.subscriptionGroup !== DISPATCH_GROUP) continue
            const event = yield* bus.getByID(delivery.eventID)
            if (!event) {
              // event row gone (retention sweep?) — the delivery is unrecoverable; leave it for the DLQ.
              log.warn("retry: event missing for pending delivery", { eventID: delivery.eventID })
              continue
            }
            yield* handle(event) // re-runs the full route → ack/nack cycle (nack extends backoff → DLQ)
            redriven++
          }
          return redriven
        })

      // Background daemons (scoped to the layer). A failure in a single event/tick/pump pass is logged
      // and swallowed so a loop never dies on one bad item. `ready` gates the layer's completion on the
      // subscribe stream actually registering the consumer group, so no event published immediately
      // after the layer builds can slip through the startup window unrecorded (#2).
      if (runLoops) {
        const ready = yield* Deferred.make<void>()
        yield* bus
          .subscribe({ group: DISPATCH_GROUP })
          .pipe(
            Stream.onStart(Deferred.succeed(ready, undefined)),
            Stream.runForEach((event) =>
              handle(event).pipe(
                Effect.catchCause((cause) =>
                  Effect.sync(() => log.error("event handle failed", { cause: Cause.pretty(cause) })),
                ),
                Effect.asVoid,
              ),
            ),
            Effect.forkScoped,
          )
        // wait until the group is registered before the layer is considered ready.
        yield* Deferred.await(ready)

        yield* tick()
          .pipe(
            Effect.catchCause((cause) =>
              Effect.sync(() => log.error("scheduler tick failed", { cause: Cause.pretty(cause) })).pipe(Effect.as(0)),
            ),
            Effect.repeat(Schedule.spaced(Duration.millis(tickIntervalMs))),
            Effect.forkScoped,
          )

        yield* pumpRetries()
          .pipe(
            Effect.catchCause((cause) =>
              Effect.sync(() => log.error("retry pump failed", { cause: Cause.pretty(cause) })).pipe(Effect.as(0)),
            ),
            Effect.repeat(Schedule.spaced(Duration.millis(retryPumpIntervalMs))),
            Effect.forkScoped,
          )
      }

      return Service.of({ group: DISPATCH_GROUP, handle, tick, pumpRetries })
    }),
  )

export const layer = layerWith()
