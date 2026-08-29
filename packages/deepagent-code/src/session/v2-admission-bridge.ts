export * as V2AdmissionBridge from "./v2-admission-bridge"

import { Effect } from "effect"
import { DeepAgentEvent } from "@deepagent-code/core/deepagent/deepagent-event"
import {
  EventRegistry,
  type EventRegistry as EventRegistryIface,
  type EventTypeRegistration,
  type RegisteredEventEnvelope,
} from "@deepagent-code/core/deepagent/event-registry"
import { EventAdmission } from "@deepagent-code/core/deepagent/event-admission"
import { EventAdmissionWiring } from "@deepagent-code/core/deepagent/event-admission-wiring"
import {
  decodeEventEnvelope,
  type EventEnvelope,
  type EventCausation,
  type EventSourceKind,
} from "@deepagent-code/core/contract/event-envelope"
import { contentDigest } from "@deepagent-code/core/contract/digest"
import type { Database } from "@deepagent-code/core/database/database"
import { SessionV2 } from "@deepagent-code/core/session"
import { SessionMessage } from "@deepagent-code/core/session/message"
import { Prompt } from "@deepagent-code/core/session/prompt"
import { Location } from "@deepagent-code/core/location"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { Option } from "effect"
import type { EventDispatcher } from "./event-dispatcher"
import type { MultiAgentRuntime } from "./multi-agent-runtime"

// C5-12 — the PRODUCTION V2 admission bridge provider for the `eventV2Admission` seam TECH1
// (C5-04) defined in MultiAgentRuntime. Design authority: docs/core-v2.0-beta/design.md §8.4 (routing →
// bounded work envelope → V2 admission receipt), §8.7 (event turns go through SessionV2/SessionExecution),
// §8.8 (bounded work, anti-noise, budget). This is the missing production caller that turns the runtime's
// injected seam contract into a real admitting path:
//
//   (a) V4 → C5 event translation — a raw `DeepAgentEvent.Event` becomes a registry-validated
//       `RegisteredEventEnvelope` via `EventRegistry.assertPublishable` (fail-closed on any unregistered
//       type, kind/schema/payload/causation/source mismatch). The registry is seeded from a documented
//       `V4_EVENT_REGISTRY` (see below) — the V4 event types the runtime dispatches. `EventV2.registry`
//       (the sync-log definition map) does NOT carry `EventTypeRegistration`-shaped declarations (it holds
//       `sync.aggregate` metadata, a different shape), so this lane owns a documented seed map rather than
//       deriving C5 registrations from it.
//   (b) securityNamespaceFor — resolves the security namespace the event's workspace belongs to. The
//       production upgrade path is `ContextLocationIdentity.resolveNamespace({kind:"workspace",...})`
//       (see context-federation/identity.ts), which needs a tenant identity not present on a routed event;
//       this provider accepts an injected resolver and defaults to a deterministic, documented,
//       workspace-scoped namespace id so the seam is typed and testable today.
//   (c) SessionV2 adapter — `(yield* SessionV2.Service).prompt(...)`, wrapped to the
//       `EventAdmission.SessionWorkAdapter.admit({envelope, sessionID, messageID, delivery, resume,
//       promptText})` contract. The prompt TEXT is the serialized bounded envelope (never the raw payload).
//   (d) DB access — `EventAdmissionWiring.admitWork(db, ...)` is driven with the `Database.Service` db.
//
// AUTHORITY: this provider NEVER trusts the raw V4 payload. It validates the event as a registry-validated
// C5 envelope and lifts only the bounded envelope REF into SessionV2; the trust level comes from the scope
// the runtime derived (`authorizedTrigger: true` → `derived`, design §8.4). An unregistered / malformed /
// over-budget event is a typed refusal that fails the dispatch (the dispatcher nacks and the retry pump
// re-drives) — never a silent re-admission.
//
// LAYERING: `deepagent-code`. Imports core fully (C5 registry, admission, wiring, SessionV2, Database)
// and the runtime's own seam type; the provider only bridges the two, it never reimplements admission.

