export * as V2OutboxWriter from "./v2-outbox-writer"

import { Effect } from "effect"
import { EventV2 } from "@deepagent-code/core/event"
import type { Database } from "@deepagent-code/core/database/database"
import { contentDigest } from "@deepagent-code/core/contract/digest"
import {
  decodeEventEnvelope,
  type EventEnvelope,
} from "@deepagent-code/core/contract/event-envelope"
import {
  EventOutbox,
  type OutboxRow,
} from "@deepagent-code/core/deepagent/event-outbox"
import {
  EventRegistry,
  type EventRegistry as Registry,
  type EventTypeRegistration,
  type RegisteredEventEnvelope,
} from "@deepagent-code/core/deepagent/event-registry"

// W5 · 事件接线与诚实化 ① 运行时写入器.
// Design authority: docs/core-v2.0-beta/v2.0-design.md W5.1 + design.md §8.3 (跨 aggregate publish 必须先
// 写 durable outbox; outbox publisher claim/lease + idempotency key) + audit/a4-events.md §2.2 (the C5
// outbox ledger exists — `deepagent_event_outbox` — but has ZERO production importers).
//
// THIS IS THE WRITER: the database landing of events published through the EventV2 consumer-registry
// interface (`EventV2.publish` via the production `EventV2Bridge` publish surface). It mirrors a
// published EventV2 `Payload` into a `deepagent_event_outbox` row (the C5 single-write-ahead ledger for
// cross-aggregate events) so consumers of the C5 ledger see exactly the events the session plane
// durably published — the C5 outbox publisher (claim/lease) then dispatches them under the SAME
// idempotency key, which is the "no duplicate effect" guarantee:
//
//   - PUBLISH → ROW: the row is written AFTER the EventV2 publish committed (the EventV2 sync event row
//     and the outbox row are the durable record; the row is keyed idempotency_key = `eventv2:<eventId>`).
//   - CRASH-WINDOW REPLAY: a process crash after publish but before the downstream effect (the C5
//     consumer's side effect) leaves the outbox row; a replay re-publishes the same event id — EventV2
//     exact-retry returns the already-committed event (no second projection) and `land` returns
//     `already_landed` (the UNIQUE idempotency key is the fence) — the effect is never duplicated.
//
// AUTHORITY / FAIL-CLOSED: the outbox only accepts envelopes the C5 registry validated
// (`EventOutbox.enqueue` rejects unregistered / kind / schema / causation mismatches — design §8.8
// "模型不能通过输出任意 event type 自我扩权"). The writer therefore lands ONLY event types that have a
// C5 `EventTypeRegistration` (docs comment on `EVENT_V2_OUTBOX_REGISTRY` below); everything else is
// skipped at the call site (a session tool-delta is not a C5 cross-aggregate event — hot path untouched).
//
// LAYERING: `deepagent-code`. Imports core fully (C5 outbox + registry + the frozen EventEnvelope
// contract); pure mapping + a single idempotent write, no session or runtime imports.

type DatabaseClient = Database.Interface["db"]

/** The deterministic outbox idempotency key for an EventV2 event id (UNIQUE column — replay fence). */
export const outboxIdempotencyKey = (eventId: string): string => `eventv2:${eventId}`

/**
 * The C5 registrations for the EventV2 event types this writer lands. Registration is the extension
 * point: a type only lands once it has a C5 registration (kind/schema/policy), because the outbox
 * refuses arbitrary self-authorizing types (design §8.8). Seeded with the SESSION LIFECYCLE facts —
 * the cross-aggregate session events every consumer plane (SSE / archive / UI) observes; session tool
 * deltas and other non-registered types are intentionally absent.
 *
 * NOTE: the C5 EventEnvelope is frozen, so the mappings use the registration's kind + schema; a new
 * type must go through the C5/contract registration procedure (contract successor rules) — never a
 * schema edit here.
 */
const SESSION_LIFECYCLE_FACTS = ["session.created", "session.updated", "session.deleted"] as const

const factRegistration = (eventType: string): EventTypeRegistration => ({
  eventType,
  kind: "fact",
  schemaId: `${eventType}.schema`,
  schemaVersion: "1",
  payloadContentType: "application/json",
  payloadVersion: "v1",
  allowedProducerKinds: ["eventv2"],
  allowedSourceKinds: ["system"],
  causation: { allowed: [], requiresCause: false },
  risk: "low",
  objective: `record the ${eventType} fact`,
  requestedCapability: "deepagent.session.observe",
  autonomyCeiling: "low",
})

/** The default C5 registry seed (documented above). Callers may pass their own `EventRegistry`. */
export const EVENT_V2_OUTBOX_REGISTRY: Registry = EventRegistry.createEventRegistry(
  SESSION_LIFECYCLE_FACTS.map(factRegistration),
)

let defaultRegistry: Registry = EVENT_V2_OUTBOX_REGISTRY

/**
 * Register an additional C5 event type for the outbox landing (the designed extension point: a type
 * only lands once registered — the outbox refuses arbitrary self-authorizing types). Production seeds
 * the documented defaults; wiring/tests register their own types at startup.
 */
