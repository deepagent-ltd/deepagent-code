import { PermissionV1 } from "@deepagent-code/core/v1/permission"
import type { Auth } from "@/auth"
import { SessionV1 } from "@deepagent-code/core/v1/session"
import type { RuntimeFlags } from "@/effect/runtime-flags"
import { InstanceState } from "@/effect/instance-state"
import { Permission } from "@/permission"
import type { Agent } from "@/agent/agent"
import type { MessageV2 } from "../message-v2"
import type { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { SystemPrompt } from "../system"
import { InstallationVersion } from "@deepagent-code/core/installation/version"
import { AgentGateway } from "@deepagent-code/core/agent-gateway"
import { Effect, Exit, Record } from "effect"
import os from "node:os"
import { writeFile, mkdir } from "node:fs/promises"
import path from "node:path"
import { DeepAgentWorkspace } from "@/deepagent/workspace-context"
import { ToolProvenance } from "@/tool/provenance"

type PromptContext = AgentGateway.PromptContext
type EnvironmentContext = AgentGateway.EnvironmentContext
type ToolRef = AgentGateway.ToolRef
type McpServerRef = AgentGateway.McpServerRef
import { jsonSchema, tool as aiTool, type ModelMessage, type Tool } from "ai"
import type { Plugin } from "@/plugin"
import { mergeDeep } from "remeda"

const USER_AGENT = `deepagent-code/${InstallationVersion}`

type PrepareInput = {
  readonly user: SessionV1.User
  readonly sessionID: string
  readonly parentSessionID?: string
  readonly model: Provider.Model
  readonly agent: Agent.Info
  readonly permission?: PermissionV1.Ruleset
  readonly system: string[]
  readonly messages: ModelMessage[]
  readonly small?: boolean
  readonly tools: Record<string, Tool>
  readonly provider: Provider.Info
  readonly auth: Auth.Info | undefined
  readonly plugin: Plugin.Interface
  readonly flags: RuntimeFlags.Info
  readonly isWorkflow: boolean
}

export type Prepared = {
  readonly system: string[]
  readonly messages: ModelMessage[]
  readonly tools: Record<string, Tool>
  readonly metadata: Record<string, unknown>
  readonly params: {
    readonly temperature?: number
    readonly topP?: number
    readonly topK?: number
    readonly maxOutputTokens?: number
    readonly options: Record<string, any>
  }
  readonly messageTransformOptions: Record<string, any>
  readonly headers: Record<string, string>
}

const mergeOptions = (target: Record<string, any>, source: Record<string, any> | undefined): Record<string, any> =>
  mergeDeep(target, source ?? {}) as Record<string, any>

const stripInternalOptions = (options: Record<string, any>) => {
  const result = { ...options }
  delete result.authProviderID
  delete result.upstreamProviderID
  return result
}

export const prepare = Effect.fn("LLMRequestPrep.prepare")(function* (input: PrepareInput) {
  const isOpenaiOauth = input.provider.id === "openai" && input.auth?.type === "oauth"
  // V3.1 global runtime: the DeepAgent system prompt is strength-driven (high/max), not
  // provider-scoped. It applies to every upstream provider; `general` keeps the inherited
  // (opencode) baseline prompt untouched.
  const agentMode = deepAgentAgentModeOverride(input.user.metadata) ?? AgentGateway.snapshot().agentMode
  const isDeepAgentActive = AgentGateway.snapshot().mode === "enabled" && agentMode !== "general"
  let system: string[]

  if (isDeepAgentActive) {
    const promptContext = yield* buildDeepAgentPromptContext(input, agentMode)
    const deepagentSystem = AgentGateway.systemPrompt(input.model.providerID, promptContext)
    system = [deepagentSystem.filter((x) => x).join("\n")]
    logPrompt(input.sessionID, promptContext.round, system[0]).catch(() => {})
  } else {
    const baseAgentSystem = input.agent.prompt ? [input.agent.prompt] : SystemPrompt.provider(input.model)
    const runtimeSystem = input.system
    system = [
      [...baseAgentSystem, ...runtimeSystem, ...(input.user.system ? [input.user.system] : [])]
        .filter((x) => x)
        .join("\n"),
    ]
  }

  const header = system[0]
  yield* input.plugin.trigger(
    "experimental.chat.system.transform",
    { sessionID: input.sessionID, model: input.model },
    { system },
  )
  if (system.length > 2 && system[0] === header) {
    const rest = system.slice(1)
    system.length = 0
    system.push(header, rest.join("\n"))
  }

  const variant =
    !input.small && input.model.variants && input.user.model.variant
      ? input.model.variants[input.user.model.variant]
      : {}
  const base = input.small
    ? ProviderTransform.smallOptions(input.model)
    : ProviderTransform.options({
        model: input.model,
        sessionID: input.sessionID,
        providerOptions: input.provider.options,
      })
  const options = stripInternalOptions(
    mergeOptions(mergeOptions(mergeOptions(base, input.model.options), input.agent.options), variant),
  )
  if (
    input.model.api.npm === "@ai-sdk/azure" &&
    (input.provider.options.useCompletionUrls || input.model.options.useCompletionUrls || options.useCompletionUrls)
  ) {
    delete options.reasoningSummary
    delete options.include
  }
  if (isOpenaiOauth) options.instructions = system.join("\n")

  const messages =
    isOpenaiOauth || input.isWorkflow
      ? input.messages
      : [
          ...system.map(
            (x): ModelMessage => ({
              role: "system",
              content: x,
            }),
          ),
          ...input.messages,
        ]

  const params = yield* input.plugin.trigger(
    "chat.params",
    {
      sessionID: input.sessionID,
      agent: input.agent.name,
      model: input.model,
      provider: input.provider,
      message: input.user,
    },
    {
      temperature: input.model.capabilities.temperature
        ? (input.agent.temperature ?? ProviderTransform.temperature(input.model))
        : undefined,
      topP: input.agent.topP ?? ProviderTransform.topP(input.model),
      topK: ProviderTransform.topK(input.model),
      maxOutputTokens: ProviderTransform.maxOutputTokens(input.model, input.flags.outputTokenMax),
      options,
    },
  )

  const { headers } = yield* input.plugin.trigger(
    "chat.headers",
    {
      sessionID: input.sessionID,
      agent: input.agent.name,
      model: input.model,
      provider: input.provider,
      message: input.user,
    },
    {
      headers: {},
    },
  )

  const tools = resolveTools(input)
  if (
    input.model.providerID.includes("github-copilot") &&
    Object.keys(tools).length === 0 &&
    hasToolCalls(input.messages)
  ) {
    // Copilot needs a tools field when replaying prior tool calls, even if no tools are currently enabled.
    tools["_noop"] = aiTool({
      description: "Do not call this tool. It exists only for API compatibility and must never be invoked.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          reason: { type: "string", description: "Unused" },
        },
      }),
      execute: async () => ({ output: "", title: "", metadata: {} }),
    })
  }

  const metadata = prepareMetadata(input, tools)

  const opencodeProjectID = input.model.providerID.startsWith("deepagent-code")
    ? (yield* InstanceState.context).project.id
    : undefined

  return {
    system,
    messages,
    tools: Object.fromEntries(Object.entries(tools).toSorted(([a], [b]) => a.localeCompare(b))),
    metadata,
    params,
    messageTransformOptions: options,
    headers: {
      ...(input.model.providerID.startsWith("deepagent-code")
        ? {
            ...(opencodeProjectID ? { "x-deepagent-code-project": opencodeProjectID } : {}),
            "x-deepagent-code-session": input.sessionID,
            "x-deepagent-code-request": input.user.id,
            "x-deepagent-code-client": input.flags.client,
            "User-Agent": USER_AGENT,
          }
        : {
            "x-session-affinity": input.sessionID,
            ...(input.parentSessionID ? { "x-parent-session-id": input.parentSessionID } : {}),
            "User-Agent": USER_AGENT,
          }),
      ...input.model.headers,
      ...headers,
    },
  }
})

