/**
 * C0-01 ownership rule packs.
 *
 * Each pack matches a set of entry ids and declares, per authority dimension, a verdict
 * backed by requirements that MUST machine-verify against the real import graph and AST
 * shapes of the alpha tree. A requirement that cannot be met demotes the dimension to
 * "unclassified" (build.ts classifyOne), which is the honest safety net: nothing here may
 * assert an owner it cannot prove. Rules are ordered; first match wins per dimension.
 *
 * The dominant truth at this freeze point (design.md §1/§16, worklist C0-01): MOST
 * production entry points still execute through the legacy SessionPrompt pipeline, so
 * they are "legacy" on the authority dimensions they participate in. V2 owns only the
 * surfaces where SessionV2/SessionExecution/durable V2 services actually run. read_only
 * marks config/catalog/schema/query loaders that only read. double_write is the
 * EventV2+legacy GlobalBus bridge. adapter marks bridges that translate between planes.
 */
import type { Dimension, Requirement, Verdict } from "./types"
import { AUTHORITY } from "./authority"

export type VerdictRule = {
  readonly verdict: Exclude<Verdict, "unclassified">
  readonly requirements: readonly Requirement[]
}
export type EntryRules = Readonly<Partial<Record<Dimension, VerdictRule>>>
export type RulePack = { readonly match: (id: string) => boolean; readonly rules: EntryRules }

const LEGACY_PROMPT: Requirement = { kind: "reach", pathSuffix: AUTHORITY.LEGACY_PROMPT }
const V2_EXEC_LOCAL: Requirement = { kind: "reach", pathSuffix: AUTHORITY.V2_EXECUTION_LOCAL }
const V2_TOOL_REGISTRY: Requirement = { kind: "reach", pathSuffix: AUTHORITY.V2_TOOL_REGISTRY }
const V2_EVENT_BUS: Requirement = { kind: "reach", pathSuffix: AUTHORITY.V2_EVENT_BUS }
const EVENT_V2_BRIDGE: Requirement = { kind: "reach", pathSuffix: AUTHORITY.EVENT_V2_BRIDGE }
const PROJECTOR: Requirement = { kind: "reach", pathSuffix: AUTHORITY.PROJECTOR }
const RECOVERY_BINDING: Requirement = { kind: "reach", pathSuffix: AUTHORITY.RECOVERY_BINDING }

function legacy(requirements: readonly Requirement[]): VerdictRule {
  return { verdict: "legacy", requirements }
}
function v2(requirements: readonly Requirement[]): VerdictRule {
  return { verdict: "v2", requirements }
}
function adapter(requirements: readonly Requirement[]): VerdictRule {
  return { verdict: "adapter", requirements }
}
function readOnly(requirements: readonly Requirement[]): VerdictRule {
  return { verdict: "read_only", requirements }
}
function doubleWrite(requirements: readonly Requirement[]): VerdictRule {
  return { verdict: "double_write", requirements }
}

/** Body chains that prove an operation's own handler drives the legacy SessionPrompt turn. */
const LEGACY_EXEC_BODY = "promptSvc.loop"
const LEGACY_STEER_BODY = "promptSvc.promptOrSteer"

/** Body-chain presence/absence requirements. */
function body(chain: string): Requirement {
  return { kind: "bodyChain", chain }
}
function notBody(chain: string): Requirement {
  return { kind: "noBodyChain", chain }
}

/**
 * The authority writer chains whose ABSENCE in an entry's own handler body proves it only
 * reads the corresponding dimension (honest read_only). These are the chain symbols the
 * alpha pipeline uses to write each §2.1 authority; an entry whose body never touches them
 * cannot be the writer, so read_only is the provable verdict.
 */
const READ_ONLY_NOBODY: readonly Requirement[] = [
  notBody("promptSvc.promptOrSteer"),
  notBody("promptSvc.loop"),
  notBody("promptSvc.promptAsync"),
  notBody("promptSvc.command"),
  notBody("promptSvc.shell"),
  notBody("promptSvc.cancel"),
  notBody("SessionV2.prompt"),
  notBody("SessionV2.NotFoundError"),
  notBody("SessionExecution.wake"),
  notBody("SessionExecution.run"),
  notBody("events.publish"),
  notBody("eventBus.tryPublish"),
  notBody("eventBus.publish"),
  notBody("bus.publish"),
  notBody("EventV2.Cursor"),
  notBody("EventV2.LEGACY_ARTIFACT_BATCH_EVENTS"),
  notBody("ToolRegistry.register"),
  notBody("registry.materialize"),
  notBody("SessionPromptIntent.prepare"),
  notBody("consultPanel"),
  notBody("PanelTurnRunner"),
]