export function register(registration: EventTypeRegistration): void {
  defaultRegistry = defaultRegistry.register(registration)
}

/** The deterministic C5 registration lookup used by the publish surface. */
export const registrationForEventType = (
  eventType: string,
  registry: Registry = defaultRegistry,
): EventTypeRegistration | undefined => registry.lookup(eventType)

/**
 * PURE mapping: an EventV2 `Payload` → a frozen C5 `EventEnvelope`, under a caller-supplied
 * registration. Deterministic (same event + registration ⇒ same envelope + digest):
 *   - identity      — eventId/eventType/workspaceId from the payload (workspace falls back to "").
 *   - aggregate     — the EventV2 sync aggregate field when the definition declares one (sessionID),
 *                     else the event id itself; aggregateType mirrors the event type.
 *   - payload       — referenced by ref + content digest only (raw bytes never enter the ledger).
 *   - producer      — eventv2 (must match `registration.allowedProducerKinds`, see the seed).
 *   - recordedAt    — 0: the EventV2 payload carries no timestamp; keeps the digest replay-stable.
 */
export const envelopeFor = (
  event: EventV2.Payload,
  registration: EventTypeRegistration,
): EventEnvelope => {
  const data = (event.data ?? {}) as Record<string, unknown>
  const syncAggregate = EventV2.registry.get(event.type)?.sync?.aggregate
  const aggregateID =
    typeof syncAggregate === "string" && typeof data[syncAggregate] === "string"
      ? (data[syncAggregate] as string)
      : event.id
  const body =
    registration.kind === "command"
      ? {
          action: event.type,
          targetRef: `event://${event.id}`,
          requirements: [registration.requestedCapability],
        }
      : registration.kind === "fact"
        ? { outcome: event.type, authorityRef: `event://${event.id}` }
        : { observedMetric: event.type, externalRef: `event://${event.id}` }
  return decodeEventEnvelope({
    schemaVersion: "event.v1",
    eventId: event.id,
    eventType: event.type,
    workspaceId: event.location?.workspaceID ?? "",
    aggregate: { aggregateId: aggregateID, aggregateType: event.type, aggregateRevision: 0 },
    actor: { actorId: "eventv2", actorType: "system" },
    source: { sourceId: "eventv2", sourceKind: "system" },
    correlation: { correlationId: event.id, causalChain: [] },
    causation: {},
    schema: { schemaId: registration.schemaId, schemaVersion: registration.schemaVersion },
    payload: {
      contentType: registration.payloadContentType,
      ref: `event://${event.id}`,
      payloadHash: contentDigest(event.data),
    },
    producer: { producerId: "eventv2", producerKind: "eventv2" },
    consumer: { consumerGroupId: "runtime", registeredBeforeProduce: true, flags: {} },
    idempotencyKey: outboxIdempotencyKey(event.id),
    recordedAt: 0,
    kind: registration.kind,
    ...(registration.kind === "command" ? { command: body } : {}),
    ...(registration.kind === "fact" ? { fact: body } : {}),
    ...(registration.kind === "observation" ? { observation: body } : {}),
  })
}

export type LandResult =
  | { readonly kind: "landed"; readonly row: OutboxRow }
  | { readonly kind: "already_landed"; readonly row: OutboxRow }

export interface LandInput {
  readonly event: EventV2.Payload
  readonly registration: EventTypeRegistration
  readonly now: number
}

/**
 * Land an EventV2 publish into `deepagent_event_outbox`. Idempotent on `eventv2:<eventId>`: a replay
 * (crash window: publish committed, downstream effect not run) returns `already_landed` with the
 * surviving row — never a second row, never a second dispatch. Fail-closed: the envelope is re-validated
 * against the registration (kind/schema/policy) and a mismatch is a typed `EventPublishError`.
 */
export function land(db: DatabaseClient, input: LandInput): Effect.Effect<LandResult, EventRegistry.EventPublishError> {
  return Effect.gen(function* () {
    const envelope = envelopeFor(input.event, input.registration)
    const existing = yield* EventOutbox.byIdempotencyKey(db, envelope.idempotencyKey)
    if (existing) return { kind: "already_landed", row: existing }
    const registry = EventRegistry.createEventRegistry([input.registration])
    const verdict = EventRegistry.validatePublish(registry, envelope)
    if (!verdict.ok) {
      return yield* Effect.fail(
        new EventRegistry.EventPublishError(verdict.reason, envelope.eventType, verdict.message),
      )
    }
    const row = yield* EventOutbox.enqueue(db, {
      registry,
      event: envelope as RegisteredEventEnvelope,
      aggregateType: envelope.aggregate.aggregateType,
      aggregateId: envelope.aggregate.aggregateId,
      now: input.now,
    })
    return { kind: "landed", row }
  })
}

/** The outbox row for an EventV2 event id (replay fence check + admin visibility). */
export function forEvent(db: DatabaseClient, eventId: string): Effect.Effect<OutboxRow | undefined> {
  return EventOutbox.byIdempotencyKey(db, outboxIdempotencyKey(eventId))
}
