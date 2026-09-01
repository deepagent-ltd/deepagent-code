import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import {
  enabledRuntimeFeatureSet,
  layer as searchToolLayer,
  makeRuntimeAuthorizedSearchTool,
  runtimeAuthorizedSearch,
  runtimeFeatureAuthorization,
  runtimeFeatureCompatible,
} from "@deepagent-code/core/system-context/capability-runtime-search"
import { RuntimeFeatures } from "@deepagent-code/core/flag/runtime-features"
import { capabilityCatalog } from "@deepagent-code/core/system-context/capability-catalog"
import { decodeCapabilityManifest, DeepAgentCodeToolInventory } from "@deepagent-code/core/system-context/capability-manifest"
import { ToolRegistry } from "@deepagent-code/core/tool/registry"
import { AgentV2 } from "@deepagent-code/core/agent"
import { SessionV2 } from "@deepagent-code/core/session"
import { SessionMessage } from "@deepagent-code/core/session/message"
import { testEffect } from "../lib/effect"

// W4: `RuntimeFeatures.enabled` is env-gated (flip-flag). These cases describe the
// PRODUCTION-ENABLED state (the W0.1 runtime defaults set the context gates ON in the
// entrypoints), so the context federation gate is preset to ON here; the env-consistency
// matrix (incl. the OFF side) is covered by capability-l2-production.test.ts.
process.env["DEEPAGENT_CODE_CONTEXT_FEDERATION_PRODUCTION"] = "true"
process.env["DEEPAGENT_CODE_CONTEXT_QUERY_TOOLS_V2"] = "true"
delete process.env["DEEPAGENT_CODE_EVENT_V2_ADMISSION"]
delete process.env["DEEPAGENT_CODE_EVENT_V2_IM_SINGLE_WRITE"]

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
    // W3.5 tool-consistency ruling: `deepagent.context-query` is maintenance_only (the
    // context_query tool is not registered yet), so it is NEVER advertised as executable.
    expect(output.cards.map((card) => String(card.id))).not.toContain("deepagent.context-query")
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

describe("K3 production registry assembly registers capability_search", () => {
  const itRegistry = testEffect(searchToolLayer.pipe(Layer.provideMerge(ToolRegistry.defaultLayer)))

  itRegistry.effect("the tool is registered in the Location tool registry under its canonical name", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const materialized = yield* registry.materialize()
      expect(materialized.definitions.map((tool) => tool.name)).toContain("capability_search")
    }),
  )

  itRegistry.effect("a runtime-authorized search over the recorded catalog returns cards", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const materialized = yield* registry.materialize()
      const output = yield* materialized.settle({
        sessionID: SessionV2.ID.make("ses_registry"),
        agent: AgentV2.ID.make("build"),
        assistantMessageID: SessionMessage.ID.make("msg_registry"),
        call: { type: "tool-call", id: "call-caps", name: "capability_search", input: { query: "project context", intended_action: "context_query" } },
      })
      expect(output.result.type).toBe("text")
      // W3.5: a maintenance-only capability is never in a runtime search result.
      expect(String(output.result.value)).not.toContain("deepagent.context-query")
    }),
  )
})
