export * as CapabilityCatalog from "./capability-catalog"

import { Schema } from "effect"
import { assertContentLoadBudget } from "../contract/capability-load"
import { SystemContext } from "./index"
import { SystemContextRegistry } from "./registry"
import { Token } from "../util/token"
import {
  CapabilityBudget,
  CapabilityVersion,
  CapabilityManifest,
  DeepAgentCodeToolInventory,
  assertCapabilityCatalogConsistent,
  capabilityCatalogDigest,
  decodeCapabilityManifest,
  sortManifests,
} from "./capability-manifest"
import { Layer, Effect } from "effect"
import { makeLocationNode } from "../effect/app-node"

// C4-01 first batch of capability IDs (design §7.1-7.2) + C4-02 L0 catalog
// (design §7.3). The first batch is the machine-readable inventory the model uses
// to discover DeepAgentCode features. Bodies (procedure guidance) are authored by
// the C4-09 body lane: a first-batch manifest carries `body_ref` and, once a body
// is written, a `body_hash`. Until then the capability is discoverable at L0/L1
// but is not body-loadable.

/**
 * The first batch of DeepAgentCode capabilities. Each maps to shipped entry tools
 * and permission actions (validated by `assertCapabilityCatalogConsistent` against
 * the product tool inventory), and consumes the frozen capability-load budget for
 * its body ceiling. README is not authority — this catalog is.
 */
export const capabilityCatalog: ReadonlyArray<CapabilityManifest> = sortManifests(
  [
    {
      id: "deepagent.code-read",
      version: "1.0.0-beta.0",
      summary: "Read and search source files in the active workspace",
      use_when: ["locating implementations", "tracing references", "reading files"],
      availability: "stable",
      required_permissions: ["read", "glob", "grep"],
      required_runtime_features: [],
      entry_tools: ["read", "glob", "grep"],
      body_ref: "capability://deepagent.code-read@1.0.0-beta.0",
      max_body_tokens: CapabilityBudget.l2SingleMaxTokens,
    },
    {
      id: "deepagent.code-edit",
      version: "1.0.0-beta.0",
      summary: "Edit, write and patch files in the active workspace",
      use_when: ["applying exact changes", "modifying files"],
      availability: "stable",
      required_permissions: ["edit"],
      required_runtime_features: [],
      entry_tools: ["edit", "write", "apply-patch"],
      body_ref: "capability://deepagent.code-edit@1.0.0-beta.0",
      max_body_tokens: CapabilityBudget.l2SingleMaxTokens,
    },
    {
      id: "deepagent.shell-execute",
      version: "1.0.0-beta.0",
      summary: "Execute shell commands in the active workspace",
      use_when: ["running builds", "running tests", "operating tools"],
      availability: "stable",
      required_permissions: ["bash"],
      required_runtime_features: [],
      entry_tools: ["bash"],
      body_ref: "capability://deepagent.shell-execute@1.0.0-beta.0",
      max_body_tokens: CapabilityBudget.l2SingleMaxTokens,
    },
    {
      id: "deepagent.web-research",
      version: "1.0.0-beta.0",
      summary: "Search the web and fetch external pages for current information",
      use_when: ["checking current information", "researching external sources"],
      availability: "stable",
      required_permissions: ["websearch", "webfetch"],
      required_runtime_features: [],
      entry_tools: ["websearch", "webfetch"],
      body_ref: "capability://deepagent.web-research@1.0.0-beta.0",
      max_body_tokens: CapabilityBudget.l2SingleMaxTokens,
    },
    {
      id: "deepagent.context-query",
      version: "1.0.0-beta.0",
      summary: "Query authorized cross-graph project context",
      use_when: ["recalling project context", "tracing evidence", "finding conflicts"],
      availability: "stable",
      required_permissions: ["context.read"],
      required_runtime_features: ["context_federation_v2"],
      entry_tools: ["context_query"],
      body_ref: "capability://deepagent.context-query@1.0.0-beta.0",
      max_body_tokens: CapabilityBudget.l2SingleMaxTokens,
    },
    {
      id: "deepagent.skill-guidance",
      version: "1.0.0-beta.0",
      summary: "Load skill guidance and follow documented procedures",
      use_when: ["following a skill procedure", "unknown procedure"],
      availability: "stable",
      required_permissions: ["skill"],
      required_runtime_features: [],
      entry_tools: ["skill"],
      body_ref: "capability://deepagent.skill-guidance@1.0.0-beta.0",
      max_body_tokens: CapabilityBudget.l2SingleMaxTokens,
    },
  ].map((manifest) => decodeCapabilityManifest(manifest)),
)

/** Catalog snapshot identity (design §2.1: signed capability snapshot). */
export const catalogSchemaVersion = CapabilityVersion.catalogSnapshot