/** The C5 registry seed for the V4 event types the runtime dispatches (documented seed map, §(a)). */
export const V4_EVENT_REGISTRY: EventRegistryIface = EventRegistry.createEventRegistry([
  {
    eventType: "ci.failure",
    kind: "observation",
    schemaId: "ci.failure.schema",
    schemaVersion: "1",
    payloadContentType: "application/json",
    payloadVersion: "v1",
    allowedProducerKinds: ["external"],
    allowedSourceKinds: ["external"],
    causation: { allowed: ["causedByEventId"], requiresCause: false },
    risk: "high",
    objective: "investigate the CI failure",
    requestedCapability: "deepagent.ci.triage",
    autonomyCeiling: "high",
  },
  {
    eventType: "im.message.created",
    kind: "command",
    schemaId: "im.message.created.schema",
    schemaVersion: "1",
    payloadContentType: "application/json",
    payloadVersion: "v1",
    allowedProducerKinds: ["user"],
    allowedSourceKinds: ["user"],
    causation: { allowed: ["causedByEventId"], requiresCause: false },
    risk: "medium",
    objective: "respond to the IM message",
    requestedCapability: "deepagent.im.reply",
    autonomyCeiling: "medium",
  },
  {
    eventType: "git.push",
    kind: "observation",
    schemaId: "git.push.schema",
    schemaVersion: "1",
    payloadContentType: "application/json",
    payloadVersion: "v1",
    allowedProducerKinds: ["external"],
    allowedSourceKinds: ["external"],
    causation: { allowed: ["causedByEventId"], requiresCause: false },
    risk: "medium",
    objective: "review the pushed changes",
    requestedCapability: "deepagent.git.review",
    autonomyCeiling: "medium",
  },
  {
    eventType: "pr.comment",
    kind: "command",
    schemaId: "pr.comment.schema",
    schemaVersion: "1",
    payloadContentType: "application/json",
    payloadVersion: "v1",
    allowedProducerKinds: ["external"],
    allowedSourceKinds: ["external"],
    causation: { allowed: ["causedByEventId"], requiresCause: false },
    risk: "medium",
    objective: "address the PR comment",
    requestedCapability: "deepagent.pr.triage",
    autonomyCeiling: "medium",
  },
  {
    eventType: "monitor.alert",
    kind: "observation",
    schemaId: "monitor.alert.schema",
    schemaVersion: "1",
    payloadContentType: "application/json",
    payloadVersion: "v1",
    allowedProducerKinds: ["external"],
    allowedSourceKinds: ["external"],
    causation: { allowed: ["causedByEventId"], requiresCause: false },
    risk: "high",
    objective: "investigate the alert",
    requestedCapability: "deepagent.alert.triage",
    autonomyCeiling: "high",
  },
  {
    eventType: "goal.tick.requested",
    kind: "command",
    schemaId: "goal.tick.requested.schema",
    schemaVersion: "1",
    payloadContentType: "application/json",
    payloadVersion: "v1",
    allowedProducerKinds: ["system"],
    allowedSourceKinds: ["system"],
    causation: { allowed: ["causedByEventId"], requiresCause: false },
    risk: "medium",
    objective: "advance the goal",
    requestedCapability: "deepagent.goal.advance",
    autonomyCeiling: "medium",
  },
])

/**
 * Deterministic security namespace for a workspace. The seam contract is `Effect<string, unknown>`, and a
 * routed event carries no tenant identity, so the production upgrade path (ContextLocationIdentity
 * workspace boundary) is exposed through `deps.securityNamespaceFor`; this default is the typed,
 * reproducible fallback (`sec_ws_<workspaceId>`). Non-authoritative: the durable receipt is the authority.
 */
export const defaultSecurityNamespaceFor = (workspaceId: string): string => `sec_ws_${workspaceId}`

/** Map a V4 event source to the C5 EventSourceKind. A routed event's source maps to the producer/authority
 * tier the C5 registry validates against (the V4 source vocabulary does not carry `agent`, so coordination
 * emissions stay on the V4 side and never enter this translation). */
const sourceKindFor = (source: DeepAgentEvent.EventSource): EventSourceKind => {
  switch (source) {
    case "im":
      return "user"
    case "git":
    case "ci":
    case "pr":
    case "monitor":
      return "external"
    case "schedule":
    case "system":
      return "system"
  }
}

/** Build the C5 `EventCausation` from a V4 event under the registration's causation policy. The event
 * carries at most one causation id; it is bound to the first allowed causation key. `requiresCause:false`
 * registrations tolerate an empty causation (the fail-closed default for an open event). */
