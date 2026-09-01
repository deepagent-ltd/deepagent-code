import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { SystemContext } from "@deepagent-code/core/system-context"
import { SystemContextRegistry } from "@deepagent-code/core/system-context/registry"
import {
  assertCapabilityCatalogWithinBudget,
  capabilityCatalog,
  capabilityCatalogMetrics,
  capabilityCatalogSnapshot,
  capabilityL0Line,
  registerCapabilityCatalog,
  renderCapabilityCatalog,
} from "@deepagent-code/core/system-context/capability-catalog"
import { CapabilityBudget } from "@deepagent-code/core/system-context/capability-manifest"
import { testEffect } from "../lib/effect"

// C4-02 — L0 `deepagent/capability-catalog` System Context source + budget gate.
// Target 150-300 tokens; hard cap 700 tokens / 4096 bytes (frozen contract).

const catalogLayer = Layer.provideMerge(registerCapabilityCatalog, SystemContextRegistry.layer)
const itRegistry = testEffect(catalogLayer)

describe("C4-02 L0 capability catalog", () => {
  itRegistry.effect("stably loads the catalog as a System Context source", () =>
    Effect.gen(function* () {
      const registry = yield* SystemContextRegistry.Service
      const context = yield* registry.load()
      const initialized = yield* SystemContext.initialize(context)
      expect(initialized.baseline).toContain("DeepAgentCode capabilities")
      expect(initialized.baseline).toContain("deepagent.code-read")
      expect(initialized.baseline).toContain("deepagent.context-query")
    }),
  )

  itRegistry.effect("exposes a single source with the capability-catalog key", () =>
    Effect.gen(function* () {
      const registry = yield* SystemContextRegistry.Service
      const context = yield* registry.load()
      const snapshot = yield* SystemContext.initialize(context)
      expect(Object.keys(snapshot.snapshot)).toContain("deepagent/capability-catalog")
    }),
  )
})

describe("C4-02 budget gate", () => {
  test("keeps the boot catalog within the frozen budget (target 150-300 tokens)", () => {
    const { tokenCount, byteCount } = capabilityCatalogMetrics(renderCapabilityCatalog())
    expect(tokenCount).toBeGreaterThanOrEqual(150)
    expect(tokenCount).toBeLessThanOrEqual(300)
    expect(byteCount).toBeLessThanOrEqual(CapabilityBudget.l0MaxBytes)
    expect(tokenCount).toBeLessThanOrEqual(CapabilityBudget.l0MaxTokens)
    expect(() => assertCapabilityCatalogWithinBudget(renderCapabilityCatalog())).not.toThrow()
  })

  test("rejects an over-budget catalog (never silently truncates)", () => {
    const oversized = renderCapabilityCatalog() + "\n".repeat(CapabilityBudget.l0MaxBytes)
    expect(() => assertCapabilityCatalogWithinBudget(oversized)).toThrow()
  })

  test("counts bytes and tokens deterministically", () => {
    const a = capabilityCatalogMetrics(renderCapabilityCatalog())
    const b = capabilityCatalogMetrics(renderCapabilityCatalog())
    expect(a).toEqual(b)
    expect(a.byteCount).toBeGreaterThan(0)
    expect(a.tokenCount).toBeGreaterThan(0)
  })

  test("freezes a deterministic snapshot over the first batch", () => {
    expect(capabilityCatalogSnapshot.digest).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(capabilityCatalogSnapshot.schemaVersion).toBe("capability-catalog.v1")
    expect(capabilityCatalogSnapshot.capabilities.map((m) => m.id).length).toBeGreaterThan(0)
  })
})

describe("W4.1 L0 availability annotation (design §7.6 — never advertise an unusable capability)", () => {
  test("a maintenance_only capability is marked and never advertises an executable entry vector", () => {
    const text = renderCapabilityCatalog()
    expect(text).toContain("deepagent.context-query [maintenance]")
    // The directory stays complete (the id is discoverable), but the entry vector
    // that would promise an operable `context_query` tool is withheld.
    expect(text).not.toContain("Entry: context_query")
  })

  test("capabilityL0Line annotates non-stable capabilities and keeps stable lines unmarked", () => {
    const maintenance = capabilityCatalog.find((manifest) => manifest.id === "deepagent.context-query")!
    const stable = capabilityCatalog.find((manifest) => manifest.id === "deepagent.code-read")!
    expect(capabilityL0Line(maintenance)).toContain("[maintenance]")
    expect(capabilityL0Line(maintenance)).toContain("Entry: (not yet available)")
    expect(capabilityL0Line(stable)).not.toContain("[")
    expect(capabilityL0Line(stable)).toContain("Entry: read, glob, grep")
  })

  test("the annotated catalog still fits the frozen L0 budget", () => {
    const { tokenCount, byteCount } = capabilityCatalogMetrics(renderCapabilityCatalog())
    expect(tokenCount).toBeLessThanOrEqual(CapabilityBudget.l0MaxTokens)
    expect(byteCount).toBeLessThanOrEqual(CapabilityBudget.l0MaxBytes)
    expect(() => assertCapabilityCatalogWithinBudget(renderCapabilityCatalog())).not.toThrow()
  })
})