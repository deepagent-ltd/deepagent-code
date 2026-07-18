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
import { createHash } from "node:crypto"
import path from "node:path"
import { Log } from "@deepagent-code/core/util/log"
import { DeepAgentWorkspace } from "@/deepagent/workspace-context"
import { ToolProvenance } from "@/tool/provenance"
import { SessionReminders } from "../reminders"

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
  // §5b: configurable orchestration caps (from config.experimental.orchestration). Unset ⇒ lenient
  // defaults. Only used to surface the concrete per-round concurrency number in the advisory prompt;
  // the hard code-layer cap is enforced by the §5a semaphore in task.ts.
  readonly orchestrationCaps?: OrchestrationCaps
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
  // (deepagent-code) baseline prompt untouched.
  const agentMode = deepAgentAgentModeOverride(input.user.metadata) ?? AgentGateway.snapshot().agentMode
  const isDeepAgentActive = AgentGateway.snapshot().mode === "enabled" && agentMode !== "general"
  let system: string[]
  // Prompt-cache split (docs/deepagent-cache-hit-fix-plan.md): the DeepAgent system prompt is now
  // byte-stable across a session. All per-turn volatile state (round, stage, previous-round results,
  // token budget, fan-out verdict) is rendered separately here and appended to the TAIL of the
  // message array below, so it lands after the Anthropic cache breakpoint and never churns the
  // cached prefix. Empty on the non-DeepAgent path and on first turns with nothing round-specific.
  let volatileRoundContext = ""

  if (isDeepAgentActive) {
    const promptContext = yield* buildDeepAgentPromptContext(input, agentMode)
    const deepagentSystem = AgentGateway.systemPrompt(input.model.providerID, promptContext)
    system = [deepagentSystem.filter((x) => x).join("\n")]
    // Fold the volatile round-context AND the plan-status snapshot into ONE trailing message. Both
    // carry live per-turn state (round/stage/results/budget, and plan progress/mutation-count/nudge)
    // and MUST ride the tail after the cache breakpoint — never the cached prefix. Keeping them in a
    // SINGLE trailing message is deliberate: appending a second trailing message would shift the
    // `slice(-2)` breakpoint (transform.ts applyCaching) off the last stable history message and stop
    // the growing history from being cached. `renderPlanStatus` returns null in lightweight mode / no
    // plan; join with a blank line only when both are present.
    const roundCtx = AgentGateway.volatileRoundContext(promptContext)
    const planStatus = SessionReminders.renderPlanStatus(input.sessionID)
    volatileRoundContext = [roundCtx, planStatus].filter((x) => x && x.length > 0).join("\n\n")
    logPrompt(input.sessionID, promptContext.round, system[0]).catch(() => {})
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

  // P2-b: tripwire for accidental prefix churn. The system block is the cached Anthropic prefix and
  // must stay byte-stable across a session; warn if it changed since this session's last turn.
  detectSystemPromptCacheBreak(input.sessionID, system.join("\n"))

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

  // Prompt-cache split (docs/deepagent-cache-hit-fix-plan.md): append the per-turn volatile context as
  // a fresh TRAILING user message. It is ephemeral (rebuilt every turn from the current round state,
  // never persisted), so it does not accumulate. Placing it last keeps the entire preceding prefix
  // (system + history) byte-stable turn-to-turn — Anthropic reads the cached prefix up to the previous
  // turn's last message and only this small tail is a cache write. Skipped on the workflow path, which
  // owns its own message contract. Empty string ⇒ no injection (non-DeepAgent / nothing round-specific).
  //
  // ALWAYS RESEND (do NOT add a "skip when unchanged from last turn" optimization here): this message
  // is ephemeral and NOT persisted into the append-only history, so each stateless API call only sees
  // the round/plan context if we (re)send it. Skipping a turn whose content happened to match the
  // previous one would leave the model with NO round/plan context on that call. The tail sits after
  // the cache breakpoint (uncached input either way), so resending it costs ~a few hundred tokens and
  // never touches the cached history prefix — the saving from skipping would be negligible and the
  // information-loss risk real. This mirrors claude-code's <system-reminder>s, which are re-emitted
  // every turn precisely because they are ephemeral.
  const messages =
    volatileRoundContext && !input.isWorkflow
      ? [...baseMessages, { role: "user", content: volatileRoundContext } satisfies ModelMessage]
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

  const metadata = prepareMetadata(input, tools)

  const deepagentCodeProjectID = input.model.providerID.startsWith("deepagent-code")
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
  }
})

// §5b fan-out decision: the DeepAgent path computes this inside orchestrator.buildPromptContext and
// renders it into the volatile round context (appended to the message tail, not the cached prefix).
// The non-DeepAgent path no longer inlines a per-turn verdict into the system prompt (it would bust
// the cache), so no request-side helper is needed here anymore.

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

// P2-b prompt-cache break detection (docs/deepagent-cache-hit-fix-plan.md). The cached Anthropic
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

