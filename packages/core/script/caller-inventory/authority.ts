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
