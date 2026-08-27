import {
  decodeEventEnvelope,
  type EventEnvelope,
} from "@deepagent-code/core/contract/event-envelope"
import {
  createEventRegistry,
  assertPublishable,
  type EventRegistry,
  type EventTypeRegistration,
  type RegisteredEventEnvelope,
} from "@deepagent-code/core/deepagent/event-registry"

// Shared deterministic fixtures for the C5 event suite (registry / outbox / work envelope).

export const commandReg: EventTypeRegistration = {
  eventType: "goal.tick.requested",
  kind: "command",
  schemaId: "goal.tick.requested.schema",
  schemaVersion: "1",
  payloadContentType: "application/json",
  payloadVersion: "v1",
  allowedProducerKinds: ["system"],
  allowedSourceKinds: ["system"],
  causation: { allowed: ["causedByEventId", "causedByCommandId"], requiresCause: true },
  risk: "medium",
  objective: "advance the goal",
  requestedCapability: "deepagent.goal.advance",
  autonomyCeiling: "medium",
}

export const factReg: EventTypeRegistration = {
  eventType: "agent.task.completed",
  kind: "fact",
  schemaId: "agent.task.completed.schema",
  schemaVersion: "1",
  payloadContentType: "application/json",
  payloadVersion: "v1",
  allowedProducerKinds: ["agent"],
  allowedSourceKinds: ["agent"],
  causation: { allowed: ["causedByCommandId"], requiresCause: true },
  risk: "low",
  objective: "observe task completion",
  requestedCapability: "deepagent.observe.task",
  autonomyCeiling: "low",
}

export const observationReg: EventTypeRegistration = {
  eventType: "ci.failure.observed",
  kind: "observation",
  schemaId: "ci.failure.observed.schema",
  schemaVersion: "1",
  payloadContentType: "application/json",
  payloadVersion: "v1",
  allowedProducerKinds: ["external"],
  allowedSourceKinds: ["external"],
  causation: { allowed: ["parentEventId"], requiresCause: false },
  risk: "high",
  objective: "investigate CI failure",
  requestedCapability: "deepagent.ci.triage",
  autonomyCeiling: "high",
}

export const makeRegistry = (): EventRegistry => createEventRegistry([commandReg, factReg, observationReg])

export const HASH = "0".repeat(64)

function base(over: Record<string, unknown>): Record<string, unknown> {
  return {
    schemaVersion: "event.v1",
    eventId: "e-1",
    eventType: "goal.tick.requested",
    workspaceId: "ws-1",
    aggregate: { aggregateId: "ag-1", aggregateType: "goal", aggregateRevision: 0 },
    actor: { actorId: "a-1", actorType: "agent" },
    source: { sourceId: "s-1", sourceKind: "system" },
    correlation: { correlationId: "c-1", causalChain: ["c-0"] },
    causation: { causedByEventId: "prev-1" },
    schema: { schemaId: "goal.tick.requested.schema", schemaVersion: "1" },
    payload: { contentType: "application/json", ref: "ctx://p/1", payloadHash: HASH },
    producer: { producerId: "prod-1", producerKind: "system" },
    consumer: { consumerGroupId: "grp-1", registeredBeforeProduce: true, flags: {} },
    idempotencyKey: "idem-1",
    recordedAt: 1,
    ...over,
  }
}

export const commandEnvelope = (over?: Record<string, unknown>): EventEnvelope =>
  decodeEventEnvelope({ ...base(over ?? {}), kind: "command", command: { action: "advance", targetRef: "goal://1" } })

export const verifiedCommand = (registry: EventRegistry, over?: Record<string, unknown>): RegisteredEventEnvelope =>
  assertPublishable(registry, commandEnvelope(over))
