import { mkdir, readFile, writeFile } from "node:fs/promises"
import { createHash, randomUUID } from "node:crypto"
import path from "node:path"
import { Cause, Effect, Layer, Stream } from "effect"
import { InvalidRequestReason, LLMError, LLMEvent, LLMRequest, registerClientMiddleware, type LLMEvent as LLMEventType } from "@deepagent-code/llm"
import { buildRunContext } from "./deepagent/run-context"
import { DocumentStore } from "./deepagent/document-store"
import { buildRunGraph } from "./deepagent/run-graph"
import { knowledgeEnabled, strategyMethodologyEnabled, domainKnowledgeEnabled } from "./deepagent/mode"
import type { AgentMode } from "./deepagent/mode"
import { resolveDeepAgentCodeHome } from "./deepagent/workspace"
import * as KnowledgeRetriever from "./deepagent/knowledge-retriever"
import type { ProblemProfile } from "./deepagent/domain-pack"
import {
  buildDeterministicResult,
  classifyDeterministicTask,
  deterministicToolPolicy,
  shouldActivateQueryControls,
} from "./deepagent/deterministic-task"

export const DEEPAGENT_BOOT_MESSAGE = "我是 DeepAgent Code，一个具有完整思维系统的 code agent。"

// AgentMode and knowledgeEnabled now have a single source of truth in ./deepagent/mode
// (V3 dedup). Re-exported here so existing `AgentGateway.AgentMode` consumers keep working.
export type { AgentMode }
export type Mode = "unavailable" | "off" | "enabled" | "blocked" | "degraded"
export type Implementation = "visible_skeleton" | "gateway_passthrough" | "gateway_enforced"
export type ProviderExecutedToolPolicy = "deny_by_default" | "allowlist_required"
export type CallKind = "session_turn" | "auxiliary_ai_call"

export type Config = {
  readonly enabled?: boolean
  readonly agentMode?: AgentMode
  readonly failClosed?: boolean
  readonly runsDir?: string
  // P0-0: explicit storage home for durable memory/state (injected by the caller that holds
  // Global.Path.agent.data). Independent of runsDir. Defaults to resolveDeepAgentCodeHome().
  readonly baseDir?: string
  // docs/34 §3: directory holding domain pack manifests (pack.json + index.json). Defaults to
  // <baseDir>/domain-packs (or DEEPAGENT_PACK_DIR env).
  readonly packDir?: string
  readonly providerExecutedToolPolicy?: ProviderExecutedToolPolicy
  readonly allowProviderExecutedTools?: boolean
  readonly allowProviderExecutedToolNames?: readonly string[]
  readonly killSwitch?: boolean
  readonly selfLearning?: SelfLearningPolicy
  readonly modelRouter?: Partial<ModelRouterConfig>
  readonly resumeFrom?: ResumeConfig
}

// V3.1 self-learning approval policy. "manual": learned candidates stay pending until a human
// approves them in the Review UI. "auto": newly learned candidates are approved (made
// retrievable) immediately on session completion.
export type SelfLearningPolicy = "manual" | "auto"

export type ModelRouterConfig = {
  readonly upstreamProviderID: string
  readonly upstreamModelID: string
  readonly reason: string
  readonly userPreference: "none" | "soft" | "hard"
}

export type ResumeConfig = {
  readonly checkpointPath: string
  readonly expectedCheckpointHash: string
}

export type RunInput = {
  readonly callKind: CallKind
  readonly feature: string
  readonly providerID: string
  readonly modelID: string
  readonly sessionID?: string
  readonly messageID?: string
  readonly parentSessionID?: string
  readonly auxiliaryCallID?: string
  readonly workspaceID?: string
  readonly agent?: string
  readonly origin?: {
    readonly file: string
    readonly function: string
  }
  readonly metadata?: Record<string, unknown>
}

export type RuntimeSnapshot = {
  readonly schemaVersion: "deepagent_generic_agent_runtime.v1"
  readonly mode: Mode
  readonly agentMode: AgentMode
  readonly implementation: Implementation
  readonly agentManaged: boolean
  readonly originalPathAllowed: boolean
  readonly providerExecutedToolPolicy: ProviderExecutedToolPolicy
  readonly knowledgeEnabled: boolean
}

type TokenUsage = {
  readonly input_tokens: number
  readonly output_tokens: number
  readonly cached_input_tokens: number
  readonly reasoning_tokens: number
  readonly tool_result_tokens: number
  readonly estimated_cost: number
  readonly currency: "USD"
}

type ProviderExecutedToolObservation = {
  readonly event_id: string
  readonly provider_executed: boolean
  readonly tool_type: string
  readonly policy_decision: "allowed" | "blocked" | "observed_after_execution"
  readonly input_hash: string | null
  readonly result_hash: string | null
  readonly security_impact: "none" | "must_report" | "blocking"
  readonly comparability_impact: "none" | "must_report" | "invalidates_group_comparison"
}

type ToolAuditEvent = {
  readonly event_id: string
  readonly event_type: "tool-call" | "tool-result"
  readonly tool_name: string
  readonly provider_executed: boolean
  readonly input_hash: string | null
  readonly result_hash: string | null
  readonly execution_owner: "generic_agent_tool_registry_or_mcp" | "provider_hosted_tool"
  readonly policy_decision: "observed_after_execution" | "allowed" | "blocked"
}

type RouterDecision = {
  readonly decision_id: string
  readonly execution_provider_id: string
  readonly execution_model_id: string
  readonly selected_provider_id: string
  readonly selected_model_id: string
  readonly original_provider_id: string
  readonly original_model_id: string
  readonly user_preference: "none" | "soft" | "hard"
  readonly route_scope: "configured_upstream_execution" | "configured_upstream_intent" | "user_pinned_intent"
  readonly reason: string
  readonly budget_policy_ref: string
  readonly tool_policy_ref: string
}

type SchemaValidationStatus = "pass" | "fail"
type RunCloseState = "opened" | "streaming" | "completed" | "failed" | "blocked" | "cancelled"

type HumanIntervention = {
  readonly intervention_id: string
  readonly intervention_type: "resume" | "release_block"
  readonly decision: "executed" | "blocked"
  readonly reason: string
}

type HistoryEvent = {
  readonly event_type: string
  readonly created_at: string
  readonly payload: Record<string, unknown>
}

type RunRecord = {
  readonly runID: string
  readonly roundID: string
  readonly taskID: string
  readonly bindingID: string
  readonly requestID: string
  readonly checkpointID: string
  readonly resourceID: string
  readonly workPackageID: string
  readonly policyID: string
  readonly agentMode: AgentMode
  readonly config: CurrentConfig
  readonly createdAt: string
  readonly dir: string
  readonly input: RunInput
  readonly routerDecision: RouterDecision
  readonly resumedFrom: ResumeConfig | null
  usage: TokenUsage
  eventCount: number
  latestEvents: Array<{ readonly event_type: string; readonly created_at: string; readonly payload_keys: string[] }>
  historyEvents: HistoryEvent[]
  readonly providerExecutedToolObservations: ProviderExecutedToolObservation[]
  readonly toolAuditEvents: ToolAuditEvent[]
  readonly humanInterventions: HumanIntervention[]
  terminalEventSeen: boolean
  failureDossierRef: string | null
  failureDossierText: string | null
}

const env = () => {
  const processEnv = globalThis.process?.env ?? {}
  return {
    failClosed: processEnv.DEEPAGENT_FAIL_CLOSED,
    runsDir: processEnv.DEEPAGENT_RUNS_DIR,
    allowProviderExecutedTools: processEnv.DEEPAGENT_ALLOW_PROVIDER_EXECUTED_TOOLS,
    allowProviderExecutedToolNames: processEnv.DEEPAGENT_PROVIDER_EXECUTED_TOOL_ALLOWLIST,
    killSwitch: processEnv.DEEPAGENT_KILL_SWITCH,
    selfLearning: processEnv.DEEPAGENT_SELF_LEARNING,
    routerProvider: processEnv.DEEPAGENT_ROUTER_PROVIDER,
    routerModel: processEnv.DEEPAGENT_ROUTER_MODEL,
    routerReason: processEnv.DEEPAGENT_ROUTER_REASON,
    agentMode: processEnv.DEEPAGENT_MODE,
  }
}

type CurrentConfig = {
  readonly enabled: boolean
  readonly agentMode: AgentMode
  readonly failClosed: boolean
  readonly providerExecutedToolPolicy: ProviderExecutedToolPolicy
  readonly allowProviderExecutedTools: boolean
  readonly allowProviderExecutedToolNames: readonly string[]
  readonly killSwitch: boolean
  readonly selfLearning: SelfLearningPolicy
  readonly modelRouter: ModelRouterConfig
  readonly runsDir?: string
  readonly baseDir?: string
  readonly resumeFrom?: ResumeConfig
}

let current: CurrentConfig = {
  enabled: true,
  agentMode: parseAgentMode(env().agentMode),
  failClosed: env().failClosed !== "false",
  providerExecutedToolPolicy: "deny_by_default",
  allowProviderExecutedTools: env().allowProviderExecutedTools === "true" || env().allowProviderExecutedTools === "1",
  allowProviderExecutedToolNames: parseAllowlist(env().allowProviderExecutedToolNames),
  killSwitch: env().killSwitch === "true" || env().killSwitch === "1",
  selfLearning: env().selfLearning === "auto" ? "auto" : "manual",
  modelRouter: {
    upstreamProviderID: env().routerProvider ?? "deepagent-upstream",
    upstreamModelID: env().routerModel ?? "deepagent/default-upstream",
    reason: env().routerReason ?? "DeepAgent global runtime default router policy",
    userPreference: "none",
  },
  runsDir: env().runsDir ?? path.join(resolveDeepAgentCodeHome(), "runs"),
  baseDir: resolveDeepAgentCodeHome(),
  resumeFrom: undefined,
}

export const selfLearningPolicy = (): SelfLearningPolicy => current.selfLearning

export const configure = (config: Config = {}) => {
  const nextRunsDir = "runsDir" in config ? config.runsDir : current.runsDir
  // P0-0: memory/state always root at the single storage home. Production injects `baseDir`
  // explicitly (config.ts passes Global.Path.agent.data on every configure call); when absent we
  // re-resolve from env (resolveDeepAgentCodeHome honors DEEPAGENT_CODE_HOME / TEST_HOME exactly
  // like Global). We do NOT fall back to a frozen module-init value, so a late env change (tests)
  // is still observed. This replaces the old path.dirname(runsDir) inference that made durable
  // knowledge/state diverge from project-memory whenever runsDir pointed outside <home>/runs.
  const baseDir = config.baseDir ?? resolveDeepAgentCodeHome()
  DeepAgentSessionState.configure(path.join(baseDir, "state"))
  // docs/34 §7.2/§8: durable knowledge stores root under baseDir (public/knowledge + project/<id>/
  // knowledge). The retriever's knowledge-source reads from here. Same injected baseDir, no self-resolve.
  DeepAgentKnowledgeSource.configure(baseDir)
  // docs/34 §9 DAP-11: seed core in-code knowledge (CORE_STRATEGIES/METHODOLOGY_REGISTRY/gpu pack)
  // into the user-global DocumentStore on every configure() call. seedCoreKnowledge is idempotent
  // (skips docs that already exist), so re-calling on restart is safe. After seeding, the retriever
  // reads these from DocumentStore and the in-code constants are no longer in the retrieval path.
  try { DeepAgentKnowledgeSeed.seedCoreKnowledgeAt(baseDir) } catch { /* non-fatal: stale seed, retry next call */ }
  // docs/34 §3: domain pack registry. Built-in packs (packages/domain-packs, bundled with the app)
  // are ALWAYS discovered automatically. A user/org pack dir can be layered on top via config.packDir
  // or DEEPAGENT_PACK_DIR (its packs override built-ins by id). Passing undefined = built-ins only.
  const userPackDir = config.packDir ?? process.env.DEEPAGENT_PACK_DIR
  DeepAgentDomainPackRegistry.configureRegistry(userPackDir)
  current = {
    enabled: config.enabled ?? current.enabled,
    baseDir,
    agentMode: config.agentMode ?? current.agentMode,
    failClosed: config.failClosed ?? current.failClosed,
    providerExecutedToolPolicy: config.providerExecutedToolPolicy ?? current.providerExecutedToolPolicy,
    allowProviderExecutedTools: config.allowProviderExecutedTools ?? current.allowProviderExecutedTools,
    allowProviderExecutedToolNames:
      "allowProviderExecutedToolNames" in config
        ? (config.allowProviderExecutedToolNames ?? [])
        : current.allowProviderExecutedToolNames,
    killSwitch: config.killSwitch ?? current.killSwitch,
    selfLearning: config.selfLearning ?? current.selfLearning,
    modelRouter: { ...current.modelRouter, ...config.modelRouter },
    runsDir: nextRunsDir,
    resumeFrom: "resumeFrom" in config ? config.resumeFrom : current.resumeFrom,
  }
  return current
}

export const snapshot = (): RuntimeSnapshot => ({
  schemaVersion: "deepagent_generic_agent_runtime.v1",
  mode: current.killSwitch ? "blocked" : isActiveDeepAgentRuntime() ? "enabled" : "off",
  agentMode: current.agentMode,
  implementation: isActiveDeepAgentRuntime() ? "gateway_enforced" : "visible_skeleton",
  agentManaged: isActiveDeepAgentRuntime(),
  originalPathAllowed: !isActiveDeepAgentRuntime(),
  providerExecutedToolPolicy: current.providerExecutedToolPolicy,
  knowledgeEnabled: isActiveDeepAgentRuntime() && knowledgeEnabled(current.agentMode),
})

export const routeRequest = (request: LLMRequest): LLMRequest => {
  const metadata = request.metadata ?? {}
  const agentMode = effectiveAgentMode(metadata) ?? current.agentMode
  if (!isManagedDeepAgentRuntimeWith({ ...current, agentMode })) return request
  const deepagent = isRecord(metadata.deepagent) ? metadata.deepagent : {}
  return LLMRequest.update(request, {
    metadata: {
      ...metadata,
      deepagent: {
        ...deepagent,
        router: {
          selected_provider_id: current.modelRouter.upstreamProviderID,
          selected_model_id: current.modelRouter.upstreamModelID,
          original_provider_id: String(request.model.provider),
          original_model_id: String(request.model.id),
          user_preference: current.modelRouter.userPreference,
          reason: current.modelRouter.reason,
          routed_at: new Date().toISOString(),
        },
      },
    },
  })
}

