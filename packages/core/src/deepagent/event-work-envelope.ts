export * as EventWorkEnvelope from "./event-work-envelope"

import {
  type EventPayload,
  type EventRisk,
  type EventWorkEnvelope as WorkEnvelope,
  type VerifiedFactRef,
  type WorkBudget,
  type WorkContextQuery,
  EventVersion,
  validateEventWorkEnvelope,
} from "../contract/event-envelope"
import { isCoordinationEvent, isOperationalEvent } from "./event-router"
import type { EventTypeRegistration, RegisteredEventEnvelope } from "./event-registry"

// C5-03 — event -> bounded EventWorkEnvelope builder.
// Design authority: docs/core-v2.0-beta/design.md §8.4 (work envelope) + §8.8 (防止模型被事件噪声淹没).
//
// Invariants enforced here:
//   1. The envelope handed to a model is BOUNDED: it carries the external event's *payload reference*
//      (content type + ref + hash), NEVER the raw payload bytes, credentials or an unbounded message
//      history (design §8.2 "外部 payload 保存为 artifact/reference；进入模型前经过…内容裁剪").
//   2. It never reaches the model for operational / coordination noise (heartbeat, progress, dlq,
//      agent coordination) — those are for observability/oversight, never the prompt (§8.8).
//   3. Trust / permission / egress / budget are carried in full so the runner and SecurityGate can
//      enforce them without re-deriving from raw event data.
//
// LAYERING: `core`. No session / runtime imports; the caller resolves trust/permission/egress/budget
// (e.g. from the Context Epoch + capability load) and passes them in.

/** A trust level the caller has verified for this event (design §8.4). */
export type TrustLevel = "verified" | "derived" | "unverified"

/** Resolution the caller computes before the builder — never derived from raw payload. */
export interface WorkResolution {
  readonly trust: { readonly level: TrustLevel; readonly sourceRef?: string }
  readonly permission: { readonly scopes: ReadonlyArray<string>; readonly required: ReadonlyArray<string>; readonly maxAutonomy: EventRisk }
  readonly egress: { readonly allowedDomains: ReadonlyArray<string>; readonly allowedSensitivities: ReadonlyArray<string> }
  readonly budget: WorkBudget
  readonly securityNamespaceId: string
  readonly projectScopeKey: string
  readonly contextQuery: WorkContextQuery
}

export interface BuildWorkInput {
  /** A registry-validated envelope (see `EventRegistry.assertPublishable`). */
  readonly event: RegisteredEventEnvelope
  /** The registered metadata that supplies the objective / capability / autonomy ceiling. */
  readonly registration: EventTypeRegistration
  readonly resolution: WorkResolution
  readonly verifiedFacts: ReadonlyArray<VerifiedFactRef>
}

export type BuildWorkResult =
  | { readonly ok: true; readonly envelope: WorkEnvelope }
  | { readonly ok: false; readonly reason: "noise_event" | "unbounded_payload"; readonly message: string }

/** True when an event type is coordination/operational noise that must never enter the prompt (§8.8). */
export const isNoiseEvent = (eventType: string): boolean =>
  isCoordinationEvent(eventType) || isOperationalEvent(eventType)

/**
 * Build a bounded `EventWorkEnvelope`. The external event's payload is referenced by `EventPayload`
 * (contentType + ref + hash); raw payload content is a TYPE error at this boundary and the produced
 * envelope is re-validated against the frozen contract. Coordination / operational noise is refused.
 */
export const build = (input: BuildWorkInput): BuildWorkResult => {
  const { event, registration, resolution, verifiedFacts } = input

  if (isNoiseEvent(event.eventType)) {
    return {
      ok: false,
      reason: "noise_event",
      message: `event "${event.eventType}" is operational/coordination noise and must not enter the prompt (design §8.8)`,
    }
  }

  // BOUNDED PAYLOAD REF — reject an envelope whose payload reference carries raw content. The contract's
  // EventPayload has exactly { contentType, ref, payloadHash }; any other member means an unbounded
  // payload leaked through, which the builder refuses.
  if (!isBoundedPayload(event.payload)) {
    return {
      ok: false,
      reason: "unbounded_payload",
      message: `event "${event.eventType}" payload is not a bounded reference (contentType/ref/payloadHash only)`,
    }
  }

  const envelope: WorkEnvelope = {
    schemaVersion: EventVersion.workEnvelope,
    eventRef: `event://${event.eventId}`,
    eventType: event.eventType,
    objective: registration.objective,
    payload: event.payload,
    verifiedFacts: [...verifiedFacts],
    requestedCapability: registration.requestedCapability,
    actorAndScope: {
      actorId: event.actor.actorId,
      workspaceId: event.workspaceId,
      securityNamespaceId: resolution.securityNamespaceId,
      projectScopeKey: resolution.projectScopeKey,
    },
    trust: { level: resolution.trust.level, ...(resolution.trust.sourceRef != null ? { sourceRef: resolution.trust.sourceRef } : {}) },
    permission: {
      scopes: [...resolution.permission.scopes],
      required: [...resolution.permission.required],
      maxAutonomy: resolution.permission.maxAutonomy,
    },
    egress: {
      allowedDomains: [...resolution.egress.allowedDomains],
      allowedSensitivities: [...resolution.egress.allowedSensitivities],
    },
    risk: registration.risk,
    autonomyCeiling: registration.autonomyCeiling,
    contextQuery: { ...resolution.contextQuery },
    budget: { ...resolution.budget },
    correlationId: event.correlation.correlationId,
    delivery: {
      consumerGroupId: `event.${event.eventType}`,
      leaseToken: "",
      leaseExpiresAt: 0,
      attemptCount: 0,
      dedupeId: event.idempotencyKey,
      exactlyOnceCursor: event.eventId,
      maxAttempts: 3,
    },
  }

  // Re-validate the assembled envelope — the builder never emits a shape the frozen contract rejects.
  const validation = validateEventWorkEnvelope(envelope)
  if (!validation.ok) {
    return {
      ok: false,
      reason: "unbounded_payload",
      message: `assembled work envelope for "${event.eventType}" failed contract validation: ${validation.error.message}`,
    }
  }
  return { ok: true, envelope: validation.value }
}

const isBoundedPayload = (payload: EventPayload): boolean => {
  const keys = new Set(Object.keys(payload))
  return keys.size === 3 && keys.has("contentType") && keys.has("ref") && keys.has("payloadHash")
}
