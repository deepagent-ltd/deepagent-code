export * as DeepAgentEvent from "./deepagent-event"

import { Schema } from "effect"
import { externalID, type ExternalID, withStatics } from "../schema"
import { Identifier } from "../util/identifier"

// V4.0 §A1 — the DeepAgent event model. This is the WIRE + PERSISTENCE envelope every V4.0 trigger
// (IM message, git push, CI failure, PR comment, monitor alert, scheduled scan, agent coordination)
// is normalized into before it enters the Event Bus. It is DELIBERATELY distinct from the lower-level
// `EventV2` sync-log envelope (core/src/event.ts): EventV2 is the durable per-aggregate append-only
// substrate this bus is BUILT ON; `DeepAgentEvent` is the higher-level domain event carried inside an
// EventV2 aggregate. See deepagent-event-bus.ts for how the two compose.
//
// LAYERING: lives in `core` — pure schema + types only, no LSP / panel / task-tool / session imports.
// Every V4.0 event source produces one of these; the Router (deepagent-code) dispatches on `type`.

// §A1 — a stable, sortable event id. `evt_` prefix mirrors EventV2.ID; ascending-monotonic component
// keeps natural insertion order for debugging + dedupe-window scans.
export const ID = Schema.String.check(Schema.isStartsWith("dae_")).pipe(
  Schema.brand("DeepAgentEvent.ID"),
  withStatics((schema) => ({
    // `at` (an injected clock) keeps the id's monotonic time component aligned with the event's
    // `createdAt`, so id-ascending order == createdAt order even under a deterministic test clock
    // (see deepagent-event-bus.ts replay/recentByType, which tiebreak equal createdAt by id).
    create: (at?: number) => schema.make("dae_" + Identifier.create(false, at)),
    fromExternal: (input: ExternalID) => schema.make(externalID("dae", input)),
  })),
)
export type ID = typeof ID.Type

// §A1 event source — the origin system. Determines the default Agent (§A1 table) and the trust tier
// checked in §E1 layer-1 ("event source 是否可信").
export const EventSource = Schema.Literals(["im", "git", "ci", "pr", "monitor", "schedule", "system"])
export type EventSource = Schema.Schema.Type<typeof EventSource>

// §A4 priority — Router uses this for preemption (critical 抢占低优队列) and backpressure (回压时拒绝
// 低优事件). Also gates §E4 quiet-hours pass-through (high/critical 可穿透静默时段).
export const EventPriority = Schema.Literals(["low", "normal", "high", "critical"])
export type EventPriority = Schema.Schema.Type<typeof EventPriority>

// §A1 — the canonical event envelope. `payload` is left as Unknown at the schema boundary because
// event types are open/extensible; producers/consumers narrow it per `type`. The correlation/causation
// pair (§F2 trace) strings an event to its cause and its emitted follow-ups.
export const Event = Schema.Struct({
  id: ID,
  type: Schema.String, // e.g. "im.message.created", "ci.failure", "goal.tick"
  source: EventSource,
  workspaceID: Schema.String,
  projectID: Schema.optional(Schema.String),
  actorID: Schema.optional(Schema.String),
  correlationID: Schema.optional(Schema.String), // §A3 顺序: same correlationID keeps causal order
  causationID: Schema.optional(Schema.String), // the event that directly caused this one
  idempotencyKey: Schema.String, // §A3 幂等: consumer dedupes on this
  priority: EventPriority,
  createdAt: Schema.Int,
  payload: Schema.Unknown,
}).annotate({ identifier: "DeepAgentEvent" })
export type Event = Schema.Schema.Type<typeof Event>

// §C4 — inter-agent coordination events. Agents communicate THROUGH the bus, never by calling each
// other's internal functions. These ride as `DeepAgentEvent.payload` under `type` = the tag below.
export const AgentCoordinationEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("agent.task.started"), taskID: Schema.String, agentID: Schema.String }),
  Schema.Struct({ type: Schema.Literal("agent.task.blocked"), taskID: Schema.String, reason: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("agent.task.completed"),
    taskID: Schema.String,
    artifacts: Schema.Array(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("agent.handoff.requested"),
    from: Schema.String,
    to: Schema.String,
    reason: Schema.String,
  }),
]).annotate({ identifier: "AgentCoordinationEvent" })
export type AgentCoordinationEvent = Schema.Schema.Type<typeof AgentCoordinationEvent>

// The subset of §A1 fields a producer supplies; the bus fills id/createdAt/idempotencyKey defaults.
export const PublishInput = Schema.Struct({
  type: Schema.String,
  source: EventSource,
  workspaceID: Schema.String,
  projectID: Schema.optional(Schema.String),
  actorID: Schema.optional(Schema.String),
  correlationID: Schema.optional(Schema.String),
  causationID: Schema.optional(Schema.String),
  idempotencyKey: Schema.optional(Schema.String),
  priority: Schema.optional(EventPriority),
  payload: Schema.Unknown,
}).annotate({ identifier: "DeepAgentEvent.PublishInput" })
export type PublishInput = Schema.Schema.Type<typeof PublishInput>
