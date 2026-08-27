import { describe, expect, test } from "bun:test"
import {
  EventEnvelope,
  EventWorkEnvelope,
  EventEnvelopeDecodeError,
  EventWorkEnvelopeDecodeError,
  decodeEventEnvelope,
  encodeEventEnvelope,
  decodeEventWorkEnvelope,
  encodeEventWorkEnvelope,
  validateEventEnvelope,
  validateEventWorkEnvelope,
  eventEnvelopeDigest,
  eventWorkEnvelopeDigest,
} from "../../src/contract/event-envelope"

function baseEvent(): Record<string, unknown> {
  return {
    schemaVersion: "event.v1",
    eventId: "e1",
    eventType: "goal.tick.requested",
    workspaceId: "ws-1",
    aggregate: { aggregateId: "ag-1", aggregateType: "goal", aggregateRevision: 0 },
    actor: { actorId: "a-1", actorType: "agent" },
    source: { sourceId: "s-1", sourceKind: "system" },
    correlation: { correlationId: "c-1", causalChain: ["c-0"] },
    causation: {},
    schema: { schemaId: "sch-1", schemaVersion: "1" },
    payload: { contentType: "application/json", ref: "ctx://p/1", payloadHash: "abc" },
    producer: { producerId: "prod-1", producerKind: "system" },
    consumer: { consumerGroupId: "grp-1", registeredBeforeProduce: true, flags: {} },
    idempotencyKey: "idem-1",
    recordedAt: 123,
  }
}

function makeEvent(kind: "command" | "fact" | "observation"): EventEnvelope {
  return decodeEventEnvelope({
    ...baseEvent(),
    kind,
    ...(kind === "command"
      ? { command: { action: "advance", targetRef: "goal://1" } }
      : kind === "fact"
        ? { fact: { outcome: "completed", terminalHash: "hash-1" } }
        : { observation: { observedMetric: "ci.failure", severity: "high" } }),
  })
}

function makeWorkEnvelope(): EventWorkEnvelope {
  return decodeEventWorkEnvelope({
    schemaVersion: "event-work.v1",
    eventRef: "event://e1",
    eventType: "goal.tick.requested",
    objective: "advance the goal",
    payload: { contentType: "application/json", ref: "ctx://p/1", payloadHash: "abc" },
    verifiedFacts: [{ factId: "f-1", factHash: "fh" }],
    requestedCapability: "deepagent.goal.advance",
    actorAndScope: { actorId: "a-1", workspaceId: "ws-1", securityNamespaceId: "ns-1", projectScopeKey: "psc-1" },
    trust: { level: "verified", sourceRef: "ctx://src/1" },
    permission: { scopes: ["goal.read"], required: ["goal.write"], maxAutonomy: "medium" },
    egress: { allowedDomains: ["plugins"], allowedSensitivities: ["public"] },
    risk: "medium",
    autonomyCeiling: "medium",
    contextQuery: { intent: "related", query: "advance" },
    budget: { maxTokens: 8000, maxToolCalls: 4, maxDurationMs: 60000, hourTokensMax: 4000, hourWindowMinutes: 60, workspaceBudgetId: "wb-1", eventRoot: "goal://1" },
    correlationId: "c-1",
    delivery: {
      consumerGroupId: "grp-1",
      leaseToken: "lease-1",
      leaseExpiresAt: 999,
      attemptCount: 1,
      dedupeId: "dedupe-1",
      exactlyOnceCursor: "seq-1",
      maxAttempts: 5,
    },
  })
}

function evError(input: unknown): EventEnvelopeDecodeError {
  try {
    decodeEventEnvelope(input)
  } catch (error) {
    if (error instanceof EventEnvelopeDecodeError) return error
    throw error
  }
  throw new Error("expected decodeEventEnvelope to fail")
}

function workError(input: unknown): EventWorkEnvelopeDecodeError {
  try {
    decodeEventWorkEnvelope(input)
  } catch (error) {
    if (error instanceof EventWorkEnvelopeDecodeError) return error
    throw error
  }
  throw new Error("expected decodeEventWorkEnvelope to fail")
}

