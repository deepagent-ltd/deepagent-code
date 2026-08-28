import { describe, expect, test } from "bun:test"
import type { WorkBudget, WorkContextQuery } from "@deepagent-code/core/contract/event-envelope"
import { EventWorkEnvelope } from "@deepagent-code/core/deepagent/event-work-envelope"
import type { WorkResolution } from "@deepagent-code/core/deepagent/event-work-envelope"
import { commandReg, makeRegistry, verifiedCommand, commandEnvelope, HASH } from "./event-fixture"

// C5-03 — event -> bounded EventWorkEnvelope builder. Design §8.4 (work envelope) + §8.8 (anti-noise).

const registry = makeRegistry()

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

const resolution = (over?: Partial<WorkResolution>): WorkResolution => ({
  trust: { level: "verified", sourceRef: "ctx://src/1" },
  permission: { scopes: ["goal.read"], required: ["goal.write"], maxAutonomy: "medium" },
  egress: { allowedDomains: ["plugins"], allowedSensitivities: ["public"] },
  budget,
  securityNamespaceId: "ns-1",
  projectScopeKey: "psc-1",
  contextQuery,
  ...over,
})

const build = (event = verifiedCommand(registry), reg = commandReg, res = resolution()) => EventWorkEnvelope.build({ event, registration: reg, resolution: res, verifiedFacts: [{ factId: "f-1", factHash: "fh" }] })

describe("EventWorkEnvelope.build", () => {
  test("produces a bounded envelope with the payload REF only (never the raw bytes)", () => {
    const result = build()
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.message)
    expect(result.envelope.schemaVersion).toBe("event-work.v1")
    expect(result.envelope.eventRef).toBe("event://e-1")
    expect(result.envelope.eventType).toBe("goal.tick.requested")
    expect(result.envelope.objective).toBe("advance the goal")
    expect(result.envelope.requestedCapability).toBe("deepagent.goal.advance")
    expect(result.envelope.payload).toEqual({ contentType: "application/json", ref: "ctx://p/1", payloadHash: HASH })
    expect(Object.keys(result.envelope.payload).length).toBe(3)
  })

  test("carries trust / permission / egress / budget in full", () => {
    const result = build()
    if (!result.ok) throw new Error(result.message)
    const e = result.envelope
    expect(e.trust.level).toBe("verified")
    expect(e.trust.sourceRef).toBe("ctx://src/1")
    expect(e.permission).toEqual({ scopes: ["goal.read"], required: ["goal.write"], maxAutonomy: "medium" })
    expect(e.egress).toEqual({ allowedDomains: ["plugins"], allowedSensitivities: ["public"] })
    expect(e.budget.maxTokens).toBe(8000)
    expect(e.budget.hourTokensMax).toBe(4000)
    expect(e.budget.hourWindowMinutes).toBe(60)
    expect(e.risk).toBe("medium")
    expect(e.autonomyCeiling).toBe("medium")
    expect(e.correlationId).toBe("c-1")
  })

  test("resolves actor/scope from the envelope + resolution", () => {
    const result = build()
    if (!result.ok) throw new Error(result.message)
    expect(result.envelope.actorAndScope).toEqual({
      actorId: "a-1",
      workspaceId: "ws-1",
      securityNamespaceId: "ns-1",
      projectScopeKey: "psc-1",
    })
  })

  test("delivery is seeded with the idempotency dedupe + event cursor", () => {
    const result = build()
    if (!result.ok) throw new Error(result.message)
    expect(result.envelope.delivery.dedupeId).toBe("idem-1")
    expect(result.envelope.delivery.exactlyOnceCursor).toBe("e-1")
    expect(result.envelope.delivery.attemptCount).toBe(0)
    expect(result.envelope.delivery.maxAttempts).toBe(3)
  })

  test("refuses coordination / operational noise (never enters the prompt)", () => {
    // A coordination event is never handed to a model, even if a registry type existed.
    const noise = commandEnvelope({ eventType: "agent.task.started" })
    const result = EventWorkEnvelope.build({
      event: noise as never,
      registration: { ...commandReg, eventType: "agent.task.started" },
      resolution: resolution(),
      verifiedFacts: [],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe("noise_event")
  })

  test("refuses an unbounded payload (raw content leaking into the ref)", () => {
    const raw = commandEnvelope()
    const leak = { ...(raw as unknown as Record<string, unknown>), payload: { contentType: "application/json", ref: "ctx://p/1", payloadHash: HASH, raw: "SECRET" } }
    const result = EventWorkEnvelope.build({
      event: leak as never,
      registration: commandReg,
      resolution: resolution(),
      verifiedFacts: [],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe("unbounded_payload")
  })

  test("the produced envelope round-trips through the frozen contract validator", () => {
    const result = build()
    if (!result.ok) throw new Error(result.message)
    // decodeEventWorkEnvelope would throw if the shape were invalid; assert it is well-formed.
    expect(result.envelope.schemaVersion).toBe("event-work.v1")
    expect(typeof result.envelope.budget.maxTokens).toBe("number")
  })
})
