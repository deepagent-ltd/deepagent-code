export * as PanelConveneConsumer from "./panel-convene-consumer"

import { Context, Deferred, Effect, Layer, Stream, Schedule, Duration, Cause } from "effect"
import { DeepAgentEventBus } from "@deepagent-code/core/deepagent/deepagent-event-bus"
import { DeepAgentEvent } from "@deepagent-code/core/deepagent/deepagent-event"
import { LMNEvents } from "@deepagent-code/core/deepagent/lmn-events"
import { PanelConvenePolicy } from "@deepagent-code/core/deepagent/panel-convene-policy"
import { ApprovalQueue } from "@deepagent-code/core/deepagent/approval-queue"
import { RuntimeFlags } from "@/effect/runtime-flags"
import type { PanelVerdict } from "@/agent/schema/panel"
import * as Log from "@deepagent-code/core/util/log"

// V4.0 §M — the Expert Panel AUTO-CONVENE consumer. V3.9 convened a panel only from an explicit
// in-session Convener call (still intact — see panel/consult.ts). V4.0's §M moves the TRIGGER to the
// Event Bus: this service subscribes to the bus, runs the PURE `PanelConvenePolicy.shouldConvene` gate
// on each event, and — on "convene" — drives the EXISTING V3.9 panel engine (via an INJECTED
// PanelConvenePort so this module never creates sessions itself), publishes the resulting
// `panel.verdict` back onto the bus, and offers it to the §D2 Approval Queue (which folds the
// needs_human gate). It adds NO panel mechanics — the Arbiter, isolation, and fail-closed semantics all
// stay V3.9; this is purely the bus→panel bridge.
//
// DELIVERY DISCHARGE (§A3 at-least-once): this is a grouped ("panel-convener") subscriber, so `publish`
// records a durable `pending` delivery row for every event owed to the group. Each delivery MUST be
// acked or nacked — an unresolved pending row leaks and breaks at-least-once. Every terminal path here
// acks; only a transient panel failure nacks (so the retry pump re-drives it).
//
// IDEMPOTENCY: two layers guard against double-convening on re-delivery (retry pump / crash recovery):
//   1. Before convening, we check the durable log for an already-published `panel.verdict` whose
//      causationID is THIS event's id (a started-guard, mirroring MultiAgentRuntime's
//      `agent.task.started` check). If one exists, the panel already ran → ack, don't re-convene.
//   2. Belt-and-suspenders: the published verdict carries a deterministic idempotencyKey
//      `panel:<event.id>`, so even a racing re-publish is a bus-level no-op (never a second verdict,
//      never a second Approval-Queue enqueue via UNIQUE(event_id)).
//
// LAYERING: `deepagent-code`. Bridges the bus + policy (core) to the panel engine (deepagent-code).

const log = Log.create({ service: "panel-convene-consumer" })

export const CONVENE_GROUP = "panel-convener"
// §A3 retry-pump cadence for this consumer group (mirrors EventDispatcher / EventDrivenArchiver).
export const DEFAULT_RETRY_PUMP_INTERVAL_MS = 30_000

// The §M coordination events originate from the runtime, not a human/external source.
const CONVENE_SOURCE: DeepAgentEvent.EventSource = "system"

/** The input handed to the injected panel port when the policy decides to auto-convene. */
export interface PanelConveneInput {
  /** The frozen, human-readable question built from the triggering event + risk class. */
  readonly question: string
  /** The risk class the §M policy assigned (drives the quorum policy the port may pick). */
  readonly riskClass: PanelConvenePolicy.RiskClass
  /** The triggering event (the port can mine payload/workspace/correlation for context). */
  readonly event: DeepAgentEvent.Event
}

/**
 * Port: run an Expert Panel for a frozen question and return its deterministic `PanelVerdict`.
 *
 * Production wires this to `consultPanel` (panel/consult.ts) built from a `makeTaskSubagentRunner`
 * turn runner — i.e. the SAME child-session + permission-derivation path the HTTP panelConsult handler
 * uses (see server/.../handlers/deepagent.ts `panelTurnRunnerFor`). Tests inject a deterministic stub.
 *
 * The consumer NEVER creates sessions itself (exactly like MultiAgentRuntime takes an injected
 * `runner`): all session mechanics live behind this port. The Effect MAY fail — a failed panel run is
 * transient, so the consumer nacks it for retry rather than publishing a bogus verdict.
 */
export type PanelConvenePort = (input: PanelConveneInput) => Effect.Effect<PanelVerdict, unknown>