describe("event envelope round-trip and digest", () => {
  test("command/fact/observation each round-trip encode -> decode deterministically", () => {
    for (const kind of ["command", "fact", "observation"] as const) {
      const envelope = makeEvent(kind)
      const encoded = encodeEventEnvelope(envelope)
      const decoded = decodeEventEnvelope(encoded)
      expect(decoded).toEqual(envelope)
    }
  })

  test("work envelope round-trips encode -> decode deterministically", () => {
    const envelope = makeWorkEnvelope()
    const decoded = decodeEventWorkEnvelope(encodeEventWorkEnvelope(envelope))
    expect(decoded).toEqual(envelope)
  })

  test("event digest is byte-stable and independent of recordedAt (timestamp)", () => {
    const a = makeEvent("command")
    const b = makeEvent("command")
    expect(eventEnvelopeDigest(a)).toEqual(eventEnvelopeDigest(b))
    expect(eventEnvelopeDigest(a)).toMatch(/^[0-9a-f]{64}$/)
    // different recordedAt (wall-clock timestamp) -> identical digest
    const bWithTime = { ...(a as unknown as Record<string, unknown>), recordedAt: 999999 } as unknown as EventEnvelope
    expect(eventEnvelopeDigest(bWithTime)).toEqual(eventEnvelopeDigest(a))
  })

  test("event digest is canonical over JSON-equivalent key order", () => {
    const a = makeEvent("command")
    const keys = Object.keys(a)
    const reordered: Record<string, unknown> = {}
    for (const key of keys.toReversed()) reordered[key] = (a as unknown as Record<string, unknown>)[key]
    expect(eventEnvelopeDigest(a)).toEqual(eventEnvelopeDigest(reordered as unknown as EventEnvelope))
  })

  test("work envelope digest is byte-stable and ignores volatile lease/timestamp", () => {
    const a = makeWorkEnvelope()
    expect(eventWorkEnvelopeDigest(a)).toEqual(eventWorkEnvelopeDigest(a))
    const withTime = { ...(a as unknown as Record<string, unknown>), time: 123 } as unknown as EventWorkEnvelope
    expect(eventWorkEnvelopeDigest(withTime)).toEqual(eventWorkEnvelopeDigest(a))
  })

  test("work envelope does not carry raw payload bytes (bounded payload ref only)", () => {
    const envelope = makeWorkEnvelope()
    expect(envelope.eventRef).toEqual("event://e1")
    expect(envelope.payload.contentType).toEqual("application/json")
    expect(envelope.payload.payloadHash).toEqual("abc")
  })
})

describe("event envelope negative shapes", () => {
  test("missing nested field -> typed error with exact path", () => {
    const input = { ...baseEvent(), kind: "command", command: {} }
    const error = evError(input)
    expect(error).toBeInstanceOf(EventEnvelopeDecodeError)
    expect(error.path).toEqual(["command", "action"])
  })

  test("extra field -> typed error with exact path", () => {
    const input = { ...baseEvent(), kind: "command", command: { action: "x" }, extra: true }
    const error = evError(input)
    expect(error.path).toEqual(["extra"])
  })

  test("wrong type -> typed error with exact path", () => {
    const input = { ...baseEvent(), recordedAt: "oops", kind: "command", command: { action: "x" } }
    const error = evError(input)
    expect(error.path).toEqual(["recordedAt"])
  })

  test("unknown enum value (source kind) -> typed error with exact path", () => {
    const input = { ...baseEvent(), source: { sourceId: "s-1", sourceKind: "bogus" }, kind: "command", command: { action: "x" } }
    const error = evError(input)
    expect(error.path).toEqual(["source", "sourceKind"])
  })

  test("wrong discriminant (event kind) -> typed error with exact path", () => {
    const input = { ...baseEvent(), kind: "bogus", command: { action: "x" } }
    const error = evError(input)
    expect(error.path[0]).toEqual("kind")
    expect(error.message).toContain('["kind"]')
  })

  test("version mismatch -> typed error with exact path", () => {
    const input = { ...baseEvent(), schemaVersion: "event.v2", kind: "command", command: { action: "x" } }
    const error = evError(input)
    expect(error.path).toEqual(["schemaVersion"])
  })
})

