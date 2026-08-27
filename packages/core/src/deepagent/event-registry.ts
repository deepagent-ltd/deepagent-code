export * as EventRegistry from "./event-registry"

import {
  type EventCausation,
  type EventEnvelope,
  type EventKind,
  type EventRisk,
  type EventSourceKind,
} from "../contract/event-envelope"

// C5-01 — Event envelope schema registry + publisher policy.
// Design authority: docs/core-v2.0-beta/design.md §8 (event-driven agent system),
// §8.2 (event classes), §8.8 (模型不能通过输出任意 event type 自我扩权，publisher 只接受注册 schema
// 和允许的 causation).
//
// This is PURE + deterministic: it has no Effect, no DB, no clock. Producers and the
// outbox publisher register their event types up front (the registry is seeded from code at
// startup); the publisher policy FAILS CLOSED on any envelope that is NOT registered, whose
// kind/schema does not match the registration, or whose causation is not allowed. A model
// outputting an arbitrary event type therefore can never self-authorize work — only a type a
// trusted producer registered may be published.

/** A causation link key carried on a frozen EventEnvelope (design §8.2). */
export type CausationKey = keyof EventCausation

/** How a registered event type may be caused (design §8.2, §8.8: publisher accepts allowed causation only). */
export type CausationPolicy = {
  /** Causation keys this event type is permitted to carry. An empty array forbids any causation link. */
  readonly allowed: ReadonlyArray<CausationKey>
  /** When true at least one of `allowed` must be present on the envelope. */
  readonly requiresCause: boolean
}

/** A registered event type: the schema the publisher accepts and the metadata the work-envelope builder needs. */
export interface EventTypeRegistration {
  readonly eventType: string
  readonly kind: EventKind
  /** Frozen `EventSchemaRef.schemaId` the publisher requires on the envelope. */
  readonly schemaId: string
  /** Frozen `EventSchemaRef.schemaVersion` the publisher requires on the envelope. */
  readonly schemaVersion: string
  /** Expected `EventPayload.contentType` — the external payload reference's content type. */
  readonly payloadContentType: string
  /** Registered payload schema version tag (bound to the schema; a payload schema bump is a new registration). */
  readonly payloadVersion: string
  /** Producer `producerKind` values trusted to publish this type. */
  readonly allowedProducerKinds: ReadonlyArray<string>
  /** `source.sourceKind` values this type may originate from. */
  readonly allowedSourceKinds: ReadonlyArray<EventSourceKind>
  readonly causation: CausationPolicy
  /** Default safety risk for work derived from this type (design §8.4). */
  readonly risk: EventRisk
  /** The work objective string handed to the agent (design §8.4). */
  readonly objective: string
  /** The capability an agent needs to do the work (design §8.4). */
  readonly requestedCapability: string
  /** Autonomy ceiling the work may not exceed (design §8.4). */
  readonly autonomyCeiling: string
}

/** A registry of registered event types, keyed by eventType. */
export interface EventRegistry {
  readonly registrations: ReadonlyMap<string, EventTypeRegistration>
  readonly register: (registration: EventTypeRegistration) => EventRegistry
  readonly lookup: (eventType: string) => EventTypeRegistration | undefined
  readonly eventTypes: () => ReadonlyArray<string>
  readonly size: number
}

/** Why a publish was refused. Fail-closed order is documented per member. */
export type PublishRejectionReason =
  | "unregistered_type"
  | "kind_mismatch"
  | "schema_mismatch"
  | "payload_hash_missing"
  | "payload_hash_malformed"
  | "payload_content_type_mismatch"
  | "causation_forbidden"
  | "producer_forbidden"
  | "source_forbidden"

export type PublishVerdict =
  | { readonly ok: true; readonly registration: EventTypeRegistration }
  | { readonly ok: false; readonly reason: PublishRejectionReason; readonly message: string }

/** Typed error thrown by `assertPublishable`. */
export class EventPublishError extends Error {
  readonly _tag = "EventRegistry.EventPublishError"
  readonly reason: PublishRejectionReason
  readonly eventType: string
  constructor(reason: PublishRejectionReason, eventType: string, message: string) {
    super(message)
    this.name = "EventPublishError"
    this.reason = reason
    this.eventType = eventType
  }
}

/** A registration that has passed the publisher policy — the outbox accepts only this (no bypass). */
export type RegisteredEventEnvelope = EventEnvelope & { readonly __registered: unique symbol }

const HEX64 = /^[0-9a-f]{64}$/

const presentKeys = (causation: EventCausation): ReadonlyArray<CausationKey> => {
  const present: CausationKey[] = []
  if (causation.causedByEventId !== undefined) present.push("causedByEventId")
  if (causation.causedByCommandId !== undefined) present.push("causedByCommandId")
  if (causation.parentEventId !== undefined) present.push("parentEventId")
  return present
}