export interface Interface {
  /**
   * Handle ONE bus event and DISCHARGE its delivery. Flag off → ack + skip. Policy "skip" → ack.
   * Policy "convene" → (idempotency guard) run the panel via the injected port, publish a
   * `panel.verdict`, offer it to the Approval Queue, then ack. A panel-port failure → nack (transient).
   * Returns the published verdict's decision, or null when nothing was convened. Exposed for
   * deterministic testing; the background subscription calls it.
   */
  readonly handle: (event: DeepAgentEvent.Event) => Effect.Effect<PanelVerdict["decision"] | null>
  /**
   * §A3 retry pump for THIS group ("panel-convener"). Re-drives pending deliveries whose backoff has
   * elapsed (a panel that failed or a crash-orphaned delivery), reloading the event and re-running
   * handle (idempotent via the started-guard + idempotencyKey). Without it a grouped subscriber's
   * pending rows never discharge. Exposed for testing; the background loop calls it on a cadence.
   */
  readonly pumpRetries: (now?: number) => Effect.Effect<number>
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/PanelConveneConsumer") {}

export interface LayerOptions {
  /**
   * The panel port (production: `consultPanel` over a `makeTaskSubagentRunner` turn runner). Injected
   * so tests supply a fake and production supplies the real session-driven one — the consumer never
   * hardcodes session creation. REQUIRED.
   */
  readonly convene: PanelConvenePort
  /** Optional risk rules override for the pure policy; defaults to `PanelConvenePolicy.DEFAULT_RULES`. */
  readonly rules?: ReadonlyArray<PanelConvenePolicy.RiskRule>
  /**
   * Start the background bus subscription + retry pump as scoped daemons. Default true; tests set false
   * and call handle()/pumpRetries() directly for determinism.
   */
  readonly runLoop?: boolean
  readonly retryPumpIntervalMs?: number
  readonly now?: () => number
}

// A readable, FROZEN question for the panel, derived from the event type + risk class + any salient
// payload fields. The panel grounds its findings in this string (auto-convened panels have no code
// refs by default — the risk is described, not diffed).
const buildQuestion = (event: DeepAgentEvent.Event, riskClass: PanelConvenePolicy.RiskClass): string => {
  const p = (event.payload ?? {}) as Record<string, unknown>
  const detail =
    typeof p.summary === "string" && p.summary.length > 0
      ? `: ${p.summary}`
      : typeof p.title === "string" && p.title.length > 0
        ? `: ${p.title}`
        : ""
  return (
    `Auto-convened Expert Panel (${riskClass}) triggered by ${event.type} event ${event.id}${detail}. ` +
    `Independently assess the risk and recommend approve / revise / block, escalating to needs_human when uncertain.`
  )
}

export const layerWith = (options: LayerOptions) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const bus = yield* DeepAgentEventBus.Service
      const queue = yield* ApprovalQueue.Service
      const flags = yield* RuntimeFlags.Service
      const convene = options.convene
      const rules = options.rules
      const runLoop = options.runLoop ?? true
      const retryPumpIntervalMs = options.retryPumpIntervalMs ?? DEFAULT_RETRY_PUMP_INTERVAL_MS

      const ack = (event: DeepAgentEvent.Event) => bus.ack(CONVENE_GROUP, event.id)

      // idempotency started-guard: has a panel.verdict already been published FOR this event? A verdict
      // published by a prior (retried) handle carries causationID = event.id, so a durable-log scan for
      // that pins a completed convene. Uses recentByType with a max window scoped to the workspace
      // (mirrors MultiAgentRuntime's agent.task.started guard). A lookup FAILURE is treated as "not yet"
      // (re-convene is safe — the publish idempotencyKey still dedupes the verdict itself).
      const alreadyConvened = (event: DeepAgentEvent.Event) =>
        bus
          .recentByType({
            type: LMNEvents.PANEL_VERDICT,
            workspaceID: event.workspaceID,
            windowMs: Number.MAX_SAFE_INTEGER,
            now: event.createdAt,
          })
          .pipe(
            Effect.map((events) => events.some((e) => e.causationID === event.id)),
            Effect.orElseSucceed(() => false),
          )