export const fromRequest = (request: LLMRequest): RunInput => {
  const metadata = request.metadata ?? {}
  const genericAgent = isRecord(metadata["deepagent-code"])
    ? metadata["deepagent-code"]
    : isRecord(metadata.deepagent)
      ? metadata.deepagent
      : {}
  return {
    callKind: genericAgent.callKind === "auxiliary_ai_call" ? "auxiliary_ai_call" : "session_turn",
    feature: stringValue(genericAgent.feature) ?? "llm_client",
    providerID: String(request.model.provider),
    modelID: String(request.model.id),
    sessionID: stringValue(genericAgent.sessionID),
    messageID: stringValue(genericAgent.messageID),
    parentSessionID: stringValue(genericAgent.parentSessionID),
    auxiliaryCallID: stringValue(genericAgent.auxiliaryCallID),
    workspaceID: stringValue(genericAgent.workspaceID),
    agent: stringValue(genericAgent.agent),
    origin:
      typeof genericAgent.originFile === "string" && typeof genericAgent.originFunction === "string"
        ? { file: genericAgent.originFile, function: genericAgent.originFunction }
        : undefined,
    metadata,
  }
}

// providerID identifies the execution backend; auth routing still needs to know whether the
// configured provider is the DeepAgent native provider. It no longer gates runtime activation.
export const isDeepAgentProvider = (providerID: string) => providerID === "deepagent"

// V3.1 global runtime: activation is strength-driven and provider-agnostic. The runtime is
// active for high/max on every provider; general (and a disabled/killed runtime) is passthrough.
export const isActiveDeepAgentRuntime = () => current.enabled && !current.killSwitch && current.agentMode !== "general"

const isManagedDeepAgentRuntimeWith = (config: CurrentConfig) =>
  config.enabled && !config.killSwitch && config.agentMode !== "general"

import { buildSystemPrompt, type PromptContext } from "./deepagent/prompt-policy"
import * as DeepAgentOrchestrator from "./deepagent/orchestrator"
import * as DeepAgentSessionState from "./deepagent/session-state"
import * as DeepAgentDiagnosis from "./deepagent/diagnosis"
import * as DeepAgentValidation from "./deepagent/validation"
import * as DeepAgentLearning from "./deepagent/learning"
import * as DeepAgentKnowledgeSource from "./deepagent/knowledge-source"
import * as DeepAgentKnowledgeSeed from "./deepagent/knowledge-seed"
import * as DeepAgentDurableKnowledgeStore from "./deepagent/durable-knowledge-store"
import * as DeepAgentDomainPackRegistry from "./deepagent/domain-pack-registry"
import * as DeepAgentPromotion from "./deepagent/promotion"
import * as DeepAgentDocumentStore from "./deepagent/document-store"
import * as DeepAgentRunGraph from "./deepagent/run-graph"
import * as DeepAgentWorkspace from "./deepagent/workspace"
import * as DeepAgentBackgroundLearning from "./deepagent/background-learning"
import * as DeepAgentPromptPipeline from "./deepagent/prompt-pipeline"
import * as DeepAgentRoundReport from "./deepagent/round-report"
import * as DeepAgentMode from "./deepagent/mode"
import * as DeepAgentBudget from "./deepagent/budget"
import * as DeepAgentKnowledgeRetriever from "./deepagent/knowledge-retriever"
import * as DeepAgentHooks from "./deepagent/hooks"
import * as DeepAgentKnowledgeGate from "./deepagent/knowledge-gate"
import type { RunSummary } from "./deepagent/run-graph"

export { DeepAgentOrchestrator, DeepAgentSessionState, DeepAgentDiagnosis, DeepAgentValidation, DeepAgentLearning, DeepAgentPromotion, DeepAgentDocumentStore, DeepAgentRunGraph, DeepAgentWorkspace, DeepAgentBackgroundLearning, DeepAgentPromptPipeline, DeepAgentRoundReport, DeepAgentMode, DeepAgentBudget, DeepAgentKnowledgeRetriever, DeepAgentHooks, DeepAgentKnowledgeGate, DeepAgentKnowledgeSource, DeepAgentDurableKnowledgeStore, DeepAgentDomainPackRegistry }
export type { PromptContext } from "./deepagent/prompt-policy"
export type { EnvironmentContext, McpServerRef, PreviousResults, ToolContext, ToolRef } from "./deepagent/prompt-policy"
export type { OrchestratorInput, PostTurnDecision } from "./deepagent/orchestrator"
export type { SessionRunState } from "./deepagent/session-state"
export type { ValidationResult } from "./deepagent/round-state"

// Global runtime: the DeepAgent system prompt is injected for every provider whenever the
// runtime is active (high/max). `general` (and disabled/kill-switched) returns [] so the
// inherited opencode baseline prompt is used unchanged. providerID is accepted for caller
// signature stability but no longer gates injection.
export const systemPrompt = (_providerID: string, context?: PromptContext) =>
  isActiveDeepAgentRuntime()
    ? [context ? buildSystemPrompt(context) : bootMessage(current.agentMode)]
    : []

export const preflight = (input: RunInput): Effect.Effect<void, LLMError> =>
  preflightWith(input, current)

const preflightWith = (input: RunInput, config: CurrentConfig): Effect.Effect<void, LLMError> =>
  Effect.gen(function* () {
    // Global runtime: preflight applies to every provider, gated by strength not providerID.
    // Kill switch is fail-closed and must run BEFORE the management gate, because
    // isManagedDeepAgentRuntimeWith is false when killSwitch is on, which would otherwise
    // short-circuit to a no-op (untracked passthrough) and never reach this failure.
    if (config.killSwitch) return yield* Effect.fail(gatewayBlocked("DeepAgent runtime kill switch is enabled"))
    // general mode / disabled runtime is pure passthrough (protects the opencode baseline).
    if (!isManagedDeepAgentRuntimeWith(config)) return
    if (!config.enabled) return yield* Effect.fail(gatewayBlocked("DeepAgent runtime is not enabled"))
    if (!config.runsDir) return yield* Effect.fail(gatewayBlocked("DEEPAGENT_RUNS_DIR is not configured"))
    if (!config.resumeFrom) return
    const valid = yield* Effect.promise(() => verifyCheckpoint(config.resumeFrom!))
    if (!valid) return yield* Effect.fail(gatewayBlocked("DeepAgent checkpoint hash mismatch or checkpoint missing"))
  })

export const manageStream = <E>(
  input: RunInput,
  stream: Stream.Stream<LLMEventType, E>,
): Stream.Stream<LLMEventType, E | LLMError> => {
  // DeepAgent V3.1 is the GLOBAL runtime: activation is strength-driven, not provider-scoped.
  // It applies to every upstream provider; `providerID` only identifies the execution backend.
  // Kill switch is fail-closed for all providers (emergency stop), and must precede the
  // management gate because isManagedDeepAgentRuntimeWith is false under killSwitch and would
  // otherwise pass through untracked. Graceful disable (enabled=false) still passes through.
  if (current.killSwitch) {
    return Stream.fail(gatewayBlocked("DeepAgent runtime kill switch is enabled"))
  }
  // general mode (and a disabled runtime) is pure passthrough with zero artifacts, which
  // protects the inherited generic-agent (opencode) baseline.
  const agentMode = effectiveAgentMode(input.metadata) ?? current.agentMode
  if (!isManagedDeepAgentRuntimeWith({ ...current, agentMode })) return stream
  if (input.sessionID) {
    const budgetStatus = DeepAgentSessionState.budgetStatus(input.sessionID)
    if (budgetStatus?.status === "exhausted" || budgetStatus?.status === "exceeded") {
      return Stream.fail(gatewayBlocked(deepAgentBudgetMessage(budgetStatus)))
    }
  }

  return Stream.unwrap(
    Effect.gen(function* () {
      const config = cloneConfig({ ...current, agentMode })
      yield* preflightWith(input, config)
      const run = yield* open(input, config)
      ensureSessionStateForRun(run)
      let closed = false
      const closeOnce = (state: Exclude<RunCloseState, "opened" | "streaming">, failure?: unknown) =>
        Effect.promise(async () => {
          if (closed) return
          closed = true
          await close(run, state, failure)
        })
      const closeTerminal = Effect.promise(async () => {
        if (closed) return
        closed = true
        await close(
          run,
          run.terminalEventSeen ? "completed" : "failed",
          run.terminalEventSeen ? undefined : "DeepAgent stream ended before terminal finish event",
        )
      })
      return stream.pipe(
        Stream.tap((event) => Effect.sync(() => observe(run, event))),
        Stream.mapEffect((event) =>
          isDeniedProviderExecutedTool(run, event)
            ? blockProviderExecutedTool(run, event).pipe(
                Effect.andThen(closeOnce("blocked", providerExecutedToolError(event))),
                Effect.andThen(Effect.fail(providerExecutedToolError(event))),
              )
            : Effect.succeed(event),
        ),
        Stream.catchCause((cause) =>
          Stream.fromEffect(closeOnce(Cause.hasInterrupts(cause) ? "cancelled" : "failed", cause)).pipe(
            Stream.flatMap(() => Stream.failCause(cause)),
          ),
        ),
        Stream.ensuring(closeTerminal),
      )
    }),
  )
}

const deepAgentBudgetMessage = (status: DeepAgentBudget.BudgetCheck) => {
  if (status.status === "exceeded" && status.roundsRemaining === 0) {
    return "DeepAgent ultra round budget exceeded for this session. Start a new ultra task or switch to a non-ultra mode to continue."
  }
  if (status.status === "exhausted" && status.tokensRemaining === 0) {
    return "DeepAgent token budget exhausted for this session. Use the normal context compaction path or start a new task."
  }
  return status.message ? `DeepAgent budget stopped this session: ${status.message}` : "DeepAgent budget stopped this session."
}

const effectiveAgentMode = (metadata: Record<string, unknown> | undefined): AgentMode | undefined => {
  const deepagent = metadata && isRecord(metadata.deepagent) ? metadata.deepagent : {}
  return deepagent.agent_mode_override === "general" ? "general" : undefined
}

