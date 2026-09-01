export * as EventDispatcher from "./event-dispatcher"

import { Context, Effect, Layer, Stream, Schedule, Duration, Cause, Deferred, Option } from "effect"
import { DeepAgentEventBus } from "@deepagent-code/core/deepagent/deepagent-event-bus"
import { EventRouter } from "@deepagent-code/core/deepagent/event-router"
import { Scheduler } from "@deepagent-code/core/deepagent/scheduler"
import { DeepAgentEvent } from "@deepagent-code/core/deepagent/deepagent-event"
import { LMNEvents } from "@deepagent-code/core/deepagent/lmn-events"
import { QuietHours } from "@deepagent-code/core/deepagent/quiet-hours"
import { WorkspaceConfig } from "@deepagent-code/core/deepagent/workspace-config"
import type { AgentDescriptor } from "@deepagent-code/core/im/mention-parser"
import { AgentListProviderService } from "@deepagent-code/core/im/agent-list-provider"
import { IMRepository } from "@deepagent-code/core/im/repository"
import type { IMRepositoryInterface } from "@deepagent-code/core/im/repository"
import { IMBroadcasterService } from "@deepagent-code/core/im/broadcaster"
import { isEventV2AdmissionEnabled } from "@deepagent-code/core/deepagent/event-admission"
import { declaresMentionTrigger, MENTION_TRIGGER } from "@/agent/agent"
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

/** The decision `handle` returns: the pure router's decision for event-triggered routing, or `receipted`
 * for a W0.4 mention that produced a `agent_no_trigger_mention` receipt instead of a silent `no_match`
 * drop. `receipted` is terminal and acked like `dispatch`. */
export type HandleDecision =
  | EventRouter.RouteDecision
  | { readonly type: "receipted"; readonly reason: MentionReceiptReason }

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

// ---------------------------------------------------------------------------
// W0.4 — @mention 路由修复与默认统一 (design v2.0-design.md W0.4).
//
// The IM @mention flow (CLI event-V2 admission ON) publishes `im.message.created` onto the bus; the
// router previously matched agents by their `triggers[].event` against that type and — since no agent
// declares an IM trigger by default — terminal-dropped the mention with `no_match`: no execution, no
// receipt, a silent loss for the user. The fix routes mentions by NAME (the @mentioned agent is the
// authorization target, mirroring the legacy agent-orchestrator resolution) and only dispatches when
// the mentioned agent declares the mention trigger (default `["mention"]` — see
// `Agent.declaresMentionTrigger`). Anything else writes a durable `agent_no_trigger_mention` receipt
// into the initiating conversation and logs `mention_no_trigger_receipt` — the `no_match` silent-drop
// path is never taken for a mention event.
// ---------------------------------------------------------------------------

/** W0.4 — the durable mention-routing receipt message type (IM message `metadata.type` discriminant). */
export const AGENT_NO_TRIGGER_MENTION = "agent_no_trigger_mention"

/** W0.4 — why a mention was receipted instead of dispatched. `agent_no_trigger_mention` = the mentioned
 * agent resolved but did not declare the mention trigger; `no_declared_trigger` = no agent at all was
 * mentionable (unknown names / no declarer). Both write a `AGENT_NO_TRIGGER_MENTION` message. */
export type MentionReceiptReason = "agent_no_trigger_mention" | "no_declared_trigger"

/** W0.4 — the durable mention-routing receipt payload (written into the initiating IM conversation /
 * session; the receipt carries the mentioned agent id when the name resolved to a registered agent). */
export interface MentionReceiptInput {
  readonly eventID: string
  /** The IM group (initiating conversation) — absent when the payload carries no group. */
  readonly groupID: string | undefined
  /** The initiating IM message id. */
  readonly messageID: string | undefined
  /** The mentioned agent id; absent only for the generic no-declarer receipt. */
  readonly agentID: string | undefined
  readonly agentNames: ReadonlyArray<string>
  readonly reason: MentionReceiptReason
}

