export * as CapabilityRuntimeSearch from "./capability-runtime-search"

import { DeepAgentCodeToolInventory, type CapabilityManifest } from "./capability-manifest"
import {
  makeCapabilitySearchTool,
  searchOutput,
  type SearchAuthorization,
} from "./capability-search"
import { RuntimeFeatures } from "../flag/runtime-features"
import { Tool } from "../tool/tool"

// C4-07 — reconnect the (frozen) capability_search surface's runtime-feature filter
// to the E2 manifest-derived RuntimeFeatures registry (design §7.2: the capability
// manifest is the single machine-readable truth source; a capability is advertised
// only when its required runtime features are enabled in the runtime registry).
//
// capability-search.ts is FROZEN (K1): it hardcodes `fullAuthorization` to
// `new Set(["context_federation_v2", "context_query_tools_v2"])` and exposes
// `SearchAuthorization.enabledRuntimeFeatures` as an opaque `ReadonlySet<string>`.
// This module provides the REPLACEMENT seam on the capability side: the same
// enriched search surface, but with the enabled runtime feature set DERIVED from
// the E2 registry (`RuntimeFeatures.all()`), never hardcoded. A caller switches
// from `makeCapabilitySearchTool({ authorization: fullAuthorization })` to
// `makeRuntimeAuthorizedSearchTool()`, or from `capabilitySearch(cat, input, fullAuthorization)`
// to `runtimeAuthorizedSearch(cat, input)`. The frozen search file still needs a successor
// to adopt this surface natively; until then this module is the wired entry.
//
// The registry is fail-closed: `RuntimeFeatures.enabled(feature)` throws a typed
// `UnknownRuntimeFeatureError` for a feature the frozen catalog / inventory does not
// declare, so an unknown requested feature can never silently pass as enabled. A
// manifest that requires a feature absent from the registry is authoritatively
// runtime-incompatible (never advertised), which is exactly the design §7.3
// permission/runtime filter.

/**
 * Derive the Enabled runtime-feature set strictly from the E2 manifest-derived
 * registry. Every canonical feature is checked through `RuntimeFeatures.enabled`
 * (fail-closed on an unknown feature) and the resulting set is the registry's own
 * notion of "what is enabled" — there is no hardcoded duplicate. A feature that
 * the catalog imports (via `required_runtime_features`) but the registry does not
 * know is excluded, so a would-be capability is never advertised as runtime-ready.
 */
export const enabledRuntimeFeatureSet = (): ReadonlySet<string> =>
  new Set(RuntimeFeatures.all().filter((feature) => RuntimeFeatures.enabled(feature)))

/**
 * Build a `SearchAuthorization` whose enabled runtime features come from the E2
 * registry. Granted permissions come from the product inventory's permission
 * actions (the "everything granted" base used by the frozen `fullAuthorization`);
 * the runtime-feature half is registry-derived, never a frozen literal.
 */
export const runtimeFeatureAuthorization = (): SearchAuthorization => ({
  grantedPermissions: new Set(DeepAgentCodeToolInventory.permissionActions),
  enabledRuntimeFeatures: enabledRuntimeFeatureSet(),
})

/**
 * A per-feature runtime-compatibility check against the E2 registry. This is the
 * replacement for the frozen `isAuthorized` runtime half: it consults
 * `RuntimeFeatures.enabled` for EACH manifest-required feature, so a manifest that
 * needs a feature the runtime does not enable is authoritatively incompatible.
 * Fail-closed: a feature the registry does not recognize is `false`, never a pass.
 */
export const runtimeFeatureCompatible = (manifest: CapabilityManifest): boolean =>
  manifest.required_runtime_features.every((feature) => {
    try {
      return RuntimeFeatures.enabled(feature)
    } catch {
      return false
    }
  })

/**
 * Search the catalog with runtime authorization derived from the E2 registry.
 * This is the runtime-wired successor to the frozen `searchOutput`/`capabilitySearch`
 * call path (which the frozen file threads `fullAuthorization` through). The result
 * is the frozen search envelope, but the runtime-feature filter is the registry's.
 */
export function runtimeAuthorizedSearch(
  catalog: ReadonlyArray<CapabilityManifest>,
  input: { readonly query: string; readonly intended_action?: string },
  catalogSnapshotId: string,
) {
  return searchOutput(catalog, input, runtimeFeatureAuthorization(), catalogSnapshotId)
}

/**
 * A ready-to-register runtime-authorized `capability_search` tool. Successor to the
 * frozen `makeCapabilitySearchTool`: it feeds the E2-derived authorization so the
 * runtime-feature filter is the registry's, not a frozen literal.
 */
export function makeRuntimeAuthorizedSearchTool(input?: {
  readonly catalog?: ReadonlyArray<CapabilityManifest>
  readonly catalogSnapshotId?: string
}): Tool.AnyTool {
  return makeCapabilitySearchTool({
    ...(input?.catalog ? { catalog: input.catalog } : {}),
    ...(input?.catalogSnapshotId ? { catalogSnapshotId: input.catalogSnapshotId } : {}),
    authorization: runtimeFeatureAuthorization(),
  })
}
