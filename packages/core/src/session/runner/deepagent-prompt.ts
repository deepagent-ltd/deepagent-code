import os from "node:os"
import type { ToolDefinition } from "@deepagent-code/llm"
import { Effect } from "effect"
import { AgentGateway } from "../../agent-gateway"
import { Git } from "../../git"
import { AbsolutePath } from "../../schema"
import type { SessionMessage } from "../message"
import { BuiltInTools } from "../../tool/builtins"

export type Input = {
  readonly sessionID: string
  readonly userMessageID: string
  readonly providerID: string
  readonly directory: string
  readonly messages: readonly SessionMessage.Message[]
  readonly tools: readonly ToolDefinition[]
  readonly git?: Git.Interface
}

export const buildDeepAgentPrompt = Effect.fn("SessionRunner.buildDeepAgentPrompt")(function* (input: Input) {
  const mode = AgentGateway.snapshot().agentMode
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
  AgentGateway.DeepAgentOrchestrator.initSession(orchestratorInput)
  if (latestUser?.id === input.userMessageID) {
    const observation = AgentGateway.DeepAgentSessionState.observeUserAdmission(input.sessionID, input.userMessageID)
    if (observation === "new") AgentGateway.DeepAgentSessionState.markPlanStale(input.sessionID, "user_appended")
  }
  const context = AgentGateway.DeepAgentOrchestrator.buildPromptContext(orchestratorInput)
  const latest = input.messages.at(-1)
  const continuation =
    latest?.type === "assistant" &&
    latest.content.some(
      (part) => part.type === "tool" && (part.state.status === "completed" || part.state.status === "error"),
    )
  const plan = yield* Effect.sync(() => {
    const current = AgentGateway.DeepAgentPlanStore.getPlanDoc(input.sessionID)
    const ref = AgentGateway.DeepAgentPlanStore.planDocRef(input.sessionID)
    if (!current || !ref) return undefined
    return AgentGateway.DeepAgentPlanController.renderPlanWriteContext(
      current,
      ref.version,
      continuation ? "continuation" : "full",
    )
  }).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
  return {
    context,
    stableSystemParts: AgentGateway.systemPrompt(input.providerID, context),
    volatileRoundContext: continuation
      ? AgentGateway.volatileContinuationContext(plan)
      : AgentGateway.volatileRoundContext(context, plan),
  }
})
