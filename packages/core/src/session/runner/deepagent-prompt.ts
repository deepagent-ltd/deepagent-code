import os from "node:os"
import type { ToolDefinition } from "@deepagent-code/llm"
import { Effect } from "effect"
import { AgentGateway } from "../../agent-gateway"
import { Git } from "../../git"
import { AbsolutePath } from "../../schema"
import { ModelPromptProfile } from "../../deepagent/model-prompt-profile"
import type { SessionMessage } from "../message"
import { BuiltInTools } from "../../tool/builtins"

export type Input = {
  readonly runtime: AgentGateway.RuntimeInterface
  readonly sessionID: string
  readonly userMessageID: string
  readonly providerID: string
  readonly modelID: string
  readonly directory: string
  readonly messages: readonly SessionMessage.Message[]
  readonly tools: readonly ToolDefinition[]
  readonly validationCommands?: readonly string[]
  readonly git?: Git.Interface
}

export const buildDeepAgentPrompt = Effect.fn("SessionRunner.buildDeepAgentPrompt")(function* (input: Input) {
  const mode = input.runtime.snapshot.agentMode
  const latestUser = input.messages.findLast((message) => message.type === "user")
  const repo = input.git ? yield* input.git.find(AbsolutePath.make(input.directory)) : undefined
  const branch = repo && input.git ? yield* input.git.branch(repo.directory) : undefined
  const toolRefs = input.tools.map((tool) => ({
    name: tool.name,
    source: BuiltInTools.builtinToolNames.has(tool.name) ? ("builtin" as const) : ("custom" as const),
    description: tool.description,
  }))
  const orchestratorInput: AgentGateway.OrchestratorInput = {
    sessionId: input.sessionID,
    mode,
    environment: {
      os: process.platform === "darwin" ? "macOS" : process.platform === "win32" ? "Windows" : "Linux",
      shell: process.env.SHELL ?? "unknown",
      cwd: input.directory,
      homedir: os.homedir(),
      gitBranch: branch ?? null,
      gitRoot: repo?.directory ?? null,
      isGitRepo: repo !== undefined,
      date: new Date().toISOString().slice(0, 10),
      platform: process.platform,
    },
    tools: { availableTools: toolRefs, mcpServers: [], totalToolCount: toolRefs.length },
    userRequest: latestUser?.text ?? null,
    workspacePath: input.directory,
  }
  const latest = input.messages.at(-1)
  const continuation =
    latest?.type === "assistant" &&
    latest.content.some(
      (part) => part.type === "tool" && (part.state.status === "completed" || part.state.status === "error"),
    )
  const context = input.runtime.withStorage(() => {
    AgentGateway.DeepAgentOrchestrator.initSession(orchestratorInput)
    if (input.validationCommands?.length)
      AgentGateway.DeepAgentOrchestrator.setValidationCommands(input.sessionID, [...input.validationCommands])
    if (latestUser?.id === input.userMessageID) {
      const observation = AgentGateway.DeepAgentSessionState.observeUserAdmission(input.sessionID, input.userMessageID)
      if (observation === "new") AgentGateway.DeepAgentSessionState.markPlanStale(input.sessionID, "user_appended")
    }
    return AgentGateway.DeepAgentOrchestrator.buildPromptContext(orchestratorInput)
  })
  const plan = yield* Effect.sync(() =>
    input.runtime.withStorage(() => {
      const current = AgentGateway.DeepAgentPlanStore.getPlanDoc(input.sessionID)
      const ref = AgentGateway.DeepAgentPlanStore.planDocRef(input.sessionID)
      if (!current || !ref) return undefined
      return AgentGateway.DeepAgentPlanController.renderPlanWriteContext(
        current,
        ref.version,
        continuation ? "continuation" : "full",
      )
    }),
  ).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
  const profile = ModelPromptProfile.profileFor(input.providerID, input.modelID)
  // G3 model profile channel 2 (event-triggered): validation_failed fires ONLY when the round
  // context carries a failed validation — the short repair directive rides the volatile tail,
  // never the cached prefix.
  const validationFailed =
    context.previousResults?.validationOutput != null &&
    !context.previousResults.lastCandidate?.status.includes("passed")
  const eventPrompt =
    validationFailed && !continuation ? ModelPromptProfile.eventPrompt(profile, "validation_failed") : undefined
  const roundContext = continuation
    ? input.runtime.volatileContinuationContext(plan)
    : input.runtime.volatileRoundContext(context, plan)
  return {
    context,
    // Channel 1 (stable short constraint): provider+model keyed ⇒ session-constant ⇒ cache-safe.
    stableSystemParts: [
      ...input.runtime.systemPrompt(input.providerID, context),
      ...(profile.stableConstraint.trim().length > 0 ? [profile.stableConstraint] : []),
    ],
    volatileRoundContext: eventPrompt ? `${roundContext}\n${eventPrompt}` : roundContext,
  }
})

// V1 parity fallback (session/llm/request.ts non-managed branch): a governed turn must see the
// authoritative plan write precondition even when the gateway runtime is enabled but NOT
// model-managed (e.g. agentMode "general" — `runtime.active` is false and buildDeepAgentPrompt is
// skipped). This covers every non-compaction agent, not only the goal-worker: the V2 plan gate
// forces a seeded session's plan to "high" regardless of agent, and without the precondition the
// plan tool's advance cannot supply the exact expected_plan_id/expected_version. Returns undefined
// when the session has no committed plan — nothing to inject.
export const buildGovernedPlanContext = (input: {
  readonly runtime: AgentGateway.RuntimeInterface
  readonly sessionID: string
  readonly messages: readonly SessionMessage.Message[]
}): string | undefined =>
  input.runtime.withStorage(() => {
    const current = AgentGateway.DeepAgentPlanStore.getPlanDoc(input.sessionID)
    const ref = AgentGateway.DeepAgentPlanStore.planDocRef(input.sessionID)
    if (!current || !ref) return undefined
    const latest = input.messages.at(-1)
    const continuation =
      latest?.type === "assistant" &&
      latest.content.some(
        (part) => part.type === "tool" && (part.state.status === "completed" || part.state.status === "error"),
      )
    const snapshot = AgentGateway.DeepAgentPlanController.renderPlanWriteContext(
      current,
      ref.version,
      continuation ? "continuation" : "full",
    )
    return AgentGateway.volatilePlanContext(`<plan-status>\n${snapshot}\n</plan-status>`)
  })
