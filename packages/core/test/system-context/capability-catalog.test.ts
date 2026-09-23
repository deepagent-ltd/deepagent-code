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
  CurrentAvailableToolNames,
  CurrentGrantedPermissions,
  registerCapabilityCatalog,
  renderCapabilityCatalog,
} from "@deepagent-code/core/system-context/capability-catalog"
import { CapabilityBudget } from "@deepagent-code/core/system-context/capability-manifest"
import { testEffect } from "../lib/effect"

// C4-02 — L0 `deepagent/capability-catalog` System Context source + budget gate.
// V2.0.1-001 §4.6 (decision ④): the catalog expanded to ~12-15 rows and the hard cap
// moved from 700 to 1000 tokens (4096 bytes unchanged).

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

  itRegistry.effect("renders only capabilities granted to the current Session", () =>
    Effect.gen(function* () {
      const registry = yield* SystemContextRegistry.Service
      const initialized = yield* SystemContext.initialize(yield* registry.load()).pipe(
        Effect.provideService(CurrentGrantedPermissions, new Set(["read", "glob", "grep"])),
      )

      expect(initialized.baseline).toContain("deepagent.code-read")
      expect(initialized.baseline).not.toContain("deepagent.code-edit")
      expect(initialized.baseline).not.toContain("deepagent.shell-execute")
    }),
  )

  itRegistry.effect("does not advertise a capability whose entry tool is absent from this Location", () =>
    Effect.gen(function* () {
      const registry = yield* SystemContextRegistry.Service
      const initialized = yield* SystemContext.initialize(yield* registry.load()).pipe(
        Effect.provideService(
          CurrentAvailableToolNames,
          new Set(["read", "glob", "grep", "edit", "write", "apply_patch", "bash", "websearch", "webfetch", "skill"]),
        ),
      )

      expect(initialized.baseline).toContain("deepagent.code-read")
      expect(initialized.baseline).not.toContain("deepagent.context-query")
    }),
  )
})

describe("C4-02 budget gate", () => {
  test("keeps the expanded boot catalog within the raised budget (V2.0.1-001 decision ④)", () => {
    const { tokenCount, byteCount } = capabilityCatalogMetrics(renderCapabilityCatalog())
    // The ~12-15 row expansion actually landed (the 6-row catalog measured ~260 tokens).
    expect(tokenCount).toBeGreaterThanOrEqual(300)
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

describe("Core V2 context-query capability availability", () => {
  test("the stable capability advertises its canonical Core entry vector", () => {
    const text = renderCapabilityCatalog()
    expect(text).toContain("deepagent.context-query")
    expect(text).toContain("Entry: context_query")
  })

  test("capabilityL0Line renders context_query as stable", () => {
    const contextQuery = capabilityCatalog.find((manifest) => manifest.id === "deepagent.context-query")!
    expect(capabilityL0Line(contextQuery)).not.toContain("[")
    expect(capabilityL0Line(contextQuery)).toContain("Entry: context_query")
  })

  test("the annotated catalog still fits the L0 budget", () => {
    const { tokenCount, byteCount } = capabilityCatalogMetrics(renderCapabilityCatalog())
    expect(tokenCount).toBeLessThanOrEqual(CapabilityBudget.l0MaxTokens)
    expect(byteCount).toBeLessThanOrEqual(CapabilityBudget.l0MaxBytes)
    expect(() => assertCapabilityCatalogWithinBudget(renderCapabilityCatalog())).not.toThrow()
  })
})
