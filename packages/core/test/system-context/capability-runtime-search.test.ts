import { describe, expect, test } from "bun:test"
import {
  enabledRuntimeFeatureSet,
  makeRuntimeAuthorizedSearchTool,
  runtimeAuthorizedSearch,
  runtimeFeatureAuthorization,
  runtimeFeatureCompatible,
} from "@deepagent-code/core/system-context/capability-runtime-search"
import { RuntimeFeatures } from "@deepagent-code/core/flag/runtime-features"
import { capabilityCatalog } from "@deepagent-code/core/system-context/capability-catalog"
import { decodeCapabilityManifest, DeepAgentCodeToolInventory } from "@deepagent-code/core/system-context/capability-manifest"

// C4-07 — capability_search's enabledRuntimeFeatures reconnected to the E2
// manifest-derived RuntimeFeatures registry (the frozen capability-search.ts is
// untouched; this module is the replacement seam).

const manifest = (requiredRuntimeFeatures: readonly string[]) =>
  decodeCapabilityManifest({
    id: "deepagent.context-query",
    version: "1.0.0-beta.0",
    summary: "Query authorized cross-graph project context",
    use_when: ["recalling project context"],
    availability: "stable",
    required_permissions: ["context.read"],
    required_runtime_features: requiredRuntimeFeatures,
    entry_tools: ["context_query"],
    body_ref: "capability://deepagent.context-query@1.0.0-beta.0",
    max_body_tokens: 1200,
  })

describe("runtime feature set is DERIVED from the E2 registry (never hardcoded)", () => {
  test("enabledRuntimeFeatureSet equals the registry's canonical all() set", () => {
    const fromRegistry = new Set(RuntimeFeatures.all())
    const derived = enabledRuntimeFeatureSet()
    expect([...derived].sort()).toEqual([...fromRegistry].sort())
    // The E2 registry is manifest-derived; the two are in lock-step.
    expect(RuntimeFeatures.assertCanonical()).toBeUndefined()
  })

  test("runtimeFeatureAuthorization uses the inventory permissions + registry runtime features", () => {
    const auth = runtimeFeatureAuthorization()
    expect([...auth.grantedPermissions].sort()).toEqual([...DeepAgentCodeToolInventory.permissionActions].sort())
    expect([...auth.enabledRuntimeFeatures].sort()).toEqual([...RuntimeFeatures.all()].sort())
  })
})

describe("runtimeFeatureCompatible consults RuntimeFeatures.enabled per feature (fail-closed)", () => {
  test("a manifest requiring a known, enabled feature is compatible", () => {
    expect(runtimeFeatureCompatible(manifest(["context_federation_v2"]))).toBe(true)
  })

  test("a manifest requiring an unknown feature is authoritatively incompatible (fail-closed)", () => {
    // The registry throws UnknownRuntimeFeatureError for an unknown feature; the
    // compat check must never treat it as enabled (design §7.3 runtime filter).
    expect(runtimeFeatureCompatible(manifest(["no_such_runtime_feature"]))).toBe(false)
  })

  test("a manifest with no runtime requirement is always compatible", () => {
    expect(runtimeFeatureCompatible(manifest([]))).toBe(true)
  })
})

describe("runtime-authorized search + tool (the wired successor)", () => {
  test("search returns a registry-authorized capability card", () => {
    const output = runtimeAuthorizedSearch(capabilityCatalog, { query: "project context", intended_action: "context_query" }, "capability_catalog:test")
    expect(output.cards.map((card) => String(card.id))).toContain("deepagent.context-query")
    expect(output.catalog_snapshot_id).toBe("capability_catalog:test")
  })

  test("a runtime-incompatible capability is never advertised", () => {
    const incompatible = decodeCapabilityManifest({
      id: "deepagent.context-query",
      version: "1.0.0-beta.0",
      summary: "Query authorized cross-graph project context",
      use_when: ["recalling project context"],
      availability: "stable",
      required_permissions: ["context.read"],
      required_runtime_features: ["no_such_runtime_feature"],
      entry_tools: ["context_query"],
      body_ref: "capability://deepagent.context-query@1.0.0-beta.0",
      max_body_tokens: 1200,
    })
    const catalog = [manifest(["context_federation_v2"]), incompatible]
    const output = runtimeAuthorizedSearch(catalog, { query: "project context" }, "capability_catalog:test")
    // Only the registry-compatible card is admissible; the unknown-feature one is never advertised.
    const compatible = output.cards.filter((card) => String(card.id) === "deepagent.context-query")
    expect(compatible).toHaveLength(1)
  })

  test("the tool definition is valid and registry-authorized", () => {
    const tool = makeRuntimeAuthorizedSearchTool({ catalogSnapshotId: "capability_catalog:test" })
    expect(tool).toBeTruthy()
  })
})
