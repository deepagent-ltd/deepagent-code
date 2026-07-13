export * as EventRouter from "./event-router"

import { DeepAgentEvent } from "./deepagent-event"
import { LMNEvents } from "./lmn-events"
import type { AgentDescriptor } from "../im/mention-parser"

// V4.0 §A4 — the Event Router POLICY. This is a PURE, deterministic decision function: given an event,
// the candidate agent registry projection, the current queue pressure, and the recent same-type events
// (the §A4 去重窗口 primitive from the Event Bus), it decides whether the event dispatches (and to
// which agents, at what priority) or is dropped (and why).
//
// LAYERING: lives in `core` and imports NOTHING runtime. Feature-flag state and per-agent permission
// are NOT read here — they are resolved by the deepagent-code wiring and passed in as `flagEnabled` /
// pre-filtered `agents`, so this module stays a pure, unit-testable policy with no Effect, no DB, no
// RuntimeFlags import. The wiring subscribes to the bus, computes the gates, calls `route`, and
// dispatches the decision to sessions/agents.
//
// §A4 Router responsibilities, mapped to this function:
//   事件类型匹配   : match candidate agents by their `triggers[].event` (glob-ish, see `matches`).
//   权限/flag 检查 : `flagEnabled` gate (resolved upstream) + `agents` already permission-filtered.
//   去重           : within `dedupeWindowMs`, a duplicate LOW-priority same-type event is merged.
//   优先级         : the decision carries the event's priority so the scheduler can preempt low queues.
//   回压           : when the queue is at/over capacity, low/normal events are dropped (event_dropped);
//                    high/critical always admitted (critical 抢占低优队列).

// Priority ordering for preemption + admission decisions. Higher = more urgent.
export const PRIORITY_RANK: Record<DeepAgentEvent.EventPriority, number> = {
  low: 0,
  normal: 1,
  high: 2,
  critical: 3,
}

// Why an event was dropped rather than dispatched — surfaced as an `event_dropped` observability signal.
// `coordination`: the event is a §C4 inter-agent coordination/derivative signal (agent.task.* /
// agent.handoff.*) — it exists for observation/oversight/trace, NOT to trigger a fresh agent dispatch.
// `operational`: the event is a §A3 OPERATIONAL alert (dlq.alert) — a dead-letter notification for
// Oversight/SupervisorNotifier, NOT agent work; it must never be agent-dispatched (nor spin a
// no_capable_agent nack loop if an operator happens to register a broad-glob trigger agent).
export type DropReason = "flag_disabled" | "no_match" | "deduped" | "backpressure" | "coordination" | "operational"

// §A3 OPERATIONAL SIGNAL family — events that are workspace-operator notifications (dead-letter alerts),
// NOT agent-dispatch triggers. lmn-events.ts is explicit that dlq.alert is "a SYSTEM observation signal —
// NOT an agent-dispatch trigger". Like the §C4 coordination guard this severs the AGENT-DISPATCH path only:
// the event is still persisted + delivered to the trace/oversight/notify consumers (separate subscribers).
// Guarding it in the PURE router (rather than relying on "no agent happens to subscribe") makes it robust
// to an operator registering a broad-glob (`*` / `dlq.*`) trigger agent — such an agent can never grab an
// operational alert, and the alert is terminal-acked (never an infinite no_capable_agent nack loop).
export const OPERATIONAL_EVENT_TYPES: ReadonlySet<string> = new Set([LMNEvents.DLQ_ALERT])
export const isOperationalEvent = (eventType: string): boolean => OPERATIONAL_EVENT_TYPES.has(eventType)

// §C4 RE-ENTRANCY GUARD — the coordination/derivative event-type family. The Multi-Agent Runtime emits
// these BACK onto the bus (agent.task.started/blocked/completed/needs_human) as a side effect of a
// `coordinate()` pass, so a broad-glob agent trigger (`agent.*` / `*`) subscribed to them would re-enter
// the dispatcher → a new `coordinate()` → fresh coordination events (new ids, so the alreadyCompleted
// guard never fires) → an unbounded, ceiling-bypassing cascade. Per §C4 these events are for
// observation/oversight/trace only; they must NEVER re-trigger agent dispatch. They are still persisted
// and delivered to the trace/oversight consumers (separate subscribers) — this only closes the
// AGENT-DISPATCH loop. NOTE: `agent.push.*` (proactive push) is a DIFFERENT family and still routes.
export const COORDINATION_EVENT_PREFIXES = ["agent.task."] as const
export const isCoordinationEvent = (eventType: string): boolean =>
  COORDINATION_EVENT_PREFIXES.some((prefix) => eventType.startsWith(prefix))

export type RouteDecision =
  | {
      readonly type: "dispatch"
      readonly priority: DeepAgentEvent.EventPriority
      // the agents whose triggers matched the event, in registry order.
      readonly targets: ReadonlyArray<AgentDescriptor>
    }
  | {
      readonly type: "dropped"
      readonly reason: DropReason
      // for `deduped`: the id of the recent event this one merged into (for the trace).
      readonly mergedInto?: DeepAgentEvent.ID
    }

