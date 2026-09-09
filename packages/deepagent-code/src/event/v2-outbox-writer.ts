export * as V2OutboxWriter from "./v2-outbox-writer"

import { Effect } from "effect"
import { EventV2 } from "@deepagent-code/core/event"
import type { Database } from "@deepagent-code/core/database/database"
import { contentDigest } from "@deepagent-code/core/contract/digest"
import { decodeEventEnvelope, type EventEnvelope } from "@deepagent-code/core/contract/event-envelope"
import { EventOutbox, type OutboxRow } from "@deepagent-code/core/deepagent/event-outbox"
import { EventConsumer } from "@deepagent-code/core/deepagent/event-consumer"
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
//   - PUBLISH → ROW, SAME TRANSACTION (design §8.3): the landing runs inside `PublishOptions.commit`,
//     which `commitSyncEvent` executes IN the same transaction as the EventV2 event row. The event and
//     its outbox mirror commit or roll back together — there is NO window in which the event is durable
//     and the outbox row is missing. A landing failure fails the publish transaction (fail-closed: the
//     caller sees the failure and no event row survives — never a silent missing outbox row).
//   - EXACT-RETRY FENCE: an exact idempotent re-publish re-runs the commit hook for the already-stored
//     event, but `land` is keyed by the UNIQUE `eventv2:<eventId>` (idempotency key) and returns
//     `already_landed` — one row, one dispatch, no duplicate effect. The same fence covers a replayed
//     commit: the EventV2Bridge also threads an in-transaction `onCommit` into `EventV2.replay` /
//     `replayAll`, so a replayed event id lands at most once under the same key.
//   - REPLAY SCOPE: EventV2 replay (sync/import/control-plane re-commit of the serialized event log) IS
//     a production driver, and the bridge lands its commits in-transaction (same key, same fence). An
//     event that never reached this DB in the first place (fresh import) gets its outbox row at replay
//     commit time — the C5 consumers observe imported session lifecycle facts exactly like locally
//     published ones.
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
const SESSION_LIFECYCLE_FACTS = [
  "session.created",
  "session.updated",
  "session.diff",
  "session.revert",
  "session.deleted",
  "session.next.prompt.admitted",
  "session.next.prompt.promoted",
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
] as const

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

/** The deterministic C5 registration lookup used by the publish surface. */
export const registrationForEventType = (eventType: string, registry: Registry): EventTypeRegistration | undefined =>
  registry.lookup(eventType)

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
export const envelopeFor = (event: EventV2.Payload, registration: EventTypeRegistration): EventEnvelope => {
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
 * Land an EventV2 publish into `deepagent_event_outbox`. Idempotent on `eventv2:<eventId>`: an exact
 * retry (the commit hook re-runs for an already-stored event) returns `already_landed` with the
 * surviving row — never a second row, never a second dispatch. Fail-closed: the envelope is re-validated
 * against the registration (kind/schema/policy) and a mismatch is a typed `EventPublishError` — which,
 * because the EventV2Bridge calls `land` inside `PublishOptions.commit`, rolls back the whole publish
 * transaction (no durable event without its outbox row, design §8.3).
 */
export function land(db: DatabaseClient, input: LandInput): Effect.Effect<LandResult, EventRegistry.EventPublishError> {
  return Effect.gen(function* () {
    // The envelope asserts registeredBeforeProduce=true. Make that statement durable in the SAME
    // transaction immediately before the first outbox insert; startup registration alone has a
    // race with early producers and cannot prove this invariant after a crash.
    yield* EventConsumer.register(db, {
      consumerKey: "runtime",
      deliveryContractVersion: "event.v1",
      now: input.now,
    }).pipe(Effect.orDie)
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
