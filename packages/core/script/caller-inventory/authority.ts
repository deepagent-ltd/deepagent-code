/**
 * C0-01 authority module anchors.
 *
 * Each constant is the normalized repo-relative path suffix of the production module
 * that is the single-authority owner (or the bridge/adapter) for one design.md §2.1
 * dimension, at this 2.0.0-alpha.0 freeze point. Rules reference these so the honest
 * "legacy / v2 / adapter / read_only / double_write" verdicts are always backed by a
 * reachable-module fact, never by assumption.
 */
export const AUTHORITY = {
  /** Legacy SessionPrompt pipeline — the execution/admission authority for most surfaces today. */
  LEGACY_PROMPT: "packages/deepagent-code/src/session/prompt.ts",
  /** Core legacy SessionPrompt service definition (the authoritative legacy prompt module). */
  LEGACY_PROMPT_CORE: "packages/core/src/session/prompt.ts",
  /** Core Session service — the low-level legacy session authority used by the old server path. */
  LEGACY_SESSION_CORE: "packages/core/src/session.ts",
  /** Legacy GlobalBus event channel (deepagent-code). */
  LEGACY_GLOBAL_BUS: "packages/deepagent-code/src/bus/global.ts",
  /** Core DeepAgent goal loop — the legacy goal authority. */
  GOAL_LOOP: "packages/core/src/deepagent/goal-loop.ts",
  /** Legacy explicit provider resolution (prepared attempt / model route). */
  LEGACY_PROVIDER_RESOLUTION: "packages/deepagent-code/src/session/legacy-provider-resolution.ts",
  /** V2 SessionExecution local coordinator — the V2 execution authority. */
  V2_EXECUTION_LOCAL: "packages/core/src/session/execution/local.ts",
  /** V2 SessionExecution restart/recovery service. */
  V2_EXECUTION_RESTART: "packages/core/src/session/execution/restart.ts",
  /** V2 ToolRegistry register/materialize — the provider/tool-effect writer. */
  V2_TOOL_REGISTRY: "packages/core/src/tool/registry.ts",
  /** V2 durable DeepAgent event bus. */
  V2_EVENT_BUS: "packages/core/src/deepagent/deepagent-event-bus.ts",
  /** V2 event router. */
  V2_EVENT_ROUTER: "packages/core/src/deepagent/event-router.ts",
  /** EventV2 <-> legacy GlobalBus bridge (double-write producer/consumer). */
  EVENT_V2_BRIDGE: "packages/deepagent-code/src/event-v2-bridge.ts",
  /** Per-session EventV2 aggregate journal projection. */
  PROJECTOR: "packages/core/src/session/projector.ts",
  /** Database recovery binding (read-only classifier / replay authority). */
  RECOVERY_BINDING: "packages/core/src/database/recovery-binding.ts",
  /** Goal manager daemon / legacy goal pipeline. */
  GOAL_MANAGER: "packages/deepagent-code/src/session/goal-manager.ts",
  /** Goal tick consumer (event-driven goal daemon). */
  GOAL_TICK_CONSUMER: "packages/deepagent-code/src/session/goal-tick-consumer.ts",
  /** Legacy event canonicalizer runtime daemon. */
  LEGACY_CANONICALIZER: "packages/deepagent-code/src/legacy-event-canonicalizer-runtime.ts",
  /** Panel orchestrator / legacy panel pipeline. */
  PANEL_ORCHESTRATOR: "packages/deepagent-code/src/panel/orchestrator.ts",
  /** IM server-side agent executor. */
  IM_AGENT_EXECUTOR: "packages/deepagent-code/src/im/agent-executor-server.ts",
  /** Core session_input admission schema. */
  V2_SESSION_INPUT: "packages/core/src/session/input.ts",
  /** Core session V2 public exports. */
  V2_SESSION_PUBLIC: "packages/core/src/public/session.ts",
  /** dacode composition root. */
  DACODE_INDEX: "packages/deepagent-code/src/index.ts",
} as const

/** Normalized suffix matcher used by rules that need a path ending test. */
export function endsWithPathSuffix(path: string, suffix: string): boolean {
  return path.replaceAll("\\", "/").endsWith(suffix)
}

/**
 * Production delegation model (C0-01 residual closure). A `delegatesTo` requirement is
 * satisfied when the entry statically reaches, spawns, or client-calls a receiver whose
 * spawn/client target resolves (via the tables below) to an inventory entry id, AND that
 * target is classified non-unclassified on every inherited dimension (checked in build).
 */