export interface RouteInput {
  readonly event: DeepAgentEvent.Event
  // registry projection, ALREADY permission-filtered by the caller (only agents allowed to see this
  // workspace/project/event). The router matches on `triggers` within this set.
  readonly agents: ReadonlyArray<AgentDescriptor>
  // resolved feature-flag gate for this event's path (e.g. v4EventDrivenIm for im.*). A disabled flag
  // drops the event fail-closed — the legacy synchronous path stays authoritative.
  readonly flagEnabled: boolean
  // current depth of the dispatch queue and its capacity (回压). Omit `maxQueueDepth` for no limit.
  readonly queueDepth?: number
  readonly maxQueueDepth?: number
  // recent same-type events (bus.recentByType, ordered most-recent-first) for the §A4 去重窗口 merge.
  // MUST already be scoped to this event's workspace by the caller (the router does NOT re-check
  // workspace — an unscoped set risks a cross-tenant merge). Since routing runs post-persist this set
  // typically INCLUDES the event itself; `route` filters it out defensively.
  readonly recentSameType?: ReadonlyArray<DeepAgentEvent.Event>
}

// Does an agent trigger match an event type? Supports an exact match and a trailing `*` wildcard
// (e.g. `agent.*` matches `agent.task.started`). Kept intentionally small; richer `match` conditions
// on the Trigger are a forward-compat declaration (mention-parser.ts) and not evaluated here yet.
export const matches = (triggerEvent: string, eventType: string): boolean => {
  if (triggerEvent === eventType) return true
  if (triggerEvent === "*") return true
  if (triggerEvent.endsWith(".*")) {
    const prefix = triggerEvent.slice(0, -1) // keep the trailing dot: "agent." matches "agent.x"
    return eventType.startsWith(prefix)
  }
  return false
}

// The candidate agents whose triggers match this event, preserving registry order and de-duplicating.
const matchingAgents = (
  agents: ReadonlyArray<AgentDescriptor>,
  eventType: string,
): ReadonlyArray<AgentDescriptor> =>
  agents.filter((agent) => (agent.triggers ?? []).some((t) => matches(t.event, eventType)))

/**
 * §A4 — the pure routing decision. Order of checks (fail-closed first):
 *   0a. coordination  → `coordination` if the event is a §C4 derivative signal (never re-dispatches).
 *   0b. operational   → `operational` if the event is a §A3 dlq.alert (an operator notice, never agent work).
 *   1. flag gate      → `flag_disabled` if the event path's flag is off.
 *   2. type match     → `no_match` if no permitted agent subscribes to this type.
 *   3. dedup (低优)   → `deduped` if a low-priority same-type event already exists in the window.
 *   4. backpressure   → `backpressure` if the queue is full and this event is low/normal.
 *   5. otherwise      → `dispatch` to the matched agents at the event's priority.
 *
 * Dedup only merges LOW priority (the §A4 contract: "同类重复低优事件合并") — normal/high/critical are
 * never silently merged. Backpressure never drops high/critical (critical 抢占低优队列).
 */
export const route = (input: RouteInput): RouteDecision => {
  // §C4 RE-ENTRANCY GUARD (first, before agent matching): coordination/derivative events NEVER trigger a
  // fresh agent dispatch, even if a wildcard-trigger agent (`agent.*` / `*`) would otherwise match them.
  // This is the loop-closer — without it, coordinate()'s own emitted events (new ids each pass) would
  // re-enter and cascade unbounded, bypassing the §E2 ceiling. Checked before the flag gate so it holds
  // regardless of which flag governs the event path. The event is still persisted + observable by the
  // trace/oversight consumers; only the agent-dispatch path is severed here.
  if (isCoordinationEvent(input.event.type)) return { type: "dropped", reason: "coordination" }

  // §A3 OPERATIONAL guard (also before agent matching + the flag gate): a dlq.alert is an operator
  // notification, never agent work. Severs the agent-dispatch path so a broad-glob trigger agent can't
  // grab it; the alert is still observable + delivered to the SupervisorNotifier/Oversight consumers.
  if (isOperationalEvent(input.event.type)) return { type: "dropped", reason: "operational" }

  if (!input.flagEnabled) return { type: "dropped", reason: "flag_disabled" }

  const targets = matchingAgents(input.agents, input.event.type)
  if (targets.length === 0) return { type: "dropped", reason: "no_match" }

  const priority = input.event.priority

  // §A4 去重窗口: only LOW-priority duplicates merge. `recentSameType` is caller-scoped to the same
  // type + workspace + window; the first recent event (most recent) is the merge target.
  if (priority === "low") {
    const recent = input.recentSameType ?? []
    const target = recent.find((e) => e.id !== input.event.id)
    if (target) return { type: "dropped", reason: "deduped", mergedInto: target.id }
  }

  // §A4 回压: reject low/normal when the queue is at/over capacity; high/critical always pass. A
  // non-positive `maxQueueDepth` is treated as "no limit" (not "always full") — a 0/negative capacity
  // that silently dropped every low/normal event would be a footgun; omit the field or pass a positive
  // cap to enable backpressure.
  if (
    input.maxQueueDepth != null &&
    input.maxQueueDepth > 0 &&
    (input.queueDepth ?? 0) >= input.maxQueueDepth &&
    PRIORITY_RANK[priority] < PRIORITY_RANK.high
  ) {
    return { type: "dropped", reason: "backpressure" }
  }

  return { type: "dispatch", priority, targets }
}