      const handle: Interface["handle"] = (event) =>
        Effect.gen(function* () {
          // §M fail-closed: the flag is the kill-switch. Off ⇒ never auto-summon. This group receives
          // ALL events (wildcard subscribe), so a skipped event MUST still be acked (discharge it).
          if (!flags.v4PanelAutoConvene) {
            yield* ack(event)
            return null
          }

          const decision = PanelConvenePolicy.shouldConvene({
            event,
            flagEnabled: true,
            ...(rules ? { rules } : {}),
          })
          if (decision.type === "skip") {
            yield* ack(event) // not a convene-worthy event — terminal, discharge it.
            return null
          }

          // idempotency: a prior handle already convened + published for this event ⇒ don't re-run.
          if (yield* alreadyConvened(event)) {
            log.info("panel already convened for event; skipping re-convene", { eventID: event.id })
            yield* ack(event)
            return null
          }

          const question = buildQuestion(event, decision.riskClass)

          // run the panel via the INJECTED port. A failure is transient (session/turn error) ⇒ nack so
          // the pump retries; we do NOT publish a verdict on failure (never fabricate an outcome).
          const outcome = yield* convene({ question, riskClass: decision.riskClass, event }).pipe(
            Effect.map((verdict) => ({ ok: true as const, verdict })),
            Effect.catchCause((cause) => Effect.succeed({ ok: false as const, cause })),
          )
          if (!outcome.ok) {
            log.error("panel convene failed; nacking for retry", {
              eventID: event.id,
              cause: Cause.pretty(outcome.cause),
            })
            yield* bus.nack({ subscriptionGroup: CONVENE_GROUP, eventID: event.id, reason: "panel convene failed" })
            return null
          }

          const verdict = outcome.verdict
          // publish panel.verdict — chained to the trigger (correlation/causation) + deterministic
          // idempotencyKey so a re-delivery is a bus-level no-op. The payload carries the needs_human
          // discriminator ApprovalQueue.shouldQueueForApproval folds, plus a verdict summary.
          const verdictEvent = yield* bus.publish({
            type: LMNEvents.PANEL_VERDICT,
            source: CONVENE_SOURCE,
            workspaceID: event.workspaceID,
            ...(event.projectID != null ? { projectID: event.projectID } : {}),
            correlationID: event.correlationID ?? event.id,
            causationID: event.id,
            idempotencyKey: `panel:${event.id}`,
            priority: decision.urgency,
            payload: {
              decision: verdict.decision,
              question,
              riskClass: decision.riskClass,
              confidence: verdict.confidence,
              rounds: verdict.rounds,
              dissentCount: verdict.dissent.length,
              evidence: [...verdict.evidence],
            },
          })

          // §D2: offer the verdict to the Approval Queue. `offer` folds shouldQueueForApproval, so a
          // needs_human verdict lands as a pending item and an autonomously-resolved verdict is a no-op.
          yield* queue.offer(verdictEvent).pipe(
            Effect.catchCause((cause) =>
              Effect.sync(() => log.error("approval-queue offer failed", { cause: Cause.pretty(cause) })),
            ),
          )

          yield* ack(event) // success — the trigger is fully handled.
          log.info("auto-convened panel verdict published", {
            eventID: event.id,
            decision: verdict.decision,
            riskClass: decision.riskClass,
          })
          return verdict.decision
        })

      const pumpRetries: Interface["pumpRetries"] = (now) =>
        Effect.gen(function* () {
          const due = yield* bus.dueRetries(now)
          let redriven = 0
          for (const delivery of due) {
            if (delivery.subscriptionGroup !== CONVENE_GROUP) continue // only OUR group's deliveries.
            const event = yield* bus.getByID(delivery.eventID)
            if (!event) {
              log.warn("retry: event missing for pending convene delivery", { eventID: delivery.eventID })
              continue
            }
            yield* handle(event) // re-runs the full ack/nack cycle (idempotent via started-guard).
            redriven++
          }
          return redriven
        })

      if (runLoop) {
        yield* bus.registerConsumerGroup(CONVENE_GROUP)
        const ready = yield* Deferred.make<void>()
        yield* bus
          .subscribe({ group: CONVENE_GROUP })
          .pipe(
            Stream.onStart(Deferred.succeed(ready, undefined)),
            Stream.runForEach((event) =>
              handle(event).pipe(
                Effect.catchCause((cause) =>
                  Effect.sync(() => log.error("panel convene handle failed", { cause: Cause.pretty(cause) })),
                ),
                Effect.asVoid,
              ),
            ),
            Effect.forkScoped,
          )
        yield* Deferred.await(ready)

        yield* pumpRetries()
          .pipe(
            Effect.catchCause((cause) =>
              Effect.sync(() => log.error("panel convene retry pump failed", { cause: Cause.pretty(cause) })).pipe(
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
