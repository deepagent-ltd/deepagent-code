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
import { DIMENSIONS } from "./types"
import { AUTHORITY } from "./authority"

export type VerdictRule = {
  readonly verdict: Exclude<Verdict, "unclassified">
  readonly requirements: readonly Requirement[]
}
export type EntryRules = Readonly<Partial<Record<Dimension, VerdictRule>>>
export type RulePack = { readonly match: (id: string) => boolean; readonly rules: EntryRules }

const LEGACY_PROMPT_PATH = AUTHORITY.LEGACY_PROMPT
const V2_EXEC_LOCAL_PATH = AUTHORITY.V2_EXECUTION_LOCAL

const LEGACY_PROMPT: Requirement = { kind: "reach", pathSuffix: LEGACY_PROMPT_PATH }
const V2_EXEC_LOCAL: Requirement = { kind: "reach", pathSuffix: V2_EXEC_LOCAL_PATH }
const V2_TOOL_REGISTRY: Requirement = { kind: "reach", pathSuffix: AUTHORITY.V2_TOOL_REGISTRY }
const V2_EVENT_BUS: Requirement = { kind: "reach", pathSuffix: AUTHORITY.V2_EVENT_BUS }
const V2_EVENT_ROUTER: Requirement = { kind: "reach", pathSuffix: AUTHORITY.V2_EVENT_ROUTER }
const EVENT_V2_BRIDGE: Requirement = { kind: "reach", pathSuffix: AUTHORITY.EVENT_V2_BRIDGE }
const PROJECTOR: Requirement = { kind: "reach", pathSuffix: AUTHORITY.PROJECTOR }
const RECOVERY_BINDING: Requirement = { kind: "reach", pathSuffix: AUTHORITY.RECOVERY_BINDING }
const GOAL_MANAGER: Requirement = { kind: "reach", pathSuffix: AUTHORITY.GOAL_MANAGER }
const LEGACY_CANONICALIZER: Requirement = { kind: "reach", pathSuffix: AUTHORITY.LEGACY_CANONICALIZER }
const LEGACY_PROVIDER_RESOLUTION: Requirement = { kind: "reach", pathSuffix: AUTHORITY.LEGACY_PROVIDER_RESOLUTION }
const LEGACY_SESSION_CORE: Requirement = { kind: "reach", pathSuffix: AUTHORITY.LEGACY_SESSION_CORE }

const AUTHORITY_WRITERS: readonly string[] = [
  AUTHORITY.LEGACY_PROMPT,
  AUTHORITY.V2_EXECUTION_LOCAL,
  AUTHORITY.V2_EXECUTION_RESTART,
  AUTHORITY.V2_TOOL_REGISTRY,
  AUTHORITY.V2_EVENT_BUS,
  AUTHORITY.V2_EVENT_ROUTER,
  AUTHORITY.EVENT_V2_BRIDGE,
  AUTHORITY.PROJECTOR,
  AUTHORITY.RECOVERY_BINDING,
]

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
function body(chain: string): Requirement {
  return { kind: "bodyChain", chain }
}
function notBody(chain: string): Requirement {
  return { kind: "noBodyChain", chain }
}
function noReachPath(suffix: string): Requirement {
  return { kind: "noReach", pathSuffix: suffix }
}
function call(chain: string, fileSuffix?: string): Requirement {
  return fileSuffix ? { kind: "callChain", chain, fileSuffix } : { kind: "callChain", chain }
}

function all7(claim: VerdictRule): EntryRules {
  const result: Record<Dimension, VerdictRule> = {} as Record<Dimension, VerdictRule>
  for (const dimension of DIMENSIONS) result[dimension] = claim
  return result as EntryRules
}
function legacyAll7(requirements: readonly Requirement[]): EntryRules {
  return all7(legacy(requirements))
}