const prepareMetadata = (input: PrepareInput, tools: Record<string, Tool>): Record<string, unknown> => {
  const agentMode = deepAgentAgentModeOverride(input.user.metadata)
  const deepagent =
    isRecord(input.user.metadata) && isRecord(input.user.metadata.deepagent) ? input.user.metadata.deepagent : {}
  const promptPipeline = isRecord(deepagent.prompt_pipeline) ? deepagent.prompt_pipeline : undefined
  const userRequest = extractLatestUserContent(input.messages)
  return {
    "deepagent-code": {
      callKind: "session_turn",
      feature: input.small ? "session_small_model" : "session_chat",
      sessionID: input.sessionID,
      messageID: input.user.id,
      parentSessionID: input.parentSessionID,
      agent: input.agent.name,
    },
    deepagent: {
      ...(agentMode ? { agent_mode_override: agentMode } : {}),
      ...(promptPipeline ? { prompt_pipeline: promptPipeline } : {}),
      ...(userRequest ? { user_request: userRequest } : {}),
      tool_capabilities: Object.entries(tools)
        .filter(([name]) => name !== "invalid")
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([name, t]) => ({
          name,
          // M2 (S1-v3.4): read explicit provenance instead of `name.includes(":")`.
          // Map back to the token the gateway's 5 hard-matches expect — do NOT
          // change the token itself (see request.ts/agent-gateway.ts).
          source: ToolProvenance.get(t)?.source === "mcp" ? "mcp_or_namespaced_tool" : "generic_agent_tool_registry",
          execution_owner: "generic_agent_tool_registry_or_mcp",
        })),
    },
  }
}