/** W0.4 — the receipt seam (mirrors `DispatchPort`): implementations write the user-visible durable
 * receipt. `handle` tolerates a failing port (logged; receipts are best-effort, the ack still runs). */
export interface MentionReceiptPort {
  readonly receipt: (input: MentionReceiptInput) => Effect.Effect<void, unknown>
}

/**
 * P7 — how many of the group's most recent messages the receipt dedup pre-check scans. Receipt writes
 * happen immediately after the initiating mention and a retry re-drive of the same event follows promptly
 * (the retry pump), so a bounded newest-first window catches the duplicate while keeping the guard cheap;
 * an old duplicate landing outside the window is harmless (the receipt is still truthful).
 */
export const MENTION_RECEIPT_DEDUP_WINDOW = 100

/**
 * P7 — was this receipt already written? The idempotency key is groupID + messageID + agentID (a generic
 * no-declarer receipt keys on groupID + messageID with agentID undefined). Compared against the metadata
 * JSON this port itself writes, so a retry re-drive of the SAME mention event never double-writes; a
 * DIFFERENT mention (different messageID/agentID) never collides. No key material (no groupID or
 * messageID) ⇒ no dedup (the log-only fallback has no durable write to guard).
 */
const receiptAlreadyWritten = (repo: IMRepositoryInterface, input: MentionReceiptInput) =>
  Effect.gen(function* () {
    if (!input.groupID || !input.messageID) return false
    const page = yield* repo.listMessages({ groupID: input.groupID, limit: MENTION_RECEIPT_DEDUP_WINDOW })
    // IMMessage.metadata is `unknown | null` (free-form JSON column) — narrow to the receipt shape.
    return page.messages.some((m) => {
      const meta = m.metadata as { type?: unknown; messageID?: unknown; agentID?: unknown } | null
      return (
        meta !== null &&
        meta.type === AGENT_NO_TRIGGER_MENTION &&
        meta.messageID === input.messageID &&
        meta.agentID === input.agentID
      )
    })
  })

/** W0.4 — the default receipt port: writes the receipt as a durable IM message into the initiating group
 * via IMRepository (metadata.type = `agent_no_trigger_mention`), exactly like the legacy executor's
 * `agent_run` reply messages. In isolated contexts (no IM repository / no group on the event) it falls
 * back to the `mention_no_trigger_receipt` log line — never a silent no-op. */
export const defaultMentionReceiptPort: MentionReceiptPort = {
  receipt: (input) =>
    Effect.gen(function* () {
      const repo = Option.getOrUndefined(yield* Effect.serviceOption(IMRepository))
      if (!repo || !input.groupID) {
        log.info("mention_no_trigger_receipt", { ...input, surface: "log-only" })
        return
      }
      // P7 — retry idempotency: a bus retry re-drive of the same mention must not double-write the receipt.
      if (yield* receiptAlreadyWritten(repo, input)) return
      const text =
        input.reason === "no_declared_trigger"
          ? `没有 agent 声明支持该触发器（${MENTION_TRIGGER}）——本次 @mention 未执行。`
          : `@${input.agentNames[0] ?? ""} (${input.agentID ?? "unknown"}) 未声明 ${MENTION_TRIGGER} 触发器——没有 agent 声明支持该触发器，本次 @mention 未执行。`
      const message = yield* repo.createMessage({
        groupID: input.groupID,
        senderID: input.agentID ?? "system",
        senderType: input.agentID ? "agent" : "system",
        type: "text",
        content: text,
        mentions: [],
        metadata: {
          type: AGENT_NO_TRIGGER_MENTION,
          ...(input.agentID != null ? { agentID: input.agentID } : {}),
          ...(input.agentNames.length > 0 ? { agentNames: [...input.agentNames] } : {}),
          ...(input.eventID ? { eventID: input.eventID } : {}),
          ...(input.messageID != null ? { messageID: input.messageID } : {}),
        },
      })
      // P3 — the receipt is a real IM message, so broadcast it exactly like the legacy executor's reply
      // broadcast (agent-orchestrator.ts broadcastAgentResult) — the body text reaches live clients, not
      // just the DB. Best-effort: the broadcast call is synchronous and never fails; a missing broadcaster
      // service (isolated contexts) keeps the durable write.
      const broadcaster = Option.getOrUndefined(yield* Effect.serviceOption(IMBroadcasterService))
      broadcaster?.broadcast(input.groupID, {
        type: "message_created",
        data: {
          id: message.id,
          groupID: message.groupID,
          senderID: message.senderID,
          senderType: message.senderType,
          messageType: message.type,
          content: message.content,
          mentions: message.mentions,
          metadata: message.metadata,
          replyToID: message.replyToID,
          createdAt: message.createdAt,
          updatedAt: message.updatedAt,
        },
      })
    }),
}

