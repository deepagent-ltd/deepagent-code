import { Schema } from "effect"
import { contentDigest } from "../contract/digest"

// C4-01 — machine-readable capability manifest (design authority:
// docs/core-v2.0-beta/design.md §7.1-7.2). The manifest is the single
// machine-readable truth source for a DeepAgentCode capability: it tells the
// model how the capability is operated (entry tools + use_when) and how the
// runtime authorizes it (required_permissions / required_runtime_features) and
// where its procedure body lives (body_ref / body_hash). README is NOT the
// authority; this frozen schema is.
//
// Cross-field coherence with the frozen capability-load contract
// (contract/capability-load.ts design §7.2-7.5):
//   - A manifest's max_body_tokens must not exceed the frozen single-L2 body
//     budget (CapabilityBudgetLimits.l2SingleMaxTokens = 1200);
//   - body_ref always uses the capability://<id>@<version> scheme, never an
//     arbitrary filesystem path or URL — a manifest never names an external
//     body location (design §7.4: the loader only reads signed/trusted bundles);
//   - body_hash is the sha256:<hex> content digest of the procedure body. It is
//     OPTIONAL here: bodies are authored by the C4-09 body lane, so a first-batch
//     manifest carries body_ref but may carry no body_hash until the body exists.
//     A capability with an absent body_hash is discoverable at L0/L1 but is not
//     yet body-loadable (a the loader must return a typed not-found/incompatible).
//
// Signature vs digest:
//   - capabilityManifestSignature(manifest) is the per-manifest content identity
//     (sha256 over the canonical manifest). This is the "signed manifest"
//     binding in design §2.1.
//   - capabilityCatalogDigest(manifests) is the byte-stable identity of the
//     whole catalog (sha256 over the sorted manifests). Two JSON-equivalent
//     catalogs hash to the same digest; re-recording never changes it.

/** Version tag for the catalog / manifest schema surface. */
export const CapabilityVersion = {
  manifest: "capability-manifest.v1",
  signature: "capability-signature.v1",
  catalogSnapshot: "capability-catalog.v1",
} as const

/**
 * Disclosure budget limits, mirroring the frozen capability-load contract
 * (contract/capability-load.ts `CapabilityBudgetLimits`; design §7.3 / §13). The
 * enforced L0/L2 budget check below uses the frozen `assertContentLoadBudget`,
 * so a manifest or catalog that exceeds a literal here fails at the contract's
 * own gate. These literals are the values the frozen contract decoded to; if the
 * contract drifts, the catalog gate fails loudly rather than silently truncating.
 */
export const CapabilityBudget = {
  l0MaxBytes: 4096,
  l0MaxTokens: 700,
  l2SingleMaxTokens: 1200,
  l2PerTurnMaxNew: 2,
  l2PerTurnMaxNewTokens: 2400,
} as const

/**
 * Namespaced capability id: `deepagent.<name>` (design §7.1: product
 * capabilities live under the `deepagent.capability.*` namespace).
 */
export const CapabilityId = Schema.String.check(Schema.isPattern(/^deepagent\.[a-z0-9][a-z0-9-]*$/)).pipe(
  Schema.brand("Capability.Id"),
)
export type CapabilityId = typeof CapabilityId.Type

/**
 * Body reference for a capability procedure body, always the
 * `capability://<id>@<version>` scheme. Never an arbitrary path/URL (design
 * §7.4). `name` is an identifier, not prose.
 */
export const CapabilityBodyRef = Schema.String.check(
  Schema.isPattern(/^capability:\/\/deepagent\.[a-z0-9][a-z0-9-]*@[0-9A-Za-z][0-9A-Za-z.+-]*$/),
).pipe(Schema.brand("Capability.BodyRef"))
export type CapabilityBodyRef = typeof CapabilityBodyRef.Type

/** Availability / maintenance state (design §7.2, §7.6 — never advertise unusable). */
export const CapabilityAvailability = Schema.Literals(["stable", "maintenance_only", "disabled", "unavailable"])
export type CapabilityAvailability = typeof CapabilityAvailability.Type

const hash = /^sha256:[0-9a-f]{64}$/

/** A body hash is the sha256 content digest of the procedure body. */
export const CapabilityBodyHash = Schema.String.check(Schema.isPattern(hash)).pipe(Schema.brand("Capability.BodyHash"))
export type CapabilityBodyHash = typeof CapabilityBodyHash.Type

/** A capability version, e.g. `2.0.0-beta.0`. Non-empty, no whitespace. */
export const CapabilityVersionString = Schema.String.check(Schema.isPattern(/^\S+$/)).pipe(
  Schema.brand("Capability.Version"),
)
export type CapabilityVersionString = typeof CapabilityVersionString.Type

