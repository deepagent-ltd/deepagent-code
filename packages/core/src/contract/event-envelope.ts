export * as EventEnvelopeContract from "./event-envelope"

import { Schema } from "effect"
import { contentDigest } from "./digest"

// C0-02 Phase 1 - Event envelope contract (freeze base)
// Design authority: docs/core-v2.0-beta/design.md §8 (event-driven agent system),
// in particular §8.2 (event classes), §8.4 (work envelope), §8.6 (delivery),
// §8.8 (bounded/anti-noise) and §14 (correlation chain).

/** Version matrix for the event envelope contract. `schema` is the envelope schema version. */
export const EventVersion = {
  schema: "event.v1",
  workEnvelope: 1,
  kind: 1,
  risk: 1,
  sourceKind: 1,
  payload: 1,
  delivery: 1,
  budget: 1,
} as const

/** Event class discriminant: command asks for work; fact is committed authority; observation is external/ops. */
export const EventKindSchema = Schema.Literals(["command", "fact", "observation"])
export type EventKind = typeof EventKindSchema.Type

/** Where the event originated. */
export const EventSourceKind = Schema.Literals(["system", "user", "agent", "external", "internal"])
export type EventSourceKind = typeof EventSourceKind.Type

/** Risk / autonomy ceiling levels (design §8.4, §8.8). */
export const EventRisk = Schema.Literals(["low", "medium", "high", "critical"])
export type EventRisk = typeof EventRisk.Type

/** Bounded payload reference — never the raw external payload (design §8.2, §8.8). */
export const EventPayload = Schema.Struct({
  contentType: Schema.String,
  ref: Schema.String,
  payloadHash: Schema.String,
})
export type EventPayload = typeof EventPayload.Type

/** Aggregate the event belongs to. */
export const EventAggregate = Schema.Struct({
  aggregateId: Schema.String,
  aggregateType: Schema.String,
  aggregateRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
})
export type EventAggregate = typeof EventAggregate.Type

/** Actor identity and kind. */
export const EventActor = Schema.Struct({
  actorId: Schema.String,
  actorType: Schema.String,
})
export type EventActor = typeof EventActor.Type

/** Source identity. */
export const EventSource = Schema.Struct({
  sourceId: Schema.String,
  sourceKind: EventSourceKind,
})
export type EventSource = typeof EventSource.Type

/** Unified correlation chain (design §14): from input/event through execution to cursor. */
export const EventCorrelation = Schema.Struct({
  correlationId: Schema.String,
  causalChain: Schema.Array(Schema.String),
})
export type EventCorrelation = typeof EventCorrelation.Type

/** Causation links (design §8.2): which previous event/command caused this one. */
export const EventCausation = Schema.Struct({
  causedByEventId: Schema.String.pipe(Schema.optional),
  causedByCommandId: Schema.String.pipe(Schema.optional),
  parentEventId: Schema.String.pipe(Schema.optional),
})
export type EventCausation = typeof EventCausation.Type

/** Registered event schema reference. */
export const EventSchemaRef = Schema.Struct({
  schemaId: Schema.String,
  schemaVersion: Schema.String,
})
export type EventSchemaRef = typeof EventSchemaRef.Type

/** Producer registration. */
export const EventProducer = Schema.Struct({
  producerId: Schema.String,
  producerKind: Schema.String,
})
export type EventProducer = typeof EventProducer.Type

/** Consumer registration flags (design §8.6: consumers register before producers). */
export const EventConsumerRegistry = Schema.Struct({
  consumerGroupId: Schema.String,
  registeredBeforeProduce: Schema.Boolean,
  flags: Schema.Record(Schema.String, Schema.Boolean),
})
export type EventConsumerRegistry = typeof EventConsumerRegistry.Type

/** Command-specific payload: the requested action and its references. */
export const CommandBody = Schema.Struct({
  action: Schema.String,
  targetRef: Schema.String.pipe(Schema.optional),
  parametersRef: Schema.String.pipe(Schema.optional),
  requirements: Schema.Array(Schema.String).pipe(Schema.optional),
})
export type CommandBody = typeof CommandBody.Type

/** Fact-specific payload: the committed outcome and its authority refs. */
export const FactBody = Schema.Struct({
  outcome: Schema.String,
  terminalHash: Schema.String.pipe(Schema.optional),
  authorityRef: Schema.String.pipe(Schema.optional),
})
export type FactBody = typeof FactBody.Type

/** Observation-specific payload: the observed metric / severity / external ref. */
export const ObservationBody = Schema.Struct({
  observedMetric: Schema.String.pipe(Schema.optional),
  severity: EventRisk.pipe(Schema.optional),
  externalRef: Schema.String.pipe(Schema.optional),
})
export type ObservationBody = typeof ObservationBody.Type