/** Receiver entry id -> the module path that owns/provides the delegated authority. */
export const DELEGATION_TARGET_MODULE: Readonly<Record<string, string>> = {
  "composition.dacode-cli-entry": "packages/deepagent-code/src/index.ts",
  "composition.instance-httpapi-stack": "packages/deepagent-code/src/server/routes/instance/httpapi/server.ts",
  "composition.server-web-handler": "packages/server/src/routes.ts",
  "composition.lildax-runtime": "packages/cli/src/index.ts",
  "composition.app-runtime-layers": "packages/deepagent-code/src/effect/app-runtime.ts",
  "im.agent-executor": "packages/deepagent-code/src/im/agent-executor-server.ts",
  "panel.orchestrator": "packages/deepagent-code/src/panel/orchestrator.ts",
  "event.panel-convene-consumer": "packages/deepagent-code/src/panel/panel-convene-consumer.ts",
  "event.goal-tick-consumer": "packages/deepagent-code/src/session/goal-tick-consumer.ts",
  "task.goal-manager": "packages/deepagent-code/src/session/goal-manager.ts",
}
/** Dispatched inventory entry id -> referenced in spawned/sidecar launcher entry id. */
export const DELEGATION_TARGET_ENTRY: Readonly<Record<string, string>> = {
  "composition.dacode-cli-entry": "desktop.app-main",
}
/** Spawn/fork/exec or client-call string-literal target -> inventory entry id (process/CLI boundary). */
export const DELEGATION_SPAWN_BINDINGS: Readonly<Record<string, string>> = {
  // Desktop sidecar process forks sidecar.js, which loads the dacode server (dacode-cli-entry).
  "sidecar.js": "composition.dacode-cli-entry",
  "deepagent-code": "composition.dacode-cli-entry",
  "virtual:deepagent-code-server": "composition.dacode-cli-entry",
  // lildax daemon: DEEPAGENT_CODE_DAEMON_BACKEND=legacy mounts the legacy deepagent-code server;
  // the daemon (composition.lildax-runtime) is the authority receiver for client/daemon commands.
}

/** A module the entry reaches/uses that owns/refers the delegated authority -> target entry id. */
export const DELEGATION_REFERENCE_MODULE: Readonly<Record<string, string>> = {
  // lildax CLI commands drive the daemon through the Daemon service, which manages the daemon runtime.
  "packages/cli/src/services/daemon.ts": "composition.lildax-runtime",
  // IM orchestration runs under the legacy AgentExecutor service provided by the server composition.
  "packages/deepagent-code/src/session/legacy-execution-zero.ts": "im.agent-executor",
  "packages/desktop/src/main/server.ts": "desktop.spawn-local-server",
  "packages/desktop/src/main/wsl/runtime.ts": "composition.dacode-cli-entry",
  "packages/deepagent-code/src/im/agent-reply-sink-server.ts": "im.agent-executor",
  "packages/deepagent-code/src/panel/orchestrator.ts": "im.agent-executor",
  "packages/deepagent-code/src/panel/arbiter.ts": "im.agent-executor",
}

/**
 * Effect service-layer port bindings (DI resolution, static code). Each port module's service
 * has exactly ONE canonical production provider: a Layer.effect/sync in providerModule that
 * provides the port service, plus a production composition module that imports/provides that
 * layer (so test-only layers never count). providerEntryId is the inventoried authority entry
 * whose repoFile is providerModule and whose verdict the consumer inherits (portBound).
 */
export const PORTS: Readonly<Record<string, { service: string; providerModule: string; providerEntryId: string; compositionModule: string }>> = {
  "packages/core/src/im/agent-executor.ts": {
    service: "AgentExecutorService",
    providerModule: "packages/deepagent-code/src/im/agent-executor-server.ts",
    providerEntryId: "im.agent-executor",
    compositionModule: "packages/deepagent-code/src/server/routes/instance/httpapi/server.ts",
  },
  "packages/core/src/im/agent-reply-sink.ts": {
    service: "AgentReplySinkService",
    providerModule: "packages/deepagent-code/src/im/agent-executor-server.ts",
    providerEntryId: "im.agent-executor",
    compositionModule: "packages/deepagent-code/src/server/routes/instance/httpapi/server.ts",
  },
}