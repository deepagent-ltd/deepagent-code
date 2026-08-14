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
import { modeRank } from "@deepagent-code/core/deepagent/mode"
import { buildOrchestrationSection, type OrchestrationCaps } from "@deepagent-code/core/deepagent/orchestration"
import { Effect, Exit, Record } from "effect"
import os from "node:os"
import { writeFile, mkdir } from "node:fs/promises"
import { createHash, createHmac, randomBytes } from "node:crypto"
import path from "node:path"
import { Log } from "@deepagent-code/core/util/log"
import { DeepAgentWorkspace } from "@/deepagent/workspace-context"
import { ToolProvenance } from "@/tool/provenance"
import { ToolInternal } from "@/tool/internal"
import { SessionReminders } from "../reminders"
import { ContextFederationObservability } from "@/context-federation/observability"
import { GlobalBus } from "@/bus/global"
import { Global } from "@deepagent-code/core/global"
import type { DocumentRef, Selection } from "@deepagent-code/core/deepagent/released-snapshot"
import { PreparedProviderTurn } from "@deepagent-code/core/session/runner/prepared-provider-turn"

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
  readonly runtimeTail?: string
  readonly federatedProjection?: boolean
  readonly federatedShadow?: Readonly<Record<"code" | "knowledge" | "memory" | "documents", number>>
  readonly releasedKnowledgeSelection?: Selection
  // §5b: configurable orchestration caps (from config.experimental.orchestration). Unset ⇒ lenient
  // defaults. Only used to surface the concrete per-round concurrency number in the advisory prompt;
  // the hard code-layer cap is enforced by the §5a semaphore in task.ts.
  readonly orchestrationCaps?: OrchestrationCaps
}