/** Byte-stable catalog digest over the sorted first-batch manifests. */
export const capabilityCatalogDigestValue = capabilityCatalogDigest(capabilityCatalog)

/** Deterministic snapshot id derived from the catalog digest (immutable per catalog). */
export const capabilityCatalogSnapshotId = `capability_catalog:${capabilityCatalogDigestValue.slice("sha256:".length)}`

/** The machine-readable catalog snapshot (id + digest + manifests). */
export const capabilityCatalogSnapshot = {
  schemaVersion: catalogSchemaVersion,
  id: capabilityCatalogSnapshotId,
  digest: capabilityCatalogDigestValue,
  capabilities: capabilityCatalog,
} as const

/** Run the tool/flags/policy consistency gate over the first batch (throws on drift). */
export function assertFirstBatchConsistent(): void {
  assertCapabilityCatalogConsistent(capabilityCatalog, DeepAgentCodeToolInventory)
}

// ---- L0 catalog render + budget gate (C4-02) ------------------------------

/** Byte + token metrics of the L0 catalog text. */
export interface CatalogMetrics {
  readonly tokenCount: number
  readonly byteCount: number
}

/** Compute deterministic byte/token metrics for the rendered L0 catalog. */
export const capabilityCatalogMetrics = (text: string): CatalogMetrics => ({
  tokenCount: Token.estimate(text),
  byteCount: Buffer.byteLength(text),
})

/**
 * Render the L0 boot catalog: the compact, model-visible summary of the shipped
 * DeepAgentCode capabilities. L0 only explains entry points and when to use them
 * (design §7.3) — it never repeats tool schemas and never includes a procedure
 * body. Each line is one capability with its entry tools and the situations it
 * is for.
 */
export function renderCapabilityCatalog(catalog: ReadonlyArray<CapabilityManifest> = capabilityCatalog): string {
  return [
    "DeepAgentCode capabilities (discovery; load a body for a full procedure):",
    ...catalog.map(
      (manifest) =>
        `- ${manifest.id} — ${manifest.summary}. Entry: ${manifest.entry_tools.join(", ")}. Use: ${manifest.use_when.join(", ")}.`,
    ),
  ].join("\n")
}

/** A capability's rendered L0 line (stable, deterministic). */
export const capabilityL0Line = (manifest: CapabilityManifest): string =>
  `- ${manifest.id} — ${manifest.summary}. Entry: ${manifest.entry_tools.join(", ")}. Use: ${manifest.use_when.join(", ")}.`

/**
 * Build/start gate: the rendered L0 catalog must stay within the frozen budget
 * (design §7.3 target 150-300 tokens; hard cap 700 tokens / 4096 bytes). On
 * overflow the gate throws `BudgetExceededError` from the frozen contract — it
 * never silently truncates a core entry.
 */
export function assertCapabilityCatalogWithinBudget(text: string): void {
  const { tokenCount, byteCount } = capabilityCatalogMetrics(text)
  assertContentLoadBudget("L0", tokenCount, byteCount, 0, 0)
}

/**
 * The L0 System Context source (`deepagent/capability-catalog`). It stably loads
 * the boot catalog over any session. The load effect first runs the budget gate so
 * an over-budget catalog fails the context (build/start gate) instead of silently
 * truncating; a malformed catalog also fails the context.
 */
export const capabilityCatalogSource = SystemContext.make({
  key: SystemContext.Key.make("deepagent/capability-catalog"),
  codec: Schema.toCodecJson(Schema.String),
  load: Effect.sync(() => {
    const text = renderCapabilityCatalog()
    assertCapabilityCatalogWithinBudget(text)
    return text
  }),
  baseline: (text) => ["Capabilities available to you:", text].join("\n"),
  update: (_previous, text) => ["The capabilities available to you are now:", text].join("\n"),
})

/**
 * Location node that registers the L0 catalog source. Compose into the System
 * Context registry stack so the catalog is stably loaded as a source.
 */
export const registerCapabilityCatalog = Layer.effectDiscard(
  Effect.gen(function* () {
    const registry = yield* SystemContextRegistry.Service
    yield* registry.register({ key: SystemContext.Key.make("deepagent/capability-catalog"), load: Effect.succeed(capabilityCatalogSource) })
  }),
)

/**
 * Registered SystemContext for the capability catalog. This is the composable
 * slice a caller merges into the default System Context stack (the C4-07 lane
 * wires it into the production stack; this lane provides the source + budget gate).
 */
export const layer = registerCapabilityCatalog

export const node = makeLocationNode({
  name: "system-context-capability-catalog",
  layer,
  deps: [SystemContextRegistry.node],
})

export const capabilityCatalogLayer = layer
