// C5-05 — manifest-derived runtime feature registry.
// Design authority: docs/core-v2.0-beta/design.md §7.2 (the capability manifest is the single
// machine-readable truth source; `required_runtime_features` declares the runtime feature a
// capability needs) and §7.6 / §13 (the static consistency gate vs RuntimeFlags / policy / App
// view). README is not the authority — the frozen catalog is.
//
// The canonical runtime feature set is DERIVED from the frozen capability catalog, never
// hand-duplicated:
//   DeepAgentCodeToolInventory.runtimeFeatures   — the product feature inventory (§7.2)
//   ∪ capabilityCatalog.required_runtime_features — the features each shipped manifest requires
//
// Because it is derived, adding a manifest-declared feature or a new inventory feature changes the
// set, and `RuntimeFeatures.assertCanonical()` keeps the runtime registry in lock-step with the
// catalog (the drift gate). A runtime registry that disagrees (added/missing feature) is a build/
// start-time failure, never something a feature could silently drift past.

import { DeepAgentCodeToolInventory, capabilityCatalogDigest } from "../system-context/capability-manifest"
import { capabilityCatalog } from "../system-context/capability-catalog"
import { flipFlagValueOn } from "../deepagent/flip-flag"

/** The runtime gate behind each canonical feature (W4: `enabled()` returns the FEATURE'S
 * REAL value, not a constant true). All of them use the single explicit-env flag table
 * (`flipFlagValueOn` — a defined `""`/`false`/`0` is OFF, any other defined value is ON):
 *
 * | feature                    | env key                                      | unsetDefault | rationale                                      |
 * |----------------------------|----------------------------------------------|--------------|------------------------------------------------|
 * | event.v2.admission         | DEEPAGENT_CODE_EVENT_V2_ADMISSION            | true         | W0.1 default table (production default ON)     |
 * | event.v2.im_single_write   | DEEPAGENT_CODE_EVENT_V2_IM_SINGLE_WRITE      | true         | W0.1 default table (production default ON)     |
 * | context_federation_v2      | DEEPAGENT_CODE_CONTEXT_FEDERATION_PRODUCTION | false        | W3.1 gate key (reserved by W0.1); fail-closed in core until the production federation wiring is in; `runtimeDefaultsFromEnv` sets it ON in production entries |
 * | context_query_tools_v2     | DEEPAGENT_CODE_CONTEXT_QUERY_TOOLS_V2        | false        | no production consumer / no catalog manifest requires it this wave; opt-in key, OFF by default (W4 目录未启用 → false) |
 *
 * A canonical feature without an env binding is a build defect: it is reported OFF
 * (fail-closed) rather than silently passing. Unknown features keep throwing the typed
 * `UnknownRuntimeFeatureError`.
 */
const featureEnv = new Map<string, { readonly env: string; readonly unsetDefault: boolean }>([
  ["event.v2.admission", { env: "DEEPAGENT_CODE_EVENT_V2_ADMISSION", unsetDefault: true }],
  ["event.v2.im_single_write", { env: "DEEPAGENT_CODE_EVENT_V2_IM_SINGLE_WRITE", unsetDefault: true }],
  ["context_federation_v2", { env: "DEEPAGENT_CODE_CONTEXT_FEDERATION_PRODUCTION", unsetDefault: false }],
  ["context_query_tools_v2", { env: "DEEPAGENT_CODE_CONTEXT_QUERY_TOOLS_V2", unsetDefault: false }],
])

/** The canonical feature set the runtime ships: inventory features ∪ catalog-required features. */
const canonicalFeatures = (): ReadonlySet<string> => {
  const features = new Set<string>(DeepAgentCodeToolInventory.runtimeFeatures)
  for (const manifest of capabilityCatalog) {
    for (const feature of manifest.required_runtime_features) features.add(feature)
  }
  return features
}

/** Typed violation: a feature queried or registered is not in the canonical runtime feature registry. */
export class UnknownRuntimeFeatureError extends Error {
  readonly _tag = "RuntimeFeatures.UnknownRuntimeFeatureError"
  readonly feature: string
  constructor(feature: string) {
    super(`unknown runtime feature: "${feature}"`)
    this.name = "RuntimeFeatures.UnknownRuntimeFeatureError"
    this.feature = feature
  }
}

/** Typed violation: the runtime registry has drifted from the frozen capability catalog. */
export class RuntimeFeatureDriftError extends Error {
  readonly _tag = "RuntimeFeatures.DriftError"
  readonly added: ReadonlyArray<string>
  readonly missing: ReadonlyArray<string>
  constructor(added: ReadonlyArray<string>, missing: ReadonlyArray<string>) {
    super(
      `runtime feature registry drifts from catalog` +
        (added.length > 0 ? ` (added: [${added.join(", ")}])` : "") +
        (missing.length > 0 ? ` (missing: [${missing.join(", ")}])` : ""),
    )
    this.name = "RuntimeFeatures.DriftError"
    this.added = added
    this.missing = missing
  }
}

/** The manifest-derived runtime feature registry. */
export interface RuntimeFeatureRegistry {
  /** The canonical runtime feature set, sorted (deterministic). */
  readonly all: () => ReadonlyArray<string>
  /**
   * Is a runtime feature enabled? FAIL-CLOSED on an unknown feature: a feature the frozen catalog
   * / inventory does not declare throws a typed `UnknownRuntimeFeatureError` rather than silently
   * reporting `false`. A canonical feature is gated by its real runtime flag (see `featureEnv`:
   * W4 — event admission / IM single-write default ON per the W0.1 table, the two context features
   * default OFF until their production wiring is in). Unset/unknown-state features are `false`.
   */
  readonly enabled: (feature: string) => boolean
  /**
   * Drift gate: recompute the canonical feature set from the frozen catalog and throw a typed
   * `RuntimeFeatureDriftError` when this registry disagrees (any added or missing feature). Build
   * / start gates call this to prove the runtime is consistent with the manifest truth source.
   */
  readonly assertCanonical: () => void
  /** Byte-stable catalog digest the feature set is derived from (deterministic). */
  readonly digest: () => string
}

/**
 * Build a runtime feature registry. With no source the registry is exactly the canonical set
 * derived from the frozen catalog. Passing an explicit `sourceFeatures` builds a registry whose
 * set may differ from canonical — the drift-test oracle (and any tooling that wants to inspect a
 * suspect registry) exercising `assertCanonical`. Production code should use `RuntimeFeatures`.
 */
export const createRuntimeFeatureRegistry = (
  sourceFeatures?: Iterable<string>,
): RuntimeFeatureRegistry => {
  const features = new Set<string>(sourceFeatures ?? canonicalFeatures())
  return {
    all: () => [...features].sort(),
    enabled: (feature) => {
      if (!features.has(feature)) throw new UnknownRuntimeFeatureError(feature)
      const gate = featureEnv.get(feature)
      // A feature without a runtime gate is a build defect: report OFF (fail-closed),
      // never a silent pass.
      if (gate === undefined) return false
      return flipFlagValueOn(process.env[gate.env], gate.unsetDefault)
    },
    assertCanonical: () => {
      const expected = canonicalFeatures()
      const added = [...features].filter((feature) => !expected.has(feature)).sort()
      const missing = [...expected].filter((feature) => !features.has(feature)).sort()
      if (added.length > 0 || missing.length > 0) throw new RuntimeFeatureDriftError(added, missing)
    },
    digest: () => capabilityCatalogDigest(capabilityCatalog),
  }
}

/** The canonical, manifest-derived runtime feature registry (module-level singleton). */
export const RuntimeFeatures = createRuntimeFeatureRegistry()