const eventCommon = {
  schemaVersion: Schema.Literal(EventVersion.schema),
  eventId: Schema.String,
  eventType: Schema.String,
  workspaceId: Schema.String,
  aggregate: EventAggregate,
  actor: EventActor,
  source: EventSource,
  correlation: EventCorrelation,
  causation: EventCausation,
  schema: EventSchemaRef,
  payload: EventPayload,
  producer: EventProducer,
  consumer: EventConsumerRegistry,
  idempotencyKey: Schema.String,
  recordedAt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
}

/** Discriminated-union member: command (request for work, not proof of completion). */
export class CommandEvent extends Schema.Class<CommandEvent>("EventEnvelope.CommandEvent")({
  ...eventCommon,
  kind: Schema.Literal("command"),
  command: CommandBody,
}) {}

/** Discriminated-union member: fact (durable authority already committed). */
export class FactEvent extends Schema.Class<FactEvent>("EventEnvelope.FactEvent")({
  ...eventCommon,
  kind: Schema.Literal("fact"),
  fact: FactBody,
}) {}

/** Discriminated-union member: observation (external/ops; must be verified before driving work). */
export class ObservationEvent extends Schema.Class<ObservationEvent>("EventEnvelope.ObservationEvent")({
  ...eventCommon,
  kind: Schema.Literal("observation"),
  observation: ObservationBody,
}) {}

/** The event envelope: a discriminated union of command | fact | observation. */
export const EventEnvelope = Schema.Union([CommandEvent, FactEvent, ObservationEvent])
export type EventEnvelope = typeof EventEnvelope.Type

// ---- EventWorkEnvelope (design §8.4, §8.8) --------------------------------

/** Verified fact refs admitted into a work envelope. */
export const VerifiedFactRef = Schema.Struct({
  factId: Schema.String,
  factHash: Schema.String,
})
export type VerifiedFactRef = typeof VerifiedFactRef.Type

/** Actor + scope snapshot carried into a work envelope. */
export const WorkScopeSnapshot = Schema.Struct({
  actorId: Schema.String,
  workspaceId: Schema.String,
  securityNamespaceId: Schema.String,
  projectScopeKey: Schema.String,
})
export type WorkScopeSnapshot = typeof WorkScopeSnapshot.Type

/** Bounded context query intent (design §6.1 query intent subset usable in a work envelope). */
export const WorkContextQuery = Schema.Struct({
  intent: Schema.Literals(["search", "recall", "related", "trace_evidence", "explain_decision", "find_conflicts"]),
  query: Schema.String.pipe(Schema.optional),
  sources: Schema.Array(Schema.Literals(["code", "documents", "knowledge", "memory"])).pipe(Schema.optional),
})
export type WorkContextQuery = typeof WorkContextQuery.Type

/** Per-work budget (design §8.8): bounded by workspace/agent/event root/hour. */
export const WorkBudget = Schema.Struct({
  maxTokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  maxToolCalls: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  maxDurationMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).pipe(Schema.optional),
  workspaceBudgetId: Schema.String.pipe(Schema.optional),
  agentBudgetId: Schema.String.pipe(Schema.optional),
  eventRoot: Schema.String.pipe(Schema.optional),
})
export type WorkBudget = typeof WorkBudget.Type

/** Delivery / claim metadata (design §8.6): lease fencing, bounded retry, exact-once-safe cursor. */
export const EventDelivery = Schema.Struct({
  consumerGroupId: Schema.String,
  leaseToken: Schema.String,
  leaseExpiresAt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).pipe(Schema.optional),
  attemptCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  dedupeId: Schema.String,
  exactlyOnceCursor: Schema.String,
  maxAttempts: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).pipe(Schema.optional),
})
export type EventDelivery = typeof EventDelivery.Type

/**
 * Bounded `EventWorkEnvelope` handed to a selected agent (design §8.4). It
 * deliberately does not carry arbitrary raw payload, headers or credentials:
 * the external event payload is referenced by content type + ref + hash, and any
 * external content must first pass schema decode, trust, permission, egress and
 * content trimming (§8.8) before it may influence the model.
 */
export class EventWorkEnvelope extends Schema.Class<EventWorkEnvelope>("EventEnvelope.EventWorkEnvelope")({
  schemaVersion: Schema.Literal(EventVersion.schema),
  eventRef: Schema.String,
  eventType: Schema.String,
  objective: Schema.String,
  payload: EventPayload,
  verifiedFacts: Schema.Array(VerifiedFactRef),
  requestedCapability: Schema.String,
  actorAndScope: WorkScopeSnapshot,
  trust: Schema.Struct({
    level: Schema.Literals(["verified", "derived", "unverified"]),
    sourceRef: Schema.String.pipe(Schema.optional),
  }),
  permission: Schema.Struct({
    scopes: Schema.Array(Schema.String),
    required: Schema.Array(Schema.String),
    maxAutonomy: EventRisk,
  }),
  egress: Schema.Struct({
    allowedDomains: Schema.Array(Schema.String),
    allowedSensitivities: Schema.Array(Schema.String),
  }),
  risk: EventRisk,
  autonomyCeiling: Schema.String,
  contextQuery: WorkContextQuery,
  budget: WorkBudget,
  correlationId: Schema.String,
  delivery: EventDelivery,
}) {}