const READ_ONLY_NOBODY_REQS: readonly Requirement[] = [
  notBody("promptSvc.promptOrSteer"),
  notBody("promptSvc.loop"),
  notBody("promptSvc.promptAsync"),
  notBody("promptSvc.command"),
  notBody("promptSvc.shell"),
  notBody("promptSvc.cancel"),
  notBody("promptSvc.latestSuggestion"),
  notBody("SessionV2.prompt"),
  notBody("SessionExecution.wake"),
  notBody("events.publish"),
  notBody("eventBus.tryPublish"),
  notBody("EventV2.Cursor"),
  notBody("EventV2.LEGACY_ARTIFACT_BATCH_EVENTS"),
  notBody("ToolRegistry.register"),
  notBody("registry.materialize"),
  notBody("SessionPromptIntent.prepare"),
  notBody("consultPanel"),
  notBody("PanelTurnRunner"),
]
function readOnlyNoBody(): EntryRules {
  return all7(readOnly(READ_ONLY_NOBODY_REQS))
}
function readOnlyNoReach(): EntryRules {
  return all7(readOnly(AUTHORITY_WRITERS.map(noReachPath)))
}

/** Same verdict on owned dims; EVERY other dimension read_only via the given requirements. */
function withReadOnlyRest(
  owned: Readonly<Partial<Record<Dimension, VerdictRule>>>,
  readOnlyReqs: readonly Requirement[],
): EntryRules {
  const result: Record<Dimension, VerdictRule> = {} as Record<Dimension, VerdictRule>
  for (const dimension of DIMENSIONS) {
    result[dimension] = owned[dimension] ?? readOnly(readOnlyReqs)
  }
  return result as EntryRules
}

/** Non-bus authority writels an event-plane consumer does not reach (so read_only rest is provable). */
const EVENT_CONSUMER_READONLY: readonly Requirement[] = [
  noReachPath(AUTHORITY.LEGACY_PROMPT),
  noReachPath(AUTHORITY.V2_EXECUTION_LOCAL),
  noReachPath(AUTHORITY.V2_EXECUTION_RESTART),
  noReachPath(AUTHORITY.V2_TOOL_REGISTRY),
  noReachPath(AUTHORITY.PROJECTOR),
  noReachPath(AUTHORITY.RECOVERY_BINDING),
]

const LEGACY_READONLY_REST: readonly Requirement[] = [notBody("promptSvc.promptOrSteer"), notBody("SessionV2.prompt"), notBody("events.publish")]

