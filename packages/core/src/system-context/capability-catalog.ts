export * as CapabilityCatalog from "./capability-catalog"

import { Context, Schema } from "effect"
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
// (design §7.3), expanded by the V2.0.1-001 system-manual wave (§4.3): the P2 tool
// surface (task family, pr_finalize, pack_search/domain_pack_load, plan, question)
// joins the catalog, plus two concept-shaped rows (permission-denial,
// context-survival) that carry behavioral guidance instead of an entry tool.
// Bodies (procedure guidance) are authored per manifest: a manifest carries
// `body_ref` and, once a body is written, a `body_hash`. Until then the capability
// is discoverable at L0/L1 but is not body-loadable.

/**
 * The shipped DeepAgentCode capabilities. Each maps to shipped entry tools
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
      entry_tools: ["edit", "write", "apply_patch"],
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
      required_permissions: ["context_query"],
      required_runtime_features: ["context_federation_v2", "context_query_tools_v2"],
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
    {
      id: "deepagent.question-clarify",
      version: "1.0.0-beta.0",
      summary: "Ask the user a concise clarifying question when the task is ambiguous",
      use_when: ["ambiguous request", "missing decision"],
      availability: "stable",
      required_permissions: ["question"],
      required_runtime_features: [],
      entry_tools: ["question"],
      body_ref: "capability://deepagent.question-clarify@1.0.0-beta.0",
      max_body_tokens: CapabilityBudget.l2SingleMaxTokens,
    },
    {
      id: "deepagent.code-intel",
      version: "1.0.0-beta.0",
      summary: "Structural code queries (callers, dependencies, symbols) over the code graph",
      use_when: ["who calls X", "what depends on Y", "before cross-file edits"],
      availability: "stable",
      required_permissions: ["code_intel", "read", "glob", "grep"],
      required_runtime_features: ["context_query_tools_v2"],
      entry_tools: ["code_intel"],
      body_ref: "capability://deepagent.code-intel@1.0.0-beta.0",
      max_body_tokens: CapabilityBudget.l2SingleMaxTokens,
    },
    {
      id: "deepagent.plan-mode",
      version: "1.0.0-beta.0",
      summary: "Maintain the session's compare-and-swap work plan",
      use_when: ["non-trivial multi-step work", "tracking step progress", "replanning after drift"],
      availability: "stable",
      required_permissions: ["plan"],
      required_runtime_features: [],
      entry_tools: ["plan"],
      body_ref: "capability://deepagent.plan-mode@1.0.0-beta.0",
      max_body_tokens: CapabilityBudget.l2SingleMaxTokens,
    },
    {
      id: "deepagent.task-orchestration",
      version: "1.0.0-beta.0",
      summary: "Delegate a self-contained subtask to a specialist subagent (general, explore, researcher, reviewer, senior-reviewer)",
      use_when: ["independent chunk of work", "parallel exploration", "adversarial review"],
      availability: "stable",
      required_permissions: ["task"],
      required_runtime_features: [],
      entry_tools: ["task"],
      body_ref: "capability://deepagent.task-orchestration@1.0.0-beta.0",
      max_body_tokens: CapabilityBudget.l2SingleMaxTokens,
    },
    {
      id: "deepagent.task-oversight",
      version: "1.0.0-beta.0",
      summary: "Monitor, inspect, close, or resolve subagent tasks this session dispatched",
      use_when: ["checking subagent progress", "recovering partial work", "cancelling a task"],
      availability: "stable",
      required_permissions: ["task_status", "task_read", "task_close", "task_recovery"],
      required_runtime_features: [],
      entry_tools: ["task_status", "task_read", "task_close", "task_recovery"],
      body_ref: "capability://deepagent.task-oversight@1.0.0-beta.0",
      max_body_tokens: CapabilityBudget.l2SingleMaxTokens,
    },
    {
      id: "deepagent.worktree-merge",
      version: "1.0.0-beta.0",
      summary: "Write-type subagents work on isolated deepagent-code/task-* branches; review and merge them",
      use_when: ["integrating subagent output", "after write-type tasks finish"],
      availability: "stable",
      required_permissions: ["pr_finalize"],
      required_runtime_features: [],
      entry_tools: ["pr_finalize"],
      body_ref: "capability://deepagent.worktree-merge@1.0.0-beta.0",
      max_body_tokens: CapabilityBudget.l2SingleMaxTokens,
    },
    {
      id: "deepagent.pack-manual",
      version: "1.0.0-beta.0",
      summary: "Search and load the built-in domain pack manual (the system manual and curated domain guidance)",
      use_when: ["how this system works", "domain question", "before answering from priors"],
      availability: "stable",
      required_permissions: ["capability.read"],
      required_runtime_features: [],
      entry_tools: ["pack_search", "domain_pack_load"],
      body_ref: "capability://deepagent.pack-manual@1.0.0-beta.0",
      max_body_tokens: CapabilityBudget.l2SingleMaxTokens,
    },
    {
      id: "deepagent.permission-denial",
      version: "1.0.0-beta.0",
      summary: "A tool error may be a user denial, not a failure — never retry a denied call unchanged",
      use_when: ["a tool call was refused", "deciding whether to retry"],
      availability: "stable",
      required_permissions: [],
      required_runtime_features: [],
      entry_tools: [],
      body_ref: "capability://deepagent.permission-denial@1.0.0-beta.0",
      max_body_tokens: CapabilityBudget.l2SingleMaxTokens,
    },
    {
      id: "deepagent.context-survival",
      version: "1.0.0-beta.0",
      summary: "Compaction summaries, budget warnings, and revert/rollback notices change what you may trust",
      use_when: ["after a checkpoint summary", "a budget or revert notice appears"],
      availability: "stable",
      required_permissions: [],
      required_runtime_features: [],
      entry_tools: [],
      body_ref: "capability://deepagent.context-survival@1.0.0-beta.0",
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
 * is for. W4.1 drawing the §7.6 line in the render itself: a NON-stable
 * capability is annotated with its availability (`[maintenance]`) and its entry
 * vector is withheld (`Entry: (not yet available)`) — the directory stays
 * complete, but the model is never shown an executable entry point for a
 * capability the runtime won't serve.
 */