export const runAuxiliary = <A, E, R>(
  input: RunInput,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | LLMError, R> => {
  return Effect.gen(function* () {
    const config = cloneConfig(current)
    // Global runtime: auxiliary calls are managed for every provider, gated by strength.
    // Kill switch fails closed; general mode / disabled runtime passes through untracked.
    if (config.killSwitch) return yield* Effect.fail(gatewayBlocked("DeepAgent runtime kill switch is enabled"))
    if (!isManagedDeepAgentRuntimeWith(config)) return yield* effect
    yield* preflightWith(input, config)
    const run = yield* open(input, config)
    ensureSessionStateForRun(run)
    const result = yield* effect.pipe(Effect.exit)
    if (result._tag === "Success") {
      yield* Effect.promise(() => close(run, "completed"))
      return result.value
    }
    yield* Effect.promise(() => close(run, Cause.hasInterrupts(result.cause) ? "cancelled" : "failed", result.cause))
    return yield* Effect.failCause(result.cause)
  })
}

const open = Effect.fn("AgentGateway.open")(function* (input: RunInput, config: CurrentConfig) {
  if (!config.runsDir) return yield* Effect.fail(gatewayBlocked("DEEPAGENT_RUNS_DIR is not configured"))
  if (config.resumeFrom) {
    const resume = config.resumeFrom
    const valid = yield* Effect.promise(() => verifyCheckpoint(resume))
    if (!valid) return yield* Effect.fail(gatewayBlocked("DeepAgent checkpoint hash mismatch or checkpoint missing"))
  }
  const now = new Date().toISOString()
  const runID = `run_${randomUUID()}`
  const run: RunRecord = {
    runID,
    roundID: `round_${randomUUID()}`,
    taskID: `task_${runID}`,
    bindingID: `deepagent-generic-agent-binding:${runID}`,
    requestID: `request_${randomUUID()}`,
    checkpointID: `checkpoint_${randomUUID()}`,
    resourceID: `resource_${randomUUID()}`,
    workPackageID: `work-package:${runID}:r1`,
    policyID: `model-policy:${runID}:r1`,
    agentMode: config.agentMode,
    config,
    createdAt: now,
    dir: path.join(config.runsDir, runID),
    input,
    routerDecision: routerDecision(input, config),
    resumedFrom: config.resumeFrom ?? null,
    usage: emptyUsage(),
    eventCount: 0,
    latestEvents: [],
    historyEvents: [],
    providerExecutedToolObservations: [],
    toolAuditEvents: [],
    terminalEventSeen: false,
    humanInterventions:
      config.resumeFrom === undefined
        ? []
        : [
            {
              intervention_id: `intervention_${randomUUID()}`,
              intervention_type: "resume",
              decision: "executed",
              reason: "Resume checkpoint hash matched before opening DeepAgent global runtime run.",
            },
          ],
    failureDossierRef: null,
    failureDossierText: null,
  }
  yield* Effect.promise(() => writeArtifacts(run, "opened"))
  return run
})

const close = async (run: RunRecord, state: Exclude<RunCloseState, "opened" | "streaming">, failure?: unknown) => {
  if ((state === "failed" || state === "blocked" || state === "cancelled") && !run.failureDossierRef) {
    run.failureDossierRef = await writeFailureDossier(run, failure)
  }
  await writeArtifacts(run, state)

  const sessionId = run.input.sessionID
  if (!sessionId) return
  if (state === "completed") {
    const hasPendingToolCalls = run.latestEvents.some((e) => e.event_type === "tool-call" && !run.latestEvents.some((r) => r.event_type === "tool-result"))
    if (!hasPendingToolCalls) {
      // V3.2 P0-1: learning writeback is the SINGLE LearningWorker path (runBackgroundLearning).
      // onSessionComplete now only does session bookkeeping (no persist) — the old duplicate
      // ungated persist + auto-approve here was the sensitivity-bypass hole; removed.
      DeepAgentOrchestrator.onSessionComplete(sessionId)
      runBackgroundLearning(run, "completed")
    }
  } else if (state === "failed") {
    DeepAgentSessionState.fail(sessionId)
    runBackgroundLearning(run, "failed")
  }
}

const ensureSessionStateForRun = (run: RunRecord): DeepAgentSessionState.SessionRunState | undefined => {
  const sessionId = run.input.sessionID
  if (!sessionId) return undefined
  const existing = DeepAgentSessionState.get(sessionId)
  DeepAgentSessionState.getOrCreate(sessionId, run.agentMode)
  return DeepAgentSessionState.update(sessionId, {
    mode: existing?.mode ?? run.agentMode,
    runId: run.runID,
    workspacePath: workspacePathForInput(run.input) ?? existing?.workspacePath ?? process.cwd(),
    userRequest: userRequestForInput(run.input) ?? existing?.userRequest ?? null,
  })
}

// E1: background learning runs OFF the main task thread via a process-level queue. close()
// enqueues (non-blocking) and the queue drains on a microtask, so learning never blocks or
// regresses the user-facing turn. The gateway only triggers session_finalization here; idle /
// pause / project_switch triggers are enqueued by the app lifecycle through the same queue.
const learningQueue = new DeepAgentBackgroundLearning.LearningQueue()

export const enqueueLearning = (job: DeepAgentBackgroundLearning.LearningJob): void => learningQueue.enqueue(job)

// Test/shutdown hook: drain any queued learning jobs now (synchronously) and await completion.
export const flushLearning = async (): Promise<void> => {
  learningQueue.drainNow()
}

const runBackgroundLearning = (run: RunRecord, finalStatus: "completed" | "failed"): void => {
  const sessionId = run.input.sessionID
  if (!sessionId) return
  const session = ensureSessionStateForRun(run)
  if (!session) return
  // Capture the run-state values now (synchronously), but defer all I/O and the worker run to
  // the queue's microtask so the close() path stays off the learning work.
  const workspacePath = session.workspacePath ?? process.cwd()
  const projectID = projectIDForWorkspace(workspacePath)
  const runID = session.runId
  const mode = session.mode
  const roundState = session.roundState
  const totalRounds = session.roundState.round
  learningQueue.enqueue({
    trigger: "session_finalization",
    build: () => {
      const home = new DeepAgentWorkspace.DeepAgentCodeHome(current.baseDir)
      const project = home.ensureProject(projectID, workspacePath)
      // P0-1: the selfLearning setting maps to the worker policy. auto -> safe memory candidates
      // auto-approve (gated by looksSensitive); manual -> everything stays pending for review.
      const policy = current.selfLearning === "auto" ? "auto_merge_safe_project" : "manual_review"
      // docs/34 §8: the worker stages into THIS workspace's durable project store (opened from the
      // same baseDir + path the retriever reads), so learned knowledge is immediately consistent.
      const durable = DeepAgentKnowledgeSource.projectStoreFor(workspacePath)
      return {
        worker: new DeepAgentBackgroundLearning.LearningWorker(project, projectID, durable),
        input: { projectID, sessionID: sessionId, runID, mode, roundState, totalRounds, finalStatus, trigger: "session_finalization", policy },
      }
    },
  })
}

const blockProviderExecutedTool = (run: RunRecord, event: LLMEventType) =>
  Effect.promise(async () => {
    if (!isProviderToolEvent(event)) return
    const eventID = `provider-tool-event:${randomUUID()}`
    const inputHash = "input" in event ? sha256(event.input) : null
    const resultHash = "result" in event ? sha256(event.result) : null
    run.providerExecutedToolObservations.push({
      event_id: eventID,
      provider_executed: true,
      tool_type: event.name,
      policy_decision: "blocked",
      input_hash: inputHash,
      result_hash: resultHash,
      security_impact: "blocking",
      comparability_impact: "must_report",
    })
    run.toolAuditEvents.push({
      event_id: eventID,
      event_type: event.type,
      tool_name: event.name,
      provider_executed: true,
      input_hash: inputHash,
      result_hash: resultHash,
      execution_owner: "provider_hosted_tool",
      policy_decision: "blocked",
    })
    run.failureDossierRef = await writeFailureDossier(run, providerExecutedToolError(event))
  })

const observe = (run: RunRecord, event: LLMEventType) => {
  if (LLMEvent.is.finish(event)) run.terminalEventSeen = true
  run.eventCount += 1
  run.historyEvents.push({ event_type: event.type, created_at: new Date().toISOString(), payload: historyPayload(event) })
  if ("usage" in event && event.usage) {
    const sessionId = run.input.sessionID
    if (sessionId) {
      DeepAgentOrchestrator.onTokenUsage(sessionId, event.usage.inputTokens ?? 0, event.usage.outputTokens ?? 0)
    }
  }
  run.latestEvents = [
    ...run.latestEvents.slice(-4),
    {
      event_type: event.type,
      created_at: new Date().toISOString(),
      payload_keys: Object.keys(event).filter((key) => key !== "type"),
    },
  ]
  observeToolAudit(run, event)
  if (!("usage" in event) || event.usage === undefined) return
  run.usage = {
    input_tokens: Math.trunc(event.usage.inputTokens ?? 0),
    output_tokens: Math.trunc(event.usage.outputTokens ?? 0),
    cached_input_tokens: Math.trunc((event.usage.cacheReadInputTokens ?? 0) + (event.usage.cacheWriteInputTokens ?? 0)),
    reasoning_tokens: Math.trunc(event.usage.reasoningTokens ?? 0),
    tool_result_tokens: 0,
    estimated_cost: 0,
    currency: "USD",
  }
}

const historyPayload = (event: LLMEventType): Record<string, unknown> =>
  Object.fromEntries(Object.entries(event).filter(([key]) => key !== "type" && key !== "providerMetadata"))

const observeToolAudit = (run: RunRecord, event: LLMEventType) => {
  if (!isProviderToolEvent(event)) return
  const providerExecuted = event.providerExecuted === true
  if (providerExecuted && !isAllowedProviderExecutedTool(run, event)) return
  const inputHash = "input" in event ? sha256(event.input) : null
  const resultHash = "result" in event ? sha256(event.result) : null
  const policyDecision = providerExecuted ? "allowed" : "observed_after_execution"
  const eventID = `tool-event:${randomUUID()}`
  run.toolAuditEvents.push({
    event_id: eventID,
    event_type: event.type,
    tool_name: event.name,
    provider_executed: providerExecuted,
    input_hash: inputHash,
    result_hash: resultHash,
    execution_owner: providerExecuted ? "provider_hosted_tool" : "generic_agent_tool_registry_or_mcp",
    policy_decision: policyDecision,
  })
  run.providerExecutedToolObservations.push({
    event_id: eventID,
    provider_executed: providerExecuted,
    tool_type: event.name,
    policy_decision: policyDecision,
    input_hash: inputHash,
    result_hash: resultHash,
    security_impact: providerExecuted ? "must_report" : "none",
    comparability_impact: providerExecuted ? "must_report" : "none",
  })
}

const writeArtifacts = async (run: RunRecord, state: RunCloseState) => {
  await mkdir(run.dir, { recursive: true })
  const summary = runSummaryFor(run, state)
  materializeRunGraph(run, summary) // F5: document graph is the first materialized run memory source.
  const artifacts = artifactsFor(run, state, summary)
  await Promise.all(
    Object.entries(artifacts).map(([name, value]) =>
      writeFile(path.join(run.dir, name), artifactText(name, value), "utf8"),
    ),
  )
}

// F5: materialize the run as a typed-document graph under <runDir>/graph so the document
// system (docs/28) is the run's working-memory substrate. Flat artifacts are compatibility
// projections from the same summary; graph materialization stays best-effort so it never
// breaks the underlying generic provider turn.
const materializeRunGraph = (run: RunRecord, summary: RunSummary) => {
  try {
    const store = new DocumentStore(path.join(run.dir, "graph"))
    buildRunGraph(store, summary)
  } catch {
    /* document-graph materialization is best-effort and must never break a run */
  }
}

const binding = (run: RunRecord) => ({
  schema_version: "deepagent_generic_agent_binding.v1",
  binding_id: run.bindingID,
  created_at: run.createdAt,
  call_kind: run.input.callKind,
  generic_agent_session_id: run.input.callKind === "session_turn" ? sessionID(run) : null,
  generic_agent_message_id: run.input.callKind === "session_turn" ? messageID(run) : null,
  parent_generic_agent_session_id: run.input.parentSessionID ?? null,
  auxiliary_call_id: run.input.auxiliaryCallID ?? null,
  workspace_id: run.input.workspaceID ?? "unknown-workspace",
  actor: run.input.agent ?? "unknown-actor",
  origin_file: run.input.origin?.file ?? "unknown-origin",
  origin_function: run.input.origin?.function ?? "unknown_origin",
  agent_run_id: run.runID,
  agent_round_id: run.roundID,
  agent_mode: run.agentMode,
  gateway_runtime_mode: "enabled",
  activation_mode: activationMode(run.agentMode),
  knowledge_enabled: knowledgeEnabled(run.agentMode),
  prompt_policy_hash: promptPolicyHash(run),
  runtime_feature: run.input.feature,
  provider_id: run.input.providerID,
  model_id: run.input.modelID,
  agent_managed: true,
  original_path_allowed: false,
  provider_executed_tool_policy: run.config.providerExecutedToolPolicy,
  provider_executed_tool_observations: run.providerExecutedToolObservations,
  monitor_ref: `run_monitor_snapshot:${run.runID}`,
  ledger_ref: `token_usage_ledger:${run.runID}:${run.requestID}`,
  checkpoint_ref: `run_checkpoint_manifest:${run.checkpointID}`,
  failure_dossier_ref: run.failureDossierRef,
})

const runState = (run: RunRecord, state: RunCloseState) => ({
  schema_version: "deepagent_global_run_state.v1",
  run_id: run.runID,
  provider_id: run.input.providerID,
  model_id: run.input.modelID,
  agent_mode: run.agentMode,
  activation_mode: activationMode(run.agentMode),
  knowledge_enabled: knowledgeEnabled(run.agentMode),
  prompt_policy_hash: promptPolicyHash(run),
  knowledge_policy_hash: knowledgePolicyHash(run.agentMode),
  deepagent_system_active: true,
  boot_message_ref: "DEEPAGENT_BOOT_MESSAGE.md",
  call_kind: run.input.callKind,
  runtime_feature: run.input.feature,
  state,
  created_at: run.createdAt,
  updated_at: new Date().toISOString(),
  generic_agent_session_id: run.input.callKind === "session_turn" ? sessionID(run) : null,
  generic_agent_message_id: run.input.callKind === "session_turn" ? messageID(run) : null,
  parent_generic_agent_session_id: run.input.parentSessionID ?? null,
  auxiliary_call_id: run.input.auxiliaryCallID ?? null,
  passthrough: true,
  default_agent_preserved: true,
  tool_mcp_preserved: true,
  checkpoint_ref: `run_checkpoint_manifest:${run.checkpointID}`,
  ledger_ref: `token_usage_ledger:${run.runID}:${run.requestID}`,
  monitor_ref: `run_monitor_snapshot:${run.runID}`,
  blocking_reasons: state === "blocked" ? ["provider_executed_tool_blocked"] : [],
  cancellation_reasons: state === "cancelled" ? ["user_or_runtime_interrupt"] : [],
  degraded_reasons: [],
  deterministic_status: deterministicResultArtifact(run).verified_state,
  failure_dossier_ref: run.failureDossierRef,
})

const ledger = (run: RunRecord) => ({
  schema_version: "token_usage_ledger.v1",
  ledger_id: `token_usage_ledger:${run.runID}:${run.requestID}`,
  run_id: run.runID,
  task_id: run.taskID,
  group: "deepagent_global_runtime",
  model_provider: run.input.providerID,
  model_id: run.input.modelID,
  price_version: "unpriced-passthrough-v1",
  request_id: run.requestID,
  created_at: run.createdAt,
  ...run.usage,
  actual_billed_cost: null,
})

const artifactsFor = (run: RunRecord, state: RunCloseState, summary = runSummaryFor(run, state)) => {
  const base: Record<string, unknown> = {
    "DEEPAGENT_BOOT_MESSAGE.md": bootMessage(run.agentMode),
    "TASK_SPEC.json": taskSpec(run),
    "PROBLEM_PROFILE.json": problemProfile(run),
    "MODEL_RUNTIME_POLICY.json": modelRuntimePolicy(run),
    "ACTIVATION_POLICY.json": activationPolicy(run),
    "MCP_CAPABILITY_INDEX.json": mcpCapabilityIndex(run),
    "KNOWLEDGE_RETRIEVAL_RESULT.json": knowledgeRetrievalResult(run),
    "DETERMINISTIC_RESULT.json": deterministicResultArtifact(run),
    "MODEL_WORK_PACKAGE.json": modelWorkPackage(run),
    "DESIGN.md": designDoc(run, state),
    "HANDOFF.md": handoffDoc(run, state),
    "TEST.md": testDoc(run, state),
    "HISTORY.md": historyDoc(run, state),
    "DIAGNOSIS_RESULT.json": diagnosisResult(run, state),
    "DEEPAGENT_RUN_STATE.json": runState(run, state),
    "RUN_CONTEXT.md": summary.runContextMarkdown,
    "CANDIDATE_LINEAGE.json": candidateLineage(run, state, summary),
    "OUTPUT_CONTRACT.json": outputContract(run),
    "deepagent_generic_agent_binding.json": binding(run),
    "token_usage_ledger.json": ledger(run),
    "resource_usage_record.json": resourceUsage(run),
    "TOOL_AUDIT.json": toolAudit(run),
    "MODEL_ROUTER_AUDIT.json": modelRouterAudit(run),
    "LEARNING_WRITEBACK_MANIFEST.json": learningWriteback(run),
    "RELEASE_GATE_AUDIT.json": releaseGateAudit(run),
    "release_bundle_manifest.json": releaseBundle(run),
  }
  if (run.humanInterventions.length > 0) base["human_intervention_record.json"] = humanInterventionRecord(run)
  if (run.failureDossierText) base["FAILURE_DOSSIER.md"] = run.failureDossierText

  base["SCHEMA_VALIDATION_REPORT.json"] = schemaValidationReport(base)
  const refs = hashRefs(base)
  base["run_checkpoint_manifest.json"] = checkpoint(run, state, refs)
  base["SCHEMA_VALIDATION_REPORT.json"] = schemaValidationReport(base)
  const finalRefs = hashRefs(base)
  base["run_checkpoint_manifest.json"] = checkpoint(run, state, finalRefs)
  const withMonitorRefs = hashRefs(base)
  base["run_monitor_snapshot.json"] = monitor(run, state, withMonitorRefs)
  return base
}

const taskSpec = (run: RunRecord) => ({
  schema_version: "task_spec.v1",
  task_id: run.taskID,
  user_request: `DeepAgent global runtime ${run.input.callKind} via ${run.input.feature}`,
  task_type: "code_modification",
  domain: "code",
  deterministic_task: deterministicTaskSummary(run),
  goals: ["Preserve generic agent behavior while adding DeepAgent control-plane audit."],
  success_criteria: [
    "Every configured upstream provider enters the DeepAgent global runtime.",
    "Tool and MCP execution stay owned by generic agent runtime.",
    "Checkpoint, ledger and monitor artifacts are written for audit and resume.",
    "DeepAgent boot message is produced by the DeepAgent gateway, not by the generic agent system prompt.",
  ],
  allowed_actions: {
    edit_files: true,
    run_tests: true,
    network: false,
    remote_execution: false,
    gpu_required: false,
  },
  budgets: {
    max_rounds: 1,
    max_wall_time_seconds: null,
    max_model_attempts: 1,
    max_gpu_seconds: null,
  },
  risk_boundaries: [
    "Do not bypass DeepAgent runtime or silently switch upstream provider execution.",
    "Do not execute provider-hosted tools unless allowlisted.",
    "Do not expose raw reasoning in monitor snapshots.",
  ],
  requires_human_confirmation: false,
  default_assumptions: ["DeepAgent manages all upstream provider turns."],
  created_at: run.createdAt,
})

const designDoc = (run: RunRecord, state: RunCloseState) =>
  [
    "# Design",
    "",
    `run_id: ${run.runID}`,
    `state: ${state}`,
    `mode: ${run.agentMode}`,
    `provider: ${run.input.providerID}/${run.input.modelID}`,
    "",
    "## User Request",
    "",
    userRequestForInput(run.input) ?? "No user request metadata was captured.",
    "",
    "## Approach",
    "",
    "- Route the task through the DeepAgent global runtime while preserving the generic agent tool and MCP execution boundary.",
    "- Use the configured upstream provider/model as execution backend and record routing in MODEL_ROUTER_AUDIT.json.",
    "- Keep run-local control-plane documents private to this run store.",
    "",
  ].join("\n")

const handoffDoc = (run: RunRecord, state: RunCloseState) =>
  [
    "# Handoff",
    "",
    `run_id: ${run.runID}`,
    `state: ${state}`,
    `session_id: ${sessionID(run)}`,
    `message_id: ${messageID(run)}`,
    "",
    "## Current State",
    "",
    `- DeepAgent runtime feature: ${run.input.feature}`,
    `- Latest event count: ${run.eventCount}`,
    `- Failure dossier: ${run.failureDossierRef ?? "none"}`,
    "",
    "## Next Action",
    "",
    runContextNextAction(state),
    "",
  ].join("\n")

const testDoc = (run: RunRecord, state: RunCloseState) =>
  [
    "# Test",
    "",
    `run_id: ${run.runID}`,
    `state: ${state}`,
    "",
    "## Runtime Validation",
    "",
    `- Terminal finish event observed: ${run.terminalEventSeen}`,
    `- Provider stream event count: ${run.eventCount}`,
    `- Input tokens: ${run.usage.input_tokens}`,
    `- Output tokens: ${run.usage.output_tokens}`,
    "",
    "## Tool Boundary",
    "",
    `- Provider-executed tool observations: ${run.providerExecutedToolObservations.length}`,
    `- Tool audit events: ${run.toolAuditEvents.length}`,
    "",
  ].join("\n")

const historyDoc = (run: RunRecord, state: RunCloseState) =>
  [
    "# History",
    "",
    "Private run history. Do not promote or share this document.",
    "",
    `run_id: ${run.runID}`,
    `state: ${state}`,
    `session_id: ${sessionID(run)}`,
    `message_id: ${messageID(run)}`,
    `created_at: ${run.createdAt}`,
    "",
    "## Input",
    "",
    "```json",
    JSON.stringify(
      {
        user_request: userRequestForInput(run.input),
        metadata: run.input.metadata ?? {},
        call_kind: run.input.callKind,
        feature: run.input.feature,
        provider_id: run.input.providerID,
        model_id: run.input.modelID,
      },
      null,
      2,
    ),
    "```",
    "",
    "## Events",
    "",
    "```json",
    JSON.stringify(run.historyEvents, null, 2),
    "```",
    "",
    "## Output Summary",
    "",
    "```json",
    JSON.stringify({ latest_events: run.latestEvents, usage: run.usage }, null, 2),
    "```",
    "",
  ].join("\n")

const problemProfile = (_run: RunRecord) => ({
  schema_version: "problem_profile.v1",
  task_type: "code_modification",
  domain: "code",
  backend: "node",
  language: "typescript",
  framework: "generic-agent",
  runtime: "bun",
  arch: null,
  dtype: null,
  shape: null,
  domain_metadata: {
    runtime_scope: "global",
    execution_provider_id: _run.input.providerID,
    default_agent_preserved: true,
  },
  signals: {
    hidden_evaluator_feedback_present: false,
    hosted_tool_policy: _run.config.providerExecutedToolPolicy,
    knowledge_enabled: knowledgeEnabled(_run.agentMode),
  },
})

const modelRuntimePolicy = (run: RunRecord) => ({
  schema_version: "model_runtime_policy.v1",
  policy_id: run.policyID,
  model_id: run.routerDecision.selected_model_id,
  execution_model_id: run.routerDecision.execution_model_id,
  execution_provider_id: run.routerDecision.execution_provider_id,
  route_scope: run.routerDecision.route_scope,
  model_tier: "frontier",
  task_id: run.taskID,
  round: 1,
  prompt_profile: "standard_code_agent",
  agent_mode: run.agentMode,
  activation_mode: activationMode(run.agentMode),
  knowledge_enabled: knowledgeEnabled(run.agentMode),
  prompt_policy_hash: promptPolicyHash(run),
  knowledge_policy_hash: knowledgePolicyHash(run.agentMode),
  inline_context_policy: "minimal_summary",
  max_prompt_chars: 12000,
  max_inline_chars: 6000,
  max_candidate_inline_chars: 8000,
  max_skill_index_items: 0,
  max_knowledge_synthesis_chars: knowledgeEnabled(run.agentMode) ? 1200 : 0,
  knowledge_default: "activation_policy",
  knowledge_refresh_after_failures: 1,
  deterministic_task: deterministicTaskSummary(run),
  deterministic_tool_policy: deterministicToolPolicy(deterministicTaskInput(run)),
  bounded_redesign_enabled: true,
  redesign_after_round: 2,
  redesign_metric_threshold: 0,
  hard_rules: [
    "execution provider/model must remain the configured upstream provider/model unless user intent is explicitly recorded",
    "DeepAgent identity boot message must originate from the DeepAgent gateway",
    "tool and MCP execution remain delegated to generic agent runtime",
    "hidden evaluator feedback is sealed audit only",
  ],
  artifact_policy: "refs_only_except_active_delta",
  skill_body_policy: "load_on_demand_excerpt_only",
  reason: run.routerDecision.reason,
})

const activationPolicy = (run: RunRecord) => ({
  schema_version: "deepagent_activation_policy.v1",
  activation_id: `activation:${run.runID}:r1`,
  run_id: run.runID,
  agent_mode: run.agentMode,
  default_activation_mode: activationMode(run.agentMode),
  first_turn_policy: "first_fast_design",
  knowledge_enabled: knowledgeEnabled(run.agentMode),
  escalation_triggers: [
    "validation_failed",
    "high_risk_change",
    "repeated_failure",
    "user_requests_deeper_reasoning",
    "insufficient_diagnostic_evidence",
  ],
  prompt_budget_policy: promptPolicy(run.agentMode),
  full_knowledge_in_prompt_allowed: false,
  full_skill_body_in_prompt_allowed: false,
  hidden_evaluator_feedback_allowed: false,
})

const mcpCapabilityIndex = (run: RunRecord) => {
  const caps = toolCapabilities(run)
  const mcpTools = caps.filter((c) => c.source === "mcp_or_namespaced_tool")
  const builtinTools = caps.filter((c) => c.source === "generic_agent_tool_registry")
  return {
    schema_version: "deepagent_mcp_capability_index.v1",
    run_id: run.runID,
    source_runtime: "generic_agent_mcp_registry",
    execution_owner: "generic_agent_tool_registry_or_mcp",
    provider_hosted_mcp_allowed: false,
    capabilities: caps,
    capability_summary: {
      total: caps.length,
      enabled: caps.length,
      unavailable: 0,
      mcp_server_tools: mcpTools.length,
      builtin_tools: builtinTools.length,
    },
    policy: {
      expose_tool_schema_refs_only: true,
      execute_mcp_directly_from_deepagent: false,
      require_opencode_approval_flow: true,
    },
  }
}

const knowledgeRetrievalResult = (run: RunRecord) => {
  const retrieval = retrieveKnowledge(run)
  const enabled = knowledgeEnabled(run.agentMode)
  return {
    schema_version: "deepagent_knowledge_retrieval_result.v1",
    run_id: run.runID,
    agent_mode: run.agentMode,
    enabled,
    retrieval_mode: enabled ? "v3_retriever" : "disabled",
    retriever: "packages/core/src/deepagent/knowledge-retriever.ts",
    query: knowledgeQueryForRun(run),
    candidate_refs: retrieval?.candidateRefs ?? [],
    selected_refs: retrieval?.selectedRefs ?? [],
    rejected_refs: retrieval?.rejectedRefs ?? [],
    synthesis: retrieval?.synthesis ?? null,
    conflicts: retrieval?.conflicts ?? [],
    do_not_use_refs: retrieval?.doNotUse ?? [],
    gap_analysis: retrieval?.gapAnalysis ?? [],
    scope_notes: ["No hidden/evaluator data is eligible for prompt, memory, strategy, or active knowledge."],
    retrieval_policy: {
      topk_by_kind: retrieval?.topkApplied ?? KnowledgeRetriever.TOPK_DEFAULT,
      evidence_threshold: KnowledgeRetriever.EVIDENCE_THRESHOLD,
      evidence_gated_kinds: [...KnowledgeRetriever.EVIDENCE_GATED_KINDS],
      min_relevance: 0,
      body_policy: "refs_and_short_synthesis_only",
      deterministic_ranking: true,
    },
    prompt_injection_policy: {
      inject_synthesis: enabled && Boolean(retrieval),
      inject_full_strategy_body: false,
      inject_full_memory_body: false,
      inject_full_skill_body: false,
    },
  }
}

const deterministicResultArtifact = (run: RunRecord) => {
  const input = deterministicTaskInput(run)
  const enabled = shouldActivateQueryControls(input)
  const policy = deterministicToolPolicy(input)
  const evidenceEvents = deterministicEvidenceEvents(run)
  const verifiedState = deterministicVerifiedState(enabled, evidenceEvents, policy)
  const resultSummary = deterministicResultSummary(run, verifiedState, evidenceEvents)
  return {
    schema_version: "deepagent_deterministic_result.v1",
    run_id: run.runID,
    enabled,
    task_kind: classifyDeterministicTask(input),
    active_pack_ids: input.activePackIds ?? [],
    verified_state: verifiedState,
    tool_policy: policy,
    result: enabled
      ? buildDeterministicResult(
          {
            kind: deterministicResultKindFor(policy.task_kind),
            source: evidenceEvents.length > 0 ? "tool" : "runner",
            commandOrQuery: userRequestForInput(run.input) ?? run.input.feature,
            resultSummary,
            resultRef: evidenceEvents[0]?.ref,
            createdAt: run.createdAt,
          },
          { maxSummaryChars: 2000 },
        )
      : null,
    evidence_refs: enabled ? ["HISTORY.md", "TOOL_AUDIT.json"] : [],
    mismatches: deterministicMismatches(run, enabled, verifiedState),
    final_answer_state: deterministicFinalAnswerState(enabled, verifiedState),
    completion_gate: {
      auto_complete_allowed: !enabled || verifiedState === "verified",
      reason:
        !enabled
          ? "deterministic controls inactive"
          : verifiedState === "verified"
            ? "deterministic evidence observed"
            : "deterministic task remains unverified; this is not a runtime failure",
    },
    token_policy: {
      extra_model_calls: 0,
      raw_tool_output_in_prompt: false,
      summary_max_chars: 2000,
    },
  }
}

const modelWorkPackage = (run: RunRecord) => {
  const selectedRefs = knowledgeRefsForRun(run)
  const selectedStrategyRefs = selectedRefs
    .filter((ref) => ref.ref_id.startsWith("strategy:"))
    .map((ref) => ref.ref_id)
  const selectedMemoryRefs = selectedRefs
    .filter((ref) => ref.ref_id.startsWith("memory:"))
    .map((ref) => ref.ref_id)
  const selectedMethodologyRefs = selectedRefs
    .filter((ref) => ref.ref_id.startsWith("methodology:"))
    .map((ref) => ref.ref_id)
  return {
  schema_version: "model_work_package.v1",
  work_package_id: run.workPackageID,
  task_id: run.taskID,
  round: 1,
  run_workspace_ref: `run_workspace:${run.runID}`,
  activation_ref: `activation:${run.runID}:r1`,
  activation_policy_ref: "ACTIVATION_POLICY.json",
  model_policy_ref: run.policyID,
  mcp_capability_index_ref: "MCP_CAPABILITY_INDEX.json",
  knowledge_retrieval_ref: "KNOWLEDGE_RETRIEVAL_RESULT.json",
  prompt_profile: "standard_code_agent",
  agent_mode: run.agentMode,
  activation_mode: activationMode(run.agentMode),
  knowledge_enabled: knowledgeEnabled(run.agentMode),
  prompt_policy_hash: promptPolicyHash(run),
  knowledge_policy_hash: knowledgePolicyHash(run.agentMode),
  goal: "Execute a DeepAgent-managed upstream provider turn without replacing provider execution.",
  task_summary: `DeepAgent global runtime call for ${run.input.feature}; app-wide control-plane artifacts are required.`,
  document_refs: [
    {
      ref_id: "doc:run_context",
      path: "RUN_CONTEXT.md",
      purpose: "mandatory per-run global runtime context summary",
      read_policy: "must_read_before_edit",
    },
    { ref_id: "doc:design", path: "DESIGN.md", purpose: "mandatory code-task design note", read_policy: "must_read_before_edit" },
    { ref_id: "doc:handoff", path: "HANDOFF.md", purpose: "mandatory continuation handoff", read_policy: "must_read_before_resume" },
    { ref_id: "doc:test", path: "TEST.md", purpose: "mandatory validation record", read_policy: "must_read_before_final" },
    { ref_id: "doc:history", path: "HISTORY.md", purpose: "private full run history", read_policy: "private_lookup_only" },
  ],
  artifact_refs: [
    { ref_id: "artifact:task_spec", path: "TASK_SPEC.json", artifact_type: "task_contract", visibility: "tool_only" },
    { ref_id: "artifact:run_state", path: "DEEPAGENT_RUN_STATE.json", artifact_type: "run_state", visibility: "model_visible" },
    { ref_id: "artifact:boot_message", path: "DEEPAGENT_BOOT_MESSAGE.md", artifact_type: "agent_identity", visibility: "model_visible" },
    {
      ref_id: "artifact:candidate_lineage",
      path: "CANDIDATE_LINEAGE.json",
      artifact_type: "candidate_lineage",
      visibility: "model_visible",
    },
    {
      ref_id: "artifact:output_contract",
      path: "OUTPUT_CONTRACT.json",
      artifact_type: "output_contract",
      visibility: "model_visible",
    },
    { ref_id: "artifact:checkpoint", path: "run_checkpoint_manifest.json", artifact_type: "checkpoint", visibility: "internal_ledger" },
    { ref_id: "artifact:tool_audit", path: "TOOL_AUDIT.json", artifact_type: "tool_audit", visibility: "internal_ledger" },
    { ref_id: "artifact:mcp_capability_index", path: "MCP_CAPABILITY_INDEX.json", artifact_type: "capability_index", visibility: "tool_only" },
    { ref_id: "artifact:activation_policy", path: "ACTIVATION_POLICY.json", artifact_type: "activation_policy", visibility: "model_visible" },
    { ref_id: "artifact:knowledge_retrieval", path: "KNOWLEDGE_RETRIEVAL_RESULT.json", artifact_type: "knowledge_result", visibility: "model_visible" },
    { ref_id: "artifact:deterministic_result", path: "DETERMINISTIC_RESULT.json", artifact_type: "deterministic_result", visibility: "model_visible" },
    { ref_id: "artifact:design", path: "DESIGN.md", artifact_type: "design_doc", visibility: "model_visible" },
    { ref_id: "artifact:handoff", path: "HANDOFF.md", artifact_type: "handoff_doc", visibility: "model_visible" },
    { ref_id: "artifact:test", path: "TEST.md", artifact_type: "test_doc", visibility: "model_visible" },
    { ref_id: "artifact:history", path: "HISTORY.md", artifact_type: "private_history", visibility: "private_run_only" },
  ],
  allowed_reads: [
    "RUN_CONTEXT.md",
    "DEEPAGENT_RUN_STATE.json",
    "DEEPAGENT_BOOT_MESSAGE.md",
    "CANDIDATE_LINEAGE.json",
    "OUTPUT_CONTRACT.json",
    "MODEL_ROUTER_AUDIT.json",
    "ACTIVATION_POLICY.json",
    "MCP_CAPABILITY_INDEX.json",
    "KNOWLEDGE_RETRIEVAL_RESULT.json",
    "DETERMINISTIC_RESULT.json",
    "DESIGN.md",
    "HANDOFF.md",
    "TEST.md",
  ],
  inline_context_policy: "minimal_summary",
  max_inline_chars: 6000,
  max_prompt_chars: 12000,
  max_candidate_inline_chars: 8000,
  bounded_redesign_enabled: true,
  prompt_budget_justification: "Global runtime runs inline only summary/control-plane refs; raw reasoning and hidden feedback remain excluded.",
  prompt_budget_audit: {
    max_prompt_chars: 12000,
    max_inline_chars: 6000,
    max_candidate_inline_chars: 8000,
    section_audits: [{ title: "DeepAgent global runtime task", raw_chars: 96, stored_chars: 96, truncated: false }],
    truncated: false,
    required_outputs_preserved: true,
    render_policy: "reserve_required_outputs_then_truncate_optional_sections",
  },
  selected_memory_refs: selectedMemoryRefs,
  selected_strategy_refs: selectedStrategyRefs,
  required_skill_refs: [],
  selected_methodology_refs: selectedMethodologyRefs,
  // docs/34 §9 S4/DAP-7: record the active domain pack set + locked snapshot so the run is
  // reproducible. activePackSnapshot is derived from the run's problem profile via the registry.
  active_pack_set: activePackSnapshot(run).packs.map((p) => p.id),
  pack_snapshot_id: activePackSnapshot(run).id,
  knowledge_retrieval: {
    enabled: knowledgeEnabled(run.agentMode),
    mode: knowledgeEnabled(run.agentMode) ? "bounded_retrieval_refs_only" : "disabled",
    selected_refs: selectedRefs.map((ref) => ref.ref_id),
    selected_ref_details: selectedRefs,
    do_not_use_refs: retrieveKnowledge(run)?.doNotUse ?? [],
    hidden_evaluator_feedback_allowed: false,
    full_skill_body_allowed: false,
  },
  deterministic_result: {
    ref: "DETERMINISTIC_RESULT.json",
    enabled: deterministicResultArtifact(run).enabled,
    task_kind: deterministicResultArtifact(run).task_kind,
    verified_state: deterministicResultArtifact(run).verified_state,
    read_only: deterministicResultArtifact(run).tool_policy.read_only,
    mismatches: deterministicResultArtifact(run).mismatches,
  },
  available_skill_index: [],
  mcp_capability_summary: {
    ref: "MCP_CAPABILITY_INDEX.json",
    execution_owner: "generic_agent_tool_registry_or_mcp",
    deepagent_executes_mcp_directly: false,
  },
  constraints: [
    "preserve generic agent tool registry and MCP execution",
    "keep configured upstream provider execution explicit and auditable",
    "do not include hidden evaluator feedback",
    ...(deterministicResultArtifact(run).tool_policy.read_only
      ? ["when deterministic query controls are active, prefer read-only evidence and treat mutation as denied until separately approved"]
      : []),
  ],
  materialization_plan_ref: null,
  anti_patterns: ["silent_provider_fallback", "hosted_tool_execution_without_allowlist", "hidden_feedback_prompt_injection"],
  required_outputs: ["DESIGN.md", "HANDOFF.md", "TEST.md", "HISTORY.md", "deepagent_generic_agent_binding.json", "run_checkpoint_manifest.json", "run_monitor_snapshot.json"],
  evidence_refs: [
    "doc:run_context",
    "doc:design",
    "doc:test",
    "artifact:run_state",
    "artifact:candidate_lineage",
    "artifact:output_contract",
    "artifact:deterministic_result",
  ],
  prompt_sections: [
    {
      title: "Runtime scope",
      content: "DeepAgent manages every upstream provider call and does not replace generic tool/MCP/session runtime.",
    },
    {
      title: "DeepAgent identity",
      content: bootMessage(run.agentMode),
    },
    ...(knowledgeEnabled(run.agentMode)
      ? [
          {
            title: "Knowledge mode",
            content: "Use bounded retrieval synthesis and refs only; do not inline full strategy, memory, skill body, logs, or hidden evaluator data.",
          },
        ]
      : []),
    ...(deterministicResultArtifact(run).enabled
      ? [
          {
            title: "Deterministic task status",
            content: "Use DETERMINISTIC_RESULT.json for verified/unverified state; unverified is not a runtime failure but blocks automatic high-confidence completion.",
          },
        ]
      : []),
  ],
  active_subsystems: ["run_binding", "checkpoint", "monitor", "ledger", "tool_audit", "model_router", "learning_gate", "deterministic_result"],
  skipped_subsystems: [
    "hidden_feedback_prompting",
    ...(knowledgeEnabled(run.agentMode) ? [] : ["knowledge_retrieval"]),
  ],
  }
}

const runContextStatus = (state: string): import("./deepagent/run-context").RunContextStatus =>
  state === "completed"
    ? "completed"
    : state === "failed"
    ? "runtime_failed"
    : state === "blocked"
    ? "blocked"
    : state === "cancelled"
    ? "cancelled"
    : "in_progress"

const runContextNextAction = (state: string): string =>
  state === "blocked" || state === "failed" || state === "cancelled"
    ? "review_required_before_resume"
    : "continue_or_complete"

const runContextRootCause = (state: string): string | null =>
  state === "blocked" ? "provider_executed_tool_blocked" : state === "cancelled" ? "user_or_runtime_interrupt" : null

const runContextInput = (run: RunRecord, state: string) => ({
    runId: run.runID,
    mode: run.agentMode,
    status: runContextStatus(state),
    round: 1,
    modelId: run.input.modelID,
    feature: run.input.feature,
    routerProvider: run.routerDecision.selected_provider_id,
    routerModel: run.routerDecision.selected_model_id,
    activationMode: activationMode(run.agentMode),
    knowledgeEnabled: knowledgeEnabled(run.agentMode),
    bestCandidateRef: "generic_agent_passthrough",
    nextAction: runContextNextAction(state),
    rootCause: runContextRootCause(state),
    bootMessage: bootMessage(run.agentMode),
  })

const runSummaryFor = (run: RunRecord, state: RunCloseState): RunSummary => {
  const failed = state === "failed" || state === "blocked" || state === "cancelled"
  const context = runContextInput(run, state)
  return {
    runId: run.runID,
    taskId: run.taskID,
    agentMode: run.agentMode,
    status: context.status,
    round: context.round,
    nextActionPolicy: context.nextAction,
    runContextMarkdown: buildRunContext(context),
    candidate: {
      summary: "generic_agent_passthrough",
      status: state === "completed" ? "validated" : failed ? "failed" : "generated",
    },
    ...(failed
      ? {
          diagnosis: {
            summary: `Run ${state}`,
            rootCause: context.rootCause,
            nextAction: context.nextAction,
          },
        }
      : {}),
    decision: { verdict: state === "completed" ? "accept" : "rollback", reason: `run ${state}` },
    learningCandidates: graphLearningCandidates(run),
  }
}

const runContext = (run: RunRecord, state: string) => runSummaryFor(run, state as RunCloseState).runContextMarkdown

const candidateLineage = (run: RunRecord, state: RunCloseState, summary = runSummaryFor(run, state)) => ({
  schema_version: "candidate_lineage.v1",
  run_id: run.runID,
  task_id: run.taskID,
  group: "production",
  nodes: [
    {
      round: 1,
      attempt: 1,
      candidate_ref: "generic_agent_passthrough",
      parent_candidate_ref: null,
      source_policy: "initial_candidate",
      status: summary.status === "runtime_failed" || summary.status === "blocked" ? "runtime_failed" : summary.status === "cancelled" ? "cancelled" : summary.candidate.status,
      primary_metric: null,
      min_metric: null,
      correctness: { status: "not_applicable", passed: null, total: null },
      decision_ref: "graph/decision",
      failure_dossier_ref: state === "failed" || state === "blocked" || state === "cancelled" ? (run.failureDossierRef ?? "FAILURE_DOSSIER.md") : null,
      notes:
        summary.status === "cancelled"
          ? ["Provider control-plane run was cancelled and preserved for resume review."]
          : summary.status === "runtime_failed" || summary.status === "blocked"
          ? ["Provider control-plane failure preserved for diagnosis and rollback."]
          : ["DeepAgent control plane preserved the generic agent passthrough candidate."],
    },
  ],
})

const outputContract = (run: RunRecord) => ({
  schema_version: "output_contract.v1",
  contract_id: `output-contract:${run.runID}`,
  accepted_formats: ["diagnosis_json"],
  deterministic_final_answer_state: deterministicResultArtifact(run).final_answer_state,
  deterministic_result_ref: "DETERMINISTIC_RESULT.json",
  materializer: "diagnosis_json_validate",
  raw_source_language: null,
  target_path: "generic_agent_output",
  json_wrapper_allowed: false,
  required_top_level_keys: [],
  postprocess_required: false,
  postprocess_steps: [],
  reject_if: ["raw_reasoning_exposed", "hidden_evaluator_feedback_included"],
  do_not_reject_if: ["deterministic_result_unverified_without_runtime_error"],
})

const diagnosisResult = (run: RunRecord, state: RunCloseState) => ({
  schema_version: "deepagent_diagnosis_result.v1",
  run_id: run.runID,
  round_id: run.roundID,
  status: state === "failed" || state === "blocked" || state === "cancelled" ? "required" : "not_required",
  trigger: state === "blocked" ? "policy_block" : state === "failed" ? "runtime_failure" : state === "cancelled" ? "cancelled" : "none",
  deterministic_result_ref: "DETERMINISTIC_RESULT.json",
  deterministic_status: deterministicResultArtifact(run).verified_state,
  deterministic_mismatches: deterministicResultArtifact(run).mismatches,
  root_cause: state === "blocked" ? "provider_executed_tool_blocked" : state === "cancelled" ? "user_or_runtime_interrupt" : null,
  evidence_refs: state === "failed" || state === "blocked" || state === "cancelled" ? [run.failureDossierRef ?? "FAILURE_DOSSIER.md"] : [],
  next_action: state === "blocked" || state === "failed" || state === "cancelled" ? "review_required_before_resume" : "continue_or_complete",
  rollback_policy: {
    enabled: true,
    rollback_owner: "generic_agent_file_session_runtime",
    best_candidate_ref: "generic_agent_passthrough",
  },
})

const resourceUsage = (run: RunRecord) => ({
  schema_version: "resource_usage_record.v1",
  record_id: run.resourceID,
  run_id: run.runID,
  sampled_at: new Date().toISOString(),
  gpu: { backend: "none", device_id: null, utilization_pct: 0, memory_used_mb: 0, power_watts: null, temperature_c: null },
  cpu: { utilization_pct: 0 },
  memory: { rss_mb: 0, cgroup_limit_mb: 0, oom_events: 0 },
  disk: { workspace_mb: 0, artifact_mb: 0 },
  network: { egress_bytes: 0, blocked_requests: 0 },
})

const resourceLatest = (run: RunRecord) => ({
  sampled_at: new Date().toISOString(),
  gpu_backend: "none",
  gpu_device_id: null,
  gpu_utilization_pct: 0,
  gpu_memory_used_mb: 0,
  cpu_utilization_pct: 0,
  rss_mb: 0,
  workspace_mb: 0,
  artifact_mb: 0,
  network_egress_bytes: 0,
})

const toolAudit = (run: RunRecord) => ({
  schema_version: "deepagent_tool_audit.v1",
  run_id: run.runID,
  execution_boundary: "generic_agent_tool_registry_and_mcp_preserved",
  provider_executed_tool_policy: run.config.providerExecutedToolPolicy,
  events: run.toolAuditEvents,
})

const modelRouterAudit = (run: RunRecord) => ({
  schema_version: "deepagent_model_router_audit.v1",
  run_id: run.runID,
  decisions: [run.routerDecision],
  silent_fallback_allowed: false,
  gateway_enforced: true,
  execution_contract:
    "DeepAgent does not silently switch generic provider execution. selected_provider_id is an auditable upstream intent used inside the configured deepagent model boundary.",
})

const learningWriteback = (run: RunRecord) => ({
  schema_version: "learning_writeback_manifest.v1",
  writeback_id: `writeback_${run.runID}`,
  source_run_id: run.runID,
  eval_mode: "production_user_task",
  created_at: run.createdAt,
  memory_candidates: learningCandidates(run, "memory"),
  skill_candidates: [],
  strategy_candidates: [
    { candidate_id: `strategy_candidate:${run.runID}:mode_contract`, status: "staged", source_ref: "MODEL_WORK_PACKAGE.json" },
    ...learningCandidates(run, "strategy"),
  ],
  methodology_candidates: learningCandidates(run, "methodology"),
  anti_pattern_candidates: [],
  rejected_candidate_refs: [],
  validation_gate_refs: ["learning_gate:no_hidden_lineage", "learning_gate:review_required_before_promotion"],
  active_snapshot_ref: null,
  candidate_extraction: {
    mode: "sync",
    max_sync_ms: 250,
    candidate_quota: 0,
    elapsed_ms: 0,
    background_job_ref: null,
  },
  policy_checks: [
    { check_id: "no_hidden_lineage", status: "pass" },
    { check_id: "review_required_before_active_promotion", status: "needs_review" },
  ],
  promotion_decision: "staged",
  target_scope: "run_local",
  review_record_refs: [],
})

const releaseGateAudit = (run: RunRecord) => ({
  schema_version: "deepagent_release_gate_audit.v1",
  run_id: run.runID,
  kill_switch_enabled: run.config.killSwitch,
  global_runtime_regression_scope: "all upstream providers enter DeepAgent runtime",
  global_runtime_e2e_required: true,
  checkpoint_resume_required: true,
  rollback_drill_required: true,
  blocking_issue_policy: "blocking_or_production_blocking_forces_release_block",
  schema_validation_required: true,
  upstream_provider_regression_required: true,
  max_knowledge_bounded_required: true,
  deterministic_result_required: true,
  deterministic_unverified_is_failure: false,
})

const learningCandidates = (run: RunRecord, kind: "strategy" | "methodology" | "memory") =>
  knowledgeRefsForRun(run)
    .filter((ref) => ref.kind === kind)
    .map((ref) => ({
      candidate_id: `${kind}_candidate:${run.runID}:${ref.ref_id}`,
      status: "staged",
      source_ref: "KNOWLEDGE_RETRIEVAL_RESULT.json",
      knowledge_ref: ref.ref_id,
      provenance: ref.provenance,
      relevance: ref.relevance,
      promotion_policy: "human_review_required",
    }))

const graphLearningCandidates = (run: RunRecord) =>
  (["memory", "strategy", "methodology"] as const).flatMap((kind) =>
    knowledgeRefsForRun(run)
      .filter((ref) => ref.kind === kind)
      .map((ref) => ({
        candidate_id: `${kind}_candidate:${run.runID}:${ref.ref_id}`,
        type: kind,
        status: "staged" as const,
        source_run_id: run.runID,
        source_round: 1,
        summary: ref.summary,
        evidence_refs: ["KNOWLEDGE_RETRIEVAL_RESULT.json", ref.ref_id],
        confidence: ref.relevance,
      })),
  )

const releaseBundle = (run: RunRecord) => ({
  schema_version: "deepagent_release_bundle_manifest.v1",
  run_id: run.runID,
  runtime_scope: "global",
  gateway_version: "deepagent-global-runtime.v1",
  agent_mode: run.agentMode,
  activation_mode: activationMode(run.agentMode),
  knowledge_enabled: knowledgeEnabled(run.agentMode),
  policy_hash: sha256({
    agentMode: run.agentMode,
    promptPolicyHash: promptPolicyHash(run),
    knowledgePolicyHash: knowledgePolicyHash(run.agentMode),
    providerExecutedToolPolicy: run.config.providerExecutedToolPolicy,
    allowProviderExecutedTools: run.config.allowProviderExecutedTools,
    allowProviderExecutedToolNames: run.config.allowProviderExecutedToolNames,
    killSwitch: run.config.killSwitch,
  }),
  model_router_config_hash: sha256(run.config.modelRouter),
  rollback: {
    disable_deepagent_runtime_preserves_upstream_providers: true,
    artifacts_retained_for_audit: true,
    memory_promotion_revocable: true,
  },
})

const checkpoint = (
  run: RunRecord,
  state: RunCloseState,
  refs: Record<string, string>,
) => ({
  schema_version: "run_checkpoint_manifest.v1",
  checkpoint_id: run.checkpointID,
  run_id: run.runID,
  task_id: run.taskID,
  group: "production",
  created_at: new Date().toISOString(),
  runner_config_hash: sha256({
    gateway: "deepagent-global-runtime",
    agentMode: run.agentMode,
    promptPolicyHash: promptPolicyHash(run),
    knowledgePolicyHash: knowledgePolicyHash(run.agentMode),
    modelRouter: run.config.modelRouter,
  }),
  state,
  attempt_counters: { model_calls: state === "opened" ? 0 : 1 },
  budget_counters: {
    input_tokens: run.usage.input_tokens,
    output_tokens: run.usage.output_tokens,
    reasoning_tokens: run.usage.reasoning_tokens,
  },
  conversation_summary_hash: sha256({
    session: sessionID(run),
    message: messageID(run),
    latestEvents: run.latestEvents,
  }),
  workspace_state_hash: sha256({
    workspace: run.input.workspaceID ?? "unknown-workspace",
    feature: run.input.feature,
  }),
  artifact_refs: [
    "DEEPAGENT_BOOT_MESSAGE.md",
    "TASK_SPEC.json",
    "PROBLEM_PROFILE.json",
    "MODEL_WORK_PACKAGE.json",
    "DESIGN.md",
    "HANDOFF.md",
    "TEST.md",
    "HISTORY.md",
    "MODEL_RUNTIME_POLICY.json",
    "ACTIVATION_POLICY.json",
    "MCP_CAPABILITY_INDEX.json",
    "KNOWLEDGE_RETRIEVAL_RESULT.json",
    "DETERMINISTIC_RESULT.json",
    "DIAGNOSIS_RESULT.json",
    "SCHEMA_VALIDATION_REPORT.json",
    "deepagent_generic_agent_binding.json",
    "token_usage_ledger.json",
    "resource_usage_record.json",
    "TOOL_AUDIT.json",
    "MODEL_ROUTER_AUDIT.json",
    "LEARNING_WRITEBACK_MANIFEST.json",
    "RELEASE_GATE_AUDIT.json",
  ],
  run_context_refs: [
    { kind: "run_state", ref: "DEEPAGENT_RUN_STATE.json", sha256: refs["DEEPAGENT_RUN_STATE.json"] ?? null },
    { kind: "boot_message", ref: "DEEPAGENT_BOOT_MESSAGE.md", sha256: refs["DEEPAGENT_BOOT_MESSAGE.md"] ?? null },
    { kind: "run_context", ref: "RUN_CONTEXT.md", sha256: refs["RUN_CONTEXT.md"] ?? null },
    { kind: "design", ref: "DESIGN.md", sha256: refs["DESIGN.md"] ?? null },
    { kind: "handoff", ref: "HANDOFF.md", sha256: refs["HANDOFF.md"] ?? null },
    { kind: "test", ref: "TEST.md", sha256: refs["TEST.md"] ?? null },
    { kind: "history_private", ref: "HISTORY.md", sha256: refs["HISTORY.md"] ?? null },
    { kind: "activation_policy", ref: "ACTIVATION_POLICY.json", sha256: refs["ACTIVATION_POLICY.json"] ?? null },
    { kind: "mcp_capability_index", ref: "MCP_CAPABILITY_INDEX.json", sha256: refs["MCP_CAPABILITY_INDEX.json"] ?? null },
    { kind: "knowledge_retrieval", ref: "KNOWLEDGE_RETRIEVAL_RESULT.json", sha256: refs["KNOWLEDGE_RETRIEVAL_RESULT.json"] ?? null },
    { kind: "deterministic_result", ref: "DETERMINISTIC_RESULT.json", sha256: refs["DETERMINISTIC_RESULT.json"] ?? null },
    { kind: "schema_validation", ref: "SCHEMA_VALIDATION_REPORT.json", sha256: refs["SCHEMA_VALIDATION_REPORT.json"] ?? null },
    { kind: "candidate_lineage", ref: "CANDIDATE_LINEAGE.json", sha256: refs["CANDIDATE_LINEAGE.json"] ?? null },
    { kind: "output_contract", ref: "OUTPUT_CONTRACT.json", sha256: refs["OUTPUT_CONTRACT.json"] ?? null },
    ...(run.failureDossierRef ? [{ kind: "failure_dossier", ref: "FAILURE_DOSSIER.md", sha256: refs["FAILURE_DOSSIER.md"] ?? null }] : []),
  ],
  artifact_hashes: Object.entries(refs).map(([ref, hash]) => ({ ref, sha256: hash })),
  token_ledger_refs: [`token_usage_ledger:${run.runID}:${run.requestID}`],
  resource_usage_refs: [`resource_usage_record:${run.resourceID}`],
  human_intervention_refs: run.humanInterventions.map((intervention) => `human_intervention_record:${intervention.intervention_id}`),
  resume_policy: {
    decision: state === "failed" || state === "blocked" || state === "cancelled" ? "review_required" : "resume_allowed",
    reason:
      state === "failed" || state === "blocked" || state === "cancelled"
        ? "Run has blocking/failure state; resume requires review and matching checkpoint hash."
        : "DeepAgent checkpoint contains run context, ledger and resource references.",
  },
})

const humanInterventionRecord = (run: RunRecord) => {
  const intervention = run.humanInterventions[run.humanInterventions.length - 1]!
  return {
    schema_version: "human_intervention_record.v1",
    intervention_id: intervention.intervention_id,
    run_id: run.runID,
    actor: "deepagent-gateway",
    created_at: new Date().toISOString(),
    intervention_type: intervention.intervention_type,
    decision: intervention.decision,
    reason: intervention.reason,
    evidence_refs: [`run_checkpoint_manifest:${run.checkpointID}`],
    comparability_impact: "must_report",
  }
}

const monitor = (
  run: RunRecord,
  state: RunCloseState,
  refs: Record<string, string>,
) => ({
  schema_version: "run_monitor_snapshot.v1",
  snapshot_id: `run_monitor_snapshot:${run.runID}`,
  run_id: run.runID,
  task_id: run.taskID,
  group: "deepagent_global_runtime",
  state,
  sampled_at: new Date().toISOString(),
  event_count: run.eventCount,
  latest_events: run.latestEvents,
  token_totals: run.usage,
  resource_latest: resourceLatest(run),
  artifact_refs: [
    { kind: "task_spec", ref: "TASK_SPEC.json", sha256: refs["TASK_SPEC.json"] ?? null },
    { kind: "boot_message", ref: "DEEPAGENT_BOOT_MESSAGE.md", sha256: refs["DEEPAGENT_BOOT_MESSAGE.md"] ?? null },
    { kind: "problem_profile", ref: "PROBLEM_PROFILE.json", sha256: refs["PROBLEM_PROFILE.json"] ?? null },
    { kind: "model_work_package", ref: "MODEL_WORK_PACKAGE.json", sha256: refs["MODEL_WORK_PACKAGE.json"] ?? null },
    { kind: "activation_policy", ref: "ACTIVATION_POLICY.json", sha256: refs["ACTIVATION_POLICY.json"] ?? null },
    { kind: "mcp_capability_index", ref: "MCP_CAPABILITY_INDEX.json", sha256: refs["MCP_CAPABILITY_INDEX.json"] ?? null },
    { kind: "knowledge_retrieval", ref: "KNOWLEDGE_RETRIEVAL_RESULT.json", sha256: refs["KNOWLEDGE_RETRIEVAL_RESULT.json"] ?? null },
    { kind: "deterministic_result", ref: "DETERMINISTIC_RESULT.json", sha256: refs["DETERMINISTIC_RESULT.json"] ?? null },
    { kind: "diagnosis_result", ref: "DIAGNOSIS_RESULT.json", sha256: refs["DIAGNOSIS_RESULT.json"] ?? null },
    { kind: "schema_validation", ref: "SCHEMA_VALIDATION_REPORT.json", sha256: refs["SCHEMA_VALIDATION_REPORT.json"] ?? null },
    { kind: "run_state", ref: "DEEPAGENT_RUN_STATE.json", sha256: refs["DEEPAGENT_RUN_STATE.json"] ?? null },
    { kind: "run_context", ref: "RUN_CONTEXT.md", sha256: refs["RUN_CONTEXT.md"] ?? null },
    { kind: "design", ref: "DESIGN.md", sha256: refs["DESIGN.md"] ?? null },
    { kind: "handoff", ref: "HANDOFF.md", sha256: refs["HANDOFF.md"] ?? null },
    { kind: "test", ref: "TEST.md", sha256: refs["TEST.md"] ?? null },
    { kind: "history_private", ref: "HISTORY.md", sha256: refs["HISTORY.md"] ?? null },
    { kind: "candidate_lineage", ref: "CANDIDATE_LINEAGE.json", sha256: refs["CANDIDATE_LINEAGE.json"] ?? null },
    { kind: "output_contract", ref: "OUTPUT_CONTRACT.json", sha256: refs["OUTPUT_CONTRACT.json"] ?? null },
    { kind: "binding", ref: "deepagent_generic_agent_binding.json", sha256: refs["deepagent_generic_agent_binding.json"] ?? null },
    { kind: "tool_audit", ref: "TOOL_AUDIT.json", sha256: refs["TOOL_AUDIT.json"] ?? null },
    { kind: "router_audit", ref: "MODEL_ROUTER_AUDIT.json", sha256: refs["MODEL_ROUTER_AUDIT.json"] ?? null },
    { kind: "learning_writeback", ref: "LEARNING_WRITEBACK_MANIFEST.json", sha256: refs["LEARNING_WRITEBACK_MANIFEST.json"] ?? null },
    { kind: "release_gate", ref: "RELEASE_GATE_AUDIT.json", sha256: refs["RELEASE_GATE_AUDIT.json"] ?? null },
  ],
  checkpoint_refs: [
    { kind: "checkpoint", ref: "run_checkpoint_manifest.json", sha256: refs["run_checkpoint_manifest.json"] ?? null },
  ],
  intervention_refs: run.humanInterventions.map((intervention) => ({
    kind: intervention.intervention_type,
    ref: "human_intervention_record.json",
    sha256: refs["human_intervention_record.json"] ?? null,
  })),
  reasoning: {
    visible: false,
    status: reasoningStatus(run.latestEvents.map((event) => event.event_type)),
    summary: null,
    source_event_types: [],
    raw_hidden: true,
  },
})

const writeFailureDossier = async (run: RunRecord, failure: unknown) => {
  await mkdir(run.dir, { recursive: true })
  const ref = "FAILURE_DOSSIER.md"
  const content = failureDossierText(run, failure)
  run.failureDossierText = content
  await writeFile(path.join(run.dir, ref), content, "utf8")
  return `failure_dossier:${run.runID}`
}

const failureDossierText = (run: RunRecord, failure: unknown) =>
  [
    "Failure type: deepagent_global_runtime_block",
    `Observed symptom: ${failureMessage(failure)}`,
    `Evidence refs: ${run.bindingID}`,
    "Blocked actions: do not bypass the DeepAgent runtime",
    "Required next action: fix DeepAgent gateway policy/config or use the internal kill switch with fail-closed reporting",
    "",
  ].join("\n")

const ARTIFACT_SCHEMAS: Record<string, { schema_version: string; required_keys: string[] }> = {
  "TASK_SPEC.json": { schema_version: "task_spec.v1", required_keys: ["task_id", "task_type", "goals", "success_criteria", "allowed_actions", "budgets"] },
  "PROBLEM_PROFILE.json": { schema_version: "problem_profile.v1", required_keys: ["task_type", "domain", "signals"] },
  "MODEL_RUNTIME_POLICY.json": { schema_version: "model_runtime_policy.v1", required_keys: ["policy_id", "model_id", "agent_mode", "hard_rules"] },
  "ACTIVATION_POLICY.json": { schema_version: "deepagent_activation_policy.v1", required_keys: ["activation_id", "run_id", "agent_mode", "knowledge_enabled"] },
  "MCP_CAPABILITY_INDEX.json": { schema_version: "deepagent_mcp_capability_index.v1", required_keys: ["run_id", "capabilities", "capability_summary", "policy"] },
  "KNOWLEDGE_RETRIEVAL_RESULT.json": { schema_version: "deepagent_knowledge_retrieval_result.v1", required_keys: ["run_id", "enabled", "retrieval_mode", "selected_refs"] },
  "DETERMINISTIC_RESULT.json": { schema_version: "deepagent_deterministic_result.v1", required_keys: ["run_id", "enabled", "task_kind", "verified_state", "tool_policy"] },
  "MODEL_WORK_PACKAGE.json": { schema_version: "model_work_package.v1", required_keys: ["work_package_id", "task_id", "agent_mode", "goal", "artifact_refs"] },
  "DIAGNOSIS_RESULT.json": { schema_version: "deepagent_diagnosis_result.v1", required_keys: ["run_id", "status", "trigger", "next_action"] },
  // NOTE: the round report (deepagent-code.round_report.v1) is a session-layer macro-round artifact
  // persisted by PromptDraftStore.saveRoundReport, NOT a gateway run artifact — the gateway never
  // produces it, so it is intentionally absent from this run-artifact registry.
  "DEEPAGENT_RUN_STATE.json": { schema_version: "deepagent_global_run_state.v1", required_keys: ["run_id", "provider_id", "agent_mode", "state"] },
  "CANDIDATE_LINEAGE.json": { schema_version: "candidate_lineage.v1", required_keys: ["run_id", "task_id", "group", "nodes"] },
  "OUTPUT_CONTRACT.json": { schema_version: "output_contract.v1", required_keys: ["contract_id", "accepted_formats", "reject_if"] },
  "deepagent_generic_agent_binding.json": { schema_version: "deepagent_generic_agent_binding.v1", required_keys: ["binding_id", "agent_run_id", "agent_mode"] },
  "token_usage_ledger.json": { schema_version: "token_usage_ledger.v1", required_keys: ["ledger_id", "run_id", "request_id"] },
  "resource_usage_record.json": { schema_version: "resource_usage_record.v1", required_keys: ["record_id", "run_id", "gpu", "cpu", "memory"] },
  "TOOL_AUDIT.json": { schema_version: "deepagent_tool_audit.v1", required_keys: ["run_id", "execution_boundary", "events"] },
  "MODEL_ROUTER_AUDIT.json": { schema_version: "deepagent_model_router_audit.v1", required_keys: ["run_id", "decisions"] },
  "LEARNING_WRITEBACK_MANIFEST.json": { schema_version: "learning_writeback_manifest.v1", required_keys: ["writeback_id", "source_run_id", "promotion_decision"] },
  "RELEASE_GATE_AUDIT.json": { schema_version: "deepagent_release_gate_audit.v1", required_keys: ["run_id", "kill_switch_enabled", "schema_validation_required"] },
  "release_bundle_manifest.json": { schema_version: "deepagent_release_bundle_manifest.v1", required_keys: ["run_id", "agent_mode", "policy_hash"] },
}

const validateArtifact = (name: string, value: unknown): { status: SchemaValidationStatus; errors: string[] } => {
  if (value === undefined) return { status: "fail", errors: ["artifact missing"] }
  if (name.endsWith(".md")) return { status: typeof value === "string" && value.length > 0 ? "pass" : "fail", errors: typeof value === "string" && value.length > 0 ? [] : ["empty markdown content"] }
  if (!isRecord(value)) return { status: "fail", errors: ["artifact is not an object"] }
  const schema = ARTIFACT_SCHEMAS[name]
  if (!schema) return { status: "pass", errors: [] }
  const errors: string[] = []
  if (value.schema_version !== schema.schema_version) errors.push(`schema_version mismatch: expected ${schema.schema_version}, got ${String(value.schema_version)}`)
  for (const key of schema.required_keys) {
    if (!(key in value)) errors.push(`missing required key: ${key}`)
  }
  return { status: errors.length === 0 ? "pass" : "fail", errors }
}

const schemaValidationReport = (artifacts: Record<string, unknown>) => {
  const required = [
    "TASK_SPEC.json",
    "PROBLEM_PROFILE.json",
    "MODEL_RUNTIME_POLICY.json",
    "ACTIVATION_POLICY.json",
    "MCP_CAPABILITY_INDEX.json",
    "KNOWLEDGE_RETRIEVAL_RESULT.json",
    "DETERMINISTIC_RESULT.json",
    "MODEL_WORK_PACKAGE.json",
    "DIAGNOSIS_RESULT.json",
    "DEEPAGENT_RUN_STATE.json",
    "RUN_CONTEXT.md",
    "DESIGN.md",
    "HANDOFF.md",
    "TEST.md",
    "HISTORY.md",
    "CANDIDATE_LINEAGE.json",
    "OUTPUT_CONTRACT.json",
    "deepagent_generic_agent_binding.json",
    "token_usage_ledger.json",
    "resource_usage_record.json",
    "TOOL_AUDIT.json",
    "MODEL_ROUTER_AUDIT.json",
    "LEARNING_WRITEBACK_MANIFEST.json",
    "RELEASE_GATE_AUDIT.json",
    "release_bundle_manifest.json",
  ]
  const checks = required.map((name) => {
    const result = validateArtifact(name, artifacts[name])
    return {
      artifact: name,
      status: result.status,
      schema_ref: ARTIFACT_SCHEMAS[name]?.schema_version ?? `${name}:content-contract`,
      errors: result.errors.length > 0 ? result.errors : undefined,
    }
  })
  const crossChecks = validateArtifactGraph(artifacts, required)
  const allChecks = [...checks, ...crossChecks]
  return {
    schema_version: "deepagent_schema_validation_report.v1",
    status: allChecks.every((check) => check.status === "pass") ? "pass" : ("fail" satisfies SchemaValidationStatus),
    validator: "structural_and_cross_artifact_contract_validator",
    generated_at: new Date().toISOString(),
    checks,
    cross_checks: crossChecks,
  }
}

const validateArtifactGraph = (artifacts: Record<string, unknown>, required: readonly string[]) => {
  const checks: Array<{ artifact: string; status: SchemaValidationStatus; schema_ref: string; errors?: string[] }> = []
  const runState = artifacts["DEEPAGENT_RUN_STATE.json"]
  const runID = isRecord(runState) ? stringValue(runState.run_id) : undefined
  const runIDArtifacts = [
    "MCP_CAPABILITY_INDEX.json",
    "KNOWLEDGE_RETRIEVAL_RESULT.json",
    "DETERMINISTIC_RESULT.json",
    "DIAGNOSIS_RESULT.json",
    "MODEL_ROUTER_AUDIT.json",
    "LEARNING_WRITEBACK_MANIFEST.json",
    "RELEASE_GATE_AUDIT.json",
    "release_bundle_manifest.json",
  ]
  const runIDErrors = runIDArtifacts.flatMap((name) => {
    const value = artifacts[name]
    if (!isRecord(value)) return [`${name} is not an object`]
    const artifactRunID = stringValue(value.run_id) ?? stringValue(value.source_run_id)
    return artifactRunID === runID ? [] : [`${name} run_id mismatch: expected ${runID}, got ${artifactRunID ?? "missing"}`]
  })
  checks.push({
    artifact: "artifact_graph:run_id_consistency",
    status: runID && runIDErrors.length === 0 ? "pass" : "fail",
    schema_ref: "deepagent.cross_artifact.run_id.v1",
    errors: runIDErrors.length > 0 ? runIDErrors : undefined,
  })

  const knowledge = artifacts["KNOWLEDGE_RETRIEVAL_RESULT.json"]
  const workPackage = artifacts["MODEL_WORK_PACKAGE.json"]
  const knowledgeRefs = isRecord(knowledge) && Array.isArray(knowledge.selected_refs)
    ? knowledge.selected_refs.flatMap((ref) => (isRecord(ref) && typeof ref.ref_id === "string" ? [ref.ref_id] : []))
    : []
  const workPackageRefs = isRecord(workPackage) && isRecord(workPackage.knowledge_retrieval) && Array.isArray(workPackage.knowledge_retrieval.selected_refs)
    ? workPackage.knowledge_retrieval.selected_refs.filter((ref): ref is string => typeof ref === "string")
    : []
  const refErrors = arraysEqual(knowledgeRefs, workPackageRefs)
    ? []
    : [`knowledge selected_refs differ from work package refs: ${knowledgeRefs.join(",")} != ${workPackageRefs.join(",")}`]
  checks.push({
    artifact: "artifact_graph:knowledge_ref_consistency",
    status: refErrors.length === 0 ? "pass" : "fail",
    schema_ref: "deepagent.cross_artifact.knowledge_refs.v1",
    errors: refErrors.length > 0 ? refErrors : undefined,
  })

  const checkpoint = artifacts["run_checkpoint_manifest.json"]
  const checkpointHashes = isRecord(checkpoint) && Array.isArray(checkpoint.artifact_hashes)
    ? new Set(
        checkpoint.artifact_hashes.flatMap((item) =>
          isRecord(item) && typeof item.ref === "string" && typeof item.sha256 === "string" ? [item.ref] : [],
        ),
      )
    : new Set<string>()
  const missingHashes = required.filter((name) => name !== "run_checkpoint_manifest.json" && !checkpointHashes.has(name))
  checks.push({
    artifact: "artifact_graph:checkpoint_hash_coverage",
    status: missingHashes.length === 0 ? "pass" : "fail",
    schema_ref: "deepagent.cross_artifact.checkpoint_hashes.v1",
    errors: missingHashes.length > 0 ? missingHashes.map((name) => `missing checkpoint artifact hash: ${name}`) : undefined,
  })
  return checks
}

const arraysEqual = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && left.every((item, index) => item === right[index])

const emptyUsage = (): TokenUsage => ({
  input_tokens: 0,
  output_tokens: 0,
  cached_input_tokens: 0,
  reasoning_tokens: 0,
  tool_result_tokens: 0,
  estimated_cost: 0,
  currency: "USD",
})

const isDeniedProviderExecutedTool = (run: RunRecord, event: LLMEventType) =>
  isProviderToolEvent(event) && event.providerExecuted === true && !isAllowedProviderExecutedTool(run, event)

const isAllowedProviderExecutedTool = (run: RunRecord, event: LLMEventType) =>
  run.config.allowProviderExecutedTools &&
  isProviderToolEvent(event) &&
  run.config.allowProviderExecutedToolNames.includes(event.name)

const isProviderToolEvent = (event: LLMEventType) => LLMEvent.is.toolCall(event) || LLMEvent.is.toolResult(event)

const providerExecutedToolError = (event: LLMEventType) =>
  new LLMError({
    module: "AgentGateway",
    method: "providerExecutedToolPolicy",
    reason: new InvalidRequestReason({
      message: `DeepAgent blocked provider-executed tool "${toolEventName(event)}" because hosted/server-side tools must be explicitly allowlisted`,
    }),
  })

const toolEventName = (event: LLMEventType) => (isProviderToolEvent(event) ? event.name : "unknown")

const cloneConfig = (config: CurrentConfig): CurrentConfig => ({
  ...config,
  allowProviderExecutedToolNames: [...config.allowProviderExecutedToolNames],
  modelRouter: { ...config.modelRouter },
  resumeFrom: config.resumeFrom ? { ...config.resumeFrom } : undefined,
})

const gatewayBlocked = (message: string) =>
  new LLMError({
    module: "AgentGateway",
    method: "open",
    reason: new InvalidRequestReason({ message }),
  })

const failureMessage = (error: unknown) => {
  if (isCause(error) && Cause.hasInterrupts(error)) return "DeepAgent run was interrupted or cancelled"
  if (error instanceof Error) return error.message
  return String(error)
}

const stringValue = (value: unknown) => (typeof value === "string" && value.length > 0 ? value : undefined)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isCause = (value: unknown): value is Cause.Cause<unknown> =>
  isRecord(value) && Array.isArray(value.reasons)

const toolCapabilities = (run: RunRecord) => {
  const deepagent = run.input.metadata && isRecord(run.input.metadata.deepagent) ? run.input.metadata.deepagent : {}
  const raw = Array.isArray(deepagent.tool_capabilities) ? deepagent.tool_capabilities : []
  return raw.filter(isRecord).map((item) => ({
    name: stringValue(item.name) ?? "unknown_tool",
    source: stringValue(item.source) ?? "generic_agent_tool_registry",
    execution_owner: "generic_agent_tool_registry_or_mcp",
    risk: stringValue(item.risk) ?? "local_approval_policy",
  }))
}

const deterministicTaskInput = (run: RunRecord) => ({
  raw: userRequestForInput(run.input) ?? run.input.feature,
  repoSignals: [run.input.feature, ...(extractProblemProfile(run).signals ?? [])],
  activePackIds: activePackSnapshot(run).packs.map((pack) => pack.id),
})

const deterministicTaskSummary = (run: RunRecord) => {
  const input = deterministicTaskInput(run)
  return {
    kind: classifyDeterministicTask(input),
    enabled: shouldActivateQueryControls(input),
    active_pack_ids: input.activePackIds ?? [],
    result_ref: "DETERMINISTIC_RESULT.json",
  }
}

const deterministicEvidenceEvents = (run: RunRecord) =>
  run.historyEvents
    .map((event, index) => ({ event, ref: `HISTORY.md#event-${index + 1}` }))
    .filter(({ event }) => event.event_type === "tool-result")

const deterministicVerifiedState = (
  enabled: boolean,
  evidenceEvents: ReturnType<typeof deterministicEvidenceEvents>,
  policy: ReturnType<typeof deterministicToolPolicy>,
) => {
  if (!enabled) return "not_applicable"
  if (policy.read_only && mutatingToolEvents(policy, evidenceEvents).length > 0) return "blocked"
  return evidenceEvents.length > 0 ? "verified" : "unverified"
}

const deterministicResultKindFor = (kind: ReturnType<typeof classifyDeterministicTask>) =>
  kind === "validation_status"
    ? "validation"
    : kind === "state_inspection"
      ? "environment"
      : "query"

const deterministicResultSummary = (
  run: RunRecord,
  verifiedState: string,
  evidenceEvents: ReturnType<typeof deterministicEvidenceEvents>,
) => {
  if (verifiedState === "not_applicable") return "Deterministic controls were not active for this run."
  if (evidenceEvents.length === 0) {
    return `No tool or runner result was observed for deterministic request "${userRequestForInput(run.input) ?? run.input.feature}". The answer state is unverified, not failed.`
  }
  return `Observed ${evidenceEvents.length} tool result event(s) for deterministic request "${userRequestForInput(run.input) ?? run.input.feature}". Use HISTORY.md and TOOL_AUDIT.json as runner evidence.`
}

const deterministicMismatches = (run: RunRecord, enabled: boolean, verifiedState: string) => {
  if (!enabled) return []
  const policy = deterministicToolPolicy(deterministicTaskInput(run))
  const mutationEvents = mutatingToolEvents(policy, deterministicEvidenceEvents(run))
  return [
    ...(verifiedState === "unverified" && modelClaimsDeterministicSuccess(run)
      ? [
          {
            field: "deterministic_result",
            detail: "model output appears to claim success for a deterministic task, but no tool or runner evidence was observed",
          },
        ]
      : []),
    ...mutationEvents.map((event) => ({
      field: "tool_policy",
      detail: `read-only deterministic task observed mutating tool result: ${event.event.event_type}`,
    })),
  ]
}

const deterministicFinalAnswerState = (enabled: boolean, verifiedState: string) =>
  !enabled ? "not_applicable" : verifiedState === "verified" ? "verified" : "unverified"

const mutatingToolEvents = (
  policy: ReturnType<typeof deterministicToolPolicy>,
  evidenceEvents: ReturnType<typeof deterministicEvidenceEvents>,
) =>
  evidenceEvents.filter(({ event }) => {
    const name = stringValue(event.payload.name) ?? stringValue(event.payload.tool_name) ?? ""
    return policy.denied_actions.some((action) => name.toLowerCase().includes(action))
  })

const modelClaimsDeterministicSuccess = (run: RunRecord) =>
  /\b(done|complete|completed|success|successful|passed|tests pass|all good)\b|完成|通过|成功/i.test(
    run.historyEvents.map((event) => JSON.stringify(event.payload)).join("\n"),
  )

function parseAllowlist(value: string | undefined) {
  return (
    value
      ?.split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0) ?? []
  )
}

