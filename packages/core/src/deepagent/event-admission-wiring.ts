export * as EventAdmissionWiring from "./event-admission-wiring"

import { Effect } from "effect"
import { EventWorkEnvelope as WorkEnvelopePolicy } from "./event-work-envelope"
import { EventAdmission } from "./event-admission"
import type { EventTypeRegistration, RegisteredEventEnvelope } from "./event-registry"
import type { Database } from "../database/database"
import type {
  EventWorkEnvelope as WorkEnvelope,
  VerifiedFactRef,
  WorkBudget,
  WorkContextQuery,
} from "../contract/event-envelope"
import type { WorkResolution } from "./event-work-envelope"

// C5-04 — the production bridge between the C5 event runtime and the V2 admission path.
// Design authority: docs/core-v2.0-beta/design.md §8.4 (routing → work envelope → V2 admission receipt
// binds the envelope hash), §8.7 (event turn runners must call SessionV2/SessionExecution) and §8.8
// (bounded work, anti-noise, budget per workspace/agent/event-root/hour).
//
// This is the mapping E4a deferred: `EventAdmission.admit` had NO production caller. Here the C5 event
// runtime resolves a registry-validated event + registration + an explicit scope into a concrete
// `AdmitInput`-ready shape, builds the bounded `EventWorkEnvelope`, and drives `EventAdmission.admit` as
// durable V2 session work.
//
// AUTHORITY: the mapping NEVER trusts the raw payload for authority. The event must be registry-validated
// first (`EventRegistry.assertPublishable` — callers pass the result in as `RegisteredEventEnvelope`);
// this module only lifts the bounded payload REF (contentType/ref/hash) into the envelope. Trust is
// derived from the caller's scope, never from the payload:
//   - a registry-verified source            ⇒ trust level `verified`
//   - an authorized trigger match (router)  ⇒ trust level `derived`
//   - anything else                         ⇒ `unverified` AND a typed refusal (§8.4: never trust raw
//                                              routing / an unresolved source).
//
// FAIL-CLOSED refusals (each a typed `AdmissionResolveReason`, mapped by `admitWork` to an Effect failure):
//   `unverified_trust_refused` — neither a verified source nor an authorized trigger.
//   `over_budget`              — the event declares a per-work token intent above the frozen default.
//   `noise_event`/`unbounded_payload`/`invalid_envelope` — surfaced by the bounded-envelope builder.
//
// LAYERING: `core`. The only session dependency is the caller-injected `adapter` (`SessionV2.prompt` in
// production wiring), so this module has no legacy-session or runtime import — matching event-admission.ts.

/** Frozen per-work budget default (design §8.8). The contract exposes NO default constants; the mapping
 * owns the frozen default and refuses an event that declares a per-work intent above it. */
export const DEFAULT_WORK_BUDGET: WorkBudget = {
  maxTokens: 20_000,
  maxToolCalls: 12,
  maxDurationMs: 300_000,
  hourTokensMax: 10_000,
  hourWindowMinutes: 60,
}

/** The explicit routing scope a caller resolves before the mapping (workspace / security-namespace /
 * project / principal, design §8.4 `actor_and_scope`). Trust hints are supplied by the caller, never
 * derived from raw payload. */
export interface AdmissionScope {
  readonly workspaceId: string
  readonly securityNamespaceId: string
  readonly projectScopeKey: string
  readonly principal: string
  readonly sessionID: string
  /** A registry-verified source identity (design §8.2) ⇒ trust level `verified`. */
  readonly verifiedSource?: { readonly sourceRef: string }
  /** The router authorized this trigger (it returned `dispatch` for the event) ⇒ trust level `derived`. */
  readonly authorizedTrigger?: boolean
  /** Optional per-event work intent, used ONLY for the over-budget refusal + declared scopes. */
  readonly declared?: {
    readonly maxTokens?: number
    readonly scopes?: ReadonlyArray<string>
  }
}

/** Why the mapping refused an event (fail-closed). */
export type AdmissionResolveReason =
  | "noise_event"
  | "unbounded_payload"
  | "unverified_trust_refused"
  | "over_budget"
  | "invalid_envelope"

/** Typed refusal thrown through the Effect failure channel (never a buried throw). */
export class EventAdmissionWiringError extends Error {
  readonly _tag = "EventAdmissionWiring.EventAdmissionWiringError"
  readonly reason: AdmissionResolveReason
  readonly eventId: string
  constructor(reason: AdmissionResolveReason, eventId: string, message: string) {
    super(message)
    this.name = "EventAdmissionWiringError"
    this.reason = reason
    this.eventId = eventId
  }
}

/** The typed result of `resolveAdmissionInput`. `ok:false` carries a fail-closed reason; `admitWork`
 * lifts it into an Effect failure. */
export type AdmissionResolution =
  | {
      readonly ok: true
      readonly envelope: WorkEnvelope
      /** Deterministic exact-retry anchor from the event id + target session, e.g.
       * `event-admission:<eventId>:<sessionId>`. */
      readonly messageID: string
      readonly sessionID: string
      readonly delivery: EventAdmission.AdmissionDelivery
    }
  | { readonly ok: false; readonly reason: AdmissionResolveReason; readonly message: string }

/** The declared scopes an event carries (design §8.4 permission `scopes`). For a command, the command's
 * `requirements` are the requested scopes; fact/observation declare none ([] is the fail-closed default). */
