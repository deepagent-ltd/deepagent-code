import { describe, expect, test } from "bun:test"
import {
  EventRegistry,
  createEventRegistry,
  validatePublish,
  assertPublishable,
  EventPublishError,
  type EventTypeRegistration,
} from "@deepagent-code/core/deepagent/event-registry"
import { decodeEventEnvelope } from "@deepagent-code/core/contract/event-envelope"
import type { EventEnvelope } from "@deepagent-code/core/contract/event-envelope"

// C5-01 — envelope/schema registry + publisher policy. Pure, deterministic, fail-closed.

const commandReg: EventTypeRegistration = {
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

const factReg: EventTypeRegistration = {
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

const observationReg: EventTypeRegistration = {
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

const registry = createEventRegistry([commandReg, factReg, observationReg])

function base(): Record<string, unknown> {
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
    payload: { contentType: "application/json", ref: "ctx://p/1", payloadHash: "0".repeat(64) },
    producer: { producerId: "prod-1", producerKind: "system" },
    consumer: { consumerGroupId: "grp-1", registeredBeforeProduce: true, flags: {} },
    idempotencyKey: "idem-1",
    recordedAt: 1,
  }
}

const makeCommand = (over?: Record<string, unknown>): EventEnvelope =>
  decodeEventEnvelope({ ...base(), kind: "command", command: { action: "advance", targetRef: "goal://1" }, ...over })

describe("EventRegistry create + lookup", () => {
  test("seeds a registry and indexes types by eventType", () => {
    expect(registry.size).toBe(3)
    expect(registry.eventTypes().sort()).toEqual(["agent.task.completed", "ci.failure.observed", "goal.tick.requested"])
    expect(registry.lookup("goal.tick.requested")?.kind).toBe("command")
    expect(registry.lookup("missing")).toBeUndefined()
  })

  test("register returns a NEW registry without mutating the source", () => {
    const next = registry.register({ ...commandReg, eventType: "new.command" })
    expect(next.size).toBe(4)
    expect(registry.size).toBe(3)
    expect(next.lookup("new.command")).toBeDefined()
    expect(registry.lookup("new.command")).toBeUndefined()
  })
})

describe("EventRegistry publisher policy (fail-closed)", () => {
  test("a registered, well-formed command publishes", () => {
    const verdict = validatePublish(registry, makeCommand())
    expect(verdict.ok).toBe(true)
    if (verdict.ok) expect(verdict.registration.eventType).toBe("goal.tick.requested")
  })

  test("unregistered event type fails unregistered_type", () => {
    const verdict = validatePublish(registry, makeCommand({ eventType: "not.registered" }))
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.reason).toBe("unregistered_type")
  })

  test("kind mismatch fails kind_mismatch (defense-in-depth guard)", () => {
    // The frozen envelope's discriminated union prevents an invalid kind from DECODING, so this
    // guard is reachable only if a caller hands the policy a raw/mis-typed object. Exercise it
    // directly to prove the policy still fails closed.
    const raw = { ...(makeCommand() as unknown as Record<string, unknown>), kind: "fact" } as unknown as EventEnvelope
    const verdict = validatePublish(registry, raw)
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.reason).toBe("kind_mismatch")
  })

  test("schema mismatch fails schema_mismatch", () => {
    const verdict = validatePublish(registry, makeCommand({ schema: { schemaId: "goal.tick.requested.schema", schemaVersion: "2" } }))
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.reason).toBe("schema_mismatch")
  })

  test("payload content type mismatch fails payload_content_type_mismatch", () => {
    const verdict = validatePublish(registry, makeCommand({ payload: { contentType: "text/plain", ref: "ctx://p/1", payloadHash: "0".repeat(64) } }))
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.reason).toBe("payload_content_type_mismatch")
  })

  test("missing payload hash fails payload_hash_missing", () => {
    const verdict = validatePublish(registry, makeCommand({ payload: { contentType: "application/json", ref: "ctx://p/1", payloadHash: "" } }))
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.reason).toBe("payload_hash_missing")
  })

  test("malformed payload hash fails payload_hash_malformed", () => {
    const verdict = validatePublish(registry, makeCommand({ payload: { contentType: "application/json", ref: "ctx://p/1", payloadHash: "not-a-hash" } }))
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.reason).toBe("payload_hash_malformed")
  })

  test("forbidden causation key fails causation_forbidden", () => {
    const verdict = validatePublish(registry, makeCommand({ causation: { parentEventId: "x" } }))
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.reason).toBe("causation_forbidden")
  })

  test("missing required cause fails causation_forbidden", () => {
    const verdict = validatePublish(registry, makeCommand({ causation: {} }))
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.reason).toBe("causation_forbidden")
  })

  test("forbidden producer kind fails producer_forbidden", () => {
    const verdict = validatePublish(registry, makeCommand({ producer: { producerId: "prod-2", producerKind: "external" } }))
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.reason).toBe("producer_forbidden")
  })

  test("forbidden source kind fails source_forbidden", () => {
    const verdict = validatePublish(registry, makeCommand({ source: { sourceId: "s-9", sourceKind: "external" } }))
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.reason).toBe("source_forbidden")
  })

  test("assertPublishable returns the envelope or throws a typed error", () => {
    expect(assertPublishable(registry, makeCommand()).eventType).toBe("goal.tick.requested")
    expect(() => assertPublishable(registry, makeCommand({ eventType: "missing" }))).toThrow(EventPublishError)
    try {
      assertPublishable(registry, makeCommand({ eventType: "missing" }))
    } catch (error) {
      if (error instanceof EventPublishError) {
        expect(error.reason).toBe("unregistered_type")
        expect(error.eventType).toBe("missing")
      } else throw error
    }
  })

  test("fact requires a cause (causedByCommandId) and rejects a bare fact", () => {
    const fact = decodeEventEnvelope({
      ...base(),
      eventType: "agent.task.completed",
      schema: { schemaId: "agent.task.completed.schema", schemaVersion: "1" },
      source: { sourceId: "s-1", sourceKind: "agent" },
      producer: { producerId: "p-1", producerKind: "agent" },
      kind: "fact",
      fact: { outcome: "completed", terminalHash: "h".repeat(64) },
    })
    const bad = validatePublish(registry, fact)
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.reason).toBe("causation_forbidden")
  })

  test("observation does not require a cause and allows a parent", () => {
    const obs = decodeEventEnvelope({
      ...base(),
      eventType: "ci.failure.observed",
      schema: { schemaId: "ci.failure.observed.schema", schemaVersion: "1" },
      source: { sourceId: "s-1", sourceKind: "external" },
      producer: { producerId: "p-1", producerKind: "external" },
      causation: { parentEventId: "parent-1" },
      kind: "observation",
      observation: { observedMetric: "tests.failed", severity: "high" },
    })
    const verdict = validatePublish(registry, obs)
    expect(verdict.ok).toBe(true)
  })
})
