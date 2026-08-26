// V3.8.1 §C Agent Registry extension — unit tests for the new optional
// descriptor metadata (schema optionality + defaults), the pure registry
// matchers (findByTrigger/findByCapability semantics), and the AgentDescriptor
// wire shape (encode/decode round-trip incl. serialization of the new fields).

import { describe, it, expect } from "bun:test"
import { Schema } from "effect"
import {
  AgentDescriptor,
  AutonomyLevel,
  AgentLimits,
  Trigger,
  DEFAULT_AUTONOMY_LEVEL,
} from "../src/im/mention-parser"
import { matchByTrigger, matchByCapability } from "../src/im/agent-list-provider"

const decode = Schema.decodeUnknownSync(AgentDescriptor)
const encode = Schema.encodeSync(AgentDescriptor)

describe("AgentDescriptor schema — new optional metadata (V3.8.1 §C.3)", () => {
  it("accepts a legacy descriptor with NONE of the new fields set", () => {
    const legacy = decode({
      id: "build",
      name: "build",
      displayName: "build",
      visible: true,
    })
    // Un-set metadata is absent, not defaulted to empty — V3.8 shape preserved.
    expect(legacy.triggers).toBeUndefined()
    expect(legacy.capabilities).toBeUndefined()
    expect(legacy.autonomy).toBeUndefined()
    expect(legacy.context_sources).toBeUndefined()
    expect(legacy.approval_required).toBeUndefined()
    expect(legacy.limits).toBeUndefined()
  })

  it("accepts a fully-populated descriptor and round-trips it on the wire", () => {
    const full = {
      id: "reviewer",
      name: "reviewer",
      displayName: "Reviewer",
      description: "reviews code",
      visible: true,
      triggers: [{ event: "code.changed", match: { path: "src/**" } }, { event: "ci.failure" }],
      capabilities: ["review", "test.run"],
      autonomy: "level_2" as const,
      context_sources: ["code_graph", "memory_graph"],
      approval_required: false,
      limits: {
        maxConcurrency: 4,
        maxTokensPerTurn: 200000,
        maxTurnDurationMs: 600000,
        writablePaths: ["src/"],
        toolWhitelist: ["edit", "bash"],
      },
    }
    const decoded = decode(full)
    expect(decoded.triggers?.[0]?.event).toBe("code.changed")
    expect(decoded.capabilities).toEqual(["review", "test.run"])
    expect(decoded.autonomy).toBe("level_2")
    expect(decoded.limits?.maxConcurrency).toBe(4)
    // Serializes back to a plain, wire-safe JSON object.
    const wire = encode(decoded)
    expect(JSON.parse(JSON.stringify(wire))).toEqual(full)
  })

  it("rejects an invalid autonomy literal", () => {
    expect(() => decode({ id: "x", name: "x", displayName: "x", visible: true, autonomy: "level_9" })).toThrow()
  })

  it("AutonomyLevel exposes level_0..level_5 and defaults to level_0", () => {
    expect(DEFAULT_AUTONOMY_LEVEL).toBe("level_0")
    const decodeLevel = Schema.decodeUnknownSync(AutonomyLevel)
    for (const lvl of ["level_0", "level_1", "level_2", "level_3", "level_4", "level_5"] as const) {
      expect(decodeLevel(lvl)).toBe(lvl)
    }
  })

  it("AgentLimits — all fields optional (lenient/unlimited default = empty is valid)", () => {
    // An empty limits object is valid: every ceiling unset ⇒ no limit imposed.
    const empty = Schema.decodeUnknownSync(AgentLimits)({})
    expect(empty.maxConcurrency).toBeUndefined()
    expect(empty.maxTokensPerTurn).toBeUndefined()
    expect(empty.maxTurnDurationMs).toBeUndefined()
    expect(empty.writablePaths).toBeUndefined()
    expect(empty.toolWhitelist).toBeUndefined()
  })

  it("Trigger — match conditions are optional", () => {
    expect(Schema.decodeUnknownSync(Trigger)({ event: "im.mention" }).match).toBeUndefined()
    expect(Schema.decodeUnknownSync(Trigger)({ event: "im.mention", match: { a: 1 } }).match).toEqual({ a: 1 })
  })
})

describe("registry matchers — pure matching, no dispatch (V3.8.1 §C.4)", () => {
  const base = { displayName: "", visible: true } as const
  const alpha: AgentDescriptor = {
    ...base,
    id: "alpha",
    name: "alpha",
    triggers: [{ event: "im.mention" }, { event: "code.changed" }],
    capabilities: ["code.edit", "review"],
  }
  const beta: AgentDescriptor = {
    ...base,
    id: "beta",
    name: "beta",
    triggers: [{ event: "code.changed" }],
    capabilities: ["code.edit"],
  }
  // Legacy agent: declares no metadata — must never match.
  const legacy: AgentDescriptor = { ...base, id: "legacy", name: "legacy" }
  const all = [alpha, beta, legacy]

  it("findByTrigger — multi-match", () => {
    expect(matchByTrigger(all, "code.changed").map((d) => d.id)).toEqual(["alpha", "beta"])
  })

  it("findByTrigger — single match", () => {
    expect(matchByTrigger(all, "im.mention").map((d) => d.id)).toEqual(["alpha"])
  })

  it("findByTrigger — no match returns empty", () => {
    expect(matchByTrigger(all, "ci.failure")).toEqual([])
  })

  it("findByCapability — multi-match", () => {
    expect(matchByCapability(all, "code.edit").map((d) => d.id)).toEqual(["alpha", "beta"])
  })

  it("findByCapability — single match", () => {
    expect(matchByCapability(all, "review").map((d) => d.id)).toEqual(["alpha"])
  })

  it("findByCapability — no match returns empty", () => {
    expect(matchByCapability(all, "doc.write")).toEqual([])
  })

  it("a descriptor with no triggers/capabilities never matches either query", () => {
    expect(matchByTrigger([legacy], "im.mention")).toEqual([])
    expect(matchByCapability([legacy], "code.edit")).toEqual([])
  })
})