/** Create an empty registry, or seed it with one or more registrations. */
export const createEventRegistry = (seed?: ReadonlyArray<EventTypeRegistration>): EventRegistry => {
  const map = new Map<string, EventTypeRegistration>()
  for (const registration of seed ?? []) map.set(registration.eventType, registration)
  const register = (registration: EventTypeRegistration): EventRegistry =>
    createEventRegistry([...map.values(), registration])
  return {
    registrations: map,
    register,
    lookup: (eventType) => map.get(eventType),
    eventTypes: () => [...map.keys()],
    size: map.size,
  }
}

/**
 * Evaluate the publisher policy against a frozen EventEnvelope. FAIL-CLOSED, deterministic:
 *   1. `unregistered_type`   — the event type is not in the registry.
 *   2. `kind_mismatch`       — envelope.kind != the registered kind.
 *   3. `schema_mismatch`     — envelope.schema.schemaId/schemaVersion != registered.
 *   4. `payload_content_type_mismatch` — envelope.payload.contentType != registered.
 *   5. `payload_hash_missing` / `payload_hash_malformed` — no 64-hex payload hash.
 *   6. `causation_forbidden` — a present causation key is not allowed, or a required cause is absent.
 *   7. `producer_forbidden`  — envelope.producer.producerKind not trusted.
 *   8. `source_forbidden`    — envelope.source.sourceKind not allowed.
 * Only an ok verdict yields a `RegisteredEventEnvelope` the outbox will accept.
 */
export const validatePublish = (registry: EventRegistry, envelope: EventEnvelope): PublishVerdict => {
  const registration = registry.lookup(envelope.eventType)
  if (!registration) {
    return {
      ok: false,
      reason: "unregistered_type",
      message: `event type "${envelope.eventType}" is not registered with the event registry`,
    }
  }
  if (envelope.kind !== registration.kind) {
    return {
      ok: false,
      reason: "kind_mismatch",
      message: `event "${envelope.eventType}" declares kind "${envelope.kind}" but is registered as "${registration.kind}"`,
    }
  }
  if (envelope.schema.schemaId !== registration.schemaId || envelope.schema.schemaVersion !== registration.schemaVersion) {
    return {
      ok: false,
      reason: "schema_mismatch",
      message: `event "${envelope.eventType}" uses schema "${envelope.schema.schemaId}@${envelope.schema.schemaVersion}" but "${registration.schemaId}@${registration.schemaVersion}" is registered`,
    }
  }
  if (envelope.payload.contentType !== registration.payloadContentType) {
    return {
      ok: false,
      reason: "payload_content_type_mismatch",
      message: `event "${envelope.eventType}" payload contentType "${envelope.payload.contentType}" != registered "${registration.payloadContentType}"`,
    }
  }
  if (envelope.payload.payloadHash.length === 0) {
    return {
      ok: false,
      reason: "payload_hash_missing",
      message: `event "${envelope.eventType}" carries no payload hash (external payload must be referenced by hash)`,
    }
  }
  if (!HEX64.test(envelope.payload.payloadHash)) {
    return {
      ok: false,
      reason: "payload_hash_malformed",
      message: `event "${envelope.eventType}" payload hash "${envelope.payload.payloadHash}" is not a 64-char lowercase hex digest`,
    }
  }
  for (const present of presentKeys(envelope.causation)) {
    if (!registration.causation.allowed.includes(present)) {
      return {
        ok: false,
        reason: "causation_forbidden",
        message: `event "${envelope.eventType}" causation key "${present}" is not allowed by its registration`,
      }
    }
  }
  if (registration.causation.requiresCause && presentKeys(envelope.causation).length === 0) {
    return {
      ok: false,
      reason: "causation_forbidden",
      message: `event "${envelope.eventType}" requires a cause but carries no causation link`,
    }
  }
  if (!registration.allowedProducerKinds.includes(envelope.producer.producerKind)) {
    return {
      ok: false,
      reason: "producer_forbidden",
      message: `event "${envelope.eventType}" producer kind "${envelope.producer.producerKind}" is not a trusted publisher`,
    }
  }
  if (!registration.allowedSourceKinds.includes(envelope.source.sourceKind)) {
    return {
      ok: false,
      reason: "source_forbidden",
      message: `event "${envelope.eventType}" source kind "${envelope.source.sourceKind}" is not allowed for this type`,
    }
  }
  return { ok: true, registration }
}

/** Non-throwing companion to `assertPublishable`. */
export const assertPublishable = (registry: EventRegistry, envelope: EventEnvelope): RegisteredEventEnvelope => {
  const verdict = validatePublish(registry, envelope)
  if (!verdict.ok) throw new EventPublishError(verdict.reason, envelope.eventType, verdict.message)
  return envelope as RegisteredEventEnvelope
}

/** The registration metadata for a type that a work-envelope builder consumes (design §8.4). */
export const registrationFor = (registry: EventRegistry, eventType: string): EventTypeRegistration => {
  const registration = registry.lookup(eventType)
  if (!registration) {
    throw new EventPublishError("unregistered_type", eventType, `event type "${eventType}" is not registered`)
  }
  return registration
}