describe("per-member event envelope nested negatives (toTaggedUnion precise paths)", () => {
  test("fact rejects a wrong-typed nested field at its precise path", () => {
    const input = makeEvent("fact") as unknown as Record<string, unknown>
    ;(input.fact as { outcome: unknown }).outcome = 123
    expect(evError(input).path).toEqual(["fact"])
  })

  test("observation rejects a wrong-typed nested field at its precise path", () => {
    const input = makeEvent("observation") as unknown as Record<string, unknown>
    ;(input.observation as { observedMetric: unknown }).observedMetric = 123
    expect(evError(input).path).toEqual(["observation"])
  })

  test("command rejects a wrong-typed nested field at its precise path", () => {
    const input = makeEvent("command") as unknown as Record<string, unknown>
    ;(input.command as { action: unknown }).action = 123
    expect(evError(input).path).toEqual(["command", "action"])
  })
})

describe("event work envelope budget hour dimension", () => {
  test("a valid work envelope carries the hour budget fields", () => {
    const envelope = makeWorkEnvelope()
    expect(envelope.budget.hourTokensMax).toEqual(4000)
    expect(envelope.budget.hourWindowMinutes).toEqual(60)
  })

  test("missing hourTokensMax is rejected with an exact path", () => {
    const input = makeWorkEnvelope() as unknown as { budget: { hourTokensMax?: unknown } }
    delete input.budget!.hourTokensMax
    expect(workError(input).path).toEqual(["budget", "hourTokensMax"])
  })

  test("missing hourWindowMinutes is rejected with an exact path", () => {
    const input = makeWorkEnvelope() as unknown as { budget: { hourWindowMinutes?: unknown } }
    delete input.budget!.hourWindowMinutes
    expect(workError(input).path).toEqual(["budget", "hourWindowMinutes"])
  })
})

describe("event work envelope negative shapes", () => {
  test("missing field -> typed error with exact path", () => {
    const input = makeWorkEnvelope() as unknown as { budget: { maxTokens?: unknown } }
    delete input.budget!.maxTokens
    const error = workError(input)
    expect(error.path).toEqual(["budget", "maxTokens"])
  })

  test("extra field -> typed error with exact path", () => {
    const input = { ...(makeWorkEnvelope() as unknown as Record<string, unknown>), extra: true }
    const error = workError(input)
    expect(error.path).toEqual(["extra"])
  })

  test("wrong type -> typed error with exact path", () => {
    const input = { ...(makeWorkEnvelope() as unknown as Record<string, unknown>), risk: "bogus" }
    const error = workError(input)
    expect(error.path).toEqual(["risk"])
  })

  test("unknown enum value (trust level) -> typed error with exact path", () => {
    const input = { ...(makeWorkEnvelope() as unknown as Record<string, unknown>), trust: { level: "bogus" } }
    const error = workError(input)
    expect(error.path).toEqual(["trust", "level"])
  })

  test("version mismatch -> typed error with exact path", () => {
    const input = { ...(makeWorkEnvelope() as unknown as Record<string, unknown>), schemaVersion: "event.v2" }
    const error = workError(input)
    expect(error.path).toEqual(["schemaVersion"])
  })
})

describe("event validate (non-throwing)", () => {
  test("valid envelope -> ok true; invalid -> ok false with path", () => {
    const ok = validateEventEnvelope(makeEvent("fact"))
    expect(ok.ok).toBe(true)
    const bad = validateEventEnvelope({ ...baseEvent(), kind: "bogus", command: { action: "x" } })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error.path[0]).toEqual("kind")
  })

  test("valid work envelope -> ok true; invalid -> ok false with path", () => {
    const ok = validateEventWorkEnvelope(makeWorkEnvelope())
    expect(ok.ok).toBe(true)
    const bad = validateEventWorkEnvelope({ ...(makeWorkEnvelope() as unknown as Record<string, unknown>), risk: "bogus" })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error.path).toEqual(["risk"])
  })
})