function parseAgentMode(value: string | undefined): AgentMode {
  return value === "general" || value === "high" || value === "xhigh" || value === "max" || value === "ultra" ? value : "high"
}

const retrieveKnowledge = (run: RunRecord) => {
  const task = extractTaskContext(run)
  const workspacePath = workspacePathForInput(run.input)
  return KnowledgeRetriever.retrieve({
    mode: run.agentMode,
    task,
    tools: extractToolContext(run),
    round: 1,
    previousFailures: 0,
    profile: extractProblemProfile(run),
    // docs/34 §8: scope durable retrieval to the run's workspace path (unions user-global +
    // this workspace's project-shared). Absent workspace => user-global only.
    ...(workspacePath ? { workspacePath } : {}),
  })
}

const knowledgeRefsForRun = (run: RunRecord) => retrieveKnowledge(run)?.selectedRefs ?? []

const knowledgeQueryForRun = (run: RunRecord) => {
  const task = extractTaskContext(run)
  const tools = extractToolContext(run)
  const profile = extractProblemProfile(run)
  return {
    task_type: task.taskType,
    domain: task.domain,
    user_request: task.userRequest,
    tool_count: tools.totalToolCount,
    mcp_servers: tools.mcpServers.map((server) => ({ name: server.name, tool_count: server.toolCount })),
    problem_profile: profile,
  }
}

