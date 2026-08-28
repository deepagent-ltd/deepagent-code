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

// All-seven read_only with the given (genuine-positive + absence) requirements.
function readOnlyWith(reqs: readonly Requirement[]): EntryRules {
  const result: Record<Dimension, VerdictRule> = {} as Record<Dimension, VerdictRule>
  for (const dimension of DIMENSIONS) result[dimension] = { verdict: "read_only", requirements: reqs }
  return result as EntryRules
}

export const DELEGATION_RULE_PACKS: readonly RulePack[] = [
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
  // ---- lildax daemon-CLIENT commands: their handler performs a daemon client invocation (call-site). ----
  {
    match: (id) =>
      id === "cli.lildax.service.start" || id === "cli.lildax.service.restart" ||
      id === "cli.lildax.service.stop" || id === "cli.lildax.service.status" ||
      id === "cli.lildax.service.password" || id === "cli.lildax.debug.agents",
    rules: delAll("composition.lildax-runtime"),
  },
  // ---- lildax EXTERNAL-gateway commands: the local flow is fully characterized (a remote gateway
  // client via ServerMode.Service -> DEEPAGENT_GATEWAY_URL / /control/v1/*, which has NO production
  // route registration in this tree). The authority receiver is external by scope -> read_only, with
  // the real gateway client call site as positive evidence; external_receiver annotation records it.
  {
    match: (id) =>
      id === "cli.lildax.login" || id === "cli.lildax.logout" ||
      id === "cli.lildax.workspace.list" || id === "cli.lildax.workspace.use",
    rules: readOnlyWith([
      { kind: "reach", pathSuffix: "packages/cli/src/services/server-mode.ts" },
      ...NOT_WRITE,
    ]),
  },
  // ---- lildax migrate: a NO-OP lifecycle command (body is only Effect.log); machine-checked by
  // bodyLogsOnly, documented as no-authority, classified read_only (never delegated, never a guess).
  {
    match: (id) => id === "cli.lildax.migrate",
    rules: readOnlyWith([{ kind: "bodyLogsOnly" }, ...NOT_WRITE]),
  },
  // ---- IM DI orchestrators bound to their canonical Effect port provider (legacy IM pipeline). ----
  {
    match: (id) => id === "im.agent-orchestrator",
    rules: portAll("packages/core/src/im/agent-executor.ts"),
  },
  {
    match: (id) => id === "im.agent-reply-sink",
    rules: portAll("packages/core/src/im/agent-reply-sink.ts"),
  },
  // ---- Panel orchestration: the panelist runner (runPanelist) and verdict engine (arbitrate) run
  // within the legacy agent/panel pipeline — proven by the real call-path (bound client invocation).
  {
    // panel.orchestrator is a functional panel engine: it orchestrates panelist runs via an INJECTED
    // runPanelist function (the panelist/subagent runner is bound by the caller, not statically to this
    // module), and it reads panel config/schema. Its authority is the caller-injected subagent run, so
    // it is read_only with the panel schema as genuine reader (never guessed legacy, never delegated to
    // an unbound receiver).
    match: (id) => id === "panel.orchestrator" || id === "panel.arbiter",
    rules: readOnlyWith([
      { kind: "reach", pathSuffix: "packages/deepagent-code/src/agent/schema/panel.ts" },
      ...NOT_WRITE,
    ]),
  },
];
