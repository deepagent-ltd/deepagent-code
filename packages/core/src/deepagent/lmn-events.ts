export * as LMNEvents from "./lmn-events"

// V4.0 §L/§M/§N — the canonical DeepAgentEvent `type` strings for wiring the existing V3.9 bodies
// (Repo & Wiki, Expert Panel, Goal Loop) onto the Event Bus. These are NOT new mechanics — the bodies
// already exist (V3.9); this module just fixes the event vocabulary so the producers (session loop,
// panel orchestrator, goal driver), the consumers (ExecutionArchiver, Oversight, IM push), and the
// observability layer all agree on the same strings. Each rides as a DeepAgentEvent on the bus.
//
// LAYERING: `core`, constants only.

// §L Repo & Wiki — the ExecutionArchiver consumes session/goal completion to archive execution traces
// as Wiki pages, and they feed IM push notifications for supervisors.
export const SESSION_COMPLETED = "session.completed"

// §B IM — a user message, after it persists, publishes this (the §B1 double-write). The Router/
// MentionAgent consume it; the legacy synchronous @mention path stays authoritative until the flag is on.
export const IM_MESSAGE_CREATED = "im.message.created"

// §A1 EXTERNAL INGRESS — the four external event sources (git hook/webhook, CI webhook, PR webhook,
// observability/monitoring) named in the §A1 table. The webhook ingress (deepagent-code) authenticates
// the caller and normalizes each delivery into a DeepAgentEvent carrying one of these exact `type`
// strings — matching the tables the consumers already key on: EventRouter (agent `triggers[].event`),
// TaskPartitioner.DEFAULT_RULES, and PanelConvenePolicy.DEFAULT_RULES. These are producer-side constants
// so the ingress can never drift from the strings the router/partitioner/panel match on.
//
// §E1 TRUST: git/ci/pr/monitor are NOT in DEFAULT_TRUSTED_SOURCES (["im","system","schedule"]) — as of
// P0.1 external sources are opt-in. The ingress still persists + traces these events, but the security
// gate BLOCKS agent dispatch until an operator adds the source to the workspace's trustedSources. This
// is intended (untrusted external input is fail-closed by default).
export const GIT_PUSH = "git.push"
export const CI_FAILURE = "ci.failure"
export const PR_COMMENT = "pr.comment"
export const MONITOR_ALERT = "monitor.alert"

// §N Goal Loop.
//
// COMMAND vs FACT (V4.0 §N event-driven execution). The contract says "tick = goal.tick 事件" with
// persistence/retry/dedup/backpressure — i.e. tick must be DRIVEN BY consuming an event, not merely
// observed. That requires two distinct kinds of event:
//   - GOAL_TICK_REQUESTED (COMMAND): "execute ONE tick of this goal". A consumer claims it, runs the
//     tick through the normal StepExecutor path, then — if non-terminal — re-emits the next requested
//     (the self-driving chain). Idempotent on plan-version (idempotencyKey = goal:tick:<goalId>:<ver>)
//     so a redelivered command never double-executes; nack → bus retry (real work is retried, not just
//     an observation). This is the event that carries the §N persistence/retry/dedup guarantee.
//   - GOAL_TICK (FACT / trace): a tick HAS happened — an after-the-fact observation for tracing. It is
//     `normal` priority and safely sheddable; it drives nothing. (Named `goal.tick` for back-compat; it
//     is the observed counterpart to the requested command, NOT a driver.)
// Terminal facts (completed/needs_human/rolled_back) go to Oversight/Archive as before.
export const GOAL_TICK_REQUESTED = "goal.tick.requested"
export const GOAL_TICK = "goal.tick"
export const GOAL_COMPLETED = "goal.completed"
export const GOAL_NEEDS_HUMAN = "goal.needs_human"
export const GOAL_ROLLED_BACK = "goal.rolled_back"

// §M Expert Panel — the verdict (needs_human → Approval Queue).
export const PANEL_VERDICT = "panel.verdict"