const eventDeclaredScopes = (event: RegisteredEventEnvelope): ReadonlyArray<string> =>
  event.kind === "command" ? (event.command.requirements ?? []) : []

/** The registration's declared query intent. The frozen `EventTypeRegistration` has no explicit query
 * intent field; the mapping derives a deterministic `recall` intent bound to the work objective. */
const declaredContextQuery = (registration: EventTypeRegistration): WorkContextQuery => ({
  intent: "recall",
  query: registration.objective,
})

const unknownRoutingRefusal = (event: RegisteredEventEnvelope): AdmissionResolution => ({
  ok: false,
  reason: "unverified_trust_refused",
  message: `event "${event.eventId}" has neither a verified source nor an authorized trigger, so its trust is unverified; refusing per design §8.4 (never trust raw routing)`,
})

/**
 * Resolve a registry-validated event + registration + explicit scope into an `AdmitInput`-ready shape.
 * PURE + deterministic: no Effect, no DB, no clock — the caller supplies authority (trust hints) and the
 * safe per-work limits. Refusals are fail-closed (never a silent re-admission of unverified/over-budget
 * work). The envelope is built through `EventWorkEnvelope.build`, which itself re-validates the bounded
 * shape against the frozen contract.
 */
export function resolveAdmissionInput(
  event: RegisteredEventEnvelope,
  registration: EventTypeRegistration,
  scope: AdmissionScope,
  verifiedFacts: ReadonlyArray<VerifiedFactRef> = [],
): AdmissionResolution {
  // TRUST — derived only from the caller's scope (registry-verified source → verified; authorized trigger
  // → derived; else unverified → refuse). Never from the raw payload.
  const trust = scope.verifiedSource
    ? { level: "verified" as const, sourceRef: scope.verifiedSource.sourceRef }
    : scope.authorizedTrigger
      ? { level: "derived" as const }
      : { level: "unverified" as const }
  if (trust.level === "unverified") return unknownRoutingRefusal(event)

  // BUDGET — an event that declares a per-work token intent above the frozen default is refused. The
  // mapping never spends more than the frozen default; the caller may only shrink it.
  const declaredMax = scope.declared?.maxTokens
  if (declaredMax != null && declaredMax > DEFAULT_WORK_BUDGET.maxTokens) {
    return {
      ok: false,
      reason: "over_budget",
      message: `event "${event.eventId}" declares an over-budget intent (${declaredMax} tokens) above the frozen default (${DEFAULT_WORK_BUDGET.maxTokens}); refusing`,
    }
  }

  const budget: WorkBudget = { ...DEFAULT_WORK_BUDGET, eventRoot: event.aggregate.aggregateId }

  const resolution: WorkResolution = {
    trust,
    permission: {
      scopes: [...eventDeclaredScopes(event), ...(scope.declared?.scopes ?? [])],
      required: [registration.requestedCapability],
      maxAutonomy: registration.risk,
    },
    // Egress: the registration exposes NO allowed-domain/sensitivity list, so the fail-closed default is
    // an empty allow-list (the model egresses nowhere until the caller supplies a real domain pack).
    egress: {
      allowedDomains: [],
      allowedSensitivities: [],
    },
    budget,
    securityNamespaceId: scope.securityNamespaceId,
    projectScopeKey: scope.projectScopeKey,
    contextQuery: declaredContextQuery(registration),
  }

  const built = WorkEnvelopePolicy.build({ event, registration, resolution, verifiedFacts })
  if (!built.ok) return { ok: false, reason: built.reason, message: built.message }

  const messageID = `event-admission:${event.eventId}:${scope.sessionID}`
  return { ok: true, envelope: built.envelope, messageID, sessionID: scope.sessionID, delivery: "steer" }
}

export interface AdmitWiringInput {
  readonly event: RegisteredEventEnvelope
  readonly registration: EventTypeRegistration
  readonly scope: AdmissionScope
  /** The caller-injected SessionV2 adapter (`admit`'s `input.adapter.admit(...)`). */
  readonly adapter: EventAdmission.SessionWorkAdapter
  readonly now: number
  readonly verifiedFacts?: ReadonlyArray<VerifiedFactRef>
}

/**
 * The production wiring entry: resolve the admission input then drive `EventAdmission.admit` with a
 * deterministic `messageID` + `steer` delivery. This gives `EventAdmission.admit` its production caller.
 * A resolution refusal (unverified trust / over-budget / noise / unbounded payload) is a typed
 * `EventAdmissionWiringError`; an admission refusal (digest mismatch / disabled / noise / invalid) is the
 * admission's own `EventAdmissionError`. Both fail closed.
 */
export function admitWork(
  db: Database.Interface["db"],
  input: AdmitWiringInput,
): Effect.Effect<EventAdmission.AdmitResult, EventAdmission.EventAdmissionError | EventAdmissionWiringError> {
  return Effect.gen(function* () {
    const resolved = resolveAdmissionInput(input.event, input.registration, input.scope, input.verifiedFacts ?? [])
    if (!resolved.ok) {
      return yield* Effect.fail(new EventAdmissionWiringError(resolved.reason, input.event.eventId, resolved.message))
    }
    return yield* EventAdmission.admit(db, {
      envelope: resolved.envelope,
      sessionID: resolved.sessionID,
      messageID: resolved.messageID,
      delivery: resolved.delivery,
      adapter: input.adapter,
      now: input.now,
    })
  })
}