function resolveTools(input: Pick<PrepareInput, "tools" | "agent" | "permission" | "user">) {
  const disabled = Permission.disabled(
    Object.keys(input.tools),
    Permission.merge(input.agent.permission, input.permission ?? []),
  )
  return Record.filter(input.tools, (_, k) => input.user.tools?.[k] !== false && !disabled.has(k))
}

export function hasToolCalls(messages: ModelMessage[]): boolean {
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue
    for (const part of msg.content) {
      if (part.type === "tool-call" || part.type === "tool-result") return true
    }
  }
  return false
}

async function logPrompt(sessionId: string, round: number, prompt: string) {
  const dir = path.join(os.homedir(), ".deepagent", "code", "prompt-log")
  await mkdir(dir, { recursive: true })
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
  const filename = `${timestamp}_${sessionId.slice(0, 12)}_r${round}.md`
  await writeFile(path.join(dir, filename), prompt, "utf8")
}

const buildDeepAgentPromptContext = Effect.fn("LLMRequestPrep.buildDeepAgentPromptContext")(function* (
  input: PrepareInput,
  mode: AgentGateway.AgentMode,
) {
  const toolRefs: ToolRef[] = Object.entries(input.tools)
    .filter(([name]) => name !== "invalid")
    .map(([name, t]) => ({
      name,
      // M2 (S1-v3.4): read explicit provenance; preserve this exit's own token vocabulary.
      source: ToolProvenance.get(t)?.source === "mcp" ? ("mcp" as const) : ("builtin" as const),
      mcpServer: ToolProvenance.get(t)?.mcpServer,
    }))

  const mcpServers: McpServerRef[] = []
  const mcpNames = new Set<string>()
  for (const ref of toolRefs) {
    if (ref.source !== "mcp") continue
    // M2: server grouping comes from explicit provenance.mcpServer, not a name split.
    // Fall back to the tool name only if provenance somehow lacks a server.
    const serverName = ref.mcpServer ?? ref.name
    if (mcpNames.has(serverName)) continue
    mcpNames.add(serverName)
    mcpServers.push({
      name: serverName,
      toolCount: toolRefs.filter((t) => t.source === "mcp" && (t.mcpServer ?? t.name) === serverName).length,
    })
  }

  const ctx = yield* InstanceState.context.pipe(Effect.exit)
  const workspaceCwd = Exit.isSuccess(ctx) ? ctx.value.directory : process.cwd()

  const envCtx: EnvironmentContext = {
    os: process.platform === "darwin" ? "macOS" : process.platform === "win32" ? "Windows" : "Linux",
    shell: process.env.SHELL ?? "unknown",
    cwd: workspaceCwd,
    homedir: os.homedir(),
    gitBranch: process.env.GIT_BRANCH ?? null,
    gitRoot: process.env.GIT_ROOT ?? null,
    isGitRepo: Boolean(process.env.GIT_ROOT || process.env.GIT_BRANCH),
    date: new Date().toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" }),
    platform: process.platform,
  }

  const userRequest = extractLatestUserContent(input.messages)
  const previousValidationResults = extractValidationResults(input.messages)

  const workspaceInfo = yield* Effect.promise(() => DeepAgentWorkspace.detect(envCtx.cwd))
  const validationCommands = workspaceInfo.validationCommands

  const tools: AgentGateway.ToolContext = { availableTools: toolRefs, mcpServers, totalToolCount: toolRefs.length }

  const orchestratorInput: AgentGateway.OrchestratorInput = {
    sessionId: input.sessionID,
    mode,
    environment: envCtx,
    tools,
    userRequest,
    workspacePath: envCtx.cwd,
  }

  const sessionExistedBefore = AgentGateway.DeepAgentSessionState.get(input.sessionID) !== undefined
  AgentGateway.DeepAgentOrchestrator.initSession(orchestratorInput)

  if (validationCommands.length > 0) {
    AgentGateway.DeepAgentOrchestrator.setValidationCommands(input.sessionID, validationCommands)
  }

  if (previousValidationResults.length > 0) {
    const output = previousValidationResults.map((r) => `${r.command}: ${r.passed ? "PASS" : "FAIL"}`).join("\n")
    AgentGateway.DeepAgentSessionState.recordValidation(input.sessionID, previousValidationResults, output)
    AgentGateway.DeepAgentOrchestrator.processValidationResults(input.sessionID, previousValidationResults)
  } else if (deepAgentRoundControl(input.user.metadata) === "continue") {
    const state = AgentGateway.DeepAgentSessionState.get(input.sessionID)
    if (state) {
      AgentGateway.DeepAgentSessionState.advanceToNextRound(input.sessionID, "continue")
    }
  } else if (sessionExistedBefore) {
    // U1: a fresh user message on an already-running session (not a model-driven round continue) is
    // the "user appended a new instruction" signal — the existing plan may no longer match intent,
    // so flip the latch from this runtime fact rather than waiting for the model to notice.
    AgentGateway.DeepAgentSessionState.markPlanStale(input.sessionID, "user_appended")
  }

  const runtimeInstructions = [...input.system, ...(input.user.system ? [input.user.system] : [])]
    .map((item) => item.trim())
    .filter((item) => Boolean(item) && !/^You are deepagent-code/i.test(item) && !/interactive CLI tool/i.test(item))
  const context = AgentGateway.DeepAgentOrchestrator.buildPromptContext(orchestratorInput)
  return {
    ...context,
    userInstructions: runtimeInstructions.length ? runtimeInstructions.join("\n\n") : null,
  } as PromptContext
})