const eventCausation = (event: DeepAgentEvent.Event, registration: EventTypeRegistration): EventCausation =>
  event.causationID == null
    ? {}
    : registration.causation.allowed.includes("causedByEventId")
      ? { causedByEventId: event.causationID }
      : registration.causation.allowed.includes("causedByCommandId")
        ? { causedByCommandId: event.causationID }
        : {}

const kindBody = (event: DeepAgentEvent.Event, registration: EventTypeRegistration): Record<string, unknown> => {
  if (registration.kind === "command") {
    return {
      command: {
        action: event.type,
        targetRef: `event://${event.id}`,
        requirements: [registration.requestedCapability],
      },
    }
  }
  if (registration.kind === "fact") {
    return { fact: { outcome: event.type, authorityRef: `event://${event.id}` } }
  }
  return { observation: { observedMetric: event.type, externalRef: `event://${event.id}` } }
}

/**
 * V4 → C5 translation. A raw `DeepAgentEvent.Event` + its registration become a C5 `EventEnvelope`.
 * Deterministic (same event + registration ⇒ same envelope): the payload is referenced by its content
 * hash (never embedded), the schema comes from the registration, and only the bounded envelope REF is
 * lifted. The result is NOT yet registry-validated — call `assertPublishable` / check `validatePublish`.
 */
export const toEventEnvelope = (event: DeepAgentEvent.Event, registration: EventTypeRegistration): EventEnvelope => {
  const sourceKind = sourceKindFor(event.source)
  return decodeEventEnvelope({
    schemaVersion: "event.v1",
    eventId: event.id,
    eventType: event.type,
    workspaceId: event.workspaceID,
    aggregate: { aggregateId: event.id, aggregateType: event.type, aggregateRevision: 0 },
    actor: { actorId: event.actorID ?? "system", actorType: "system" },
    source: { sourceId: event.source, sourceKind },
    correlation: {
      correlationId: event.correlationID ?? event.id,
      causalChain: event.causationID ? [event.causationID] : [],
    },
    causation: eventCausation(event, registration),
    schema: { schemaId: registration.schemaId, schemaVersion: registration.schemaVersion },
    payload: {
      contentType: registration.payloadContentType,
      ref: `event://${event.id}`,
      payloadHash: contentDigest(event.payload),
    },
    producer: { producerId: event.source, producerKind: sourceKind },
    consumer: { consumerGroupId: "runtime", registeredBeforeProduce: true, flags: {} },
    idempotencyKey: event.idempotencyKey,
    recordedAt: event.createdAt,
    kind: registration.kind,
    ...kindBody(event, registration),
  })
}

/**
 * A deterministic SessionV2 message id derived from the admission's opaque exact-retry anchor
 * (`event-admission:<eventId>:<sessionId>`). SessionV2.prompt `id` must be a valid `msg_` id; the anchor
 * is opaque, so the adapter derives a stable `msg_` id (same anchor ⇒ same id ⇒ SessionV2 dedupes an exact
 * retry). Never carries the raw anchor into the message id — it is content-hashed.
 */
const sessionMessageID = (anchor: string): string => `msg_${contentDigest(anchor).slice(0, 40)}`

/** The `(yield* SessionV2.Service).prompt(...)` adapter wrapped to the `EventAdmission.SessionWorkAdapter`
 * contract. The model-facing prompt is the serialized bounded envelope (`promptText`), never the raw V4
 * payload; the delivery vocabulary maps 1:1 (steer/queue/goal_steer). */
export const makeSessionV2Adapter = (
  v2Session: SessionV2.Interface,
  locationFor: (workspaceId: string | undefined) => Location.Ref | undefined,
  workspaceId: string | undefined,
): EventAdmission.SessionWorkAdapter => ({
  admit: ({ envelope, sessionID, messageID, delivery, resume, promptText }) =>
    Effect.gen(function* () {
      const sid = SessionV2.ID.make(sessionID)
      // C5-12-DEV-01: a fresh routed event may arrive before its V2 projection exists; the durable
      // admission must get-or-create the session first (the legacy path lazily ensured it). The
      // location follows the §C derivation (a non-"wrk" workspaceID doubles as the directory).
      const exists = yield* v2Session.get(sid).pipe(Effect.option)
      if (Option.isNone(exists)) {
        const location = locationFor(workspaceId)
        if (!location) {
          return yield* Effect.fail(
            new Error(`C5-12 admission cannot create session "${sessionID}": no event directory or workspace location`),
          )
        }
        yield* v2Session.create({ id: sid, location })
      }
      const admitted = yield* v2Session.prompt({
        sessionID: sid,
        prompt: new Prompt({ text: promptText }),
        delivery,
        resume,
        ...(messageID ? { id: SessionMessage.ID.make(sessionMessageID(messageID)) } : {}),
      })
      return { messageID: admitted.id }
    }),
})