// Response-side prompt-cache-hit monitor (docs/deepagent-cache-hit-fix-plan.md). The system-hash
// tripwire above catches PREFIX churn we author; this catches the real billing outcome — Anthropic's
// reported cache_read tokens. Inspired by claude-code's promptCacheBreakDetection.ts phase 2, which
// watches cache_read_input_tokens drop across calls. We compare each step's cache-read ratio
// (cache.read / prompt-input) to the previous step of the SAME session and warn when it collapses
// while the prompt did NOT shrink — the signature of an unintended prefix bust that the static hash
// can't see (e.g. history-region churn, a provider-side TTL expiry, tool-list reorder). Diagnostic
// only: never blocks a turn; bounded per-process map keyed by session. The FIRST step of a session
// has nothing to compare against and only records a baseline (cache writes with zero reads are normal
// on turn 1). `promptInputTokens` = the non-cached input the model actually read this step.
type CacheHitSample = { readonly cacheRead: number; readonly promptInput: number }
const lastCacheSampleBySession = new Map<string, CacheHitSample>()

// A drop of more than this fraction in the cache-read RATIO between two consecutive steps, with a
// non-shrinking prompt, is treated as a suspected cache break. 0.05 mirrors claude-code's >5% rule.
const CACHE_HIT_DROP_THRESHOLD = 0.05

export function recordCacheHitOutcome(
  sessionId: string,
  tokens: { readonly input: number; readonly cache: { readonly read: number; readonly write: number } },
): void {
  // promptInput = everything the model was billed to read this step (fresh input + cache read). The
  // AI-SDK/opencode token shape already subtracts cache read/write out of `input` (session.ts
  // adjustedInputTokens), so reconstruct the true prompt size by adding them back.
  const promptInput = Math.max(0, tokens.input) + Math.max(0, tokens.cache.read) + Math.max(0, tokens.cache.write)
  const cacheRead = Math.max(0, tokens.cache.read)
  const sample: CacheHitSample = { cacheRead, promptInput }
  const prev = lastCacheSampleBySession.get(sessionId)
  lastCacheSampleBySession.set(sessionId, sample)
  if (!prev || prev.promptInput === 0 || promptInput === 0) return
  const prevRatio = prev.cacheRead / prev.promptInput
  const ratio = cacheRead / promptInput
  // Only flag when the prompt did NOT shrink (a smaller prompt legitimately reads less cache) and the
  // ratio fell materially. A growing/steady prompt with a collapsing hit ratio is the real symptom.
  if (promptInput >= prev.promptInput && prevRatio - ratio > CACHE_HIT_DROP_THRESHOLD) {
    breakLog.warn("prompt cache hit ratio dropped mid-session — suspected cache break", {
      sessionId,
      prevHitRatio: Number(prevRatio.toFixed(3)),
      hitRatio: Number(ratio.toFixed(3)),
      cacheRead,
      promptInput,
    })
  }
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
  const previousValidationResults = extractValidationResults(input.messages, validationCommands)

  const tools: AgentGateway.ToolContext = { availableTools: toolRefs, mcpServers, totalToolCount: toolRefs.length }

  const orchestratorInput: AgentGateway.OrchestratorInput = {
    sessionId: input.sessionID,
    mode,
    environment: envCtx,
    tools,
    userRequest,
    workspacePath: envCtx.cwd,
    // §5b: surface the configured (lenient) caps so the DeepAgent-path fan-out decision reflects the
    // deployment's per-round concurrency. Hard enforcement remains the §5a semaphore in task.ts.
    ...(input.orchestrationCaps ? { orchestrationCaps: input.orchestrationCaps } : {}),
  }

  const sessionExistedBefore = AgentGateway.DeepAgentSessionState.get(input.sessionID) !== undefined
  AgentGateway.DeepAgentOrchestrator.initSession(orchestratorInput)

  if (validationCommands.length > 0) {
    AgentGateway.DeepAgentOrchestrator.setValidationCommands(input.sessionID, validationCommands)
  }

  if (previousValidationResults.length > 0) {
    // STALE-REHARVEST GUARD: extractValidationResults re-scans the WHOLE transcript every turn, so a
    // test result from an earlier round (with its frozen `[Nms]` duration) is re-extracted verbatim on
    // every subsequent turn as long as it stays in history. Without this guard, each turn re-ran
    // recordValidation + processValidationResults, and processValidationResults → recordCandidate →
    // addCandidate APPENDS a new candidate unconditionally (no dedupe). After N turns the candidate list
    // held N copies of the SAME stale ValidationResult, so collectValidationFailureText (and any other
    // candidate/validation walker) emitted that identical block N times — the "26轮逐字不变" symptom.
    // Only (re)record when the extracted evidence actually DIFFERS from what we last recorded: a genuine
    // new validation run changes the fingerprint; a stale re-harvest does not.
    const existing = AgentGateway.DeepAgentSessionState.get(input.sessionID)
    const isNewEvidence =
      !existing || validationFingerprint(existing.lastValidationResults) !== validationFingerprint(previousValidationResults)
    if (isNewEvidence) {
      const output = previousValidationResults.map((r) => `${r.command}: ${r.passed ? "PASS" : "FAIL"}`).join("\n")
      AgentGateway.DeepAgentSessionState.recordValidation(input.sessionID, previousValidationResults, output)
      AgentGateway.DeepAgentOrchestrator.processValidationResults(input.sessionID, previousValidationResults)
    }
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
    .map((r) => `${r.command} ${r.exit_code}`)
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
  // Latest per declared command wins: the loop re-scans the whole transcript each round, so without
  // dedupe a fixed failure would stay "failed" forever even after the same command passes.
  const latest = new Map<string, AgentGateway.ValidationResult>()
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
        latest.set(candidate, {
          command: candidate,
          passed,
          exit_code,
          output: output.slice(0, 2000),
          duration_ms: 0,
        })
      }
    }
  }
  return [...latest.values()]
}

export * as LLMRequestPrep from "./request"