// §A3 DLQ ALERT — the Event Bus publishes this (source="system", high priority) the moment a delivery
// exhausts its retries and flips to "dead", so a dead-letter "生成告警" (§A3) instead of sitting silently
// in the DLQ view until someone queries it. It carries the dead event's id, the subscription group, the
// final failure reason, and the attempt count so Oversight/notify can surface it. It is a SYSTEM
// observation signal — NOT an agent-dispatch trigger — so it is guarded against self-cascade at the
// producer (a dead delivery OF a dlq.alert never re-alerts).
export const DLQ_ALERT = "dlq.alert"

// §C/§D — a multi-agent subtask that could NOT auto-execute and needs a human: it exceeded the agent's
// autonomy ceiling, or it is a level_5 suggestion_only action (never auto-runs). The Multi-Agent
// Runtime publishes this so the §D2 Approval Queue surfaces it for a human decision (rather than the
// action being silently dropped).
export const AGENT_TASK_NEEDS_HUMAN = "agent.task.needs_human"

// The set of event types that represent a TERMINAL outcome requiring human attention — the Oversight
// Approval Queue (§D2) is populated from these. Kept as a set so the wiring can test membership.
export const APPROVAL_QUEUE_TYPES: ReadonlySet<string> = new Set([
  GOAL_NEEDS_HUMAN,
  GOAL_ROLLED_BACK,
  AGENT_TASK_NEEDS_HUMAN,
  PANEL_VERDICT, // only when the verdict is needs_human — the wiring checks the payload
])

// The event types the §L ExecutionArchiver consumes to build Wiki execution-archive pages.
export const ARCHIVE_TRIGGER_TYPES: ReadonlySet<string> = new Set([SESSION_COMPLETED, GOAL_COMPLETED])

// Is this event type a CANDIDATE for the Approval Queue? Renamed from a definitive-sounding
// `isApprovalQueueType` because PANEL_VERDICT is only conditionally queued (on decision=needs_human) —
// a boolean that reads as "yes, queue it" is a footgun. Use `shouldQueueForApproval` for the real
// yes/no, which folds in the payload check. This candidate check is for coarse routing only.
export const isApprovalQueueCandidate = (eventType: string): boolean => APPROVAL_QUEUE_TYPES.has(eventType)

// The DEFINITIVE §D2 Approval-Queue test: does this specific event require human approval? Folds the
// payload gate PANEL_VERDICT needs (only queue a needs_human verdict, not approve/revise/block) so no
// caller can accidentally flood the queue with autonomously-resolved verdicts.
export const shouldQueueForApproval = (event: { readonly type: string; readonly payload: unknown }): boolean => {
  if (event.type === PANEL_VERDICT) {
    const decision = (event.payload as { decision?: string } | null)?.decision
    return decision === "needs_human"
  }
  return APPROVAL_QUEUE_TYPES.has(event.type)
}

// §N bridge: the existing producer emits ONE goal event `goal.updated` with a `phase` discriminator
// (goal-event.ts) rather than the discrete goal.* types below. This maps a driver phase to the discrete
// V4.0 event type so the event-driven wiring can re-emit / route it onto the bus consistently. Returns
// undefined for phases that are not a discrete V4.0 lifecycle event (running/paused/stopped are
// transient status, not queue/archive triggers).
export const goalPhaseToEventType = (phase: string): string | undefined => {
  switch (phase) {
    case "done":
      return GOAL_COMPLETED
    case "needs_human":
      return GOAL_NEEDS_HUMAN
    case "rolled_back":
      return GOAL_ROLLED_BACK
    default:
      return undefined // running | paused | stopped — no discrete lifecycle event
  }
}

// Should an event type trigger Wiki execution archival (§L event-driven archiver)?
export const isArchiveTrigger = (eventType: string): boolean => ARCHIVE_TRIGGER_TYPES.has(eventType)
