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
import { DELEGATION_RULE_PACKS } from "./delegation"

export type VerdictRule = {
  readonly verdict: Exclude<Verdict, "unclassified">
  readonly requirements: readonly Requirement[]
}
export type EntryRules = Readonly<Partial<Record<Dimension, VerdictRule>>>
export type RulePack = { readonly match: (id: string) => boolean; readonly rules: EntryRules }

const PROMPT_SURFACE_PATH = AUTHORITY.PROMPT_SURFACE
const V2_EXEC_LOCAL_PATH = AUTHORITY.V2_EXECUTION_LOCAL

const PROMPT_SURFACE: Requirement = { kind: "reach", pathSuffix: PROMPT_SURFACE_PATH }
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
const V2_SESSION_CORE: Requirement = { kind: "reach", pathSuffix: AUTHORITY.V2_SESSION_CORE }
const V2_SESSION_RUNTIME: Requirement = { kind: "reach", pathSuffix: AUTHORITY.V2_SESSION_RUNTIME }
const INSTANCE_STATE: Requirement = {
  kind: "reach",
  pathSuffix: "packages/deepagent-code/src/effect/instance-state.ts",
}

const AUTHORITY_WRITERS: readonly string[] = [
  AUTHORITY.PROMPT_SURFACE,
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
function guardBeforeLegacy(guard: string, legacy: string): Requirement {
  return { kind: "guardBeforeLegacy", guard, legacy }
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
function v2All7(requirements: readonly Requirement[]): EntryRules {
  return all7(v2(requirements))
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
// A genuine read-side requirement for a query/reader op: the entry must reach a reader module it
// actually reads from, so read_only is never absence-only / self-reach-only (NEW-P2-C). Optional.
function readOnlyNoBody(readReach: string = "packages/deepagent-code/src/effect/instance-state.ts"): EntryRules {
  // NEW-P2-C: read_only requires a GENUINE reader module the entry reads from (default: the
  // instance/workspace context reader all instance HTTP handlers use), never a self-reach.
  return all7(readOnly([{ kind: "reach" as const, pathSuffix: readReach }, ...READ_ONLY_NOBODY_REQS]))
}
/** Same verdict on owned dims; EVERY other dimension read_only via the given requirements. */
function withReadOnlyRest(
  owned: Readonly<Partial<Record<Dimension, VerdictRule>>>,
  readOnlyReqs: readonly Requirement[],
  readReach: string = "packages/deepagent-code/src/effect/instance-state.ts",
): EntryRules {
  // NEW-P2-C: the read_only rest must carry a GENUINE read fact (reach the entry's actual reader
  // module), never absence-only. Default reader for instance-plane entries is the instance/workspace
  // context reader that all instance HTTP handlers use.
  const result: Record<Dimension, VerdictRule> = {} as Record<Dimension, VerdictRule>
  const restReqs = [{ kind: "reach" as const, pathSuffix: readReach }, ...readOnlyReqs]
  for (const dimension of DIMENSIONS) {
    result[dimension] = owned[dimension] ?? readOnly(restReqs)
  }
  return result as EntryRules
}

/** Non-bus authority writers an event-plane consumer does not reach (so read_only rest is provable). */
const EVENT_CONSUMER_READONLY: readonly Requirement[] = [
  noReachPath(AUTHORITY.PROMPT_SURFACE),
  noReachPath(AUTHORITY.V2_EXECUTION_LOCAL),
  noReachPath(AUTHORITY.V2_EXECUTION_RESTART),
  noReachPath(AUTHORITY.V2_TOOL_REGISTRY),
  noReachPath(AUTHORITY.PROJECTOR),
  // recovery-binding is a READ-ONLY recovery classifier, not a writer. Since A5/C1A-11 the
  // DB-layer post-verify audit (migration.ts -> post-verify.ts -> recovery-binding.ts) is in every
  // event consumer's reach closure, so an absence check against it could never hold again — it
  // guarded a non-writer and was unsound by construction; the writer noReach guards above remain.
]

/** Chains a CLI command body uses when it writes sessions or drives interactions through the
 * SDK client — each verified against the real command bodies. */
const CLI_SESSION_WRITE_PROBES: readonly string[] = [
  "client.session.prompt",
  "client.session.command",
  "client.deepagent.goal.start",
  "client.permission.reply",
  "client.question.reply",
  "client.question.reject",
  "client.v2.session.permission.reply",
]

const LEGACY_READONLY_REST: readonly Requirement[] = [
  notBody("promptSvc.promptOrSteer"),
  notBody("SessionV2.prompt"),
  notBody("events.publish"),
]

export const RULE_PACKS: readonly RulePack[] = [
  // ===========================================================================
  // Delegation model (production-grade closure): entries that delegate authority to a statically-
  // provable receiver inherit that receiver's verdict. Must be FIRST so they win over the generic
  // legacy/read_only providers below, and so build.ts pass-2 can resolve the inherited verdict.
  // ===========================================================================
  ...DELEGATION_RULE_PACKS,

  // ===========================================================================
  // NEW-P3-F: genuine reader/loader/schema/query/event/recovery entries whose OWN module IS their
  // reader. Their non-owner dimensions are read_only with the entry's own module as the (reachable)
  // read fact — these are documented readers, not the removed always-succeeds synthetic self-reach.
  // These must come FIRST so they win over the generic event/provider/recovery rules below.
  // ===========================================================================
  {
    match: (id) => id === "provider.model-catalog-parse",
    rules: withReadOnlyRest(
      {},
      [
        notBody("promptSvc.promptOrSteer"),
        notBody("SessionV2.prompt"),
        notBody("events.publish"),
        notBody("EventV2.Cursor"),
      ],
      "packages/core/src/model.ts",
    ),
  },
  {
    match: (id) => id === "provider.provider-v2-schema",
    rules: withReadOnlyRest(
      {},
      [
        notBody("promptSvc.promptOrSteer"),
        notBody("SessionV2.prompt"),
        notBody("events.publish"),
        notBody("EventV2.Cursor"),
      ],
      "packages/core/src/provider.ts",
    ),
  },
  {
    match: (id) => id === "provider.model-request-resolver",
    rules: withReadOnlyRest(
      {},
      [
        notBody("promptSvc.promptOrSteer"),
        notBody("SessionV2.prompt"),
        notBody("events.publish"),
        notBody("EventV2.Cursor"),
      ],
      "packages/core/src/model-request.ts",
    ),
  },
  {
    match: (id) => id === "event.deepagent-bus",
    rules: withReadOnlyRest(
      { event_producer_consumer: v2([V2_EVENT_BUS]) },
      EVENT_CONSUMER_READONLY,
      "packages/core/src/deepagent/deepagent-event-bus.ts",
    ),
  },
  {
    match: (id) => id === "event.event-router",
    rules: withReadOnlyRest(
      { event_producer_consumer: v2([V2_EVENT_ROUTER]) },
      EVENT_CONSUMER_READONLY,
      "packages/core/src/deepagent/event-router.ts",
    ),
  },
  {
    match: (id) => id === "event.goal-tick-consumer",
    rules: withReadOnlyRest(
      { event_producer_consumer: v2([V2_EVENT_BUS]) },
      EVENT_CONSUMER_READONLY,
      "packages/deepagent-code/src/session/goal-tick-consumer.ts",
    ),
  },
  {
    match: (id) => id === "event.panel-convene-consumer",
    rules: withReadOnlyRest(
      { event_producer_consumer: v2([V2_EVENT_BUS]) },
      EVENT_CONSUMER_READONLY,
      "packages/deepagent-code/src/panel/panel-convene-consumer.ts",
    ),
  },
  {
    match: (id) => id === "recovery.session-execution-restart",
    rules: withReadOnlyRest(
      { recovery_owner: v2([{ kind: "reach", pathSuffix: AUTHORITY.V2_EXECUTION_RESTART }]) },
      [
        notBody("promptSvc.promptOrSteer"),
        notBody("SessionV2.prompt"),
        notBody("events.publish"),
        notBody("EventV2.Cursor"),
      ],
      "packages/core/src/session/execution/restart.ts",
    ),
  },
  {
    match: (id) => id === "recovery.provider-owner-runtime",
    rules: withReadOnlyRest(
      {
        recovery_owner: adapter([
          { kind: "reach", pathSuffix: "packages/deepagent-code/src/context-federation/provider-owner-runtime.ts" },
        ]),
      },
      [
        notBody("promptSvc.promptOrSteer"),
        notBody("SessionV2.prompt"),
        notBody("events.publish"),
        notBody("EventV2.Cursor"),
      ],
      "packages/deepagent-code/src/context-federation/provider-owner-runtime.ts",
    ),
  },

  // ---- C6 API surfaces (capability/context/maintenance/system-context groups): instance-plane
  // read/control HTTP handlers — read_only with the genuine instance/workspace reader fact (the
  // same pattern every other http.instance.* GET reader uses). Their authority owners live in
  // the core services the handlers read. ----
  {
    match: (id) =>
      id.startsWith("http.instance.capability.") ||
      id.startsWith("http.instance.context.") ||
      id.startsWith("http.instance.maintenance.") ||
      id.startsWith("http.instance.system-context."),
    rules: readOnlyNoBody(),
  },

  // ===========================================================================
  // ===========================================================================
  // RI-95 W1 (2026-09-10): browser client, remote gateway client, and the CI release root.
  // The browser entry and the remote gateway client are pure consumers — they render and call
  // HTTP; every authority dimension is read_only, proven by the SDK/fetch client module in
  // their closure plus absence of every authority writer. The CI release root runs the
  // authoritative ledger generator; it reads the tree and inventories and writes release
  // evidence, never session authority.
  {
    match: (id) => id === "browser.app-entry",
    rules: all7(readOnly([
      // The `@/` alias is only resolvable inside the deepagent-code package, so the positive read
      // fact is the entry's own resolved relative import: the server connection helper.
      { kind: "reach", pathSuffix: "packages/app/src/utils/server.ts" },
      { kind: "noReach", pathSuffix: AUTHORITY.PROMPT_SURFACE },
      { kind: "noReach", pathSuffix: AUTHORITY.V2_EXECUTION_LOCAL },
      { kind: "noReach", pathSuffix: AUTHORITY.V2_TOOL_REGISTRY },
      { kind: "noReach", pathSuffix: AUTHORITY.PROJECTOR },
      notBody("events.publish"),
    ])),
  },
  {
    match: (id) => id === "browser.remote-gateway-client",
    rules: all7(readOnly([
      { kind: "reach", pathSuffix: "packages/app/src/utils/gateway-client.ts" },
      { kind: "noReach", pathSuffix: AUTHORITY.PROMPT_SURFACE },
      { kind: "noReach", pathSuffix: AUTHORITY.V2_EXECUTION_LOCAL },
      { kind: "noReach", pathSuffix: AUTHORITY.V2_TOOL_REGISTRY },
      { kind: "noReach", pathSuffix: AUTHORITY.PROJECTOR },
      notBody("events.publish"),
    ])),
  },
  {
    match: (id) => id === "ci.publish-workflow",
    rules: all7(readOnly([
      { kind: "reach", pathSuffix: "packages/core/src/contract/evidence-manifest.ts" },
      { kind: "reach", pathSuffix: "packages/core/src/system-context/capability-catalog.ts" },
      { kind: "noReach", pathSuffix: AUTHORITY.PROMPT_SURFACE },
      { kind: "noReach", pathSuffix: AUTHORITY.V2_EXECUTION_LOCAL },
      { kind: "noReach", pathSuffix: AUTHORITY.V2_TOOL_REGISTRY },
      { kind: "noReach", pathSuffix: AUTHORITY.PROJECTOR },
    ])),
  },

  // ===========================================================================
  // RI-71 W1 (2026-09-10): V2-backed reclassifications under the production core-v2-only
  // profile. coreV2Only is a machine-verified hardcoded invariant (productionProfile), so the
  // runtime authority for these entries is Core V2 — proven by positive AST facts, not intent.
  // ===========================================================================
  // summarize is a DIRECT V2 command since RI-18 native manual compaction: the handler calls
  // SessionV2.compact (durable request chain, V2 events, V2 receipts).
  {
    match: (id) => id === "http.instance.session.summarize",
    rules: v2All7([
      { kind: "productionProfile" },
      body("coreV2Session.compact"),
      PROMPT_SURFACE,
      V2_SESSION_CORE,
      V2_EXEC_LOCAL,
    ]),
  },
  // W0-4 legacy recovery surfaces stay legacy ON PURPOSE (attempted reclassification reverted):
  // contextAttemptResolve still contains a promptSvc.loop replay branch after the profile refusal,
  // and the requirements language cannot prove statement ordering. The refusal guard makes them
  // unavailable at runtime, but the legacy reachability itself is RI-54's deletion work.
  // abort targets the V2 execution owner under the core-v2-only profile: promptSvc.cancel
  // routes coreV2Session.interrupt (process-local V2 interrupt) and never touches the legacy
  // run-state cancel branch.
  {
    match: (id) => id === "http.instance.session.abort",
    rules: v2All7([
      { kind: "productionProfile" },
      body("promptSvc.cancel"),
      call("coreV2Session.interrupt", PROMPT_SURFACE_PATH),
      V2_SESSION_CORE,
      V2_EXEC_LOCAL,
    ]),
  },
  // The promptOrSteer family is the app wire-protocol adapter over V2 authority: under the
  // core-v2-only profile every prompt routes promptV2 (SessionV2 admission + coreV2Session
  // resume through the V2 runner) and legacy execution for V2 sessions is refused by
  // LEGACY-EXECUTION-ZERO. adapter, not v2: the app layer still translates the wire shape.
  {
    match: (id) =>
      id.startsWith("http.instance.session.") &&
      ["prompt", "promptAsync", "promptPrepare", "promptPrepareStream", "promptSuggestion"].includes(
        id.slice("http.instance.session.".length),
      ),
    rules: all7(adapter([
      { kind: "productionProfile" },
      body("promptSvc"),
      PROMPT_SURFACE,
      V2_SESSION_CORE,
      V2_EXEC_LOCAL,
      call("coreV2Session.prompt", PROMPT_SURFACE_PATH),
      call("coreV2Session.resume", PROMPT_SURFACE_PATH),
    ])),
  },

  // ===========================================================================
  // HTTP — session-execution operations driving the legacy SessionPrompt turn
  // ===========================================================================
  {
    // v2w-l2: command/shell/init resolve through the command surface service (commandSvc ->
    // SessionCommandV2) which delegates execution to the prompt-v2 admission; the receipted
    // side effects (P0-4) stay in the command module.
    match: (id) =>
      id.startsWith("http.instance.session.") &&
      ["command", "shell", "init"].includes(id.slice("http.instance.session.".length)),
    rules: all7(adapter([
      { kind: "productionProfile" },
      body("commandSvc"),
      PROMPT_SURFACE,
      V2_SESSION_CORE,
      V2_EXEC_LOCAL,
      call("coreV2Session.prompt", PROMPT_SURFACE_PATH),
    ])),
  },
  {
    match: (id) =>
      id.startsWith("http.instance.session.") &&
      ["prompt", "promptAsync", "promptPrepare", "promptPrepareStream", "promptSuggestion"].includes(
        id.slice("http.instance.session.".length),
      ),
    rules: legacyAll7([PROMPT_SURFACE, body("promptSvc")]),
  },
  {
    // RI-71 zero wave: the recovery-resolution surfaces refuse BEFORE any legacy machinery under
    // the production profile (structural early return; the resolution state machines and the
    // replay fork live in the legacy-profile helpers), so the handler bodies themselves cannot
    // reach the legacy session execution chain.
    match: (id) =>
      id === "http.instance.session.contextAttemptResolve" ||
      id === "http.instance.session.continuationResolutionResolve",
    rules: all7(adapter([
      { kind: "productionProfile" },
      // LEGACY-EXECUTION-ZERO contract, now machine-verified: the profile-pinned refusal runs
      // BEFORE any legacy-execution chain in the handler flow (line order = statement order in
      // the generator body, including same-file helper expansion).
      guardBeforeLegacy("refuseLegacyRecoveryMutation", "promptSvc"),
      PROMPT_SURFACE,
      V2_SESSION_CORE,
      V2_EXEC_LOCAL,
    ])),
  },
  // ---- session create/fork (legacy Session session-lifecycle writers) ----
  // RI-16/RI-25: POST /session under the core-v2-only profile is Core-native create
  // (session.created.2 authority; the handler reads the V1 wire shape back as pure egress).
  {
    match: (id) => id === "http.instance.session.create",
    rules: v2All7([
      { kind: "productionProfile" },
      body("coreV2Session.create"),
      { kind: "reach", pathSuffix: AUTHORITY.V2_SESSION_CORE },
      { kind: "reach", pathSuffix: AUTHORITY.PROJECTOR },
    ]),
  },
  // RI-71 W3: fork is the V2-history-preserving clone — the dac fork machinery copies
  // session_message rows (fresh V2 ids + parentID remap) and fast-forwards the child's event
  // sequence (completeForkSideEffects). adapter: fork-lifecycle translation over the shared V2
  // history authority.
  {
    match: (id) => id === "http.instance.session.fork",
    rules: all7(adapter([
      body("session.fork"),
      V2_SESSION_CORE,
      { kind: "callChain", chain: "SessionMessageTable" },
      notBody("promptSvc.promptOrSteer"),
      notBody("promptSvc.loop"),
      notBody("SessionV2.prompt"),
    ])),
  },
  {
    match: (id) =>
      id.startsWith("http.instance.session.") &&
      [
        "get",
        "list",
        "status",
        "messages",
        "message",
        "plan",
        "diff",
        "todo",
        "exportSnapshot",
        "importSnapshot",
        "remove",
        "revert",
        "unrevert",
        "share",
        "unshare",
        "update",
        "deleteMessage",
        "deletePart",
        "updatePart",
        "permissionRespond",
        "contextCohort",
        "contextDiagnostics",
        "continuationResolutionList",
        "diffArtifactFile",
        "diffArtifactMaintenance",
        "diffArtifactManifest",
        "children",
      ].includes(id.slice("http.instance.session.".length)),
    rules: readOnlyNoBody(),
  },
  {
    // RI-71 zero wave: LIST is a pure describe over the legacy provider-resolution store — a
    // read surface, never an execution path.
    match: (id) => id === "http.instance.session.providerResolutionList",
    rules: all7(readOnly([
      LEGACY_PROVIDER_RESOLUTION,
      body("providerResolutionSvc.describe"),
      notBody("promptSvc.promptOrSteer"),
      notBody("SessionV2.prompt"),
      notBody("events.publish"),
    ])),
  },
  {
    // RI-71 zero wave: RESOLVE refuses BEFORE any legacy machinery under the production profile
    // (structural early return; the legacy state machine lives in the legacy-profile helper), and
    // the handler body itself never touches the session execution chain.
    match: (id) => id === "http.instance.session.providerResolutionResolve",
    rules: all7(adapter([
      { kind: "productionProfile" },
      guardBeforeLegacy("refuseLegacyRecoveryMutation", "providerResolutionSvc"),
      LEGACY_PROVIDER_RESOLUTION,
    ])),
  },

  // ---- deepagent goal/panel/knowledge/pack pipeline (legacy) ----
  // RI-71 W3: the goal-lifecycle endpoints control GoalManager, which since RI-39 captures
  // SessionV2 explicitly and drives goal turns through the V2 owner under the production profile.
  // adapter: goal-lifecycle control translated to the V2-driving goal manager; the goal loop's
  // execution authority is Core V2.
  {
    match: (id) =>
      id.startsWith("http.instance.deepagent.") &&
      ["goalEditPlan", "goalPause", "goalResume", "goalStart", "goalStop"].includes(
        id.slice("http.instance.deepagent.".length),
      ),
    rules: all7(adapter([
      { kind: "productionProfile" },
      body("experimentalGoalLoop"),
      GOAL_MANAGER,
      V2_SESSION_CORE,
      notBody("promptSvc.promptOrSteer"),
      notBody("SessionV2.prompt"),
      notBody("ToolRegistry.register"),
    ])),
  },
  // RI-71 W3: panel arm/status is AgentGateway session-state control (debate depth, armed
  // choice) — UI-process state behind the gateway's DeepAgent session-state store, never session
  // authority. The gateway store is a legacy release-graph global (RI-94 tracks it), but the HTTP
  // handler body only calls its panel accessors.
  {
    match: (id) => id === "http.instance.deepagent.panelArm" || id === "http.instance.deepagent.panelStatus",
    rules: all7(adapter([
      body("AgentGateway.DeepAgentSessionState"),
      notBody("promptSvc.promptOrSteer"),
      notBody("SessionV2.prompt"),
      notBody("ToolRegistry.register"),
      notBody("events.publish"),
    ])),
  },
  {
    // v2f-c goal/panel V2-only subagent lifecycle: the panel consult handler drives reviewer
    // turns through makeTaskSubagentRunner with the captured SessionV2.Service (v2Session) — the
    // runner is V2-native (its SessionPrompt fallback is deleted) and drives SessionV2 directly,
    // so there is no legacy prompt hop to pin anymore. adapter: the handler still adapts the
    // panel wire protocol onto the V2 child-session runner seam (panel.consult/panelist-runner
    // are adapter-classified the same way).
    match: (id) => id === "http.instance.deepagent.panelConsult",
    rules: all7(adapter([
      { kind: "productionProfile" },
      body("makeTaskSubagentRunner"),
      body("v2Session"),
      V2_SESSION_CORE,
      V2_EXEC_LOCAL,
    ])),
  },
  // RI-71 W3: knowledge ship-gate/reject/release operate the AgentGateway knowledge-source
  // coordination state (review queues, baselines) — not session execution authority.
  {
    match: (id) =>
      id.startsWith("http.instance.deepagent.") &&
      ["knowledgeRejectIds", "knowledgeReleaseBaseline", "knowledgeShipGate"].includes(
        id.slice("http.instance.deepagent.".length),
      ),
    rules: all7(adapter([
      body("AgentGateway.DeepAgentKnowledgeSource"),
      notBody("promptSvc.promptOrSteer"),
      notBody("SessionV2.prompt"),
      notBody("ToolRegistry.register"),
      notBody("events.publish"),
    ])),
  },
  // RI-71 W3: domain-pack registry reads and pin/unpin are registry-state operations (the
  // domain-pack prototype is unreachable in production per RI-07); bus.publish here is the
  // pack-change notification, not session authority.
  {
    match: (id) =>
      id.startsWith("http.instance.deepagent.") &&
      ["packsActive", "packsAll"].includes(id.slice("http.instance.deepagent.".length)),
    rules: all7(readOnly([
      body("AgentGateway.DeepAgentDomainPackRegistry"),
      notBody("promptSvc.promptOrSteer"),
      notBody("SessionV2.prompt"),
      notBody("events.publish"),
      notBody("bus.publish"),
    ])),
  },
  {
    match: (id) =>
      id.startsWith("http.instance.deepagent.") &&
      ["packsPin", "packsUnpin"].includes(id.slice("http.instance.deepagent.".length)),
    rules: all7(adapter([
      body("bus.publish"),
      notBody("promptSvc.promptOrSteer"),
      notBody("SessionV2.prompt"),
      notBody("ToolRegistry.register"),
    ])),
  },
  {
    match: (id) =>
      id.startsWith("http.instance.deepagent.") &&
      [
        "goalStartable",
        "goalStatus",
        "envFacts",
        "envFactsDecide",
        "envFactsModify",
        "knowledgeApprove",
        "knowledgePending",
        "knowledgeReviewSummary",
        "promote",
        "reject",
        "reviews",
        "wikiEdit",
        "wikiExecutionArchive",
        "wikiPage",
        "wikiPages",
        "wikiSearch",
        "queuedInputs",
      ].includes(id.slice("http.instance.deepagent.".length)),
    rules: readOnlyNoBody(),
  },

  // ---- global ----
  // RI-71 W3: global capabilities introspects the expert-panel experiment surface (a config/
  // feature gate reader); it never writes session authority.
  {
    match: (id) => id === "http.instance.global.capabilities",
    rules: all7(readOnly([
      body("experimentalExpertPanel"),
      notBody("promptSvc.promptOrSteer"),
      notBody("SessionV2.prompt"),
      notBody("events.publish"),
      notBody("ToolRegistry.register"),
    ])),
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
  // v2f-d IM durable-only migration: ServerAgentExecutor (fresh V1 session per turn through
  // SessionPrompt.promptOrSteer) is deleted. createMessage now performs exactly ONE durable
  // SessionV2 admission per @mention in-request (IMAgentExecution.admitMention on the
  // SessionV2.Service captured by the handler group); the terminal reply returns through the
  // im_reply_outbox daemon, never a fire-and-forget publish. adapter: IM wire-protocol
  // translation over the durable V2 admission — the same adapter family the HTTP prompt
  // handlers form (the app layer still translates the wire shape).
  {
    match: (id) => id === "http.instance.im.createMessage",
    rules: all7(adapter([
      { kind: "productionProfile" },
      body("IMAgentExecution.admitMention"),
      { kind: "reach", pathSuffix: "packages/deepagent-code/src/im/im-agent-execution.ts" },
      V2_SESSION_CORE,
      V2_EXEC_LOCAL,
    ])),
  },
  // v2f-d: the durable ADMISSION half of the IM migration (src/im/im-agent-execution.ts). One
  // SessionV2 admission per mention with deterministic ids — the session id derived from
  // (group, agent) so reuse ADOPTS the stable conversation session, the prompt message id from
  // (message, agent) so a duplicate delivery reconciles as an exact retry — admitted as the
  // durable session_input row itself; execution is decoupled (advisory wake under the runner).
  // v2 on admission/execution: verified SessionV2.prompt admission chain plus the core session
  // and local-execution authorities in the closure, and NO legacy prompt hop in the module's
  // import closure (noReach). The remaining dimensions are read_only with the module's own
  // admission surface as the genuine read fact.
  {
    match: (id) => id === "im.agent-execution",
    rules: withReadOnlyRest(
      {
        admission_owner: v2([
          { kind: "reach", pathSuffix: "packages/deepagent-code/src/im/im-agent-execution.ts" },
          { kind: "reach", pathSuffix: AUTHORITY.V2_SESSION_INPUT },
          call("SessionV2.ID.make", "packages/deepagent-code/src/im/im-agent-execution.ts"),
          call("SessionMessage.ID.make", "packages/deepagent-code/src/im/im-agent-execution.ts"),
          call("v2Session.prompt", "packages/deepagent-code/src/im/im-agent-execution.ts"),
          noReachPath(AUTHORITY.PROMPT_SURFACE),
        ]),
        execution_owner: v2([
          { kind: "reach", pathSuffix: "packages/deepagent-code/src/im/im-agent-execution.ts" },
          V2_SESSION_CORE,
          V2_EXEC_LOCAL,
          call("v2Session.prompt", "packages/deepagent-code/src/im/im-agent-execution.ts"),
          noReachPath(AUTHORITY.PROMPT_SURFACE),
        ]),
      },
      [notBody("promptSvc.promptOrSteer"), notBody("SessionV2.prompt"), notBody("events.publish")],
      "packages/deepagent-code/src/im/im-agent-execution.ts",
    ),
  },
  // v2f-d: the durable REPLY half (src/im/im-reply-outbox.ts). The terminal assistant reply of a
  // settled IM session is collected into the im_reply_outbox table (idempotent on
  // (session, reply)) and delivered at-least-once: claim (lease + attempts CAS) → deliver
  // (IMRepository.createMessage + broadcast) → settle (delivered | pending+backoff | dead at the
  // cap — never vanished). A post-commit EventV2 listener drains on settle and a periodic
  // reconcile covers downtime; nothing rides a droppable fire-and-forget channel. v2 on the
  // event dimension (EventV2 consumer through the bridge's listen surface); delivery/storage is
  // not one of the seven session-authority dimensions, so the rest is read_only with the
  // outbox's own module as the genuine read fact.
  {
    match: (id) => id === "im.reply-outbox",
    rules: withReadOnlyRest(
      {
        event_producer_consumer: v2([
          { kind: "reach", pathSuffix: "packages/deepagent-code/src/im/im-reply-outbox.ts" },
          EVENT_V2_BRIDGE,
          call("SessionV2.Service", "packages/deepagent-code/src/im/im-reply-outbox.ts"),
          call("events.listen", "packages/deepagent-code/src/im/im-reply-outbox.ts"),
          call("claimDueReply", "packages/deepagent-code/src/im/im-reply-outbox.ts"),
          call("markDelivered", "packages/deepagent-code/src/im/im-reply-outbox.ts"),
          call("db.insert", "packages/deepagent-code/src/im/im-reply-outbox.ts"),
        ]),
      },
      [notBody("promptSvc.promptOrSteer"), notBody("SessionV2.prompt"), notBody("events.publish")],
      "packages/deepagent-code/src/im/im-reply-outbox.ts",
    ),
  },
  // v2f-d: agent-executor-server.ts keeps only ServerAgentListProviderLive — mention-list
  // resolution against the routed instance's Agent.Service roster (plus the built-in autonomous
  // descriptors). The class holds no prompt-execution authority anymore (ServerAgentExecutor is
  // deleted), so the entry is read_only: its own provider module plus the core list-provider
  // contract are the genuine read facts.
  {
    match: (id) => id === "im.agent-executor",
    rules: all7(readOnly([
      { kind: "reach", pathSuffix: "packages/deepagent-code/src/im/agent-executor-server.ts" },
      { kind: "reach", pathSuffix: "packages/core/src/im/agent-list-provider.ts" },
      notBody("promptSvc.promptOrSteer"),
      notBody("SessionV2.prompt"),
      notBody("events.publish"),
    ])),
  },
  // v2f-i residual sweep: the im.agent-orchestrator entry is REMOVED — the module
  // (packages/core/src/im/agent-orchestrator.ts, production-dead since v2f-d with no composition
  // providing AgentExecutorService) is deleted, so there is no production caller left to classify.
  {
    match: (id) => id.startsWith("http.instance.im."),
    rules: readOnlyNoBody(),
  },

  // ---- github (v2w-j4 durable-only) ----
  // The GitHub ingress durable ADMISSION half (src/github/github-agent-execution.ts). The legacy
  // GitHub Action path (fresh V1 Session per run through Session.Service.create + SessionPrompt
  // per chat turn) is deleted. One SessionV2 admission per (delivery, agent, turn) with
  // deterministic ids — the session id derived from the (lane, agent) conversation so a follow-up
  // event on the same issue/PR ADOPTS the session, the prompt message id from (delivery, agent,
  // turn) so a duplicate delivery reconciles as an exact retry — admitted as the durable
  // session_input row itself; execution is decoupled (advisory wake under the runner) and the
  // terminal assistant message read back from the durable history is the terminal evidence.
  // v2 on admission/execution: verified SessionV2.prompt admission chain plus the core session
  // and local-execution authorities in the closure, and NO legacy prompt hop in the module's
  // import closure (noReach). The remaining dimensions are read_only with the module's own
  // admission surface as the genuine read fact.
  {
    match: (id) => id === "github.agent-execution",
    rules: withReadOnlyRest(
      {
        admission_owner: v2([
          { kind: "reach", pathSuffix: "packages/deepagent-code/src/github/github-agent-execution.ts" },
          { kind: "reach", pathSuffix: AUTHORITY.V2_SESSION_INPUT },
          call("SessionV2.ID.make", "packages/deepagent-code/src/github/github-agent-execution.ts"),
          call("SessionMessage.ID.make", "packages/deepagent-code/src/github/github-agent-execution.ts"),
          call("v2Session.prompt", "packages/deepagent-code/src/github/github-agent-execution.ts"),
          noReachPath(AUTHORITY.PROMPT_SURFACE),
        ]),
        execution_owner: v2([
          { kind: "reach", pathSuffix: "packages/deepagent-code/src/github/github-agent-execution.ts" },
          V2_SESSION_CORE,
          V2_EXEC_LOCAL,
          call("v2Session.prompt", "packages/deepagent-code/src/github/github-agent-execution.ts"),
          noReachPath(AUTHORITY.PROMPT_SURFACE),
        ]),
      },
      [notBody("promptSvc.promptOrSteer"), notBody("SessionV2.prompt"), notBody("events.publish")],
      "packages/deepagent-code/src/github/github-agent-execution.ts",
    ),
  },

  // ---- tui ----
  // RI-71 W3 (2026-09-10): the TUI group is the terminal-UI control plane — every handler
  // publishes TuiEvent V2 definitions (tui.prompt/command/toast/select) through the EventV2
  // bridge or reads the session for validation; none writes session authority. The bridge's
  // prompt.ts reach is the shared service, not this group's body. adapter: UI-signal translation.
  {
    match: (id) => id.startsWith("http.instance.tui."),
    rules: all7(adapter([
      body("events.publish"),
      { kind: "reach", pathSuffix: "packages/deepagent-code/src/server/tui-event.ts" },
      notBody("promptSvc.promptOrSteer"),
      notBody("promptSvc.loop"),
      notBody("SessionV2.prompt"),
      notBody("ToolRegistry.register"),
      notBody("SessionExecution.wake"),
    ])),
  },
  {
    match: (id) =>
      id === "http.instance.im.createGroup" ||
      id === "http.instance.im-websocket.connect",
    rules: readOnlyNoBody(),
  },

  // ---- webhook ----
  {
    // RI-71 W3: webhook ingress is external-event translation into the DeepAgent event bus
    // (bounded, idempotency-keyed, §E2 ceiling) — the agents that react to those events own the
    // session authority downstream; the webhook handlers never touch it.
    match: (id) => id.startsWith("http.instance.webhook."),
    rules: all7(adapter([
      body("eventBus.tryPublish"),
      notBody("promptSvc.promptOrSteer"),
      notBody("promptSvc.loop"),
      notBody("SessionV2.prompt"),
      notBody("ToolRegistry.register"),
      notBody("SessionExecution.wake"),
    ])),
  },

  // ---- sync (EventV2 projection writers) ----
  {
    match: (id) =>
      id.startsWith("http.instance.sync.") &&
      [
        "artifacts",
        "checkpointCompact",
        "checkpointDiscard",
        "checkpointFinalize",
        "checkpointPrepare",
        "checkpointStage",
        "fileArtifacts",
        "snapshotRows",
      ].includes(id.slice("http.instance.sync.".length)),
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

  // ---- event subscribe ----
  // RI-71 W3: the instance event subscribe endpoint is the same consumer-only stream shape as
  // its server-plane twin above (events.all subscription, no writes) — the server twin was
  // already read_only; the instance twin gets the same positive-subscribe proof.
  {
    match: (id) => id === "http.instance.event.subscribe",
    rules: all7(readOnly([body("events.listen"), notBody("events.publish"), notBody("promptSvc.promptOrSteer")])),
  },
  {
    match: (id) => id === "http.server.server.event.event.subscribe",
    rules: all7(readOnly([{ kind: "reach", pathSuffix: "packages/core/src/event.ts" }, body("events.all")])),
  },

  // ---- Core V2 server session control operations ----
  {
    match: (id) =>
      id === "http.server.server.session.session.create" ||
      id === "http.server.server.session.session.prompt" ||
      id === "http.server.server.session.session.compact" ||
      id === "http.server.server.session.session.wait",
    rules: v2All7([V2_SESSION_CORE]),
  },
  // Query/tail operations consume the V2 projection and EventV2 journal but do not own a write.
  {
    match: (id) => id === "http.server.server.message.session.messages" || id.startsWith("http.server.server.session."),
    rules: readOnlyNoBody(AUTHORITY.V2_SESSION_CORE),
  },

  // ---- server read-only catalog / provider / skill ----
  {
    match: (id) =>
      id.startsWith("http.server.server.model.") ||
      id.startsWith("http.server.server.provider.") ||
      id.startsWith("http.server.server.skill."),
    rules: readOnlyNoBody("packages/core/src/catalog.ts"),
  },
  // Old packages/server read-only query ops: they read server-side state via the core
  // model/catalog/session-schema modules (a genuine reader), never the instance middleware.
  {
    match: (id) =>
      id.startsWith("http.server.server.fs.") ||
      id.startsWith("http.server.server.health.") ||
      id.startsWith("http.server.server.permission.") ||
      id.startsWith("http.server.server.question.") ||
      id.startsWith("http.server.server.command.") ||
      id.startsWith("http.server.server.agent."),
    rules: readOnlyNoBody("packages/core/src/session/schema.ts"),
  },

  // ---- HTTP infra read-only groups ----
  {
    match: (id) =>
      id.startsWith("http.instance.config.") ||
      id.startsWith("http.instance.control.") ||
      id.startsWith("http.instance.debug.") ||
      id.startsWith("http.instance.file.") ||
      id.startsWith("http.instance.mcp.") ||
      id.startsWith("http.instance.pty.") ||
      id.startsWith("http.instance.pty-connect.") ||
      id.startsWith("http.instance.question.") ||
      id.startsWith("http.instance.reference.") ||
      id.startsWith("http.instance.permission.") ||
      id.startsWith("http.instance.oversight.") ||
      id.startsWith("http.instance.profile.") ||
      id.startsWith("http.instance.project.") ||
      id.startsWith("http.instance.projectCopy.") ||
      id.startsWith("http.instance.workspace.") ||
      id.startsWith("http.instance.workspaceConfig.") ||
      id.startsWith("http.instance.instance.") ||
      id.startsWith("http.instance.experimental.") ||
      id.startsWith("http.instance.provider."),
    rules: readOnlyNoBody(),
  },

  // ===========================================================================
  // ACP protocol handlers (drive the legacy SessionPrompt session pipeline)
  // ===========================================================================
  // RI-71 W3: ACP is a wire-protocol adapter over the SDK client — every session operation
  // goes through input.sdk.session.* which lands on the HTTP server entries (adapter/v2 under
  // the profile). The ACP handlers never own session authority directly.
  {
    match: (id) => id.startsWith("acp."),
    rules: all7(adapter([
      { kind: "productionProfile" },
      { kind: "callChain", chain: "sdk.session" },
      notBody("promptSvc.promptOrSteer"),
      notBody("promptSvc.loop"),
      notBody("SessionV2.prompt"),
      notBody("ToolRegistry.register"),
    ])),
  },

  // ===========================================================================
  // dacode CLI (legacy composition entry; every command runs under the legacy CLI layer)
  // ===========================================================================
  // RI-71 W2 (2026-09-10): CLI commands are thin protocol clients. Under the production
  // core-v2-only profile every session write a CLI command makes lands on the server entries
  // (now adapter/v2 classified) through the SDK client; the command body itself never owns
  // authority. Ordered packs: session-writing commands prove a client write and are adapter;
  // the rest prove absence of every write probe and are read_only. Commands that prove neither
  // honestly demote to unclassified (the safety net).
  // First-match-wins per dimension: the WRITE commands are matched by exact id with positive
  // write proofs (verified against their resolved handler bodies); every other command proves
  // ABSENCE of all write probes plus the prompt/publish bodies and is read_only.
  {
    match: (id) => id === "cli.dacode.run",
    rules: all7(adapter([
      { kind: "productionProfile" },
      body("client.session"),
    ])),
  },
  // tui-thread drives the low-level SDK client (client.call/on/close) rather than client.session.
  {
    match: (id) => id === "cli.dacode.tui-thread",
    rules: all7(adapter([{ kind: "productionProfile" }, body("client.call")])),
  },
  {
    match: (id) => id.startsWith("cli.dacode."),
    rules: all7(readOnly([
      { kind: "reach", pathSuffix: "packages/deepagent-code/src/index.ts" },
      ...CLI_SESSION_WRITE_PROBES.map((chain) => notBody(chain)),
      notBody("promptSvc.promptOrSteer"),
      notBody("promptSvc.loop"),
      notBody("events.publish"),
    ])),
  },

  // ===========================================================================
  // Composition roots
  // ===========================================================================
  {
    // RI-71 zero wave: the process-root compositions BUILD both surfaces, and under the
    // production profile their session-execution authority graph IS the V2 runtime — every
    // prompt admission routes promptV2 and the graph carries Core session + local execution +
    // the runner frame (same reach-based composition standard as cli.lildax/server-web-handler,
    // plus the profile flag the adapters rely on). The legacy prompt module remains in the
    // graph as the fork host; the fork target is the V2 owner.
    // v2w-j5: the AppRuntime root no longer COMPOSES the legacy prompt layer (the V1 assembly is
    // torn out of baseAppLayer; zero root-level consumers — the session-ingress handlers own it on
    // the httpapi graph). app-runtime-layers still reaches prompt.ts through the shared import
    // graph (plugin -> server -> httpapi routes), the same passive-reach standard the
    // tools.dacode-registry entry documents; the reach requirement stays machine-true.
    match: (id) =>
      id === "composition.app-runtime-layers" ||
      id === "composition.dacode-cli-entry" ||
      id === "composition.instance-httpapi-stack",
    rules: v2All7([
      { kind: "productionProfile" },
      PROMPT_SURFACE,
      V2_SESSION_CORE,
      V2_EXEC_LOCAL,
      V2_SESSION_RUNTIME,
    ]),
  },
  {
    match: (id) => id === "composition.server-web-handler" || id === "composition.lildax-runtime",
    rules: v2All7([V2_SESSION_RUNTIME]),
  },
  {
    // The public SDK launcher spawns the formal deepagent-code process. Keep that
    // library entrypoint in the denominator because every embedded integration can
    // otherwise bypass the process-root inventory. The spawned process boots the
    // production profile whose composition (dacode-cli-entry) carries the V2 runtime;
    // the launcher's own module is the spawn surface, verified by self-reach plus the
    // V2 runner frame in its dependency graph (the SDK client imports the Core runtime
    // types bundle).
    match: (id) => id === "composition.sdk-server-launcher",
    // delegatesTo placeholder: pass 2 inherits dacode-cli-entry's verdict through the verified
    // spawn edge (launch("deepagent-code", ...) is bound in DELEGATION_SPAWN_BINDINGS).
    rules: Object.fromEntries(
      DIMENSIONS.map((dimension) => [dimension, { verdict: "legacy", requirements: [{ kind: "delegatesTo", targetId: "composition.dacode-cli-entry" }] }]),
    ) as unknown as EntryRules,
  },
  {
    // Slack launches the packaged product but its own authority path is exclusively
    // the Core V2 create/admit/wait/projection SDK surface. Keep all four calls in the
    // proof so a future fallback to client.session.* cannot inherit a V2 verdict.
    match: (id) => id === "composition.slack-bot",
    rules: v2All7([
      { kind: "callChain", fileSuffix: "packages/slack/src/index.ts", chain: "deepagentCode.client.v2.session.create" },
      { kind: "callChain", fileSuffix: "packages/slack/src/index.ts", chain: "deepagentCode.client.v2.session.prompt" },
      { kind: "callChain", fileSuffix: "packages/slack/src/index.ts", chain: "deepagentCode.client.v2.session.wait" },
      {
        kind: "callChain",
        fileSuffix: "packages/slack/src/index.ts",
        chain: "deepagentCode.client.v2.session.messages",
      },
    ]),
  },
  {
    // The share backend stores/streams published artifacts but does not admit or execute an
    // agent Session. The positive reach to its filesystem ShareStore proves what it actually
    // reads/writes; absence of the seven DeepAgent authority modules is only supporting evidence,
    // never the sole reason for a read_only verdict.
    match: (id) => id === "composition.share-backend",
    rules: readOnlyNoBody("packages/function/src/store.ts"),
  },

  // lildax CLI commands run inside the lildax Handlers runtime which provides the legacy server
  // (createRoutes in packages/server/src/routes.ts); commands whose handler reaches that composition
  // drive the legacy server, so they are legacy.
  {
    match: (id) => id.startsWith("cli.lildax."),
    rules: v2All7([{ kind: "reach", pathSuffix: "packages/server/src/routes.ts" }, V2_SESSION_RUNTIME]),
  },
  // Panel orchestration components (panel.orchestrator/arbiter) resolve their authority through
  // an injected runPanelist seam and are read_only with the panel schema as their genuine reader
  // (delegation.ts).

  // v2f-c goal/panel V2-only subagent lifecycle: the goal pipeline and expert panel drive child
  // sessions through makeTaskSubagentRunner — now the V2-native child-session runner (SessionV2
  // captured explicitly; the SessionPrompt fallback is deleted) — under the production profile.
  // adapter: goal/panel orchestration translated onto the V2 child-session authority.
  // background.job is the instance-scoped CoreBackgroundJob registry wrapper — coordination
  // state only.
  {
    match: (id) =>
      id === "task.goal-manager" ||
      id === "task.goal-loop-wiring" ||
      id === "panel.consult" ||
      id === "panel.panelist-runner",
    rules: all7(adapter([
      { kind: "productionProfile" },
      V2_SESSION_CORE,
      V2_EXEC_LOCAL,
      call("makeTaskSubagentRunner", "packages/deepagent-code/src/session/goal-loop-wiring.ts"),
    ])),
  },
  {
    match: (id) => id === "background.job",
    rules: all7(readOnly([
      { kind: "reach", pathSuffix: "packages/core/src/background-job.ts" },
      notBody("promptSvc.promptOrSteer"),
      notBody("SessionV2.prompt"),
      notBody("events.publish"),
    ])),
  },
  {
    // RI-71 zero wave: goal-driver is the pure orchestration brain over the CORE goal loop and
    // plan store — its import closure never reaches the legacy prompt execution module (verified
    // noReach), so it holds none of the seven session-authority dimensions. Session execution is
    // owned by goal-loop-wiring's runner (adapter-classified separately).
    match: (id) => id === "task.goal-driver",
    rules: all7(readOnly([
      { kind: "reach", pathSuffix: AUTHORITY.GOAL_LOOP },
      { kind: "reach", pathSuffix: "packages/core/src/deepagent/plan-store.ts" },
      { kind: "noReach", pathSuffix: PROMPT_SURFACE_PATH },
      notBody("promptSvc.promptOrSteer"),
      notBody("SessionV2.prompt"),
    ])),
  },
  {
    // v2f-h2 cutover: the V1-registry TaskTool is a thin entry over the Core V2 TaskRunAuthority —
    // fresh launches submit through TaskRunAuthority.submit and foreground joins execute through
    // TaskRunAuthority.execute (verified body markers), and the module reaches the Core authority
    // + dispatcher runtime. The legacy app admission/claim/settle chain is deleted; the
    // promptOps seam that remains serves PR finalize (#29 owns its migration).
    match: (id) => id === "task.task-tool",
    rules: all7(adapter([
      { kind: "productionProfile" },
      call("TaskRunAuthority.submit", "packages/deepagent-code/src/tool/task.ts"),
      call("TaskRunAuthority.execute", "packages/deepagent-code/src/tool/task.ts"),
      { kind: "reach", pathSuffix: "packages/core/src/session/task-run.ts" },
    ])),
  },

  // ===========================================================================
  // IM server-side pipeline: the legacy SessionPrompt pack is GONE (v2f-d durable-only
  // migration). ServerAgentExecutor / agent-reply-sink-server / agent-progress-stream are
  // deleted; every surviving IM entry is classified in the im pack above (durable V2
  // admission, durable reply outbox, mention-list provider read). The production-dead core
  // agent-orchestrator module and its entry are deleted outright (v2f-i residual sweep).
  // ===========================================================================

  // ===========================================================================
  // Event plane (durable V2 bus / router / consumers / bridge)
  // ===========================================================================
  {
    match: (id) => id === "event.deepagent-bus",
    rules: withReadOnlyRest(
      { event_producer_consumer: v2([V2_EVENT_BUS]) },
      EVENT_CONSUMER_READONLY,
      "packages/core/src/event.ts",
    ),
  },
  {
    match: (id) => id === "event.event-router",
    rules: withReadOnlyRest(
      { event_producer_consumer: v2([V2_EVENT_ROUTER]) },
      EVENT_CONSUMER_READONLY,
      "packages/core/src/event.ts",
    ),
  },
  {
    match: (id) =>
      id === "event.goal-tick-consumer" ||
      id === "event.panel-convene-consumer" ||
      id === "event.wiki-event-driven-archiver",
    rules: withReadOnlyRest(
      { event_producer_consumer: v2([V2_EVENT_BUS]) },
      EVENT_CONSUMER_READONLY,
      "packages/core/src/event.ts",
    ),
  },
  {
    match: (id) => id === "event.legacy-canonicalizer-daemon",
    rules: withReadOnlyRest(
      { event_producer_consumer: adapter([LEGACY_CANONICALIZER]) },
      EVENT_CONSUMER_READONLY,
      "packages/core/src/event.ts",
    ),
  },
  {
    match: (id) => id === "event.v2-bridge",
    rules: withReadOnlyRest(
      {},
      [notBody("promptSvc.promptOrSteer"), notBody("SessionV2.prompt"), notBody("events.publish")],
      "packages/core/src/event.ts",
    ),
  },

  // Desktop / lildax lifecycle entry points are spawner/sidecar launchers whose authority receiver
  // is an external process that is NOT statically bound to them at this freeze point (NEW-P2-C).
  // They are intentionally left UNCLASSIFIED (never guessed read_only / legacy).

  // ===========================================================================
  // Tools & Provider & Recovery planes (single authoritative dimension; rest read_only)
  // ===========================================================================
  // RI-71 W4: the dac tool registry captures SessionV2 and the V2 owner-qualification state;
  // it materializes tools per Location through the V2 frame (W1.x evidence). Its reach to
  // prompt.ts is through the shared graph, not a legacy registration path.
  {
    match: (id) => id === "tools.dacode-registry",
    rules: withReadOnlyRest(
      { provider_tool_writer: adapter([{ kind: "productionProfile" }, V2_SESSION_CORE, V2_TOOL_REGISTRY]) },
      [notBody("promptSvc.promptOrSteer"), notBody("SessionV2.prompt"), notBody("events.publish")],
      "packages/core/src/tool/registry.ts",
    ),
  },
  {
    match: (id) => id === "tools.v2-registry",
    rules: withReadOnlyRest(
      { provider_tool_writer: v2([V2_TOOL_REGISTRY, call("register", "packages/core/src/tool/registry.ts")]) },
      [notBody("promptSvc.promptOrSteer"), notBody("SessionV2.prompt"), notBody("events.publish")],
      "packages/core/src/session/schema.ts",
    ),
  },
  {
    match: (id) => id.startsWith("provider."),
    rules: withReadOnlyRest(
      { provider_tool_writer: readOnly(AUTHORITY_WRITERS.map(noReachPath)) },
      [notBody("promptSvc.promptOrSteer"), notBody("SessionV2.prompt"), notBody("events.publish")],
      "packages/core/src/session/schema.ts",
    ),
  },
  {
    match: (id) => id === "recovery.database-binding",
    rules: withReadOnlyRest(
      { recovery_owner: readOnly([RECOVERY_BINDING]) },
      [notBody("promptSvc.promptOrSteer"), notBody("SessionV2.prompt"), notBody("events.publish")],
      "packages/core/src/database/recovery-binding.ts",
    ),
  },
  {
    match: (id) => id === "recovery.session-execution-restart",
    rules: withReadOnlyRest(
      { recovery_owner: v2([{ kind: "reach", pathSuffix: AUTHORITY.V2_EXECUTION_RESTART }]) },
      [notBody("promptSvc.promptOrSteer"), notBody("SessionV2.prompt"), notBody("events.publish")],
      "packages/core/src/session/execution/local.ts",
    ),
  },
  {
    // RI-71 zero wave: the V1 task-recovery tool resolves runs whose settlements carry the
    // durable V2 task-run receipts (the task-run module records them — verified reach), and the
    // tool itself is excluded from the V2 face (RI-113 deferred list): under the production
    // profile no session materializes it. Its recovery reach never touches the legacy prompt.
    match: (id) => id === "recovery.task-recovery-tool",
    rules: withReadOnlyRest(
      {
        recovery_owner: adapter([
          { kind: "productionProfile" },
          { kind: "reach", pathSuffix: "packages/deepagent-code/src/tool/task-run.ts" },
          { kind: "reach", pathSuffix: "packages/core/src/session/runner/v2-task-run-receipt.ts" },
        ]),
      },
      [notBody("promptSvc.promptOrSteer"), notBody("SessionV2.prompt"), notBody("events.publish")],
      "packages/deepagent-code/src/tool/task_recovery.ts",
    ),
  },
  {
    match: (id) => id === "recovery.provider-owner-runtime",
    rules: withReadOnlyRest(
      {
        recovery_owner: adapter([
          { kind: "reach", pathSuffix: "packages/deepagent-code/src/context-federation/provider-owner-runtime.ts" },
        ]),
      },
      [notBody("promptSvc.promptOrSteer"), notBody("SessionV2.prompt"), notBody("events.publish")],
      "packages/deepagent-code/src/context-federation/query-authorization.ts",
    ),
  },
]
