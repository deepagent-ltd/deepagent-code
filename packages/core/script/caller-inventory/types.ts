/**
 * C0-01 production composition/caller inventory types.
 *
 * The gate freezes the set of production entry points across 11 surfaces and
 * classifies each one along the single-authority dimensions from design.md §1/§2.
 * Verdict vocabulary is fixed; every verdict carries machine-verified file:line
 * evidence collected at the AST level.
 */

/** Fixed classification vocabulary (worklist.md §4 C0-01 / wave manifest Lane A). */
export type Verdict = "legacy" | "v2" | "adapter" | "read_only" | "double_write" | "unclassified"

export const VERDICTS: readonly Verdict[] = [
  "legacy",
  "v2",
  "adapter",
  "read_only",
  "double_write",
  "unclassified",
]

/** Authority dimensions a caller can participate in (design.md §2.1 table). */
export type Dimension =
  | "admission_owner"
  | "execution_owner"
  | "context_writer"
  | "provider_tool_writer"
  | "event_producer_consumer"
  | "projector"
  | "recovery_owner"

export const DIMENSIONS: readonly Dimension[] = [
  "admission_owner",
  "execution_owner",
  "context_writer",
  "provider_tool_writer",
  "event_producer_consumer",
  "projector",
  "recovery_owner",
]

/** Machine-verified static evidence for one classification decision. */
export type Evidence = {
  readonly repoFile: string
  readonly line: number
  readonly marker: string
  /** BFS distance in the import graph from the entry module to this hit. */
  readonly distance: number
}

/** One dimension verdict with its verified evidence trail. */
export type RoleClassification = {
  readonly dimension: Dimension
  readonly verdict: Verdict
  readonly evidence: readonly Evidence[]
}

export type SurfaceId =
  | "composition"
  | "http"
  | "desktop"
  | "cli-deepagent-code"
  | "cli-lildax"
  | "acp"
  | "im"
  | "event"
  | "task-goal-panel"
  | "provider"
  | "tools"
  | "recovery"

/** One frozen production entry point. */
export type Entry = {
  readonly id: string
  readonly surface: SurfaceId
  /** Human-readable kind, e.g. http-operation, yargs-command, bus-consumer. */
  readonly kind: string
  readonly name: string
  readonly repoFile: string
  readonly line: number
}

/** Extracted entry plus its structural handler link (when the surface has one). */
export type HandlerSite = {
  readonly name: string
  readonly repoFile: string
  readonly line: number
  /** Same-file declaration backing this handler when `.handle(op, fnName)` named a local binding. */
  readonly bodyDecl?: string
  /** HTTP group name parsed from the enclosing HttpApiGroup.make/HttpApiBuilder.group chain. */
  readonly group?: string
}

export type EntryWithHandlers = {
  readonly entry: Entry
  /** Additional registration sites structurally linked to this entry. */
  readonly handlers: readonly HandlerSite[]
}

/**
 * A single machine-checkable requirement backing one dimension verdict.
 *
 * Requirements are verified against real AST structures only:
 *   - reach            : the module with this normalized-path suffix is reachable from the
 *                        entry roots through actual import statements (import graph BFS);
 *   - importOf         : a reachable file whose path matches fileSuffix has an import binding
 *                        from a specifier ending in specifierSuffix (import table, no text scan);
 *   - callChain        : a reachable file contains an AST property-access chain ending in
 *                        exactly this dotted member chain (comments/strings are invisible);
 *   - bodyChain        : the dotted chain occurs inside THIS entry's own handler-body scope
 *                        (resolved `.handle(...)`/anchor function subtrees plus bounded
 *                        same-file callee expansion — proves the flow itself performs the call);
 *   - noBodyChain      : the opposite structural fact — the chain does not occur anywhere in
 *                        this entry's handler-body scope, proving the flow cannot invoke that
 *                        writer family;
 *   - noReach          : the module with this normalized-path suffix is NOT reachable from the
 *                        entry roots — the entry's import closure cannot bring the writer
 *                        authority into its own flow, supporting an honest read_only / non-owner
 *                        verdict for entries that never touch the authority module;
 *   - productionProfile: three-site proof that THIS packaged build force-selects the Core-V2-only
 *                        runtime profile (package.json version matches isCoreV2OnlyVersion, the
 *                        flag wires that predicate to InstallationVersion, and the production
 *                        bundler injects that version string via DEEPAGENT_CODE_VERSION).
 */
export type Requirement =
  | { readonly kind: "reach"; readonly pathSuffix: string }
  | { readonly kind: "importOf"; readonly fileSuffix: string; readonly specifierSuffix: string }
  | { readonly kind: "callChain"; readonly fileSuffix?: string; readonly chain: string }
  | { readonly kind: "bodyChain"; readonly chain: string }
  | { readonly kind: "noBodyChain"; readonly chain: string }
  | { readonly kind: "noReach"; readonly pathSuffix: string }
  | { readonly kind: "productionProfile" }

/** A declared, machine-checked ownership claim for one entry. */
export type Declaration = {
  /** Every listed verdict stands only if all of its requirements verify. */
  readonly claims: Readonly<Partial<Record<Dimension, VerdictClaim>>>
}

export type VerdictClaim = {
  readonly verdict: Exclude<Verdict, "unclassified">
  readonly requirements: readonly Requirement[]
  /** Recorded when the verdict cannot be proven; keeps failures auditable, never silent. */
  readonly pendingReason?: string
}

export const SURFACE_IDS: readonly SurfaceId[] = [
  "composition",
  "http",
  "desktop",
  "cli-deepagent-code",
  "cli-lildax",
  "acp",
  "im",
  "event",
  "task-goal-panel",
  "provider",
  "tools",
  "recovery",
]

/** Surfaces whose entries always participate in the seven-dimension classification. */
export const INVENTORY_SURFACE_IDS = SURFACE_IDS

export type ClassifiedEntry = {
  readonly entry: Entry
  readonly handlers: readonly HandlerSite[]
  /** One role per dimension, always all seven; unproven owners stay "unclassified". */
  readonly roles: readonly RoleClassification[]
  readonly unclassifiedCount: number
  /** Per-dimension reason for each owner left unclassified (same key set size). */
  readonly openOwners?: Readonly<Partial<Record<Dimension, string>>>
}

export type Inventory = {
  readonly baseCommit: string
  readonly entries: readonly ClassifiedEntry[]
  readonly totals: {
    readonly entries: number
    readonly unclassifiedEntries: number
    readonly unclassifiedRoles: number
    readonly byVerdict: Readonly<Record<Verdict, number>>
    readonly bySurface: Readonly<Record<SurfaceId, number>>
  }
}