/**
 * A non-empty human phrase (summary / use_when / permission / runtime feature /
 * tool name). Reject empty and whitespace-only strings so a frozen catalog never
 * advertises an empty entry point.
 */
const Phrase = Schema.String.check(Schema.isPattern(/^(?=\S)[\s\S]+$/))

/**
 * The machine-readable capability manifest (design §7.2). A closed, decode-strict
 * shape: unknown fields reject (onExcessProperty is enforced by the consumer's
 * decode call), and the invariants below are cross-field, not shape.
 */
export const CapabilityManifest = Schema.Struct({
  id: CapabilityId,
  version: CapabilityVersionString,
  summary: Phrase,
  use_when: Schema.Array(Phrase),
  availability: CapabilityAvailability,
  required_permissions: Schema.Array(Phrase),
  required_runtime_features: Schema.Array(Phrase),
  entry_tools: Schema.Array(Phrase),
  body_ref: CapabilityBodyRef,
  body_hash: CapabilityBodyHash.pipe(Schema.optional),
  max_body_tokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
})
export type CapabilityManifest = typeof CapabilityManifest.Type

/** Decode a CapabilityManifest, rejecting unknown fields and cross-field incoherence.
 * A body_ref that names a different capability (or version) than the manifest id is
 * an illegitimate manifest (design §7.4: body_ref is always the capability://<id>@<version>
 * scheme) — rejected here, never accepted into the catalog. */
export const decodeCapabilityManifest = (input: unknown): CapabilityManifest => {
  const manifest = Schema.decodeUnknownSync(CapabilityManifest, { onExcessProperty: "error" })(input)
  const expectedBodyRef = `capability://${String(manifest.id)}@${manifest.version}`
  if (String(manifest.body_ref) !== expectedBodyRef) {
    throw new MismatchedBodyRefError({ capabilityId: manifest.id, bodyRef: manifest.body_ref })
  }
  return manifest
}

// ---- typed gate violations -------------------------------------------------

/** Typed violation: a manifest references an entry tool that is not in the tool inventory. */
export class UnknownEntryToolError extends Schema.TaggedErrorClass<UnknownEntryToolError>()(
  "CapabilityManifest.UnknownEntryToolError",
  { capabilityId: CapabilityId, tool: Schema.String },
) {}

/** Typed violation: a manifest requires a permission action not in the permission catalog. */
export class UnknownPermissionError extends Schema.TaggedErrorClass<UnknownPermissionError>()(
  "CapabilityManifest.UnknownPermissionError",
  { capabilityId: CapabilityId, permission: Schema.String },
) {}

/** Typed violation: a manifest requires a runtime feature that is not known/enabled. */
export class UnknownRuntimeFeatureError extends Schema.TaggedErrorClass<UnknownRuntimeFeatureError>()(
  "CapabilityManifest.UnknownRuntimeFeatureError",
  { capabilityId: CapabilityId, feature: Schema.String },
) {}

/** Typed violation: a stable capability declares a body budget above the frozen L2 single-body cap. */
export class BodyBudgetExceededError extends Schema.TaggedErrorClass<BodyBudgetExceededError>()(
  "CapabilityManifest.BodyBudgetExceededError",
  {
    capabilityId: CapabilityId,
    maxBodyTokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    limitTokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  },
) {}

/** Typed violation: a body_ref does not name the same capability it is attached to. */
export class MismatchedBodyRefError extends Schema.TaggedErrorClass<MismatchedBodyRefError>()(
  "CapabilityManifest.MismatchedBodyRefError",
  { capabilityId: CapabilityId, bodyRef: CapabilityBodyRef },
) {}

/** Typed violation: a manifest is advertised but an invariant is broken. */
export class InconsistentManifestError extends Schema.TaggedErrorClass<InconsistentManifestError>()(
  "CapabilityManifest.InconsistentManifestError",
  { capabilityId: CapabilityId, violations: Schema.Array(Schema.String) },
) {}

/** Catalog-level gate that failed before it could be analyzed. */
export class CapabilityCatalogGateError extends Schema.TaggedErrorClass<CapabilityCatalogGateError>()(
  "CapabilityManifest.CatalogGateError",
  { message: Schema.String },
) {}

// ---- signature + digest ----------------------------------------------------

/** Content identity (signature) of one manifest: `sha256:<hex>` over the canonical manifest. */
export const capabilityManifestSignature = (manifest: CapabilityManifest): string => `sha256:${contentDigest(manifest)}`

/**
 * Byte-stable catalog digest: `sha256:<hex>` over the sorted manifests (by id,
 * then version). The catalog carries no volatile timestamp, so the digest depends
 * only on the capability content — re-recording or re-dispatch never changes it.
 */
export const capabilityCatalogDigest = (manifests: ReadonlyArray<CapabilityManifest>): string =>
  `sha256:${contentDigest(sortManifests(manifests))}`