function extractLatestUserContent(messages: ModelMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role !== "user") continue
    if (typeof msg.content === "string") return msg.content
    if (Array.isArray(msg.content)) {
      const textParts = msg.content.filter((p): p is { type: "text"; text: string } => p.type === "text")
      if (textParts.length > 0) return textParts.map((p) => p.text).join("\n")
    }
    return null
  }
  return null
}

const deepAgentAgentModeOverride = (metadata: unknown): AgentGateway.AgentMode | undefined => {
  const deepagent = isRecord(metadata) && isRecord(metadata.deepagent) ? metadata.deepagent : {}
  return deepagent.agent_mode_override === "general" ? "general" : undefined
}

// T3 (S1-v3.4): round_control.action carries the microbatch triage action that was written onto an
// INJECTED turn. Only advance-trigger actions are ever emitted ({continue, revise, narrow}), each of
// which corresponds to a real turn, so all of them advance the round. Terminal outcomes (red /
// exhausted narrowing) inject no turn and surface via the macro-round needs_human suggestion instead,
// so they never reach here. The set guard also defends against any stray/unknown action value.
const ADVANCE_ACTIONS = new Set(["continue", "revise", "narrow"])
const deepAgentRoundControl = (metadata: unknown): "continue" | undefined => {
  const deepagent = isRecord(metadata) && isRecord(metadata.deepagent) ? metadata.deepagent : {}
  const control = isRecord(deepagent.round_control) ? deepagent.round_control : {}
  return typeof control.action === "string" && ADVANCE_ACTIONS.has(control.action) ? "continue" : undefined
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

function extractValidationResults(messages: ModelMessage[]): AgentGateway.ValidationResult[] {
  const results: AgentGateway.ValidationResult[] = []
  for (const msg of messages) {
    if (msg.role !== "tool") continue
    if (!Array.isArray(msg.content)) continue
    for (const part of msg.content) {
      if (!("type" in part) || part.type !== "tool-result") continue
      if (!("toolName" in part)) continue
      const toolName = (part as { toolName: string }).toolName
      if (!toolName.includes("shell") && !toolName.includes("bash") && !toolName.includes("exec")) continue
      const output =
        "output" in part &&
        part.output &&
        typeof part.output === "object" &&
        "type" in part.output &&
        part.output.type === "text"
          ? (part.output as { type: "text"; value: string }).value
          : ""
      if (!output) continue
      const hasValidationSignal =
        /exit\s*code\s*[:=]\s*\d+/i.test(output) || /\b(PASS|FAIL|passed|failed|error|Error)\b/.test(output)
      if (!hasValidationSignal) continue
      // T1 (S1-v3.4): recover the exit code from the tool output when present (e.g. "exit code: 127").
      // When an explicit code is present it is AUTHORITATIVE: derive `passed` from it so the
      // `passed === (exit_code === 0)` invariant (round-state.ts) holds even for outputs like
      // "Tests passed. exit code: 1". Only when no code is present do we fall back to the PASS/FAIL text.
      const exitMatch = output.match(/exit\s*code\s*[:=]\s*(\d+)/i)
      const textPassed = /\bPASS(ED)?\b/i.test(output) && !/\bFAIL(ED)?\b/i.test(output)
      const exit_code = exitMatch ? Number(exitMatch[1]) : textPassed ? 0 : 1
      const passed = exit_code === 0
      results.push({ command: toolName, passed, exit_code, output: output.slice(0, 2000), duration_ms: 0 })
    }
  }
  return results
}

export * as LLMRequestPrep from "./request"