export interface V2AdmissionBridgeDeps {
  /** The `Database.Service` db the `admitWork` path writes the durable admission receipt to. */
  readonly db: Database.Interface["db"]
  /** The SessionV2 stack (optional: an absent stack makes admission fail closed at dispatch time). */
  readonly v2Session?: SessionV2.Interface
  /** The C5 event registry. Defaults to the documented `V4_EVENT_REGISTRY` seed map. */
  readonly registry?: EventRegistryIface
  /** Optional security-namespace resolver (production: ContextLocationIdentity workspace boundary).
   * Omitted ⇒ deterministic workspace-scoped default. */
  readonly securityNamespaceFor?: (workspaceId: string) => Effect.Effect<string, unknown>
  readonly now?: () => number
  /** Optional session-location derivation for get-or-create (C5-12-DEV-01). Default: §C
   * derivation — a non-"wrk" workspaceID doubles as the directory; bare "wrk_" ids have no
   * directory and get-or-create fails closed instead of guessing one. */
  readonly locationFor?: (workspaceId: string | undefined) => Location.Ref | undefined
}

/** Default §C derivation for get-or-create: a non-"wrk" workspaceID doubles as the directory. */
const defaultLocationFor = (workspaceId: string | undefined): Location.Ref | undefined =>
  workspaceId && !workspaceId.startsWith("wrk")
    ? Location.Ref.make({ directory: AbsolutePath.make(workspaceId) })
    : undefined

/**
 * Build the production `MultiAgentRuntime.EventV2AdmissionBridge`. This is typed against the runtime's
 * seam, so the construction site can pass it into `MultiAgentRuntime.layerWith({ eventV2Admission })` and
 * the runtime will use it whenever `isEventV2AdmissionEnabled()` is ON.
 *
 * `admit` translates the routed V4 event into a registry-validated C5 envelope and drives
 * `EventAdmissionWiring.admitWork` with the injected SessionV2 adapter. A registry refusal (unregistered /
 * malformed) or an admission refusal (noise / over-budget / disabled) is surfaced as an Effect failure so
 * the dispatcher nacks and the retry pump re-drives — never a silent drop.
 */
export const makeV2AdmissionBridge = (deps: V2AdmissionBridgeDeps): MultiAgentRuntime.EventV2AdmissionBridge => {
  const registry = deps.registry ?? V4_EVENT_REGISTRY
  const now = deps.now ?? Date.now
  const securityNamespaceFor =
    deps.securityNamespaceFor ?? ((workspaceId: string) => Effect.succeed(defaultSecurityNamespaceFor(workspaceId)))

  return {
    securityNamespaceFor,
    admit: ({ request, scope }) =>
      Effect.gen(function* () {
        if (!deps.v2Session) {
          return yield* Effect.fail(
            new Error(
              `C5-12 V2 admission bridge requires the SessionV2 stack to admit event "${request.event.id}"`,
            ),
          )
        }
        const registration = registry.lookup(request.event.type)
        if (!registration) {
          return yield* Effect.fail(
            new Error(
              `C5-12 event type "${request.event.type}" is not registered with the V2 admission registry; refusing (fail-closed)`,
            ),
          )
        }
        const envelope = toEventEnvelope(request.event, registration)
        const verdict = EventRegistry.validatePublish(registry, envelope)
        if (!verdict.ok) {
          return yield* Effect.fail(
            new Error(`C5-12 event "${request.event.id}" is not publishable: ${verdict.message}`),
          )
        }
        const registered = envelope as RegisteredEventEnvelope
        yield* EventAdmissionWiring.admitWork(deps.db, {
          event: registered,
          registration: verdict.registration,
          scope,
          adapter: makeSessionV2Adapter(deps.v2Session, deps.locationFor ?? defaultLocationFor, scope.workspaceId),
          now: now(),
        })
      }),
  }
}
