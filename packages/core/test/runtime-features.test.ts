import { describe, expect, test } from "bun:test"
import {
  RuntimeFeatures,
  createRuntimeFeatureRegistry,
  UnknownRuntimeFeatureError,
  RuntimeFeatureDriftError,
} from "@deepagent-code/core/flag/runtime-features"
import { DeepAgentCodeToolInventory } from "@deepagent-code/core/system-context/capability-manifest"
import { capabilityCatalog, capabilityCatalogDigestValue } from "@deepagent-code/core/system-context/capability-catalog"

// W4: `enabled()` now returns the feature's REAL runtime value (flip-flag gates). These
// suite-wide assertions describe the PRODUCTION-enabled state (the W0.1 runtime defaults
// set these envs in the entrypoints), so the two context gates are preset to ON here; the
// env-consistency matrix (incl. the OFF side) is covered by
// system-context/capability-l2-production.test.ts.
process.env["DEEPAGENT_CODE_CONTEXT_FEDERATION_PRODUCTION"] = "true"
process.env["DEEPAGENT_CODE_CONTEXT_QUERY_TOOLS_V2"] = "true"
delete process.env["DEEPAGENT_CODE_EVENT_V2_ADMISSION"]
delete process.env["DEEPAGENT_CODE_EVENT_V2_IM_SINGLE_WRITE"]

// C5-05 — the runtime feature registry is DERIVED from the frozen capability catalog, never a
// hand-duplicated literal. These tests prove the derivation, the fail-closed unknown-feature
// behavior, the drift gate, and deterministic digest.

const expectedCanonical = (): ReadonlyArray<string> => {
  const features = new Set<string>(DeepAgentCodeToolInventory.runtimeFeatures)
  for (const manifest of capabilityCatalog) {
    for (const feature of manifest.required_runtime_features) features.add(feature)
  }
  return [...features].sort()
}

describe("RuntimeFeatures derivation (from the frozen catalog)", () => {
  test("canonical set == catalog required_runtime_features ∪ inventory runtimeFeatures", () => {
    expect(RuntimeFeatures.all()).toEqual(expectedCanonical())
  })

  test("includes the manifest-declared context_federation_v2 and the inventory-only context_query_tools_v2", () => {
    expect(RuntimeFeatures.enabled("context_federation_v2")).toBe(true)
    expect(RuntimeFeatures.enabled("context_query_tools_v2")).toBe(true)
  })

  test("every catalog-declared runtime feature is in the registry", () => {
    const declared = capabilityCatalog.flatMap((manifest) => manifest.required_runtime_features)
    for (const feature of declared) expect(RuntimeFeatures.all()).toContain(feature)
  })

  test("the registry is derived, not a hand-duplicated literal (no empty/missing catalog feature)", () => {
    // context_federation_v2 is declared by deepagent.context-query; a hand-duplicated registry that
    // forgot the union would drop it or add something the catalog never declares.
    expect(RuntimeFeatures.all().length).toBeGreaterThanOrEqual(2)
  })
})

describe("RuntimeFeatures.enabled (fail-closed on unknown feature)", () => {
  test("a known shipped feature is enabled", () => {
    expect(RuntimeFeatures.enabled("context_federation_v2")).toBe(true)
    expect(RuntimeFeatures.enabled("context_query_tools_v2")).toBe(true)
  })

  test("captures immutable startup values and isolates independent roots", () => {
    const on = createRuntimeFeatureRegistry(undefined, {
      DEEPAGENT_CODE_CONTEXT_FEDERATION_PRODUCTION: "true",
    })
    const offEnv = { DEEPAGENT_CODE_CONTEXT_FEDERATION_PRODUCTION: "false" }
    const off = createRuntimeFeatureRegistry(undefined, offEnv)
    offEnv.DEEPAGENT_CODE_CONTEXT_FEDERATION_PRODUCTION = "true"

    expect(on.enabled("context_federation_v2")).toBe(true)
    expect(off.enabled("context_federation_v2")).toBe(false)
  })

  test("an unknown feature throws a typed UnknownRuntimeFeatureError (never a silent false)", () => {
    expect(() => RuntimeFeatures.enabled("context_federation_v9")).toThrow(UnknownRuntimeFeatureError)
    try {
      RuntimeFeatures.enabled("bogus_feature")
      throw new Error("expected to throw")
    } catch (error) {
      if (error instanceof UnknownRuntimeFeatureError) {
        expect(error.feature).toBe("bogus_feature")
      } else throw error
    }
  })
})

describe("RuntimeFeatures.assertCanonical (drift gate)", () => {
  test("does not throw when the registry matches the catalog", () => {
    expect(() => RuntimeFeatures.assertCanonical()).not.toThrow()
  })

  test("drift oracle: an added feature throws RuntimeFeatureDriftError", () => {
    const drifted = createRuntimeFeatureRegistry([...RuntimeFeatures.all(), "context_federation_v9"])
    expect(() => drifted.assertCanonical()).toThrow(RuntimeFeatureDriftError)
  })

  test("drift oracle: a missing required feature throws RuntimeFeatureDriftError", () => {
    const withoutFeature = RuntimeFeatures.all().filter((feature) => feature !== "context_federation_v2")
    const drifted = createRuntimeFeatureRegistry(withoutFeature)
    expect(() => drifted.assertCanonical()).toThrow(RuntimeFeatureDriftError)
  })
})

describe("RuntimeFeatures.digest (deterministic)", () => {
  test("the digest is deterministic and equals the catalog digest", () => {
    expect(RuntimeFeatures.digest()).toBe(capabilityCatalogDigestValue)
    expect(RuntimeFeatures.digest()).toBe(RuntimeFeatures.digest())
  })
})
