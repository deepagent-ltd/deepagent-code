import { describe, expect, test } from "bun:test"
import { EventCoalescing } from "@deepagent-code/core/deepagent/event-coalescing"
import { EventWorkEnvelope } from "@deepagent-code/core/deepagent/event-work-envelope"
import type { WorkBudget, WorkContextQuery } from "@deepagent-code/core/contract/event-envelope"
import type { EventRisk } from "@deepagent-code/core/contract/event-envelope"
import type { EventTypeRegistration } from "@deepagent-code/core/deepagent/event-registry"
import { createEventRegistry } from "@deepagent-code/core/deepagent/event-registry"
import { verifiedCommand } from "./event-fixture"

// C5-07 — coalescing / backpressure / quota POLICY (pure). Design §8.6 (low 合并, normal 受回压,
// high/critical 不丢失但 durable 排队) + §8.8 (coalescing window, fact reducer).

const budget: WorkBudget = {
  maxTokens: 8000,
  maxToolCalls: 4,
  maxDurationMs: 60000,
  hourTokensMax: 4000,
  hourWindowMinutes: 60,
  workspaceBudgetId: "wb-1",
  agentBudgetId: "ab-1",
  eventRoot: "goal://1",
}

const contextQuery: WorkContextQuery = { intent: "related", query: "advance the goal" }

const resolution = () => ({
  trust: { level: "verified" as const, sourceRef: "ctx://src/1" },
  permission: { scopes: ["goal.read"], required: ["goal.write"], maxAutonomy: "medium" as const },
  egress: { allowedDomains: ["plugins"], allowedSensitivities: ["public"] },
  budget,
  securityNamespaceId: "ns-1",
  projectScopeKey: "psc-1",
  contextQuery,
})

/** Build a non-noise envelope with an explicit risk, keyed by event id. */
const mk = (risk: EventRisk, eventId: string, extraFacts: ReadonlyArray<{ factId: string; factHash: string }> = []) => {
  const registration: EventTypeRegistration = {
    eventType: `work.${eventId}`,
    kind: "command",
    schemaId: "work.schema",
    schemaVersion: "1",
    payloadContentType: "application/json",
    payloadVersion: "v1",
    allowedProducerKinds: ["system"],
    allowedSourceKinds: ["system"],
    causation: { allowed: [], requiresCause: false },
    risk,
    objective: "do the work",
    requestedCapability: "deepagent.work",
    autonomyCeiling: risk,
  }
  const reg = createEventRegistry([registration])
  const event = verifiedCommand(reg, {
    eventType: `work.${eventId}`,
    eventId,
    idempotencyKey: `idem-${eventId}`,
    schema: { schemaId: "work.schema", schemaVersion: "1" },
    causation: {},
  }) as never
  const result = EventWorkEnvelope.build({ event, registration, resolution: resolution(), verifiedFacts: extraFacts })
  if (!result.ok) throw new Error(result.message)
  return result.envelope
}

const ctx = (over?: Partial<EventCoalescing.CoalesceContext>): EventCoalescing.CoalesceContext => ({
  now: 10_000,
  windowMs: 1000,
  consumerRate: { limit: EventCoalescing.DEFAULT_NORMAL_RATE_LIMIT, usedInWindow: 0 },
  ...over,
})

describe("C5-07 risk -> drain priority", () => {
  test("medium maps to normal; low/high/critical pass through", () => {
    expect(EventCoalescing.riskToDrainPriority("low")).toBe("low")
    expect(EventCoalescing.riskToDrainPriority("medium")).toBe("normal")
    expect(EventCoalescing.riskToDrainPriority("high")).toBe("high")
    expect(EventCoalescing.riskToDrainPriority("critical")).toBe("critical")
  })
})

describe("C5-07 low coalescing", () => {
  test("two same/key low envelopes in the window merge; identity preserved on the base", () => {
    const base = mk("low", "a", [{ factId: "f1", factHash: "h1" }])
    const incoming = mk("low", "a", [{ factId: "f2", factHash: "h2" }, { factId: "f1", factHash: "h1" }])
    expect(base.eventRef).toBe(incoming.eventRef)
    const merged = EventCoalescing.mergeEnvelopes(base, incoming)
    // Identity preserved (same eventRef), facts deduped and accumulated (design §8.8: 保留 refs).
    expect(merged.eventRef).toBe(base.eventRef)
    expect(merged.verifiedFacts.map((f) => f.factId).sort()).toEqual(["f1", "f2"])
  })

  test("a same-key low envelope within the window classifies as merge; outside the window it admits", () => {
    const env = mk("low", "a")
    const inWindow = EventCoalescing.classify(env, ctx({ lastSeenSameKeyAt: 9000, now: 10_000, windowMs: 1000 }))
    expect(inWindow.action).toBe("merge")
    const outOfWindow = EventCoalescing.classify(env, ctx({ lastSeenSameKeyAt: 8000, now: 10_000, windowMs: 1000 }))
    expect(outOfWindow.action).toBe("admit")
  })

  test("a low envelope with no same-key pending admits", () => {
    const env = mk("low", "a")
    expect(EventCoalescing.classify(env, ctx()).action).toBe("admit")
  })
})

describe("C5-07 normal throttle (never drop)", () => {
  test("a normal envelope within the per-consumer rate admits", () => {
    const env = mk("medium", "a")
    const decision = EventCoalescing.classify(env, ctx({ consumerRate: { limit: 5, usedInWindow: 4 } }))
    expect(decision.action).toBe("admit")
  })

  test("a normal envelope that EXCEEDS the rate is spooled (never silently dropped)", () => {
    const env = mk("medium", "a")
    const decision = EventCoalescing.classify(env, ctx({ consumerRate: { limit: 5, usedInWindow: 5 } }))
    expect(decision.action).toBe("spool")
    if (decision.action === "spool") {
      expect(decision.priority).toBe("normal")
      expect(decision.throttled).toBe(true)
    }
  })
})

describe("C5-07 high/critical: never merge, never drop", () => {
  test("a high envelope always spools (never merges) regardless of a same-key window", () => {
    const env = mk("high", "a")
    const decision = EventCoalescing.classify(env, ctx({ lastSeenSameKeyAt: 9000, now: 10_000, windowMs: 1000 }))
    expect(decision.action).toBe("spool")
    if (decision.action === "spool") expect(decision.priority).toBe("high")
  })

  test("a critical envelope always spools at critical priority", () => {
    const env = mk("critical", "a")
    const decision = EventCoalescing.classify(env, ctx())
    expect(decision.action).toBe("spool")
    if (decision.action === "spool") expect(decision.priority).toBe("critical")
  })

  test("merge is identity-preserving for high/critical (never merges)", () => {
    const base = mk("high", "a")
    const incoming = mk("high", "a")
    expect(EventCoalescing.mergeEnvelopes(base, incoming)).toBe(base)
  })
})

describe("C5-07 coalesce key + drain ranking", () => {
  test("coalesce key is (session, consumer, kind); drain order is critical > high > normal > low", () => {
    const env = mk("high", "a")
    const key = EventCoalescing.coalesceKey(env)
    expect(key.kind).toBe(`work.a`)
    expect(key.session).toBe("ws-1")
    expect(EventCoalescing.DRAIN_RANK.critical).toBeGreaterThan(EventCoalescing.DRAIN_RANK.high)
    expect(EventCoalescing.DRAIN_RANK.high).toBeGreaterThan(EventCoalescing.DRAIN_RANK.normal)
    expect(EventCoalescing.DRAIN_RANK.normal).toBeGreaterThan(EventCoalescing.DRAIN_RANK.low)
  })
})