/** Typed decode error carrying the offending JSON path for the EventEnvelope. */
export class EventEnvelopeDecodeError extends Schema.TaggedErrorClass<EventEnvelopeDecodeError>()(
  "EventEnvelope.DecodeError",
  { message: Schema.String, path: Schema.Array(Schema.String) },
) {}

/** Typed decode error carrying the offending JSON path for the EventWorkEnvelope. */
export class EventWorkEnvelopeDecodeError extends Schema.TaggedErrorClass<EventWorkEnvelopeDecodeError>()(
  "EventWorkEnvelope.DecodeError",
  { message: Schema.String, path: Schema.Array(Schema.String) },
) {}

export type EventEnvelopeValidation =
  | { readonly ok: true; readonly value: EventEnvelope }
  | { readonly ok: false; readonly error: EventEnvelopeDecodeError }

export type EventWorkEnvelopeValidation =
  | { readonly ok: true; readonly value: EventWorkEnvelope }
  | { readonly ok: false; readonly error: EventWorkEnvelopeDecodeError }

function extractErrorPath(error: unknown): string[] {
  const message = error instanceof Error ? error.message : String(error)
  const atIndex = message.indexOf("\n  at ")
  if (atIndex === -1) return []
  const lineStart = atIndex + 6
  const lineEnd = message.indexOf("\n", lineStart)
  const tail = lineEnd === -1 ? message.slice(lineStart) : message.slice(lineStart, lineEnd)
  const segments: string[] = []
  const re = /\[([^\]]*)\]/g
  let current: RegExpExecArray | null
  while ((current = re.exec(tail)) !== null) {
    const raw = current[1]!
    segments.push(raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw)
  }
  return segments
}

/** Decode an EventEnvelope (command | fact | observation). Extra properties are rejected. */
export const decodeEventEnvelope = (input: unknown): EventEnvelope => {
  try {
    return Schema.decodeUnknownSync(EventEnvelope, { onExcessProperty: "error" })(input)
  } catch (error) {
    throw new EventEnvelopeDecodeError({
      message: error instanceof Error ? error.message : String(error),
      path: extractErrorPath(error),
    })
  }
}

/** Encode an EventEnvelope to its schema-derived JSON shape. */
export const encodeEventEnvelope = (value: EventEnvelope): EventEnvelope => Schema.encodeSync(EventEnvelope)(value)

/** Non-throwing validation of an EventEnvelope. */
export const validateEventEnvelope = (input: unknown): EventEnvelopeValidation => {
  try {
    return { ok: true, value: Schema.decodeUnknownSync(EventEnvelope, { onExcessProperty: "error" })(input) }
  } catch (error) {
    return {
      ok: false,
      error: new EventEnvelopeDecodeError({
        message: error instanceof Error ? error.message : String(error),
        path: extractErrorPath(error),
      }),
    }
  }
}

/** Decode an EventWorkEnvelope. Extra properties are rejected. */
export const decodeEventWorkEnvelope = (input: unknown): EventWorkEnvelope => {
  try {
    return Schema.decodeUnknownSync(EventWorkEnvelope, { onExcessProperty: "error" })(input)
  } catch (error) {
    throw new EventWorkEnvelopeDecodeError({
      message: error instanceof Error ? error.message : String(error),
      path: extractErrorPath(error),
    })
  }
}

/** Encode an EventWorkEnvelope to its schema-derived JSON shape. */
export const encodeEventWorkEnvelope = (value: EventWorkEnvelope): EventWorkEnvelope =>
  Schema.encodeSync(EventWorkEnvelope)(value)

/** Non-throwing validation of an EventWorkEnvelope. */
export const validateEventWorkEnvelope = (input: unknown): EventWorkEnvelopeValidation => {
  try {
    return { ok: true, value: Schema.decodeUnknownSync(EventWorkEnvelope, { onExcessProperty: "error" })(input) }
  } catch (error) {
    return {
      ok: false,
      error: new EventWorkEnvelopeDecodeError({
        message: error instanceof Error ? error.message : String(error),
        path: extractErrorPath(error),
      }),
    }
  }
}

/** Byte-stable canonical content digest of an EventEnvelope (timestamp-independent). */
export const eventEnvelopeDigest = (value: EventEnvelope): string => contentDigest(value)

/** Byte-stable canonical content digest of an EventWorkEnvelope (timestamp-independent). */
export const eventWorkEnvelopeDigest = (value: EventWorkEnvelope): string => contentDigest(value)