export type Prepared = {
  readonly system: string[]
  readonly stableSystemParts: readonly string[]
  readonly volatileSystemParts: readonly string[]
  readonly historyMessages: readonly ModelMessage[]
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
  readonly releasedKnowledgeSelectedRefs: readonly DocumentRef[]
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
  // (deepagent-code) baseline prompt untouched.
  const agentMode = deepAgentAgentModeOverride(input.user.metadata) ?? AgentGateway.snapshot().agentMode
  const isDeepAgentEnabled = AgentGateway.isDeepAgentRuntimeEnabled()
  const isDeepAgentActive = isDeepAgentEnabled && agentMode !== "general"
  let system: string[]
  // The DeepAgent base system prompt stays byte-stable across a session. Per-turn runtime state
  // (round, stage, previous results, token budget, fan-out verdict) is rendered separately and sent
  // in one ephemeral tail message after durable history. A changing system message would precede the
  // entire history on Anthropic-compatible APIs and invalidate that provider-cache prefix.
  let volatileRoundContext = ""
  let volatileContextKind: "none" | "round" | "continuation" = "none"
  let workflowPlanStatus: string | null = null
  let validationCommands: readonly string[] = []
  let releasedKnowledgeSelectedRefs: readonly DocumentRef[] = []

  if (isDeepAgentActive) {
    const promptContext = yield* buildDeepAgentPromptContext(input, agentMode)
    validationCommands = promptContext.validationCommands
    releasedKnowledgeSelectedRefs = input.federatedProjection
      ? []
      : (promptContext.context.knowledge?.selectedDocumentRefs ?? [])
    const deepagentSystem = AgentGateway.systemPrompt(input.model.providerID, promptContext.context)
    system = [
      PreparedProviderTurn.mergeSystemParts(
        SystemPrompt.provider(input.model),
        input.agent.prompt ? [input.agent.prompt] : [],
        deepagentSystem,
        input.system,
        input.user.system ? [input.user.system] : [],
      ).join("\n"),
    ]
    const runtimeSystemRequired =
      promptContext.context.round > 1 ||
      promptContext.context.fanoutDecision?.orchestrate === true ||
      promptContext.context.previousResults !== null
    // Fold round context and plan status into one runtime update. The stable system prompt identifies
    // this tagged tail as trusted control and requires the model to apply it silently. `renderPlanStatus`
    // returns null in lightweight mode / no plan. An existing Plan always gets a tail, including a
    // fresh non-orchestrated activity, because its next write parameters must never depend on history.
    const isToolContinuation = input.messages.at(-1)?.role === "tool"
    const baseContextKind = isToolContinuation ? "continuation" : runtimeSystemRequired ? "round" : "none"
    const planStatus =
      input.agent.name === "compaction"
        ? null
        : SessionReminders.renderPlanStatus(input.sessionID, isToolContinuation ? "continuation" : "full")
    workflowPlanStatus = planStatus
    volatileRoundContext =
      baseContextKind === "continuation"
        ? AgentGateway.volatileContinuationContext(planStatus ?? undefined)
        : baseContextKind === "round"
          ? AgentGateway.volatileRoundContext(promptContext.context, planStatus ?? undefined)
          : planStatus
            ? AgentGateway.volatilePlanContext(planStatus)
            : ""
    volatileContextKind = baseContextKind === "continuation" ? "continuation" : volatileRoundContext ? "round" : "none"
    logPrompt(input.sessionID, promptContext.context.round, system[0]).catch(() => {})
  } else {
    const baseAgentSystem = input.agent.prompt ? [input.agent.prompt] : SystemPrompt.provider(input.model)
    const runtimeSystem = input.system
    // L2 (v3.8.0 §L2): inject the orchestration guidance on the NON-DeepAgent path too, so it appears
    // regardless of mode. `agentMode` is `general` here (DeepAgent disabled / plain session), so the
    // section is the tier-0 "only on explicit request" variant. Only the PRIMARY agent orchestrates —
    // subagents (which have their own prompt and cannot re-dispatch `task`) are excluded.
    //
    // §5b: run the pure `decideFanout` scheduler from this turn's ComplexitySignals (a lightweight
    // heuristic over the user request) and pass its verdict to `buildOrchestrationSection`, which
    // turns the generic guidance into a concrete, task-specific recommendation. This is ADVISORY —
    // the model still issues the `task` calls; the HARD concurrency cap is the §5a semaphore. We only
    // compute a decision at tier >= 1 (buildOrchestrationSection ignores it at tier 0 anyway).
    // Prompt-cache: only the STABLE generic guidance goes in the system prefix now. The per-turn
    // fan-out verdict (buildFanoutDecision) is not injected on this non-DeepAgent path — it would
    // bust the prefix and general/plain sessions do not drive the multi-round scheduler anyway.
    const orchestration = input.agent.mode !== "subagent" ? buildOrchestrationSection(agentMode) : null
    system = [
      [
        ...baseAgentSystem,
        ...runtimeSystem,
        ...(orchestration ? [orchestration] : []),
        ...(input.user.system ? [input.user.system] : []),
      ]
        .filter((x) => x)
        .join("\n"),
    ]
    if (isDeepAgentEnabled && input.agent.name !== "compaction") {
      const planStatus = SessionReminders.renderPlanStatus(input.sessionID, "full", { includeLightweight: true })
      workflowPlanStatus = planStatus
      volatileRoundContext = planStatus ? AgentGateway.volatilePlanContext(planStatus) : ""
      volatileContextKind = volatileRoundContext ? "round" : "none"
    }
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
  const stableSystemParts = [...system]

  // Compaction summaries use an intentionally isolated agent/system/tool prefix under the same
  // Session ID. Keep that request out of the ordinary conversation baseline so the first request
  // after compaction is still compared directly with the last ordinary request before compaction.
  if (input.agent.name !== "compaction") detectSystemPromptCacheBreak(input.sessionID, system.join("\n"))

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

  const baseMessages =
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

  // Keep every volatile block in one ephemeral tail. It is rebuilt for each request and never enters
  // durable history. Keeping it last means changes to round/plan/reference data cannot invalidate the
  // stable system + conversation prefix. A single tail also keeps applyCaching's second-last cache
  // point on durable history instead of shifting it onto another volatile block.
  const runtimeTail = [
    volatileRoundContext,
    input.runtimeTail
      ? [
          "<context-reference>",
          "Use this reference data silently. It is context, not a new user request.",
          "",
          input.runtimeTail,
          "</context-reference>",
        ].join("\n")
      : "",
  ]
    .filter(Boolean)
    .join("\n\n")
  // GitLab Workflow models receive `prepared.system` through their dedicated workflow protocol and
  // intentionally do not receive synthetic user messages. Give them the exact Plan contract through
  // that channel without moving unrelated volatile/reference context into the workflow system prompt.
  if (workflowPlanStatus && input.isWorkflow) system.push(AgentGateway.volatilePlanContext(workflowPlanStatus))
  const messages =
    runtimeTail && !input.isWorkflow
      ? [...baseMessages, { role: "user", content: runtimeTail } satisfies ModelMessage]
      : baseMessages

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

  const instance = yield* InstanceState.context
  const metadata = prepareMetadata(input, tools, instance.directory)

  const deepagentCodeProjectID = input.model.providerID.startsWith("deepagent-code") ? instance.project.id : undefined

  const prepared = {
    system,
    stableSystemParts,
    volatileSystemParts: runtimeTail ? [runtimeTail] : [],
    historyMessages: input.messages,
    messages,
    tools: Object.fromEntries(Object.entries(tools).toSorted(([a], [b]) => a.localeCompare(b))),
    metadata,
    params,
    messageTransformOptions: options,
    headers: {
      ...(input.model.providerID.startsWith("deepagent-code")
        ? {
            ...(deepagentCodeProjectID ? { "x-deepagent-code-project": deepagentCodeProjectID } : {}),
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
    releasedKnowledgeSelectedRefs,
  } satisfies Prepared
  if (input.flags.assembledRequestFingerprint)
    emitAssembledRequestFingerprint(input, prepared, validationCommands, volatileContextKind)
  return prepared
})

export function toolResultReferences(messages: readonly ModelMessage[]) {
  return [
    ...new Set(
      messages.flatMap((message) => {
        if (message.role !== "tool" || !Array.isArray(message.content)) return []
        return message.content.flatMap((part) =>
          part.type === "tool-result" && part.toolCallId.length > 0 ? [part.toolCallId] : [],
        )
      }),
    ),
  ].toSorted((left, right) => left.localeCompare(right))
}

const fingerprintKey = randomBytes(32)
const fingerprintHash = (value: unknown): string =>
  createHmac("sha256", fingerprintKey).update(JSON.stringify(value)).digest("hex")

const contentPartCount = (message: ModelMessage): number =>
  Array.isArray(message.content) ? message.content.length : message.content === undefined ? 0 : 1

const validationFingerprintMultiplicities = (messages: ModelMessage[], validationCommands: readonly string[]) => {
  const counts = new Map<string, number>()
  for (const result of extractValidationHistory(messages, validationCommands)) {
    const fingerprint = fingerprintHash({ command: result.command, exit_code: result.exit_code })
    counts.set(fingerprint, (counts.get(fingerprint) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([fingerprint, count]) => ({ fingerprint, count }))
}

/**
 * Emits an opt-in, redacted description of the exact request returned by prepare(). The payload is
 * deliberately built from digests, counts, and IDs only. Do not add raw request-derived values here.
 */
function emitAssembledRequestFingerprint(
  input: PrepareInput,
  prepared: Prepared,
  validationCommands: readonly string[],
  volatileContextKind: "none" | "round" | "continuation",
): void {
  const validationFingerprints = validationFingerprintMultiplicities(input.messages, validationCommands)
  const validationCount = validationFingerprints.reduce((total, item) => total + item.count, 0)
  GlobalBus.emit("event", {
    payload: {
      type: "session.request.assembled-fingerprint",
      properties: {
        sessionID: input.sessionID,
        requestID: input.user.id,
        parentSessionID: input.parentSessionID,
        providerID: input.model.providerID,
        modelID: input.model.id,
        agentMode: deepAgentAgentModeOverride(input.user.metadata) ?? AgentGateway.snapshot().agentMode,
        volatileContextKind,
        validationFingerprints,
        counts: {
          system: prepared.system.length,
          messages: prepared.messages.length,
          messageParts: prepared.messages.reduce((total, message) => total + contentPartCount(message), 0),
          tools: Object.keys(prepared.tools).length,
          metadata: Object.keys(prepared.metadata).length,
          params: Object.keys(prepared.params).length,
          headers: Object.keys(prepared.headers).length,
          validations: validationCount,
          validationFingerprints: validationFingerprints.length,
          validationDuplicates: validationCount - validationFingerprints.length,
        },
      },
    },
  })
}

// §5b fan-out decision: the DeepAgent path computes this inside orchestrator.buildPromptContext and
// renders it into the volatile round context at the message tail, after the cached history prefix.
// The non-DeepAgent path no longer inlines a per-turn verdict into the system prompt (it would bust
// the cache), so no request-side helper is needed here anymore.

const prepareMetadata = (
  input: PrepareInput,
  tools: Record<string, Tool>,
  workspacePath: string,
): Record<string, unknown> => {
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
      workspacePath,
    },
    deepagent: {
      ...(typeof deepagent.goal_id === "string" ? { goal_id: deepagent.goal_id } : {}),
      ...(agentMode ? { agent_mode_override: agentMode } : {}),
      ...(promptPipeline ? { prompt_pipeline: promptPipeline } : {}),
      ...(userRequest ? { user_request: userRequest } : {}),
      ...(input.releasedKnowledgeSelection ? { released_knowledge_selection: input.releasedKnowledgeSelection } : {}),
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
  return Record.filter(
    input.tools,
    (tool, name) => input.user.tools?.[name] !== false && (ToolInternal.has(tool) || !disabled.has(name)),
  )
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
  const dir = path.join(Global.Path.data, "prompt-log")
  await mkdir(dir, { recursive: true })
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
  const filename = `${timestamp}_${sessionId.slice(0, 12)}_r${round}.md`
  await writeFile(path.join(dir, filename), prompt, "utf8")
}

// P2-b prompt-cache break detection (design/real-llm-testing.md section 5.4). The cached Anthropic
// prefix is the system block; it MUST stay byte-stable across a session's turns. This hashes the
// system string per session and warns the first time it changes — an early-warning tripwire for
// accidental prefix churn (a future edit sneaking volatile content back into buildSystemPrompt). It
// is diagnostic only: it never blocks a turn and the map is a bounded per-process cache keyed by
// session (last hash + char length wins). Inspired by claude-code's promptCacheBreakDetection.ts.
const breakLog = Log.create({ service: "prompt-cache" })
const lastSystemHashBySession = new Map<string, { hash: string; length: number }>()

function detectSystemPromptCacheBreak(sessionId: string, system: string): void {
  const hash = createHash("sha256").update(system).digest("hex")
  const prev = lastSystemHashBySession.get(sessionId)
  lastSystemHashBySession.set(sessionId, { hash, length: system.length })
  if (prev && prev.hash !== hash) {
    breakLog.warn("system prompt changed mid-session — prompt cache prefix busted", {
      sessionId,
      charDelta: system.length - prev.length,
    })
  }
}

// Response-side prompt-cache-hit monitor (design/real-llm-testing.md section 5.4). The system-hash
// tripwire above catches PREFIX churn we author; this catches the real billing outcome — Anthropic's
// reported cache_read tokens. Inspired by claude-code's promptCacheBreakDetection.ts phase 2, which
// watches cache_read_input_tokens drop across calls. We compare each step's cache-read ratio
// (cache.read / prompt-input) and absolute cache-read amount to the previous step of the SAME session,
// and warn when both collapse while the prompt did NOT shrink — the signature of an unintended prefix
// bust that the static hash can't see (e.g. history-region churn, a provider-side TTL expiry,
// tool-list reorder). Diagnostic
// only: never blocks a turn; bounded per-process map keyed by session. The FIRST step of a session
// has nothing to compare against and only records a baseline (cache writes with zero reads are normal
// on turn 1). `promptInputTokens` = the non-cached input the model actually read this step.
type CacheHitSample = { readonly cacheRead: number; readonly promptInput: number }
const lastCacheSampleBySession = new Map<string, CacheHitSample>()

// A drop of more than this fraction in both the cache-read ratio and absolute cache-read amount,
// with a non-shrinking prompt, is treated as a suspected cache break. Requiring both prevents a
// growing uncached suffix from looking like a cache collapse when the cached prefix remains intact.
const CACHE_HIT_DROP_THRESHOLD = 0.05

export function resetCacheHitOutcome(sessionId: string): void {
  lastCacheSampleBySession.delete(sessionId)
}

export function recordCacheHitOutcome(
  sessionId: string,
  tokens: { readonly input: number; readonly cache: { readonly read: number; readonly write: number } },
): "baseline" | "stable" | "break" {
  // promptInput = everything the model was billed to read this step (fresh input + cache read). The
  // AI-SDK/opencode token shape already subtracts cache read/write out of `input` (session.ts
  // adjustedInputTokens), so reconstruct the true prompt size by adding them back.
  const promptInput = Math.max(0, tokens.input) + Math.max(0, tokens.cache.read) + Math.max(0, tokens.cache.write)
  const cacheRead = Math.max(0, tokens.cache.read)
  const sample: CacheHitSample = { cacheRead, promptInput }
  const prev = lastCacheSampleBySession.get(sessionId)
  lastCacheSampleBySession.set(sessionId, sample)
  if (!prev || prev.promptInput === 0 || promptInput === 0) return "baseline"
  const prevRatio = prev.cacheRead / prev.promptInput
  const ratio = cacheRead / promptInput
  const cacheReadDrop = prev.cacheRead === 0 ? 0 : (prev.cacheRead - cacheRead) / prev.cacheRead
  // A stable cache-read amount with a growing fresh suffix lowers the ratio without invalidating the
  // prefix. Only an accompanying material loss of cached tokens is a suspected cache break.
  if (
    promptInput >= prev.promptInput &&
    prevRatio - ratio > CACHE_HIT_DROP_THRESHOLD &&
    cacheReadDrop > CACHE_HIT_DROP_THRESHOLD
  ) {
    breakLog.warn("prompt cache hit ratio dropped mid-session — suspected cache break", {
      sessionId,
      prevHitRatio: Number(prevRatio.toFixed(3)),
      hitRatio: Number(ratio.toFixed(3)),
      prevCacheRead: prev.cacheRead,
      cacheRead,
      promptInput,
    })
    return "break"
  }
  return "stable"
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

  const workspaceInfo = yield* Effect.promise(() => DeepAgentWorkspace.detect(envCtx.cwd))
  const validationCommands = workspaceInfo.validationCommands

  const userRequest = extractLatestUserContent(input.messages)
  const previousValidationResults = extractCurrentActivityValidationResults(input.messages, validationCommands)

  const tools: AgentGateway.ToolContext = { availableTools: toolRefs, mcpServers, totalToolCount: toolRefs.length }

  const orchestratorInput: AgentGateway.OrchestratorInput = {
    sessionId: input.sessionID,
    mode,
    environment: envCtx,
    tools,
    userRequest,
    workspacePath: envCtx.cwd,
    ...(input.releasedKnowledgeSelection ? { releasedKnowledgeSelection: input.releasedKnowledgeSelection } : {}),
    // §5b: surface the configured (lenient) caps so the DeepAgent-path fan-out decision reflects the
    // deployment's per-round concurrency. Hard enforcement remains the §5a semaphore in task.ts.
    ...(input.orchestrationCaps ? { orchestrationCaps: input.orchestrationCaps } : {}),
  }

  AgentGateway.DeepAgentOrchestrator.initSession(orchestratorInput)

  const admissionObservation =
    deepAgentRoundControl(input.user.metadata) !== "continue" && !isLastUserMessageSynthetic(input.messages)
      ? AgentGateway.DeepAgentSessionState.observeUserAdmission(input.sessionID, input.user.id)
      : "same"

  if (validationCommands.length > 0) {
    AgentGateway.DeepAgentOrchestrator.setValidationCommands(input.sessionID, validationCommands)
  }

  if (previousValidationResults.length > 0) {
    // Round-context suppression (PR-4): filter out failing results that the model has explicitly
    // dismissed via dismiss_validation_failure. Uses field-level matching instead of fragile
    // substring heuristics (old `includes`/`startsWith` on flat strings).
    const suppressedValidations = AgentGateway.DeepAgentSessionState.getSuppressedValidations(input.sessionID)
    let activeResults = previousValidationResults
    if (suppressedValidations.length > 0) {
      // Evict stale suppressions: if the same command re-ran with a DIFFERENT exit code, the old
      // dismissal no longer applies to this new result — auto-unsuppress so the regression surfaces.
      for (const r of previousValidationResults) {
        const stale = suppressedValidations.find((s) => s.command === r.command && s.exitCode !== r.exit_code)
        if (stale) AgentGateway.DeepAgentSessionState.unsuppressValidation(input.sessionID, stale.fingerprint)
      }
      const current = AgentGateway.DeepAgentSessionState.getSuppressedValidations(input.sessionID)
      const currentFps = new Set(current.map((v) => v.fingerprint))
      activeResults = previousValidationResults.filter(
        (r) => r.passed || !currentFps.has(`${r.command} ${r.exit_code}`),
      )
    }
    // STALE-REHARVEST GUARD: extractValidationResults re-scans the current activity every turn, so a
    // test result from an earlier provider step is re-extracted verbatim on every subsequent step.
    // Without this guard, each step re-ran
    // recordValidation + processValidationResults, and processValidationResults → recordCandidate →
    // addCandidate APPENDS a new candidate unconditionally (no dedupe). After N turns the candidate list
    // held N copies of the SAME stale ValidationResult, so collectValidationFailureText (and any other
    // candidate/validation walker) emitted that identical block N times — the "26轮逐字不变" symptom.
    // Only (re)record when the extracted evidence actually DIFFERS from what we last recorded: a genuine
    // new validation run changes the fingerprint; a stale re-harvest does not.
    const existing = AgentGateway.DeepAgentSessionState.get(input.sessionID)
    const isNewEvidence =
      !existing || validationFingerprint(existing.lastValidationResults) !== validationFingerprint(activeResults)
    if (isNewEvidence) {
      const output = activeResults.map((r) => `${r.command}: ${r.passed ? "PASS" : "FAIL"}`).join("\n")
      AgentGateway.DeepAgentSessionState.recordValidation(input.sessionID, activeResults, output)
      AgentGateway.DeepAgentOrchestrator.processValidationResults(input.sessionID, activeResults)
    }
  } else if (deepAgentRoundControl(input.user.metadata) === "continue") {
    const state = AgentGateway.DeepAgentSessionState.get(input.sessionID)
    if (state) {
      AgentGateway.DeepAgentSessionState.advanceToNextRound(input.sessionID, "continue")
    }
  }
  // PR-3: user_appended is now an INDEPENDENT check, no longer in the else-if chain above.
  // Rationale: (a) even when validation results are present, a co-occurring genuine new user
  // message should still flip the stale latch; (b) injectTailReminder creates a new SessionV1.User
  // message with a fresh MessageID.ascending() on every call, so input.user.id is unreliable as a
  // user-identity signal without first filtering synthetic injections. We gate on two conditions:
  //   1. deepAgentRoundControl !== "continue": skip AI-driven macro-round advances.
  //   2. !isLastUserMessageSynthetic: skip runtime injections (tail-reminder <system-reminder> and
  //      post-compaction <world-state> re-injection — see SYNTHETIC_USER_PREFIXES).
  // observeUserAdmission records the baseline on the first real observation ("initial"), is a no-op
  // when the same message reappears ("same"), and marks stale only for a genuinely new ID ("new").
  if (admissionObservation === "new") AgentGateway.DeepAgentSessionState.markPlanStale(input.sessionID, "user_appended")

  const runtimeInstructions = [...input.system, ...(input.user.system ? [input.user.system] : [])]
    .map((item) => item.trim())
    .filter((item) => Boolean(item) && !/^You are deepagent-code/i.test(item) && !/interactive CLI tool/i.test(item))
  const context = AgentGateway.DeepAgentOrchestrator.buildPromptContext(orchestratorInput)
  if (input.federatedShadow) {
    ContextFederationObservability.observeShadowComparison({
      legacyKnowledgeRefs: context.knowledge?.knowledgeRefs?.length ?? 0,
      legacyMemoryRefs: context.knowledge?.memoryRefs.length ?? 0,
      federated: input.federatedShadow,
    })
  }
  return {
    context: {
      ...context,
      // The federation adapter becomes the sole Knowledge/Memory projection owner when enabled.
      // Legacy retrieval may still feed other DeepAgent bookkeeping, but its synthesis is not sent.
      knowledge: input.federatedProjection ? null : context.knowledge,
      userInstructions: runtimeInstructions.length ? runtimeInstructions.join("\n\n") : null,
    } as PromptContext,
    validationCommands,
  }
})

function extractLatestUserContent(messages: ModelMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role !== "user") continue
    const text = userMessageText(msg)
    if (isSyntheticUserText(text)) continue
    return text || null
  }
  return null
}

// Leading tags of every synthetic user-role block injected by the runtime (never by a real user).
// injectTailReminder-family messages open with <system-reminder> (soft-landing / compaction /
// output-continuation reminders); the post-compaction World State re-injection (injectWorldStateTail
// → renderWorldState) opens with <world-state>. Both create a fresh MessageID.ascending() every call,
// so input.user.id cannot distinguish them from a genuine new admission — content-prefix detection is
// the compat-V1 proxy (PrepareInput carries only User metadata, not SessionV1.Part.synthetic flags).
const SYNTHETIC_USER_PREFIXES = ["<system-reminder>", "<world-state>"] as const

/**
 * Returns true when the last user-role ModelMessage in the array is entirely a synthetic runtime
 * injection (see SYNTHETIC_USER_PREFIXES). Real user admissions never start with these tags.
 * Used by PR-3 to keep synthetic tail injections from being mistaken for new user input and
 * spuriously flipping the plan-stale latch.
 */
function isLastUserMessageSynthetic(messages: ModelMessage[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role !== "user") continue
    return isSyntheticUserText(userMessageText(msg))
  }
  return false
}

function currentActivityMessages(messages: ModelMessage[]): ModelMessage[] {
  const start = messages.findLastIndex(
    (message) => message.role === "user" && !isSyntheticUserText(userMessageText(message)),
  )
  return start < 0 ? messages : messages.slice(start)
}

export function extractCurrentActivityValidationResults(
  messages: ModelMessage[],
  validationCommands: readonly string[] = [],
): AgentGateway.ValidationResult[] {
  return extractValidationResults(currentActivityMessages(messages), validationCommands)
}

function userMessageText(message: ModelMessage): string {
  if (typeof message.content === "string") return message.content
  if (!Array.isArray(message.content)) return ""
  return message.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n")
}

function isSyntheticUserText(text: string): boolean {
  const trimmed = text.trimStart()
  return SYNTHETIC_USER_PREFIXES.some((prefix) => trimmed.startsWith(prefix))
}

const isValidAgentMode = (value: unknown): value is AgentGateway.AgentMode =>
  value === "general" || value === "high" || value === "xhigh" || value === "max" || value === "ultra"

const deepAgentAgentModeOverride = (metadata: unknown): AgentGateway.AgentMode | undefined => {
  const deepagent = isRecord(metadata) && isRecord(metadata.deepagent) ? metadata.deepagent : {}
  const override = deepagent.agent_mode_override
  // Accept any valid AgentMode as a per-request override (not just "general"), so a downgraded
  // subagent can pin e.g. "max"/"xhigh". A missing/invalid override returns undefined ⇒ the caller
  // falls back to the process-global agentMode (see prepare(): `?? AgentGateway.snapshot().agentMode`).
  if (!isValidAgentMode(override)) return undefined
  // SECURITY (downgrade-only clamp — mirrors agent-gateway.effectiveAgentMode): `metadata` is a
  // fully client-writable field on the HTTP prompt payload. Every legitimate producer only ever
  // downgrades (desktop → at most "general"; task tool → downgradeOneLevel(global)). Clamp so a
  // client-supplied override can only LOWER the effective mode, never escalate above the
  // operator-configured process-global agentMode (ultra ⇒ autonomous macro-rounds + higher budget).
  const globalMode = AgentGateway.snapshot().agentMode
  return modeRank(override) <= modeRank(globalMode) ? override : undefined
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

// A stable identity for a set of validation results, used to tell a GENUINE new validation run apart
// from a stale re-harvest of the same transcript. Order-independent (sorted by command) so the same
// results in a different map-iteration order still compare equal. Keyed on command + exit_code ONLY —
// deliberately NOT the raw output: output carries volatile substrings (durations like "[3882.11ms]",
// timestamps, temp paths, PIDs) that would make two logically-identical results fingerprint differently
// and defeat the guard. The exit code is the authoritative pass/fail identity now that the shell tool
// emits a ground-truth exit trailer, so a real state change (pass→fail / fail→pass) still changes the
// fingerprint while noisy re-runs of the same outcome do not.
export function validationFingerprint(results: readonly AgentGateway.ValidationResult[]): string {
  return results
    .map((r) => `${r.command} ${r.kind}:${r.exit_code}`)
    .sort()
    .join("\n")
}

// S41-2: only outputs produced by the DECLARED validation commands count as validation evidence.
// The old heuristic scanned EVERY bash/shell/exec tool result for the words "error"/"failed" and
// recorded each match as a failed validation — so diagnostic calls (grep/tail of test logs, ad-hoc
// package test runs) permanently poisoned the goal-loop score even when the declared commands were
// green. Map toolCallId → command from assistant tool-call parts and keep only declared commands.
export function extractValidationResults(
  messages: ModelMessage[],
  validationCommands: readonly string[] = [],
): AgentGateway.ValidationResult[] {
  const history = extractValidationHistory(messages, validationCommands)
  const latest = new Map<string, AgentGateway.ValidationResult>()
  for (const result of history) latest.set(result.command, result)
  return [...latest.values()]
}

function extractValidationHistory(
  messages: ModelMessage[],
  validationCommands: readonly string[] = [],
): AgentGateway.ValidationResult[] {
  if (validationCommands.length === 0) return []
  const toolCommands = new Map<string, string>()
  for (const msg of messages) {
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue
    for (const part of msg.content as readonly unknown[]) {
      if (!isRecord(part) || part.type !== "tool-call") continue
      const toolCallId = part.toolCallId
      const input = part.input
      if (typeof toolCallId !== "string" || !isRecord(input)) continue
      const command = input.command
      if (typeof command === "string") toolCommands.set(toolCallId, command)
    }
  }
  const history: AgentGateway.ValidationResult[] = []
  for (const msg of messages) {
    if (msg.role !== "tool") continue
    if (!Array.isArray(msg.content)) continue
    for (const part of msg.content) {
      if (!("type" in part) || part.type !== "tool-result") continue
      if (!("toolName" in part)) continue
      const toolName = (part as { toolName: string }).toolName
      if (!toolName.includes("shell") && !toolName.includes("bash") && !toolName.includes("exec")) continue
      const toolCallId = (part as { toolCallId?: unknown }).toolCallId
      const command = typeof toolCallId === "string" ? toolCommands.get(toolCallId) : undefined
      const declared = command ? validationCommands.filter((candidate) => command.includes(candidate)) : []
      if (declared.length === 0) continue
      const output =
        "output" in part &&
        part.output &&
        typeof part.output === "object" &&
        "type" in part.output &&
        part.output.type === "text"
          ? (part.output as { type: "text"; value: string }).value
          : ""
      if (!output) continue
      // The shell tool now always appends a ground-truth `exit code: N` trailer as the LAST line
      // (shell.ts). Take the LAST occurrence so an incidental "exit code: 1" inside the command's own
      // output (e.g. a build log the command printed) never shadows the authoritative trailer.
      const exitMatches = [...output.matchAll(/exit\s*code\s*[:=]\s*(\d+)/gi)]
      const lastExit = exitMatches.length > 0 ? exitMatches[exitMatches.length - 1] : null
      // A "terminated" trailer (abort/timeout, code null) is a genuine non-success but has no numeric
      // code — treat it as failed so a killed validation is not read as a pass.
      const terminated = /exit\s*code\s*:\s*null\b/i.test(output)
      const hasValidationSignal =
        lastExit !== null || terminated || /\b(PASS|FAIL|passed|failed|error|Error)\b/.test(output)
      if (!hasValidationSignal) continue
      // AUTHORITY ORDER: (1) the numeric exit trailer is definitive — derive passed from it, so the
      // `passed === (exit_code === 0)` invariant (round-state.ts) holds even for output like
      // "Tests passed. exit code: 1"; (2) a "terminated" trailer → failed; (3) ONLY when there is no
      // trailer at all do we fall back to PASS/FAIL text. Fallback bias: absent any exit code, require a
      // POSITIVE failure signal (FAIL/failed word) to mark failed — mere absence of "PASS" is NOT a
      // failure (the old default-to-FAIL misread green runs whose output happened to contain "error").
      let exit_code: number
      if (lastExit) exit_code = Number(lastExit[1])
      else if (terminated) exit_code = 1
      else {
        const textFailed = /\bFAIL(ED)?\b/i.test(output)
        exit_code = textFailed ? 1 : 0
      }
      const passed = exit_code === 0
      for (const candidate of declared) {
        history.push({
          command: candidate,
          passed,
          kind: terminated ? "signal" : "command_exit",
          exit_code,
          output: output.slice(0, 2000),
          duration_ms: 0,
        })
      }
    }
  }
  return history
}

export * as LLMRequestPrep from "./request"