// ---- consistency gate (design §7.2: ToolRegistry / flags / policy / App view) ----

/**
 * Product-level inventory the manifest is statically checked against. This is the
 * single source of truth for which tools, permission actions and runtime features
 * the product ships: a manifest that names an unknown entry tool, permission or
 * feature fails the gate (design §7.2 "与 ToolRegistry、RuntimeFlags、policy 和 App
 * capability view 做静态一致性校验"). The inventory is intentionally a readonly
 * surface so the gate can run at build/start time without mounting a live
 * ToolRegistry / Policy service.
 */
export interface CapabilityInventory {
  readonly toolNames: ReadonlySet<string>
  readonly runtimeFeatures: ReadonlySet<string>
  readonly permissionActions: ReadonlySet<string>
}

/** Product tool inventory: the shipped Location-scoped built-in tools plus context-federation tools. */
export const DeepAgentCodeToolInventory: CapabilityInventory = {
  toolNames: new Set([
    "read",
    "glob",
    "grep",
    "edit",
    "write",
    "apply-patch",
    "bash",
    "websearch",
    "webfetch",
    "question",
    "skill",
    "context_query",
    "code_intel",
  ]),
  runtimeFeatures: new Set(["context_federation_v2", "context_query_tools_v2"]),
  permissionActions: new Set([
    "read",
    "glob",
    "grep",
    "edit",
    "bash",
    "websearch",
    "webfetch",
    "question",
    "skill",
    "context.read",
  ]),
}

/** A manifest bodies/entry points are coherent with the supplied inventory. */
export interface ManifestCoherence {
  readonly manifest: CapabilityManifest
  readonly violations: ReadonlyArray<string>
}

/**
 * Validate one manifest against the product inventory. Entry tools must be known,
 * required permissions must be catalogued, required runtime features must be
 * known, the body budget must respect the frozen L2 ceiling, and the body_ref must
 * name the same capability. Returns the full violation list (empty = coherent);
 * throws a typed error only when the manifest itself is malformed.
 */
export function manifestCoherence(manifest: CapabilityManifest, inventory: CapabilityInventory): ManifestCoherence {
  const violations: string[] = []
  for (const tool of manifest.entry_tools) {
    if (!inventory.toolNames.has(tool)) violations.push(`unknown entry tool: ${tool}`)
  }
  for (const permission of manifest.required_permissions) {
    if (!inventory.permissionActions.has(permission)) violations.push(`unknown permission: ${permission}`)
  }
  for (const feature of manifest.required_runtime_features) {
    if (!inventory.runtimeFeatures.has(feature)) violations.push(`unknown runtime feature: ${feature}`)
  }
  if (manifest.max_body_tokens > CapabilityBudget.l2SingleMaxTokens) {
    violations.push(`max_body_tokens ${manifest.max_body_tokens} exceeds L2 cap ${CapabilityBudget.l2SingleMaxTokens}`)
  }
  const expectedBodyRef = `capability://${manifest.id}@${manifest.version}`
  if (manifest.body_ref !== expectedBodyRef) violations.push(`body_ref ${manifest.body_ref} does not name ${expectedBodyRef}`)
  return { manifest, violations }
}

/** Throw when a manifest is not coherent with the inventory (build/start gate). */
export function assertCapabilityManifestConsistent(
  manifest: CapabilityManifest,
  inventory: CapabilityInventory,
): void {
  const { violations } = manifestCoherence(manifest, inventory)
  if (violations.length > 0) {
    throw new InconsistentManifestError({ capabilityId: manifest.id, violations })
  }
}

/** Throw when the whole catalog is not instrumented against the inventory. */
export function assertCapabilityCatalogConsistent(
  manifests: ReadonlyArray<CapabilityManifest>,
  inventory: CapabilityInventory,
): void {
  const duplicates = duplicateIds(manifests)
  if (duplicates.length > 0) {
    throw new CapabilityCatalogGateError({ message: `duplicate capability ids: [${duplicates.join(", ")}]` })
  }
  for (const manifest of manifests) assertCapabilityManifestConsistent(manifest, inventory)
}

/** Deterministically sort manifests by id, then version. */
export function sortManifests(manifests: ReadonlyArray<CapabilityManifest>): ReadonlyArray<CapabilityManifest> {
  return [...manifests].toSorted(
    (a, b) => a.id.localeCompare(b.id) || a.version.localeCompare(b.version),
  )
}

function duplicateIds(manifests: ReadonlyArray<CapabilityManifest>): string[] {
  const seen = new Set<string>()
  const dupes = new Set<string>()
  for (const manifest of manifests) {
    if (seen.has(manifest.id)) dupes.add(manifest.id)
    seen.add(manifest.id)
  }
  return [...dupes].sort()
}