const extractTaskContext = (run: RunRecord): KnowledgeRetriever.RetrievalInput["task"] => ({
  userRequest: run.input.feature,
  taskType: "code_modification",
  domain: "code",
  goals: [],
  successCriteria: [],
  riskBoundaries: [],
  validationCommands: [],
})

const extractToolContext = (run: RunRecord): KnowledgeRetriever.RetrievalInput["tools"] => ({
  availableTools: toolCapabilities(run).map((tool) => ({
    name: tool.name,
    source: tool.source === "mcp_or_namespaced_tool" ? "mcp" : "builtin",
    description: tool.risk,
  })),
  mcpServers: mcpServersForRun(run),
  totalToolCount: toolCapabilities(run).length,
})

const mcpServersForRun = (run: RunRecord): KnowledgeRetriever.RetrievalInput["tools"]["mcpServers"] => {
  const counts = new Map<string, number>()
  for (const tool of toolCapabilities(run)) {
    if (tool.source !== "mcp_or_namespaced_tool") continue
    const server = tool.name.includes(":") ? tool.name.split(":")[0]! : "mcp"
    counts.set(server, (counts.get(server) ?? 0) + 1)
  }
  return [...counts.entries()].map(([name, toolCount]) => ({ name, toolCount }))
}

const extractProblemProfile = (run: RunRecord): ProblemProfile => {
  const caps = toolCapabilities(run)
  const hasMcpTools = caps.some((c) => c.source === "mcp_or_namespaced_tool")
  return {
    domain: "code",
    backend: "bun",
    language: "typescript",
    framework: "generic-agent",
    signals: [run.input.feature, run.input.callKind, hasMcpTools ? "mcp" : "local-tools"],
  }
}