/** All seven dimensions are read_only: the entry only reads, owns no §2.1 authority. */
function readOnlyAll7(): EntryRules {
  const r = readOnly(READ_ONLY_NOBODY)
  return {
    admission_owner: r,
    execution_owner: r,
    context_writer: r,
    provider_tool_writer: r,
    event_producer_consumer: r,
    projector: r,
    recovery_owner: r,
  }
}

/**
 * A session-execution entry whose handler drives the legacy SessionPrompt pipeline: it is
 * the legacy owner across all seven §2.1 dimensions (design.md §1/§16 at alpha).
 */
function legacyExecAll7(chain: string, extraBody?: string): EntryRules {
  const reqs: readonly Requirement[] = [
    LEGACY_PROMPT,
    body(chain),
    ...(extraBody ? [body(extraBody)] : []),
  ]
  const r = legacy(reqs)
  return {
    admission_owner: r,
    execution_owner: r,
    context_writer: r,
    provider_tool_writer: r,
    event_producer_consumer: r,
    projector: r,
    recovery_owner: r,
  }
}

export const RULE_PACKS: readonly RulePack[] = [
  // -----------------------------------------------------------------------------
  // HTTP surface — session-execution operations that drive the legacy SessionPrompt
  // turn (prompt / loop / steer / command / shell / abort / summary / init).
  // -----------------------------------------------------------------------------
  {
    match: (id) => id === "http.instance.session.prompt" || id === "http.instance.session.promptAsync",
    rules: legacyExecAll7(LEGACY_STEER_BODY, "promptSvc.promptAsync"),
  },
  {
    match: (id) => id === "http.instance.session.promptPrepare" || id === "http.instance.session.promptPrepareStream" || id === "http.instance.session.promptSuggestion",
    rules: legacyExecAll7("promptSvc.refineIntelligenceDraft"),
  },
  {
    match: (id) => id === "http.instance.session.command",
    rules: legacyExecAll7("promptSvc.command"),
  },
  {
    match: (id) => id === "http.instance.session.shell",
    rules: legacyExecAll7("promptSvc.shell"),
  },
  {
    match: (id) => id === "http.instance.session.abort",
    rules: legacyExecAll7("promptSvc.cancel"),
  },
  {
    match: (id) => id === "http.instance.session.summarize",
    rules: legacyExecAll7("promptSvc.latestSuggestion"),
  },
  {
    match: (id) => id === "http.instance.session.init" || id === "http.instance.session.contextAttemptResolve" || id === "http.instance.session.continuationResolutionResolve",
    rules: legacyExecAll7("SessionPrompt.Service"),
  },
  // -----------------------------------------------------------------------------
  // HTTP surface — read-only query / infra operations (they read authority state but
  // own nothing; the noBodyChain proofs must all verify against their own bodies).
  // -----------------------------------------------------------------------------
  {
    match: (id) => id.startsWith("http.instance.config.") || id.startsWith("http.instance.control.") ||
      id.startsWith("http.instance.debug.") || id.startsWith("http.instance.file.") ||
      id.startsWith("http.instance.mcp.") || id.startsWith("http.instance.pty.") ||
      id.startsWith("http.instance.pty-connect.") || id.startsWith("http.instance.question.") ||
      id.startsWith("http.instance.reference.") || id.startsWith("http.instance.permission.") ||
      id.startsWith("http.instance.oversight.") || id.startsWith("http.instance.profile.") ||
      id.startsWith("http.instance.project.") || id.startsWith("http.instance.projectCopy.") ||
      id.startsWith("http.instance.workspace.") || id.startsWith("http.instance.workspaceConfig.") ||
      id.startsWith("http.instance.instance.") || id.startsWith("http.instance.experimental.console") ||
      id.startsWith("http.instance.experimental.resource") || id.startsWith("http.instance.experimental.session") ||
      id.startsWith("http.instance.experimental.toolIDs") === false && id.startsWith("http.instance.experimental.tool") ||
      id.startsWith("http.instance.experimental.worktree") || id.startsWith("http.instance.experimental.consoleSwitch") ||
      id.startsWith("http.instance.experimental.consoleOrgs") ||
      id.startsWith("http.server.server.fs.") || id.startsWith("http.server.server.health.") ||
      id.startsWith("http.server.server.permission.") || id.startsWith("http.server.server.question.") ||
      id.startsWith("http.server.server.command.") || id.startsWith("http.server.server.agent."),
    rules: readOnlyAll7(),
  },
];
