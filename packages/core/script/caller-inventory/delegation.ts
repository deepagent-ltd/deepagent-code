/**
 * C0-01 delegation rule packs (production-grade closure of the 21-entry residual).
 *
 * These entries delegate authority to a statically-provable receiver entry (spawn/fork process,
 * service-layer binding, client call, or reach-of-target-module). Each dimension carries a
 * `delegatesTo` requirement verified by graph.ts against the real AST; build.ts pass-2 inherits the
 * TARGET entry's verdict on that dimension (never a guessed category). The placeholder verdict is
 * overwritten by the target's classification and is never used as a guess.
 */
import type { Dimension, Requirement, Verdict } from "./types"
import { DIMENSIONS } from "./types"
import type { EntryRules, RulePack, VerdictRule } from "./rules"

const NOT_WRITE: readonly Requirement[] = [
  { kind: "noBodyChain", chain: "promptSvc.promptOrSteer" },
  { kind: "noBodyChain", chain: "SessionV2.prompt" },
  { kind: "noBodyChain", chain: "events.publish" },
  { kind: "noBodyChain", chain: "EventV2.Cursor" },
]

function del(targetId: string): VerdictRule {
  return { verdict: "legacy", requirements: [{ kind: "delegatesTo", targetId }] }
}
// An EntryRules where EVERY dimension delegates to targetId (placeholder verdict overwritten in pass 2).
function delAll(targetId: string): EntryRules {
  const reqs: readonly Requirement[] = [{ kind: "delegatesTo", targetId }]
  const result: Record<Dimension, VerdictRule> = {} as Record<Dimension, VerdictRule>
  for (const dimension of DIMENSIONS) result[dimension] = { verdict: "legacy", requirements: reqs }
  return result as EntryRules
}

function portAll(portModule: string): EntryRules {
  const reqs: readonly Requirement[] = [{ kind: "portBoundTo", portModule }]
  const result: Record<Dimension, VerdictRule> = {} as Record<Dimension, VerdictRule>
  for (const dimension of DIMENSIONS) result[dimension] = { verdict: "legacy", requirements: reqs }
  return result as EntryRules
}

export const DELEGATION_RULE_PACKS: readonly RulePack[] = [
  // ---- DI/service-layer orchestrators bound to their canonical Effect port provider (legacy IM). ----
  {
    match: (id) => id === "im.agent-orchestrator",
    rules: portAll("packages/core/src/im/agent-executor.ts"),
  },
  {
    // The reply sink is part of the legacy IM pipeline, wired in the server composition alongside the
    // legacy AgentExecutor (ServerAgentReplySinkLive providing AgentReplySinkService); it inherits the
    // legacy IM pipeline's verdict via the reference binding to im.agent-executor.
    match: (id) => id === "im.agent-reply-sink",
    rules: delAll("im.agent-executor"),
  },
  // Panel orchestration is part of the legacy panel pipeline; it orchestrates agent executions via the
  // legacy agent executor, and the arbiter is the panel verdict engine — both inherit legacy authority.
  {
    match: (id) => id === "panel.orchestrator" || id === "panel.arbiter",
    rules: delAll("im.agent-executor"),
  },
  // ---- Spawner/sidecar launchers: their subprocess runs the dacode server (dacode-cli-entry). ----
  {
    match: (id) =>
      id === "desktop.spawn-local-server" || id === "desktop.sidecar-server-listen" ||
      id === "desktop.wsl-sidecar" || id === "composition.desktop-sidecar-start",
    rules: delAll("composition.dacode-cli-entry"),
  },
  {
    match: (id) => id === "desktop.app-main",
    rules: delAll("desktop.spawn-local-server"),
  },
  {
    match: (id) => id === "desktop.check-health",
    rules: {
      admission_owner: del("composition.dacode-cli-entry"),
      execution_owner: del("composition.dacode-cli-entry"),
      context_writer: del("composition.dacode-cli-entry"),
      provider_tool_writer: del("composition.dacode-cli-entry"),
      event_producer_consumer: del("composition.dacode-cli-entry"),
      projector: del("composition.dacode-cli-entry"),
      recovery_owner: del("composition.dacode-cli-entry"),
    },
  },
  // ---- lildax daemon/client commands: their transport reaches the lildax daemon runtime. ----
  {
    match: (id) =>
      id === "cli.lildax.service.start" || id === "cli.lildax.service.restart" ||
      id === "cli.lildax.service.stop" || id === "cli.lildax.service.status" ||
      id === "cli.lildax.service.password" || id === "cli.lildax.login" ||
      id === "cli.lildax.logout" || id === "cli.lildax.workspace.list" ||
      id === "cli.lildax.workspace.use" || id === "cli.lildax.debug.agents" ||
      id === "cli.lildax.migrate",
    rules: delAll("composition.lildax-runtime"),
  },
  // ---- DI/service-layer orchestrators: the production composition provides the executor / panel. ----
  {
    match: (id) => id === "im.agent-orchestrator" || id === "im.agent-reply-sink",
    rules: delAll("im.agent-executor"),
  },
  // panel.arbiter / panel.orchestrator resolve their authority through DI/panel service-layer
  // binding that is not statically reachable at this freeze point; they are intentionally left
  // UNCLASSIFIED (never delegated to an unclassified/self target, never a guessed verdict).
];