// docs/34 §9 DAP-7: lock the active domain pack snapshot for a run so each run records the exact
// pack set that shaped its knowledge retrieval. Best-effort: if the registry has no configured
// dir or discover returns nothing, the snapshot is empty (no packs) — retrieval still works.
const activePackSnapshot = (run: RunRecord): DeepAgentDomainPackRegistry.PackSnapshot => {
  if (!DeepAgentDomainPackRegistry.isRegistryConfigured()) {
    return { id: "pack_snapshot:empty", packs: [], created_at: new Date().toISOString() }
  }
  try {
    const signals = run.input.feature ?? ""
    const profile: DeepAgentDomainPackRegistry.ExtendedProblemProfile = {
      scenario_mode: "wish",
      agent_strength: run.agentMode as DeepAgentDomainPackRegistry.ExtendedProblemProfile["agent_strength"],
      task_kind: "implement",
      code_domains: ["code"],
      business_domains: [],
      platforms: [],
      languages: ["typescript"],
      frameworks: [],
      data_classes: [],
      risk_markers: [],
      repo_signals: [signals],
      round_signals: [],
      user_overrides: [],
    }
    const { snapshot } = DeepAgentDomainPackRegistry.activateForProfile(profile)
    return snapshot
  } catch {
    return { id: "pack_snapshot:error", packs: [], created_at: new Date().toISOString() }
  }
}