export function renderCapabilityCatalog(catalog: ReadonlyArray<CapabilityManifest> = capabilityCatalog): string {
  if (catalog.length === 0) return "No DeepAgentCode capabilities are available under the current permissions."
  return [
    "DeepAgentCode capabilities (discovery; load a body for a full procedure):",
    ...catalog.map((manifest) => l0Line(manifest)),
  ].join("\n")
}

export const CurrentGrantedPermissions = Context.Reference<ReadonlySet<string> | undefined>(
  "@deepagent-code/v2/CapabilityCatalog/CurrentGrantedPermissions",
  { defaultValue: () => undefined },
)

export const CurrentAvailableToolNames = Context.Reference<ReadonlySet<string> | undefined>(
  "@deepagent-code/v2/CapabilityCatalog/CurrentAvailableToolNames",
  { defaultValue: () => undefined },
)

export function authorizedCatalog(
  grantedPermissions?: ReadonlySet<string>,
  availableToolNames?: ReadonlySet<string>,
): ReadonlyArray<CapabilityManifest> {
  return capabilityCatalog.filter((manifest) =>
    (grantedPermissions === undefined || manifest.required_permissions.every((permission) => grantedPermissions.has(permission))) &&
    (availableToolNames === undefined || manifest.entry_tools.every((tool) => availableToolNames.has(tool))),
  )
}

/** A capability's rendered L0 line (stable, deterministic). */
export const capabilityL0Line = (manifest: CapabilityManifest): string => l0Line(manifest)

/** L0 line: availability mark (non-stable) + summary + entry vector + when to use. */
function l0Line(manifest: CapabilityManifest): string {
  const availability = manifest.availability === "stable" ? "" : ` [${l0AvailabilityLabel(manifest.availability)}]`
  return `- ${manifest.id}${availability} — ${manifest.summary}. Entry: ${l0EntryVector(manifest)}. Use: ${manifest.use_when.join(", ")}.`
}

/** The L0 availability label: the enum value with a compact alias for `maintenance_only`. */
function l0AvailabilityLabel(availability: CapabilityManifest["availability"]): string {
  return availability === "maintenance_only" ? "maintenance" : availability
}

/**
 * The L0 entry vector: stable capabilities advertise their executable entry
 * tools; a non-stable capability never advertises an executable vector (design
 * §7.6 — never promise an unusable capability), so the model sees an explicit
 * not-yet-available marker instead of a tool list. A stable CONCEPT capability
 * (V2.0.1-001 §4.2 概念形: permission-denial, context-survival) has no entry
 * tool by design — the row changes behavior expectations — and says so.
 */
function l0EntryVector(manifest: CapabilityManifest): string {
  if (manifest.availability !== "stable") return "(not yet available)"
  return manifest.entry_tools.length === 0 ? "(behavioral guidance)" : manifest.entry_tools.join(", ")
}

/**
 * Build/start gate: the rendered L0 catalog must stay within the budget
 * (V2.0.1-001 §4.6, decision ④: hard cap 1000 tokens / 4096 bytes for the
 * expanded ~12-15 row catalog). On overflow the gate throws
 * `BudgetExceededError` from the frozen contract — it never silently truncates
 * a core entry.
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
  load: Effect.gen(function* () {
    const text = renderCapabilityCatalog(
      authorizedCatalog(yield* CurrentGrantedPermissions, yield* CurrentAvailableToolNames),
    )
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