/** W0.4 — the mention names carried by an `im.message.created` event (already parsed by the IM handler
 * via MentionParser when the message was created). Any other event type has no mention semantics. */
export const mentionNamesFor = (event: DeepAgentEvent.Event): string[] => {
  if (event.type !== LMNEvents.IM_MESSAGE_CREATED) return []
  const payload = event.payload as { mentions?: unknown } | null
  const mentions = payload?.mentions
  return Array.isArray(mentions) ? mentions.filter((m): m is string => typeof m === "string") : []
}

/** W0.4 — one mentioned entry: the name, the registered agent it resolved to (undefined = unknown
 * mention), and whether it is dispatchable (visible agent + declares the mention trigger). Name
 * resolution mirrors the legacy agent-orchestrator: visible agents always win over same-name hidden
 * builtins (the built-ins reuse "auto"/"general" names for matchable-but-hidden trigger routers). */
export interface MentionedAgent {
  readonly name: string
  readonly agent: AgentDescriptor | undefined
  readonly dispatchable: boolean
}

export const resolveMentioned = (
  agents: ReadonlyArray<AgentDescriptor>,
  mentions: ReadonlyArray<string>,
): ReadonlyArray<MentionedAgent> => {
  const byName = new Map<string, AgentDescriptor>()
  for (const agent of agents) {
    const existing = byName.get(agent.name)
    if (existing && existing.visible && !agent.visible) continue
    byName.set(agent.name, agent)
  }
  return mentions.map((name) => {
    const agent = byName.get(name)
    return {
      name,
      agent,
      dispatchable: agent !== undefined && agent.visible && declaresMentionTrigger(agent.triggers),
    }
  })
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
  readonly handle: (event: DeepAgentEvent.Event) => Effect.Effect<HandleDecision>
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
  // W0.4 — the mention-routing receipt port. Defaults to the IM-backed writer (IMRepository message with
  // metadata.type = agent_no_trigger_mention; log-only fallback), injectable for deterministic tests.
  readonly mentionReceiptPort?: MentionReceiptPort
  readonly maxQueueDepth?: number
  readonly dedupeWindowMs?: number
  readonly tickIntervalMs?: number
  readonly retryPumpIntervalMs?: number
  // live dispatch-queue depth for §A4 回压 admission (Wave 3 supplies it; defaults to 0 = inert).
  readonly queueDepth?: () => number
  // K40-4: real durable backlog depth per workspace — takes precedence over queueDepth when provided.
  // Returns the count of pending delivery rows for the given workspace (the authoritative backpressure signal).
  readonly pendingDeliveryCount?: (workspaceID: string) => Effect.Effect<number>
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
      const mentionReceipt = options?.mentionReceiptPort ?? defaultMentionReceiptPort
      const maxQueueDepth = options?.maxQueueDepth ?? DEFAULT_MAX_QUEUE_DEPTH
      const dedupeWindowMs = options?.dedupeWindowMs ?? DEFAULT_DEDUPE_WINDOW_MS
      const tickIntervalMs = options?.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS
      const now = options?.now ?? Date.now
      const runLoops = options?.runLoops ?? true
      const retryPumpIntervalMs = options?.retryPumpIntervalMs ?? DEFAULT_RETRY_PUMP_INTERVAL_MS
      // §A4 回压 — K40-4: prefer the durable `pendingDeliveryCount` (real backlog per workspace) over the
      // in-flight `queueDepth` counter. If `pendingDeliveryCount` is wired, it is awaited inside `handle`
      // before calling the router; if only `queueDepth` is provided (legacy / tests), that synchronous
      // sampler is used as before. Both default to a constant-0 so backpressure stays INERT until the
      // caller wires a real source — matching the observe-only default and not breaking existing tests.
      const pendingDeliveryCount = options?.pendingDeliveryCount
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

      // W0.4 — write one mention receipt. Best-effort by design: a receipt-write failure is logged and
      // swallowed (the ack still settles the delivery); the receipt surface never blocks dispatch.
      const writeMentionReceipt = (input: MentionReceiptInput) =>
        mentionReceipt.receipt(input).pipe(
          Effect.catchCause((cause) =>
            Effect.sync(() =>
              log.error("mention receipt write failed", { eventID: input.eventID, cause: Cause.pretty(cause) }),
            ),
          ),
          Effect.asVoid,
        )

      // W0.4 — route one mention event (see the branch in `handle`). Returns a `dispatch` decision with
      // the mentioned targets, or `receipted` when nothing was dispatchable — the `no_match` silent drop
      // is never used for a mention. Also writes per-agent receipts for mentioned agents that resolved
      // but did NOT declare the mention trigger, and one generic receipt when nobody declared at all.
      const handleMention = (
        event: DeepAgentEvent.Event,
        agentRegistry: ReadonlyArray<AgentDescriptor>,
        mentionNames: ReadonlyArray<string>,
      ): Effect.Effect<HandleDecision> =>
        Effect.gen(function* () {
          const payload = event.payload as { groupID?: unknown; messageID?: unknown } | null
          const groupID = typeof payload?.groupID === "string" ? payload.groupID : undefined
          const messageID = typeof payload?.messageID === "string" ? payload.messageID : undefined
          const resolved = resolveMentioned(agentRegistry, mentionNames)
          const targets = resolved.flatMap((r) => (r.dispatchable && r.agent ? [r.agent] : []))
          // Visible mentioned agents that resolved but did not declare the trigger. Hidden actors (the
          // built-in trigger routers back the visible config agents of the same name) and unknown names
          // fall through to the generic no-declarer receipt instead of a per-agent claim.
          const notDeclaring = resolved.filter((r) => r.agent !== undefined && r.agent.visible && !r.dispatchable)

          // per-mentioned-agent receipts: the name resolved but the agent did not declare the trigger.
          yield* Effect.forEach(
            notDeclaring,
            (r) =>
              writeMentionReceipt({
                eventID: event.id,
                groupID,
                messageID,
                agentID: r.agent?.id,
                agentNames: [r.name],
                reason: "agent_no_trigger_mention",
              }).pipe(
                Effect.tap(() =>
                  Effect.sync(() =>
                    log.info("mention_no_trigger_receipt", {
                      eventID: event.id,
                      agentID: r.agent?.id,
                      agentName: r.name,
                      reason: "agent_no_trigger_mention",
                    }),
                  ),
                ),
              ),
            { discard: true },
          )

          if (targets.length === 0) {
            // Nothing dispatchable: a receipt instead of the silent `no_match` terminal drop. When every
            // mention resolved to a non-declaring agent, the per-agent receipts above already give the
            // user feedback; a generic no-declarer receipt covers unknown names / an empty registry.
            if (notDeclaring.length === 0) {
              yield* writeMentionReceipt({
                eventID: event.id,
                groupID,
                messageID,
                agentID: undefined,
                agentNames: mentionNames,
                reason: "no_declared_trigger",
              }).pipe(
                Effect.tap(() =>
                  Effect.sync(() =>
                    log.info("mention_no_trigger_receipt", {
                      eventID: event.id,
                      agentNames: mentionNames,
                      reason: "no_declared_trigger",
                    }),
                  ),
                ),
              )
            }
            yield* bus.ack(DISPATCH_GROUP, event.id)
            return {
              type: "receipted",
              reason: notDeclaring.length > 0 ? "agent_no_trigger_mention" : "no_declared_trigger",
            } as const
          }

          // P8 — mixed mentions: some names dispatch while others resolved to NOTHING (unknown names).
          // The dispatch target does its work; the unknown names must not pass silently — write the
          // generic no-declarer receipt for exactly those names (resolved-but-not-declaring agents are
          // already receipted per-agent above, and hidden actors are the built-in trigger routers that
          // back a visible agent of the same name).
          const unresolved = resolved.filter((r) => r.agent === undefined)
          if (unresolved.length > 0) {
            yield* writeMentionReceipt({
              eventID: event.id,
              groupID,
              messageID,
              agentID: undefined,
              agentNames: unresolved.map((r) => r.name),
              reason: "no_declared_trigger",
            }).pipe(
              Effect.tap(() =>
                Effect.sync(() =>
                  log.info("mention_no_trigger_receipt", {
                    eventID: event.id,
                    agentNames: unresolved.map((r) => r.name),
                    reason: "no_declared_trigger",
                  }),
                ),
              ),
            )
          }

          const priority = event.priority
          const outcome = yield* port.dispatch({ event, priority, targets }).pipe(
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
          return { type: "dispatch", priority, targets } as const
        })

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

            // W0.4 — @mention 路由 (see the module doc above). A mention event routes by the mentioned
            // agent's NAME; the pure router's event-type trigger match is bypassed (the @mention itself is
            // the authorization). Runs BEFORE `EventRouter.route` so a mention never lands in the
            // `no_match` terminal drop path (route.dropped log + silent ack): it dispatches to mentioned
            // agents that declare the mention trigger and receipts everyone else (agent_no_trigger_mention
            // / the "没有 agent 声明支持该触发器" no-declarer receipt).
            //
            // P1/P2 (design W0.4 note 4) — the mention branch is gated on `isEventV2AdmissionEnabled()`,
            // the SAME predicate the dispatch port uses (multi-agent-runtime.ts dispatch —
            // dispatchV2 vs coordinate). v4 ON ∧ admission ON ⇒ this dispatcher owns the mention (dispatch
            // or receipt) while the legacy synchronous executor in the IM handler is skipped — the
            // double-execution regression (P1) is closed from both sides. v4 ON ∧ admission OFF ⇒ the
            // explicit fall-back-to-legacy matrix: this mention branch is skipped, the event keeps the
            // pre-W0.4 pure-router path (the legacy executor in the IM handler runs instead — the
            // admission OFF combo is "legacy path authoritative", NOT a silent loss; no receipt is
            // written, which is the documented explicit-disabled semantic). With the event path off the
            // flag_disabled fail-closed drop stays authoritative.
            const mentions = mentionNamesFor(event)
            if (mentions.length > 0 && isEventV2AdmissionEnabled()) {
              return yield* handleMention(event, agents, mentions)
            }
          }

          // K40-4: use the durable pending-delivery count as the authoritative backpressure depth when
          // wired; fall back to the legacy in-flight sampler so existing tests remain unaffected.
          const resolvedQueueDepth = pendingDeliveryCount
            ? yield* pendingDeliveryCount(event.workspaceID)
            : queueDepth()

          const decision = EventRouter.route({
            event,
            agents,
            flagEnabled,
            queueDepth: resolvedQueueDepth,
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
            // T4.3: the comment always claimed to record the drop, but only the backpressure branch did —
            // so terminal drops (the common no_match / flag_disabled case) were invisible to the shed-rate
            // metric. Record it here too (best-effort, ordered before the ack) so Oversight sees the full
            // drop picture by reason, not just backpressure.
            log.info("route.dropped", { eventType: event.type, eventID: event.id, reason: decision.reason })
            yield* bus.recordDrop({ event, reason: decision.reason })
            yield* bus.ack(DISPATCH_GROUP, event.id)
          }

          return decision
        })

      // Publish a schedule's templated event. `overrides` lets the per-repo (P4.5b) path stamp a repo
      // discriminator into the payload + scope the workspaceID to the failing repo's workspace, and
      // `keySuffix` lets it distinguish each repo's fire in the idempotency key. Does NOT markFired — the
      // caller does that ONCE per schedule (a per-repo tick publishes N events but marks the schedule
      // fired once). No-op-safe: a publish failure is logged + swallowed so one bad fire can't kill the tick.
      const publishScheduleEvent = (
        schedule: Scheduler.Schedule,
        at: number,
        overrides?: { readonly workspaceID?: string; readonly payload?: Record<string, unknown>; readonly keySuffix?: string },
      ) =>
        Effect.gen(function* () {
          const template = schedule.eventTemplate
          // Idempotency key anchored on the STABLE logical fire time, not the tick's wall clock: if a
          // tick publishes but crashes before markFired, the next tick re-fires the SAME logical fire
          // and the bus dedupes on this key (no duplicate event). For a cadence-less condition (null
          // fireAt) there is no stable logical time, so fall back to the tick's `at` — every-tick
          // evaluation genuinely wants a distinct fire per tick. A per-repo fire adds `keySuffix` (the
          // repo) so each repo's repair dedupes independently.
          const logical = schedule.fireAt ?? at
          const idempotencyKey = `sched:${schedule.id}:${overrides?.keySuffix ? `${overrides.keySuffix}:` : ""}${logical}`
          const basePayload =
            typeof template.payload === "object" && template.payload != null
              ? (template.payload as Record<string, unknown>)
              : {}
          yield* bus
            .publish({
              ...template,
              ...(overrides?.workspaceID ? { workspaceID: overrides.workspaceID } : {}),
              ...(overrides?.payload ? { payload: { ...basePayload, ...overrides.payload } } : {}),
              idempotencyKey,
            })
            .pipe(
              Effect.catchCause((cause) =>
                Effect.sync(() =>
                  log.error("schedule publish failed", { scheduleID: schedule.id, cause: Cause.pretty(cause) }),
                ),
              ),
            )
        })

      const fireSchedule = (schedule: Scheduler.Schedule, at: number) =>
        Effect.gen(function* () {
          yield* publishScheduleEvent(schedule, at)
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

      // §C3.2 / P4.5b — the PER-REPO condition fire. Partition `recent` trigger events by their
      // `payload.repo` discriminator and publish ONE templated event per repo that independently meets the
      // threshold — stamping `repo` into the fired payload and scoping the event to that repo's failing
      // workspace. Marks the schedule fired ONCE (a per-repo tick emits N events for one schedule). Honors
      // quiet hours on the schedule's workspace for low/normal fires exactly like fireOrDefer (defers the
      // whole evaluation past the window); the CI-repair template is high priority so it always fires.
      // Returns whether the schedule fired (≥1 repo repair emitted) so the tick advances its recheck.
      const readRepo = (event: DeepAgentEvent.Event): string | undefined => {
        const repo = (event.payload as { repo?: unknown } | null)?.repo
        return typeof repo === "string" && repo.length > 0 ? repo : undefined
      }
      const firePerRepoOrDefer = (
        schedule: Scheduler.Schedule,
        spec: Scheduler.ConditionSpec,
        recent: ReadonlyArray<DeepAgentEvent.Event>,
        at: number,
      ): Effect.Effect<boolean> =>
        Effect.gen(function* () {
          const priority = schedule.eventTemplate.priority ?? "normal"
          if (priority !== "high" && priority !== "critical") {
            const qh = yield* resolveQuietHours(schedule.workspaceID, at)
            if (qh.quiet) {
              const nextAt = qh.endAt != null && qh.endAt > at ? qh.endAt : at + 1
              log.info("per-repo condition deferred by quiet hours", {
                scheduleID: schedule.id,
                workspaceID: schedule.workspaceID,
                deferUntil: nextAt,
              })
              yield* scheduler.recheckCondition(schedule.id, nextAt)
              return false
            }
          }
          // Group the window's trigger events by repo; keep each repo's count + the workspace its latest
          // failure landed in (so the repair is scoped to the failing repo's project workspace).
          // recentByType returns newest-first (desc created_at); scope each repo's repair to the workspace
          // of its MOST RECENT failure (the first one encountered for that repo).
          const byRepo = new Map<string, { count: number; workspaceID: string }>()
          for (const event of recent) {
            const repo = readRepo(event)
            if (!repo) continue // an event with no repo discriminator can't be repo-scoped → ignore.
            const prev = byRepo.get(repo)
            byRepo.set(repo, { count: (prev?.count ?? 0) + 1, workspaceID: prev?.workspaceID ?? event.workspaceID })
          }
          let firedAny = false
          for (const [repo, agg] of byRepo) {
            if (!Scheduler.conditionMet(spec, agg.count)) continue // this repo hasn't hit the threshold.
            yield* publishScheduleEvent(schedule, at, {
              workspaceID: agg.workspaceID,
              payload: { repo },
              keySuffix: repo,
            })
            firedAny = true
          }
          if (firedAny) yield* scheduler.markFired(schedule.id, at)
          return firedAny
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
              // §C3.2 / P4.5b — a groupByRepo condition evaluates the threshold PER REPO (partitioning the
              // window by payload.repo) and fires ONE repair per repo that hits it, carrying repo=<repo>.
              // A plain condition keeps the single-counter behavior (fire once when the total meets it).
              const didFire = spec.groupByRepo
                ? yield* firePerRepoOrDefer(schedule, spec, recent, at)
                : Scheduler.conditionMet(spec, recent.length)
                  ? // §E4 — fireOrDefer holds the fire for quiet hours (low/normal) and reschedules it past
                    // the window; a deferred fire already advanced fire_at, so skip the recheck below.
                    yield* fireOrDefer(schedule, at)
                  : false
              if (didFire) {
                // A fired condition must not re-fire while the SAME trigger events are still inside the
                // window. markFired (called inside fireOrDefer / firePerRepoOrDefer) advances fire_at by
                // only the recheck CADENCE (e.g. 60s), so a cadenced condition (the production 3×-CI
                // trigger: recheck 60s, window 30min) would otherwise become due again 60s later with the
                // same ≥3 failures still in-window and re-fire ~once per recheck for the whole window
                // (~30 duplicate high-priority repair goals — the bus idempotency key is per-fireAt, and
                // the router only dedups LOW priority, so nothing collapses them). Push the next recheck
                // PAST the window so those events have aged out before the condition is eligible again.
                // This applies to EVERY fired condition, cadenced or not (the old `intervalMs == null`
                // guard left the cadenced production trigger unprotected). New events landing after this
                // still start a fresh window and legitimately re-trigger.
                yield* scheduler.recheckCondition(schedule.id, at + (spec.windowMs || 1))
                fired++
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
          // RISK-001: claim our group's due rows before executing — dueRetries() was an unlocked
          // global scan, so two processes could re-drive the same retry concurrently. The claim's
          // lease (default 5min) must exceed worst-case processing time; if it lapses mid-handling
          // another claimant may re-drive the same event (bounded duplicate, same as pre-fix).
          const claim = yield* bus.claimDue({
            subscriptionGroup: DISPATCH_GROUP,
            claimantId: `event-dispatcher:${process.pid}`,
            now: at,
          })
          let redriven = 0
          for (const delivery of claim.deliveries) {
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
        yield* bus.registerConsumerGroup(DISPATCH_GROUP)
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
        // Timeout guards against DB-stall (busy WAL/retention sweep): durable registration already
        // happened via registerConsumerGroup above, so a brief live-stream miss is recoverable via
        // the retry pump. 500ms is well above normal fiber-schedule latency (<1ms).
        yield* Deferred.await(ready).pipe(Effect.timeout(Duration.millis(500)), Effect.ignore)

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