const activationMode = (mode: AgentMode) =>
  knowledgeEnabled(mode) ? "first_fast_design_bounded_knowledge" : "first_fast_design"

const bootMessage = (mode: AgentMode) =>
  mode === "ultra"
    ? `${DEEPAGENT_BOOT_MESSAGE}\n当前模式: ultra。具备 max 的全部能力（bounded knowledge retrieval，仅 refs/摘要），并由监督线程自动推进宏轮直至收敛；遇到范围变化、反复无进展或预算阈值时升级给人。`
    : mode === "max"
    ? `${DEEPAGENT_BOOT_MESSAGE}\n当前模式: max。启用完整 bounded knowledge retrieval（strategies/methodologies/knowledge/skills/memory），仅使用摘要和 refs，不注入完整知识库正文。`
    : mode === "xhigh"
    ? `${DEEPAGENT_BOOT_MESSAGE}\n当前模式: xhigh。启用领域知识 + skills + 跨项目事实记忆的 bounded retrieval；strategies/methodologies 不开放，避免在错误任务上下文中误导模型。`
    : mode === "high"
    ? `${DEEPAGENT_BOOT_MESSAGE}\n当前模式: high。启用 skills + 项目上下文记忆 / 事实记忆的 bounded retrieval；领域知识和策略不开放，首轮采用 first_fast_design。`
    : ""