export const RULE_PACKS: readonly RulePack[] = [
  // ===========================================================================
  // HTTP — session-execution operations driving the legacy SessionPrompt turn
  // ===========================================================================
  {
    match: (id) =>
      id.startsWith("http.instance.session.") &&
      ["prompt", "promptAsync", "promptPrepare", "promptPrepareStream", "promptSuggestion", "command", "shell", "abort", "summarize", "init", "contextAttemptResolve", "continuationResolutionResolve"].includes(id.slice("http.instance.session.".length)),
    rules: legacyAll7([LEGACY_PROMPT, body("promptSvc")]),
  },
  // ---- session create/fork (legacy Session session-lifecycle writers) ----
  {
    match: (id) => id === "http.instance.session.create",
    rules: legacyAll7([LEGACY_PROMPT, body("Session.CreateInput")]),
  },
  {
    match: (id) => id === "http.instance.session.fork",
    rules: legacyAll7([LEGACY_PROMPT, body("session.fork")]),
  },
  {
    match: (id) =>
      id.startsWith("http.instance.session.") &&
      ["get", "list", "status", "messages", "message", "plan", "diff", "todo", "exportSnapshot", "importSnapshot", "remove", "revert", "unrevert", "share", "unshare", "update", "deleteMessage", "deletePart", "updatePart", "permissionRespond", "contextCohort", "contextDiagnostics", "continuationResolutionList", "diffArtifactFile", "diffArtifactMaintenance", "diffArtifactManifest", "children"].includes(id.slice("http.instance.session.".length)),
    rules: readOnlyNoBody(),
  },
  {
    match: (id) => id === "http.instance.session.providerResolutionResolve" || id === "http.instance.session.providerResolutionList",
    rules: withReadOnlyRest(
      { provider_tool_writer: legacy([LEGACY_PROVIDER_RESOLUTION, body("providerResolutionSvc")]) },
      [notBody("promptSvc.promptOrSteer"), notBody("SessionV2.prompt"), notBody("events.publish")],
    ),
  },

  // ---- deepagent goal/panel/knowledge/pack pipeline (legacy) ----
  {
    match: (id) =>
      id.startsWith("http.instance.deepagent.") &&
      ["goalEditPlan", "goalPause", "goalResume", "goalStart", "goalStop"].includes(id.slice("http.instance.deepagent.".length)),
    rules: legacyAll7([LEGACY_PROMPT, body("experimentalGoalLoop")]),
  },
  {
    match: (id) => id === "http.instance.deepagent.panelArm" || id === "http.instance.deepagent.panelStatus",
    rules: legacyAll7([LEGACY_PROMPT, body("AgentGateway.DeepAgentSessionState")]),
  },
  {
    match: (id) => id === "http.instance.deepagent.panelConsult",
    rules: legacyAll7([LEGACY_PROMPT, body("consultPanel")]),
  },
  {
    match: (id) =>
      id.startsWith("http.instance.deepagent.") &&
      ["knowledgeRejectIds", "knowledgeReleaseBaseline", "knowledgeShipGate"].includes(id.slice("http.instance.deepagent.".length)),
    rules: legacyAll7([LEGACY_PROMPT, body("AgentGateway.DeepAgentKnowledgeSource")]),
  },
  {
    match: (id) =>
      id.startsWith("http.instance.deepagent.") &&
      ["packsActive", "packsAll"].includes(id.slice("http.instance.deepagent.".length)),
    rules: legacyAll7([LEGACY_PROMPT, body("AgentGateway.DeepAgentDomainPackRegistry")]),
  },
  {
    match: (id) =>
      id.startsWith("http.instance.deepagent.") &&
      ["packsPin", "packsUnpin"].includes(id.slice("http.instance.deepagent.".length)),
    rules: legacyAll7([LEGACY_PROMPT, body("bus.publish")]),
  },
  {
    match: (id) =>
      id.startsWith("http.instance.deepagent.") &&
      ["goalStartable", "goalStatus", "envFacts", "envFactsDecide", "envFactsModify", "knowledgeApprove", "knowledgePending", "knowledgeReviewSummary", "promote", "reject", "reviews", "wikiEdit", "wikiExecutionArchive", "wikiPage", "wikiPages", "wikiSearch"].includes(id.slice("http.instance.deepagent.".length)),
    rules: readOnlyNoBody(),
  },

  // ---- global ----
  {
    match: (id) => id === "http.instance.global.capabilities",
    rules: legacyAll7([LEGACY_PROMPT, body("experimentalExpertPanel")]),
  },
  {
    match: (id) => id === "http.instance.global.event",
    // Consumer-only SSE stream: it SUBSCRIBES to the event channels (GlobalBus.on / EventV2.ID
    // for SSE payload ids) but never publishes or writes a channel; so it is read_only (positive
    // read-side evidence = the subscribe call), NOT double_write.
    rules: all7(readOnly([body("GlobalBus.on"), notBody("promptSvc.promptOrSteer"), notBody("SessionV2.prompt")])),
  },
  {
    match: (id) => id.startsWith("http.instance.global."),
    rules: readOnlyNoBody(),
  },

  // ---- im ----
  {
    match: (id) => id === "http.instance.im.createMessage",
    rules: withReadOnlyRest(
      {
        admission_owner: legacy([LEGACY_PROMPT, body("eventBus.tryPublish")]),
        execution_owner: legacy([LEGACY_PROMPT, body("eventBus.tryPublish")]),
        event_producer_consumer: legacy([V2_EVENT_BUS, body("eventBus.tryPublish")]),
      },
      [notBody("promptSvc.promptOrSteer"), notBody("SessionV2.prompt")],
    ),
  },
  {
    match: (id) => id.startsWith("http.instance.im."),
    rules: readOnlyNoBody(),
  },

  // ---- tui ----
  {
    match: (id) => id.startsWith("http.instance.tui.") && id !== "http.instance.tui.controlNext" && id !== "http.instance.tui.controlResponse",
    rules: legacyAll7([LEGACY_PROMPT, body("events.publish")]),
  },
  {
    match: (id) => id === "http.instance.tui.controlNext" || id === "http.instance.tui.controlResponse" || id === "http.instance.im.createGroup" || id === "http.instance.im-websocket.connect",
    rules: readOnlyNoBody(),
  },

  // ---- webhook ----
  {
    match: (id) => id.startsWith("http.instance.webhook."),
    rules: legacyAll7([LEGACY_PROMPT, body("eventBus.tryPublish")]),
  },

  // ---- sync (EventV2 projection writers) ----
  {
    match: (id) =>
      id.startsWith("http.instance.sync.") &&
      ["artifacts", "checkpointCompact", "checkpointDiscard", "checkpointFinalize", "checkpointPrepare", "checkpointStage", "fileArtifacts", "snapshotRows"].includes(id.slice("http.instance.sync.".length)),
    rules: withReadOnlyRest(
      {
        event_producer_consumer: v2([PROJECTOR, body("EventV2")]),
        projector: v2([PROJECTOR, body("EventV2")]),
      },
      [notBody("promptSvc.promptOrSteer"), notBody("SessionV2.prompt"), notBody("events.publish")],
    ),
  },
  {
    match: (id) => id.startsWith("http.instance.sync."),
    rules: readOnlyNoBody(),
  },

  // ---- controlPlane.moveSession (V2 session authority) ----
  {
    match: (id) => id === "http.instance.controlPlane.moveSession",
    rules: withReadOnlyRest(
      {
        admission_owner: v2([V2_EXEC_LOCAL, body("SessionV2")]),
        execution_owner: v2([V2_EXEC_LOCAL, body("SessionV2")]),
      },
      [notBody("promptSvc.promptOrSteer"), notBody("events.publish")],
    ),
  },

  // ---- event subscribe (legacy event-plane consumer, no handler body) ----
  {
    match: (id) => id === "http.instance.event.subscribe",
    rules: legacyAll7([LEGACY_PROMPT]),
  },
  {
    match: (id) => id === "http.server.server.event.event.subscribe",
    rules: legacyAll7([LEGACY_SESSION_CORE]),
  },

  // ---- legacy server session/message planes (old packages/server path: drives the CORE
  // Session service, a legacy authority, and the old server session operations) ----
  {
    match: (id) =>
      id.startsWith("http.server.server.session.") ||
      id === "http.server.server.message.session.messages" ||
      id === "http.server.server.event.event.subscribe",
    rules: legacyAll7([LEGACY_SESSION_CORE]),
  },

  // ---- server read-only catalog / provider / skill ----
  {
    match: (id) =>
      id.startsWith("http.server.server.model.") ||
      id.startsWith("http.server.server.provider.") ||
      id.startsWith("http.server.server.skill."),
    rules: readOnlyNoBody(),
  },

  // ---- HTTP infra read-only groups ----
  {
    match: (id) =>
      id.startsWith("http.instance.config.") || id.startsWith("http.instance.control.") ||
      id.startsWith("http.instance.debug.") || id.startsWith("http.instance.file.") ||
      id.startsWith("http.instance.mcp.") || id.startsWith("http.instance.pty.") ||
      id.startsWith("http.instance.pty-connect.") || id.startsWith("http.instance.question.") ||
      id.startsWith("http.instance.reference.") || id.startsWith("http.instance.permission.") ||
      id.startsWith("http.instance.oversight.") || id.startsWith("http.instance.profile.") ||
      id.startsWith("http.instance.project.") || id.startsWith("http.instance.projectCopy.") ||
      id.startsWith("http.instance.workspace.") || id.startsWith("http.instance.workspaceConfig.") ||
      id.startsWith("http.instance.instance.") || id.startsWith("http.instance.experimental.") ||
      id.startsWith("http.instance.provider.") ||
      id.startsWith("http.server.server.fs.") || id.startsWith("http.server.server.health.") ||
      id.startsWith("http.server.server.permission.") || id.startsWith("http.server.server.question.") ||
      id.startsWith("http.server.server.command.") || id.startsWith("http.server.server.agent."),
    rules: readOnlyNoBody(),
  },

  // ===========================================================================
  // ACP protocol handlers (drive the legacy SessionPrompt session pipeline)
  // ===========================================================================
  {
    match: (id) => id.startsWith("acp."),
    rules: legacyAll7([LEGACY_PROMPT]),
  },

  // ===========================================================================
  // dacode CLI (legacy composition entry; every command runs under the legacy CLI layer)
  // ===========================================================================
  {
    match: (id) => id.startsWith("cli.dacode."),
    rules: legacyAll7([LEGACY_PROMPT]),
  },

  // ===========================================================================
  // Composition roots
  // ===========================================================================
  {
    match: (id) =>
      id === "composition.app-runtime-layers" || id === "composition.dacode-cli-entry" ||
      id === "composition.instance-httpapi-stack",
    rules: legacyAll7([LEGACY_PROMPT]),
  },
  {
    match: (id) => id === "composition.server-web-handler" || id === "composition.lildax-runtime",
    rules: legacyAll7([LEGACY_SESSION_CORE]),
  },

  // lildax CLI commands run inside the lildax Handlers runtime which provides the legacy server
  // (createRoutes in packages/server/src/routes.ts); commands whose handler reaches that composition
  // drive the legacy server, so they are legacy.
  {
    match: (id) => id.startsWith("cli.lildax."),
    rules: legacyAll7([{ kind: "reach", pathSuffix: "packages/server/src/routes.ts" }]),
  },
  // Panel / IM orchestration components (panel.orchestrator/arbiter, im.agent-orchestrator,
  // im.agent-reply-sink) resolve their authority through dynamic dispatch / DI to a receiver that
  // is not statically bound to them at this freeze point. They are not readers, so classifying them
  // read_only by absence would be dishonest (F5); they are intentionally left UNCLASSIFIED here.

  {
    match: (id) =>
      id === "task.goal-manager" || id === "task.goal-loop-wiring" ||
      id === "background.job" || id === "panel.consult" || id === "panel.panelist-runner",
    rules: legacyAll7([LEGACY_PROMPT]),
  },
  {
    match: (id) => id === "task.task-run-admission",
    rules: legacyAll7([LEGACY_SESSION_CORE]),
  },
  {
    // goal-driver drives goals through the CORE DeepAgent goal loop (a legacy goal authority);
    // it does not reach the SessionPrompt pipeline directly, so anchor legacy at the goal loop.
    match: (id) => id === "task.goal-driver",
    rules: legacyAll7([{ kind: "reach", pathSuffix: AUTHORITY.GOAL_LOOP }]),
  },

  // ===========================================================================
  // IM server-side pipeline (legacy SessionPrompt)
  // ===========================================================================
  {
    match: (id) => id === "im.agent-executor" || id === "im.agent-progress-stream" || id === "im.agent-orchestrator" || id === "im.agent-reply-sink",
    rules: legacyAll7([LEGACY_PROMPT]),
  },

  // ===========================================================================
  // Event plane (durable V2 bus / router / consumers / bridge)
  // ===========================================================================
  {
    match: (id) => id === "event.deepagent-bus",
    rules: withReadOnlyRest({ event_producer_consumer: v2([V2_EVENT_BUS]) }, EVENT_CONSUMER_READONLY),
  },
  {
    match: (id) => id === "event.event-router",
    rules: withReadOnlyRest({ event_producer_consumer: v2([V2_EVENT_ROUTER]) }, EVENT_CONSUMER_READONLY),
  },
  {
    match: (id) => id === "event.goal-tick-consumer" || id === "event.panel-convene-consumer" || id === "event.wiki-event-driven-archiver",
    rules: withReadOnlyRest({ event_producer_consumer: v2([V2_EVENT_BUS]) }, EVENT_CONSUMER_READONLY),
  },
  {
    match: (id) => id === "event.legacy-canonicalizer-daemon",
    rules: withReadOnlyRest({ event_producer_consumer: adapter([LEGACY_CANONICALIZER]) }, EVENT_CONSUMER_READONLY),
  },
  {
    match: (id) => id === "event.v2-bridge",
    rules: withReadOnlyRest({}, [notBody("promptSvc.promptOrSteer"), notBody("SessionV2.prompt"), notBody("events.publish")]),
  },

  // ===========================================================================
  // Desktop & lildax lifecycle entry points (reach no authority writer -> read_only)
  // ===========================================================================
  {
    match: (id) => id.startsWith("desktop.") || id.startsWith("cli.lildax.") ||
      id === "composition.desktop-sidecar-start" || id === "composition.lildax-runtime",
    rules: readOnlyNoReach(),
  },

  // ===========================================================================
  // Tools & Provider & Recovery planes (single authoritative dimension; rest read_only)
  // ===========================================================================
  {
    match: (id) => id === "tools.dacode-registry",
    rules: withReadOnlyRest(
      { provider_tool_writer: legacy([LEGACY_PROMPT]) },
      [notBody("promptSvc.promptOrSteer"), notBody("SessionV2.prompt"), notBody("events.publish")],
    ),
  },
  {
    match: (id) => id === "tools.v2-registry",
    rules: withReadOnlyRest(
      { provider_tool_writer: v2([V2_TOOL_REGISTRY, call("register", "packages/core/src/tool/registry.ts")]) },
      [notBody("promptSvc.promptOrSteer"), notBody("SessionV2.prompt"), notBody("events.publish")],
    ),
  },
  {
    match: (id) => id.startsWith("provider."),
    rules: withReadOnlyRest(
      { provider_tool_writer: readOnly(AUTHORITY_WRITERS.map(noReachPath)) },
      [notBody("promptSvc.promptOrSteer"), notBody("SessionV2.prompt"), notBody("events.publish")],
    ),
  },
  {
    match: (id) => id === "recovery.database-binding",
    rules: withReadOnlyRest({ recovery_owner: readOnly([RECOVERY_BINDING]) }, [notBody("promptSvc.promptOrSteer"), notBody("SessionV2.prompt"), notBody("events.publish")]),
  },
  {
    match: (id) => id === "recovery.session-execution-restart",
    rules: withReadOnlyRest({ recovery_owner: v2([{ kind: "reach", pathSuffix: AUTHORITY.V2_EXECUTION_RESTART }]) }, [notBody("promptSvc.promptOrSteer"), notBody("SessionV2.prompt"), notBody("events.publish")]),
  },
  {
    match: (id) => id === "recovery.task-recovery-tool",
    rules: withReadOnlyRest({ recovery_owner: legacy([{ kind: "reach", pathSuffix: "packages/deepagent-code/src/tool/task_recovery.ts" }]) }, [notBody("promptSvc.promptOrSteer"), notBody("SessionV2.prompt"), notBody("events.publish")]),
  },
  {
    match: (id) => id === "recovery.provider-owner-runtime",
    rules: withReadOnlyRest({ recovery_owner: adapter([{ kind: "reach", pathSuffix: "packages/deepagent-code/src/context-federation/provider-owner-runtime.ts" }]) }, [notBody("promptSvc.promptOrSteer"), notBody("SessionV2.prompt"), notBody("events.publish")]),
  },
];