const promptPolicy = (mode: AgentMode) => ({
  mode_id: mode,
  activation_mode: activationMode(mode),
  knowledge_enabled: knowledgeEnabled(mode),
  inline_context_policy: "minimal_summary",
  max_prompt_chars: 12000,
  max_inline_chars: 6000,
  full_skill_body_allowed: false,
  full_tool_output_allowed: false,
  hidden_evaluator_feedback_allowed: false,
})

const promptPolicyHash = (run: RunRecord) => sha256(promptPolicy(run.agentMode))

const knowledgePolicyHash = (mode: AgentMode) =>
  sha256({
    mode_id: mode,
    enabled: knowledgeEnabled(mode),
    retrieval_policy: knowledgeEnabled(mode) ? "bounded_retrieval_refs_only" : "disabled",
    // strategy/methodology injection is a sub-capability of durable retrieval (docs/39 §3.1).
    strategy_methodology_enabled: strategyMethodologyEnabled(mode),
    domain_knowledge_enabled: domainKnowledgeEnabled(mode),
    selected_ref_budget: knowledgeEnabled(mode) ? 5 : 0,
    inject_full_strategy_body: false,
    inject_full_memory_body: false,
    inject_hidden_evaluator_data: false,
  })

const sessionID = (run: RunRecord) => run.input.sessionID ?? `session:${run.runID}`

const messageID = (run: RunRecord) => run.input.messageID ?? `message:${run.runID}`

const sha256 = (value: unknown) => `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`

const sha256Text = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`

// docs/34 §8: delegate to the single canonical workspace-id derivation in the durable store, so the
// learning writeback (write side) and the retriever (read side) compute the SAME project_id.
const projectIDForWorkspace = (workspacePath: string): string =>
  DeepAgentDurableKnowledgeStore.projectIdForWorkspace(workspacePath)

const workspacePathForInput = (input: RunInput): string | undefined => {
  const metadata = input.metadata ?? {}
  const genericAgent = isRecord(metadata["deepagent-code"])
    ? metadata["deepagent-code"]
    : isRecord(metadata.deepagent)
      ? metadata.deepagent
      : {}
  const explicit = stringValue(genericAgent.workspacePath) ?? stringValue(genericAgent.directory)
  if (explicit) return explicit
  return input.workspaceID && path.isAbsolute(input.workspaceID) ? input.workspaceID : undefined
}

const userRequestForInput = (input: RunInput): string | null => {
  const metadata = input.metadata ?? {}
  const deepagent = isRecord(metadata.deepagent) ? metadata.deepagent : {}
  const pipeline = isRecord(deepagent.prompt_pipeline) ? deepagent.prompt_pipeline : deepagent
  return stringValue(pipeline.task_prompt) ?? stringValue(pipeline.goal) ?? input.feature ?? null
}

const artifactText = (name: string, value: unknown) =>
  typeof value === "string" && name.endsWith(".md") ? value : `${JSON.stringify(value, null, 2)}\n`

const hashRefs = (artifacts: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(artifacts).map(([name, value]) => [
      name,
      sha256Text(artifactText(name, value)),
    ]),
  )

const verifyCheckpoint = async (resume: ResumeConfig) => {
  try {
    const contents = await readFile(resume.checkpointPath, "utf8")
    return sha256Text(contents) === resume.expectedCheckpointHash
  } catch {
    return false
  }
}

const routerDecision = (input: RunInput, config: CurrentConfig): RouterDecision => {
  const router = input.metadata && isRecord(input.metadata.deepagent) && isRecord(input.metadata.deepagent.router)
    ? input.metadata.deepagent.router
    : {}
  const preference = router.user_preference === "soft" || router.user_preference === "hard" ? router.user_preference : config.modelRouter.userPreference
  if (preference === "hard") {
    const selectedProviderID = stringValue(router.selected_provider_id) ?? config.modelRouter.upstreamProviderID
    const selectedModelID = stringValue(router.selected_model_id) ?? config.modelRouter.upstreamModelID
    return {
      decision_id: `router-decision:${randomUUID()}`,
      execution_provider_id: input.providerID,
      execution_model_id: input.modelID,
      selected_provider_id: selectedProviderID,
      selected_model_id: selectedModelID,
      original_provider_id: input.providerID,
      original_model_id: input.modelID,
      user_preference: "hard",
      route_scope: "user_pinned_intent",
      reason: stringValue(router.reason) ?? config.modelRouter.reason ?? "User hard-pinned model selection",
      budget_policy_ref: "token_usage_ledger",
      tool_policy_ref: config.providerExecutedToolPolicy,
    }
  }
  const ctx = routerContext(input, config)
  const resolved = resolveRouterTarget(ctx, preference, config)
  return {
    decision_id: `router-decision:${randomUUID()}`,
    execution_provider_id: input.providerID,
    execution_model_id: input.modelID,
    selected_provider_id: resolved.providerID,
    selected_model_id: resolved.modelID,
    original_provider_id: input.providerID,
    original_model_id: input.modelID,
    user_preference: preference,
    route_scope: resolved.scope,
    reason: resolved.reason,
    budget_policy_ref: "token_usage_ledger",
    tool_policy_ref: config.providerExecutedToolPolicy,
  }
}

type RouterContext = {
  readonly originalProviderID: string
  readonly originalModelID: string
  readonly complexity: "low" | "medium" | "high"
  readonly callKind: CallKind
  readonly toolDensity: number
  readonly hasMcpTools: boolean
  readonly feature: string
  readonly agentMode: AgentMode
}

const routerContext = (input: RunInput, config: CurrentConfig): RouterContext => {
  const deepagent = input.metadata && isRecord(input.metadata.deepagent) ? input.metadata.deepagent : {}
  const caps = Array.isArray(deepagent.tool_capabilities) ? deepagent.tool_capabilities.filter(isRecord) : []
  const toolDensity = caps.length
  const hasMcpTools = caps.some((c) => c.source === "mcp_or_namespaced_tool")
  const complexity: "low" | "medium" | "high" =
    toolDensity > 15 || hasMcpTools ? "high" : toolDensity > 5 ? "medium" : "low"
  return {
    originalProviderID: input.providerID,
    originalModelID: input.modelID,
    complexity,
    callKind: input.callKind,
    toolDensity,
    hasMcpTools,
    feature: input.feature,
    agentMode: config.agentMode,
  }
}

const resolveRouterTarget = (
  ctx: RouterContext,
  preference: "none" | "soft" | "hard",
  config: CurrentConfig,
): { providerID: string; modelID: string; scope: RouterDecision["route_scope"]; reason: string } => {
  if (preference === "soft" && config.modelRouter.upstreamModelID !== "deepagent/default-upstream") {
    return {
      providerID: config.modelRouter.upstreamProviderID,
      modelID: config.modelRouter.upstreamModelID,
      scope: "configured_upstream_intent",
      reason: `User soft-preference honored: ${config.modelRouter.reason}`,
    }
  }
  if (ctx.callKind === "auxiliary_ai_call") {
    return {
      providerID: config.modelRouter.upstreamProviderID,
      modelID: config.modelRouter.upstreamModelID,
      scope: "configured_upstream_intent",
      reason: "Auxiliary call routed to configured upstream provider",
    }
  }
  if ((ctx.agentMode === "max" || ctx.agentMode === "ultra") && ctx.complexity === "high") {
    return {
      providerID: config.modelRouter.upstreamProviderID,
      modelID: config.modelRouter.upstreamModelID,
      scope: "configured_upstream_intent",
      reason: "Max mode with high-complexity task routed to frontier upstream",
    }
  }
  if ((ctx.agentMode === "max" || ctx.agentMode === "ultra") && ctx.complexity === "medium") {
    return {
      providerID: config.modelRouter.upstreamProviderID,
      modelID: config.modelRouter.upstreamModelID,
      scope: "configured_upstream_intent",
      reason: "Max mode with medium-complexity task routed to upstream provider",
    }
  }
  if (ctx.agentMode === "high" && ctx.complexity === "high") {
    return {
      providerID: config.modelRouter.upstreamProviderID,
      modelID: config.modelRouter.upstreamModelID,
      scope: "configured_upstream_intent",
      reason: "High mode with high-complexity task routed to upstream provider",
    }
  }
  return {
    providerID: ctx.originalProviderID,
    modelID: ctx.originalModelID,
    scope: "configured_upstream_execution",
    reason: `${ctx.agentMode} mode ${ctx.complexity}-complexity task stays on the configured upstream provider/model`,
  }
}

const reasoningStatus = (events: readonly string[]) => {
  if (events.includes("reasoning-end")) return "ended"
  if (events.includes("reasoning-delta")) return "streaming"
  if (events.includes("reasoning-start")) return "started"
  return "not_available"
}

export const layer = (config: Config = {}) => Layer.effectDiscard(Effect.sync(() => configure(config)))

// Register the DeepAgent global-runtime middleware into the llm client seam. llm is a pure SDK
// with an identity-passthrough default; importing this module (which core always does via
// LLMClient layering) installs routing + stream management. This is the inversion that lets the
// control-plane live in core without making llm -> core a dependency cycle. The middleware only
// transforms prepare + stream; llm rebuilds generate from the wrapped stream.
registerClientMiddleware(() => ({
  prepare: (next) => (request) => next(routeRequest(request)),
  stream: (next) => (request) => {
    const routed = routeRequest(request)
    return manageStream(fromRequest(routed), next(routed))
  },
}))

export * as AgentGateway from "./agent-gateway"
