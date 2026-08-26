import { PermissionV1 } from "@deepagent-code/core/v1/permission"
import { Provider } from "@/provider/provider"
import { SessionV1 } from "@deepagent-code/core/v1/session"
import { serviceUse } from "@deepagent-code/core/effect/service-use"
import { Log } from "@deepagent-code/core/util/log"
import { Global } from "@deepagent-code/core/global"
import { Context, Effect, Layer } from "effect"
import * as Stream from "effect/Stream"
import {
  streamText,
  wrapLanguageModel,
  type ModelMessage,
  type Tool,
  APICallError,
  NoSuchToolError,
  InvalidToolInputError,
  asSchema,
} from "ai"
import { type LLMEvent } from "@deepagent-code/llm"
import { AgentGateway } from "@deepagent-code/core/agent-gateway"
import { LLMClient, RequestExecutor, WebSocketExecutor } from "@deepagent-code/llm/route"
import type { LLMClientService } from "@deepagent-code/llm/route"
import { GitLabWorkflowLanguageModel, type WorkflowToolExecutor } from "gitlab-ai-provider"
import { ProviderTransform } from "@/provider/transform"
import { Config } from "@/config/config"
import type { Agent } from "@/agent/agent"
import type { MessageV2 } from "./message-v2"
import { Plugin } from "@/plugin"
import { Permission } from "@/permission"
import { Wildcard } from "@/util/wildcard"
import { Auth } from "@/auth"
import { RuntimeFlags } from "@/effect/runtime-flags"
import * as Option from "effect/Option"
import * as OtelTracer from "@effect/opentelemetry/Tracer"
import { LLMAISDK } from "./llm/ai-sdk"
import { LLMNativeRuntime } from "./llm/native-runtime"
import { LLMRequestPrep } from "./llm/request"
import { FreeformTools } from "./llm/freeform-tools"
import { configureGateway } from "@/deepagent/config"
import { requestBudget, type RequestBudgetStatus } from "./overflow"
import { Token } from "@/util/token"
import { Hash } from "@deepagent-code/core/util/hash"
import { DeepAgentReleasedSnapshot } from "@deepagent-code/core/deepagent/released-snapshot"
import { PreparedProviderTurn } from "@deepagent-code/core/session/runner/prepared-provider-turn"
import { ProviderWireSeal } from "./llm/provider-wire-seal"

const log = Log.create({ service: "llm" })
export const OUTPUT_TOKEN_MAX = ProviderTransform.OUTPUT_TOKEN_MAX

const RECEIPT_KEY_LIMIT = 32

/**
 * Convert provider-owned values into bounded evidence.  The receipt proves that
 * two layers saw the same shape without persisting prompts, file contents, or
 * tool arguments.  Circular/unsupported provider metadata is recorded as an
 * unavailable payload instead of breaking the stream.
 */
export function boundedReceiptPayload(value: unknown) {
  const payloadKeys = isRecord(value) ? Object.keys(value).toSorted().slice(0, RECEIPT_KEY_LIMIT) : []
  if (value === undefined) {
    return {
      payloadHash: undefined,
      payloadLength: undefined,
      payloadKeys,
      unavailableReason: "payload_unavailable",
    }
  }
  const serialized = (() => {
    try {
      return typeof value === "string" ? value : stableReceiptJson(value)
    } catch {
      return undefined
    }
  })()
  if (serialized === undefined) {
    return {
      payloadHash: undefined,
      payloadLength: undefined,
      payloadKeys,
      unavailableReason: "payload_not_serializable",
    }
  }
  return {
    payloadHash: Hash.sha256(serialized),
    payloadLength: serialized.length,
    payloadKeys,
    unavailableReason: undefined,
  }
}

function stableReceiptJson(value: unknown, ancestors = new WeakSet<object>()): string {
  if (value === null || typeof value !== "object") {
    const serialized = JSON.stringify(value)
    if (serialized === undefined) throw new Error("Unsupported receipt payload")
    return serialized
  }
  if (ancestors.has(value)) throw new Error("Circular receipt payload")
  ancestors.add(value)
  const serialized = Array.isArray(value)
    ? `[${value.map((item) => stableReceiptJson(item, ancestors)).join(",")}]`
    : `{${Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => `${JSON.stringify(key)}:${stableReceiptJson(item, ancestors)}`)
        .join(",")}}`
  ancestors.delete(value)
  return serialized
}

function finalToolDefinitions(tools: Readonly<Record<string, Tool>>) {
  return Object.entries(tools)
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([name, definition]) => ({
      type: "function" as const,
      name,
      description: definition.description,
      inputSchema: "inputSchema" in definition ? asSchema(definition.inputSchema).jsonSchema : undefined,
    }))
}

function physicalToolDefinitions(value: unknown) {
  const definitions = Array.isArray(value)
    ? value.map((definition) => {
        if (!isRecord(definition)) return definition
        return Object.fromEntries(
          Object.entries(definition)
            .filter(([key]) => !["execute", "onInputStart", "onInputDelta", "onInputAvailable"].includes(key))
            .toSorted(([a], [b]) => a.localeCompare(b)),
        )
      })
    : []
  return {
    definitions,
    ids: definitions.flatMap((definition) => {
      if (!isRecord(definition)) return []
      const name = definition.name ?? definition.toolName
      return typeof name === "string" ? [name] : []
    }),
  }
}

function physicalPromptCacheKey(value: unknown) {
  const keys = new Set<string>()
  const visit = (current: unknown) => {
    if (!isRecord(current)) return
    for (const [key, child] of Object.entries(current)) {
      if (["promptCacheKey", "prompt_cache_key", "cacheKey"].includes(key) && typeof child === "string") {
        keys.add(child)
        continue
      }
      visit(child)
    }
  }
  visit(value)
  if (keys.size > 1) throw new Error("Provider request contains conflicting prompt cache keys")
  return keys.values().next().value
}

function prepareProviderTurn(input: {
  readonly stream: StreamRequest
  readonly prepared: LLMRequestPrep.Prepared
  readonly owner: "legacy_aisdk" | "legacy_native"
  readonly budget: RequestBudgetStatus
  readonly permissionFilteredToolIDs: readonly string[]
  readonly finalOfferedToolIDs: readonly string[]
  readonly toolDefinitions: unknown
  readonly toolCapability: PreparedProviderTurn.ToolCapability
  readonly toolLoweringOutcome: PreparedProviderTurn.ToolLoweringOutcome
  readonly toolChoice: "auto" | "required" | "none" | undefined
  readonly wireRequest?: unknown
  readonly wireRequestHash?: string
}) {
  const identity = input.stream.requestReceipt?.identity
  if (!identity) return
  return PreparedProviderTurn.prepare({
    sessionID: input.stream.sessionID,
    requestOrdinal: identity.requestOrdinal,
    // Legacy receipts keep the auditable backfill identity fixed by the turn-identity migration:
    // activity `legacy:<session>` with the request ordinal as the turn sequence.
    activityID: `legacy:${input.stream.sessionID}`,
    providerTurnSeq: identity.requestOrdinal,
    owner: input.owner,
    stableSystemParts: input.prepared.stableSystemParts,
    volatileSystemParts: input.prepared.volatileSystemParts,
    historyMessages: input.prepared.historyMessages,
    historyPromptEpoch: identity.promptEpoch,
    historySourceEndMessageID: identity.historySourceEndMessageID,
    contextSelectionID: identity.contextSelectionID,
    contextProjectionHash: identity.contextProjectionHash,
    contextReadiness: identity.contextReadiness,
    contextSelectedRefs: identity.contextSelectedRefs,
    toolRegistryIDs: identity.registryToolIDs,
    toolPermissionFilteredIDs: input.permissionFilteredToolIDs,
    toolFinalOfferedIDs: input.finalOfferedToolIDs,
    toolDefinitions: input.toolDefinitions,
    toolChoice: input.toolChoice ?? null,
    toolCapability: input.toolCapability,
    toolLoweringOutcome: input.toolLoweringOutcome,
    toolResultReferences: LLMRequestPrep.toolResultReferences(input.prepared.historyMessages),
    samplingModelID: input.stream.model.id,
    samplingProviderID: input.stream.model.providerID,
    samplingMaxOutputTokens: input.prepared.params.maxOutputTokens,
    samplingTemperature: input.prepared.params.temperature,
    budget: input.budget,
    wireRequest: input.wireRequest,
    wireRequestHash: input.wireRequestHash,
    receiptID: identity.receiptID,
    providerAttemptID: identity.providerAttemptID,
    userMessageID: input.stream.user.id,
    assistantMessageID: identity.assistantMessageID,
  })
}

function adapterReceiptDetails(event: LLMEvent) {
  if (event.type === "tool-call") return { callID: event.id, toolName: event.name, payload: event.input }
  if (event.type === "tool-error") {
    return {
      callID: event.id,
      toolName: event.name,
      payload: undefined,
      unavailableReason: "adapter_did_not_emit_decoded_input",
    }
  }
  return undefined
}

function adapterValidationOutcome(event: LLMEvent, validatedCallIDs: Set<string>): "schema_valid" | "schema_invalid" {
  if (event.type === "tool-call") {
    if (event.inputValidation === "schema_invalid") return "schema_invalid"
    validatedCallIDs.add(event.id)
    return "schema_valid"
  }
  if (event.type !== "tool-error") return "schema_invalid"
  return InvalidToolInputError.isInstance(event.error) || !validatedCallIDs.has(event.id)
    ? "schema_invalid"
    : "schema_valid"
}

const deepagentModelAuthProviderID = (model: Provider.Model) => {
  if (model.providerID !== "deepagent") return
  const value = model.options?.authProviderID
  return typeof value === "string" && value.length > 0 ? value : undefined
}

// Decide from the fully merged per-request options. Some providers reject
// `tool_choice: required/object` while thinking is active. Callers that need a
// hard guarantee must either disable thinking for this turn or use an explicitly
// bounded auto-only controller; this layer never silently weakens `required`.
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

type WorkflowModelHooks = {
  sessionID: string
  systemPrompt: string | null
  sessionPreapprovedTools: string[]
  toolExecutor: WorkflowToolExecutor | null
  approvalHandler:
    | ((approvalTools: Array<{ name: string; args: string }>) => Promise<{ approved: boolean; message?: string }>)
    | null
}

export function wireWorkflowModel(input: {
  readonly model: WorkflowModelHooks
  readonly sessionID: string
  readonly systemPrompt: string
  readonly tools: Record<string, Pick<Tool, "execute">>
  readonly messages: ModelMessage[]
  readonly abort: AbortSignal
  readonly ruleset: PermissionV1.Ruleset
  readonly warn: (message: string, details: Record<string, unknown>) => void
}) {
  input.model.sessionID = input.sessionID
  input.model.systemPrompt = input.systemPrompt
  input.model.toolExecutor = async (toolName, argsJson, requestID) => {
    const selected = input.tools[toolName]
    if (!selected?.execute) {
      input.warn("workflow tool call: unknown tool", { tool: toolName, errorType: "unknown_tool" })
      return {
        result: "",
        error: `[unknown_tool] Tool "${toolName}" is not available. Resend the request using a valid tool name.`,
      }
    }

    const parsedArgs = (() => {
      try {
        return { ok: true as const, value: JSON.parse(argsJson) as unknown }
      } catch (error) {
        return { ok: false as const, error }
      }
    })()
    if (!parsedArgs.ok) {
      const message = parsedArgs.error instanceof Error ? parsedArgs.error.message : "parse error"
      input.warn("workflow tool call: invalid JSON", {
        tool: toolName,
        errorType: "invalid_json",
        errorMessage: message.slice(0, 200),
        inputPreview: argsJson.length > 200 ? argsJson.slice(0, 200) + "…[truncated]" : argsJson,
      })
      return {
        result: "",
        error: `[invalid_json] Arguments for tool "${toolName}" are not valid JSON (${message.slice(0, 200)}). Resend the request with complete, valid JSON arguments.`,
      }
    }

    try {
      const result = await selected.execute(parsedArgs.value, {
        toolCallId: requestID,
        messages: input.messages,
        abortSignal: input.abort,
      })
      const output =
        typeof result === "string"
          ? result
          : isRecord(result) && typeof result.output === "string"
            ? result.output
            : (JSON.stringify(result) ?? String(result))
      return {
        result: output,
        metadata: isRecord(result) && isRecord(result.metadata) ? result.metadata : undefined,
        title: isRecord(result) && typeof result.title === "string" ? result.title : undefined,
      }
    } catch (error) {
      const detail = isRecord(error) ? error : undefined
      const isSchemaError =
        Array.isArray(detail?.issues) ||
        detail?._tag === "ParseError" ||
        (isRecord(detail?.cause) && detail.cause._tag === "ParseError")
      const message = error instanceof Error ? error.message : String(error)
      input.warn("workflow tool call: execution error", {
        tool: toolName,
        errorType: isSchemaError ? "schema_mismatch" : "execution_error",
        errorMessage: message.slice(0, 200),
      })
      if (isSchemaError) {
        return {
          result: "",
          error: `[schema_mismatch] Arguments for tool "${toolName}" do not match the expected schema. Resend the request with correctly structured arguments.`,
        }
      }
      return { result: "", error: message.slice(0, 500) }
    }
  }

  input.model.sessionPreapprovedTools = Object.keys(input.tools).filter((name) => {
    const match = input.ruleset.findLast((rule) => Wildcard.match(name, rule.permission))
    return !match || match.action !== "ask"
  })
  input.model.approvalHandler = async (approvalTools) => ({
    // This provider checkpoint has no request ID. It is advisory only: exact permission admission,
    // once consumption, and effect settlement happen when toolExecutor invokes the wrapped tool with
    // the provider's request ID and actual arguments.
    approved:
      approvalTools.length > 0 &&
      approvalTools.every((approval) =>
        Boolean(input.tools[workflowApprovalToolName(approval.name, input.tools)]?.execute),
      ),
  })
}

function workflowApprovalToolName(name: string, tools: Record<string, Pick<Tool, "execute">>) {
  if (name === "runReadFile" || name === "runReadFiles" || name === "listDirectory") return "read"
  if (name === "runWriteFile") return tools.write?.execute ? "write" : "apply_patch"
  if (name === "runEditFile") return tools.edit?.execute ? "edit" : "apply_patch"
  if (name === "findFiles") return "glob"
  if (name === "grep") return "grep"
  if (
    name === "runShellCommand" ||
    name === "runCommand" ||
    name === "runGitCommand" ||
    name === "mkdir" ||
    name === "runHTTPRequest"
  )
    return "bash"
  return name
}

const thinkingActive = (options: Record<string, unknown> | undefined): boolean => {
  if (!options) return false
  const effort = options.reasoningEffort ?? (isRecord(options.reasoning) ? options.reasoning.effort : undefined)
  if (typeof effort === "string" && effort !== "none") return true
  const thinking = options.thinking
  if (isRecord(thinking) && thinking.type !== "disabled") return true
  if (isRecord(options.thinkingConfig)) return true
  return false
}

export type ToolChoiceProtocol =
  | "openai_responses"
  | "openai_chat"
  | "anthropic_messages"
  | "gemini"
  | "bedrock_converse"
  | "unknown"

const OPENAI_RESPONSES_PACKAGES = new Set([
  "@ai-sdk/openai",
  "@ai-sdk/azure",
  "@ai-sdk/amazon-bedrock/mantle",
  "@ai-sdk/xai",
])
const OPENAI_CHAT_PACKAGES = new Set([
  "@ai-sdk/openai-compatible",
  "@openrouter/ai-sdk-provider",
  "@ai-sdk/groq",
  "@ai-sdk/deepinfra",
  "@ai-sdk/cerebras",
  "@ai-sdk/togetherai",
  "@ai-sdk/perplexity",
  "@ai-sdk/vercel",
  "@ai-sdk/alibaba",
  "@ai-sdk/github-copilot",
  "venice-ai-sdk-provider",
])

export function toolChoiceProtocol(model: Provider.Model): ToolChoiceProtocol {
  if (OPENAI_RESPONSES_PACKAGES.has(model.api.npm)) return "openai_responses"
  if (OPENAI_CHAT_PACKAGES.has(model.api.npm)) return "openai_chat"
  if (model.api.npm === "@ai-sdk/anthropic" || model.api.npm === "@ai-sdk/google-vertex/anthropic")
    return "anthropic_messages"
  if (model.api.npm === "@ai-sdk/google" || model.api.npm === "@ai-sdk/google-vertex") return "gemini"
  if (model.api.npm === "@ai-sdk/amazon-bedrock") return "bedrock_converse"
  return "unknown"
}

function reasoningOnly(model: Provider.Model) {
  if (model.options?.reasoningOnly === true) return true
  if (!model.capabilities.reasoning) return false
  const id = `${model.id} ${model.api.id}`.toLowerCase()
  return (
    /\bo(?:1|3|4)(?:\b|[._-])/.test(id) ||
    id.includes("gpt-5-pro") ||
    id.includes("deepseek-r1") ||
    id.includes("deepseek-reasoner")
  )
}

export function finalizerCapability(model: Provider.Model) {
  const protocol = toolChoiceProtocol(model)
  if (!model.capabilities.toolcall)
    return {
      capability: "unsupported" as const,
      protocol,
      reasoning: "inherit" as const,
      reason: "model_has_no_tool_call_capability" as const,
    }
  if (reasoningOnly(model))
    return {
      capability: "auto_only" as const,
      protocol,
      reasoning: "inherit" as const,
      toolChoice: "auto" as const,
      reason: "reasoning_cannot_be_disabled" as const,
    }
  if (protocol === "unknown")
    return {
      capability: "auto_only" as const,
      protocol,
      reasoning: "inherit" as const,
      toolChoice: "auto" as const,
      reason: "protocol_forced_tool_unverified" as const,
    }
  return {
    capability: "forced_tool" as const,
    protocol,
    reasoning: "disabled" as const,
    toolChoice: "required" as const,
  }
}

export const disableThinking = (options: Record<string, unknown> | undefined): Record<string, unknown> | undefined => {
  if (!options) return options
  const result = { ...options }
  delete result.reasoningEffort
  delete result.reasoning
  delete result.thinking
  delete result.thinkingConfig
  if ("enable_thinking" in result) result.enable_thinking = false
  if (isRecord(result.chat_template_args)) {
    result.chat_template_args = { ...result.chat_template_args, enable_thinking: false }
  }
  if (isRecord(result.modelParams)) {
    result.modelParams = disableThinking(result.modelParams)
  }
  return result
}

export function decideToolChoice(
  toolChoice: StreamInput["toolChoice"],
  options: Record<string, unknown> | undefined,
  model?: Provider.Model,
):
  | { capability: "forced_tool" | "auto_only"; toolChoice: StreamInput["toolChoice"] }
  | { capability: "unsupported_thinking_with_forced_tool" }
  | { capability: "unsupported_forced_tool" } {
  if (toolChoice !== "required") return { capability: "auto_only", toolChoice }
  if (model && toolChoiceProtocol(model) === "unknown") return { capability: "unsupported_forced_tool" }
  if (!thinkingActive(options)) return { capability: "forced_tool", toolChoice }
  return { capability: "unsupported_thinking_with_forced_tool" }
}

export type StreamInput = {
  user: SessionV1.User
  sessionID: string
  parentSessionID?: string
  model: Provider.Model
  agent: Agent.Info
  permission?: PermissionV1.Ruleset
  system: string[]
  messages: ModelMessage[]
  small?: boolean
  tools: Record<string, Tool>
  retries?: number
  toolChoice?: "auto" | "required" | "none"
  reasoning?: "inherit" | "disabled"
  /** One ephemeral request-tail payload assembled with round/plan context. Never persisted in history. */
  runtimeTail?: string
  /** The federated resolver owns Knowledge/Memory projection for this turn. */
  federatedProjection?: boolean
  /** Aggregate-only shadow evidence. It is observed locally and never sent to the Provider. */
  federatedShadow?: Readonly<Record<"code" | "knowledge" | "memory" | "documents", number>>
  /** Internal released-knowledge authority captured before this provider turn. */
  releasedKnowledgeSelection?: DeepAgentReleasedSnapshot.Selection
  /** A durable attempt owns retry safety for this request; provider-internal retries must stay disabled. */
  durableAttempt?: boolean
  /** Remote-compacted provider prefix plus the post-boundary messages that must follow it. */
  remoteCompaction?: {
    readonly encryptedContent: string
    readonly messages: ModelMessage[]
  }
  /** Internal durable receipt hook invoked after permission filtering and adapter preparation. */
  requestReceipt?: {
    readonly identity: {
      readonly receiptID: string
      readonly requestOrdinal: number
      readonly providerAttemptID?: string
      readonly assistantMessageID?: string
      readonly promptEpoch: number
      readonly historySourceEndMessageID: string | null
      readonly contextSelectionID: string | null
      readonly contextProjectionHash: string | null
      readonly contextReadiness: PreparedProviderTurn.ContextReadiness
      readonly contextSelectedRefs: readonly string[]
      readonly registryToolIDs: readonly string[]
    }
    readonly prepared: (input: {
      readonly permissionFilteredToolIds: readonly string[]
      readonly finalOfferedTools: Readonly<Record<string, Tool>>
      readonly adapterToolCapability: "supported" | "unsupported" | "unknown"
      readonly adapterLoweringOutcome: "ok" | "schema_rejected" | "omitted_no_support"
      readonly budget: RequestBudgetStatus
      readonly releasedKnowledgeSelectedRefs: readonly DeepAgentReleasedSnapshot.DocumentRef[]
      readonly releasedKnowledgeSelectedRefsFingerprint: string
    }) => Effect.Effect<void>
    readonly adapterPrepared: (input: {
      readonly finalRequestHash: string
      readonly promptCacheKey?: string
      readonly finalOfferedToolIds: readonly string[]
      readonly toolDefinitionHash: string
      readonly preparedTurn: PreparedProviderTurn.PreparedProviderTurn
    }) => Effect.Effect<void>
    readonly dispatched: () => Effect.Effect<void>
    readonly streaming: () => Effect.Effect<void>
    readonly settled: () => Effect.Effect<void>
    readonly failed: (error: unknown) => Effect.Effect<void>
    readonly observed: (event: LLMEvent) => Effect.Effect<void>
    readonly rejected: (input: { readonly budget: RequestBudgetStatus; readonly reason: string }) => Effect.Effect<void>
    readonly aiSdkInput: (input: {
      readonly ordinal: number
      readonly eventType: string
      readonly callID?: string
      readonly toolName?: string
      readonly payloadHash?: string
      readonly payloadLength?: number
      readonly payloadKeys: readonly string[]
      readonly unavailableReason?: string
      readonly validationOutcome: "not_evaluated" | "schema_valid" | "schema_invalid"
    }) => Effect.Effect<void>
    readonly rawFrame: (input: {
      readonly ordinal: number
      readonly eventType: string
      readonly payloadHash?: string
      readonly payloadLength?: number
      readonly payloadKeys: readonly string[]
      readonly unavailableReason?: string
      readonly validationOutcome: "not_evaluated"
    }) => Effect.Effect<void>
    readonly adapterAssembly: (input: {
      readonly ordinal: number
      readonly eventType: string
      readonly callID?: string
      readonly toolName?: string
      readonly payloadHash?: string
      readonly payloadLength?: number
      readonly payloadKeys: readonly string[]
      readonly unavailableReason?: string
      readonly validationOutcome: "schema_valid" | "schema_invalid"
    }) => Effect.Effect<void>
    readonly processorDecoded: (input: {
      readonly ordinal: number
      readonly eventType: string
      readonly callID: string
      readonly toolName: string
      readonly payloadHash?: string
      readonly payloadLength?: number
      readonly payloadKeys: readonly string[]
      readonly unavailableReason?: string
      readonly validationOutcome: "schema_valid" | "schema_invalid"
    }) => Effect.Effect<void>
    readonly processorValidation: (input: {
      readonly callID: string
      readonly validationOutcome: "schema_invalid" | "semantic_valid" | "semantic_invalid" | "conflict" | "no_progress"
    }) => Effect.Effect<void>
  }
}

export type StreamRequest = StreamInput & {
  abort: AbortSignal
}

export interface Interface {
  readonly stream: (input: StreamInput) => Stream.Stream<LLMEvent, unknown>
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/LLM") {}

export const use = serviceUse(Service)

const live: Layer.Layer<
  Service,
  never,
  Auth.Service | Config.Service | Provider.Service | Plugin.Service | LLMClientService | RuntimeFlags.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const auth = yield* Auth.Service
    const config = yield* Config.Service
    const provider = yield* Provider.Service
    const plugin = yield* Plugin.Service
    const llmClient = yield* LLMClient.Service
    const flags = yield* RuntimeFlags.Service

    const run = Effect.fn("LLM.run")(function* (input: StreamRequest) {
      const l = log
        .clone()
        .tag("providerID", input.model.providerID)
        .tag("modelID", input.model.id)
        .tag("session.id", input.sessionID)
        .tag("small", (input.small ?? false).toString())
        .tag("agent", input.agent.name)
        .tag("mode", input.agent.mode)
      l.info("stream", {
        modelID: input.model.id,
        providerID: input.model.providerID,
      })

      const cfg = yield* config.get()
      configureGateway(cfg)

      yield* AgentGateway.preflight({
        callKind: "session_turn",
        feature: input.small ? "session_small_model" : "session_chat",
        providerID: input.model.providerID,
        modelID: input.model.id,
        sessionID: input.sessionID,
        messageID: input.user.id,
        parentSessionID: input.parentSessionID,
        agent: input.agent.name,
      })

      const modelAuthID = deepagentModelAuthProviderID(input.model)
      const [language, item, providerAuth, modelAuth] = yield* Effect.all(
        [
          provider.getLanguage(input.model),
          provider.getProvider(input.model.providerID),
          auth.get(input.model.providerID),
          modelAuthID ? auth.get(modelAuthID) : Effect.succeed(undefined),
        ],
        { concurrency: "unbounded" },
      )
      const info = input.model.providerID === "deepagent" ? (modelAuth ?? providerAuth) : providerAuth
      // Official providers can configure a retry count via the connect dialog (SettingsStore →
      // provider.options.maxRetries). When set it overrides the per-call default; otherwise the
      // existing per-call retries (2 for a session turn, 0 for sub-calls) stands.
      const providerMaxRetries = typeof item.options?.maxRetries === "number" ? item.options.maxRetries : undefined

      const isWorkflow = language instanceof GitLabWorkflowLanguageModel
      const protocolTools = isWorkflow ? input.tools : FreeformTools.tools(language, input.tools)
      const remoteCompaction =
        input.remoteCompaction &&
        flags.experimentalNativeLlm &&
        LLMNativeRuntime.status({ model: input.model, provider: item, auth: info }).type === "supported"
          ? input.remoteCompaction
          : undefined
      const prepared = yield* LLMRequestPrep.prepare({
        ...input,
        messages: remoteCompaction?.messages ?? input.messages,
        tools: protocolTools,
        provider: item,
        auth: info,
        plugin,
        flags,
        isWorkflow,
        // §5b: surface the configurable (lenient) orchestration caps so the advisory fan-out decision
        // in the prompt reflects the deployment's configured per-round concurrency. Hard enforcement
        // is the §5a semaphore in task.ts, not this number.
        orchestrationCaps: {
          maxFanout: cfg.experimental?.orchestration?.max_fanout,
          maxConcurrency: cfg.experimental?.orchestration?.max_concurrency,
        },
      })

      const baseOptions = input.reasoning === "disabled" ? disableThinking(prepared.params.options) : prepared.params.options
      const effectiveOptions = remoteCompaction
        ? { ...baseOptions, compactionEncryptedContent: remoteCompaction.encryptedContent }
        : baseOptions
      const toolChoiceDecision = decideToolChoice(input.toolChoice, effectiveOptions, input.model)
      if (toolChoiceDecision.capability === "unsupported_forced_tool") {
        return yield* Effect.fail(
          new Error(
            `[unsupported_forced_tool] Required tool choice is not verified for provider protocol ${toolChoiceProtocol(input.model)}. Use an explicitly bounded auto-only controller.`,
          ),
        )
      }
      if (toolChoiceDecision.capability === "unsupported_thinking_with_forced_tool") {
        return yield* Effect.fail(
          new Error(
            "[unsupported_thinking_with_forced_tool] Required tool choice cannot be used while reasoning is active. Disable reasoning for this turn or use an explicitly bounded auto-only controller.",
          ),
        )
      }
      const effectiveToolChoice = toolChoiceDecision.toolChoice

      // Wire up toolExecutor for DWS workflow models so that tool calls
      // from the workflow service are executed via deepagent-code's tool system
      // and results sent back over the WebSocket.
      if (language instanceof GitLabWorkflowLanguageModel) {
        wireWorkflowModel({
          model: language,
          sessionID: input.sessionID,
          systemPrompt: prepared.system.join("\n"),
          tools: prepared.tools,
          messages: input.messages,
          abort: input.abort,
          ruleset: Permission.merge(input.agent.permission ?? [], input.permission ?? []),
          warn: (message, details) => l.warn(message, details),
        })
      }

      const runtimeTools = prepared.tools
      const permissionFilteredToolIDs = Object.keys(prepared.tools)
      const toolCapability =
        toolChoiceProtocol(input.model) === "unknown"
          ? ("unknown" as const)
          : input.model.capabilities.toolcall
            ? ("supported" as const)
            : ("unsupported" as const)
      const toolLoweringOutcome =
        Object.keys(input.tools).length > 0 && Object.keys(runtimeTools).length === 0
          ? ("omitted_no_support" as const)
          : ("ok" as const)
      const budget = requestBudget({
        model: input.model,
        outputTokenMax: flags.outputTokenMax,
        estimatedFullRequestTokens: Token.estimate(
          JSON.stringify({
            system: prepared.system,
            messages: prepared.messages,
            tools: Object.entries(runtimeTools)
              .toSorted(([a], [b]) => a.localeCompare(b))
              .map(([name, definition]) => ({
                name,
                description: definition.description,
                inputSchema: "inputSchema" in definition ? definition.inputSchema : undefined,
              })),
            toolChoice: effectiveToolChoice,
          }),
        ),
      })
      if (budget.decision === "unavailable") {
        const reason = budget.reason ?? "physical_budget_exceeded"
        yield* input.requestReceipt?.rejected({ budget, reason }) ?? Effect.void
        return yield* Effect.fail(
          new SessionV1.ContextOverflowError({
            message:
              reason === "context_limit_unknown"
                ? "Provider context limit is unknown; configure an endpoint/model override before continuing this long request."
                : reason === "context_limit_invalid"
                  ? "Provider context limit is invalid; correct the endpoint/model configuration before continuing."
                  : "The complete provider request exceeds the physical input budget.",
          }),
        )
      }
      yield* input.requestReceipt?.prepared({
        permissionFilteredToolIds: permissionFilteredToolIDs,
        finalOfferedTools: runtimeTools,
        adapterToolCapability: toolCapability,
        adapterLoweringOutcome: toolLoweringOutcome,
        budget,
        releasedKnowledgeSelectedRefs: prepared.releasedKnowledgeSelectedRefs,
        releasedKnowledgeSelectedRefsFingerprint: DeepAgentReleasedSnapshot.exactRefsFingerprint(
          prepared.releasedKnowledgeSelectedRefs,
        ),
      }) ?? Effect.void
      const physicalProviderOptions = ProviderTransform.providerOptions(input.model, effectiveOptions ?? {})
      const tracer = cfg.experimental?.openTelemetry
        ? Option.getOrUndefined(yield* Effect.serviceOption(OtelTracer.OtelTracer))
        : undefined
      const telemetryTracer = tracer
        ? new Proxy(tracer, {
            get(target, prop, receiver) {
              if (prop !== "startSpan") return Reflect.get(target, prop, receiver)
              return (...args: Parameters<typeof target.startSpan>) => {
                const span = target.startSpan(...args)
                span.setAttribute("session.id", input.sessionID)
                return span
              }
            },
          })
        : undefined

      // Runtime seam: native is an opt-in adapter over @deepagent-code/llm. It
      // either returns a ready LLMEvent stream or a concrete fallback reason.
      if (flags.experimentalNativeLlm) {
        const physicalTools = finalToolDefinitions(runtimeTools)
        const requestReceipt = input.requestReceipt
        const native = LLMNativeRuntime.stream({
          model: input.model,
          provider: item,
          auth: info,
          llmClient,
          messages: prepared.messages,
          tools: runtimeTools,
          toolChoice: effectiveToolChoice,
          temperature: prepared.params.temperature,
          topP: prepared.params.topP,
          topK: prepared.params.topK,
          maxOutputTokens: prepared.params.maxOutputTokens,
          providerOptions: effectiveOptions,
          headers: prepared.headers,
          abort: input.abort,
          metadata: prepared.metadata,
          // UPD-002: wire-level structured output travels through the native
          // runtime only; the AI SDK runtime keeps the synthetic-tool path.
          responseFormat: prepared.responseFormat,
          durableAttempt: input.durableAttempt,
          requestSeal: requestReceipt
            ? ({ wireHash }) =>
                Effect.gen(function* () {
                  const preparedTurn = prepareProviderTurn({
                    stream: input,
                    prepared,
                    owner: "legacy_native",
                    budget,
                    permissionFilteredToolIDs,
                    finalOfferedToolIDs: physicalTools.map((tool) => tool.name),
                    toolDefinitions: physicalTools,
                    toolCapability,
                    toolLoweringOutcome,
                    toolChoice: effectiveToolChoice,
                    wireRequestHash: wireHash,
                  })
                  if (!preparedTurn) return yield* Effect.die("provider receipt identity is missing")
                  yield* requestReceipt.adapterPrepared({
                    finalRequestHash: wireHash,
                    promptCacheKey: physicalPromptCacheKey(physicalProviderOptions),
                    finalOfferedToolIds: physicalTools.map((tool) => tool.name),
                    toolDefinitionHash: Hash.sha256(stableReceiptJson(physicalTools)),
                    preparedTurn,
                  })
                  yield* requestReceipt.dispatched()
                })
            : undefined,
        })
        if (native.type === "supported") {
          yield* input.requestReceipt?.aiSdkInput({
            ordinal: 0,
            eventType: "native-runtime",
            payloadKeys: [],
            unavailableReason: "native_runtime_selected",
            validationOutcome: "not_evaluated",
          }) ?? Effect.void
          yield* Effect.logInfo("llm runtime selected").pipe(
            Effect.annotateLogs({
              "llm.runtime": "native",
              "llm.provider": input.model.providerID,
              "llm.model": input.model.id,
            }),
          )
          return {
            type: "native" as const,
            stream: native.stream,
            metadata: prepared.metadata,
          }
        }
        yield* Effect.logInfo("llm runtime selected").pipe(
          Effect.annotateLogs({
            "llm.runtime": "ai-sdk",
            "llm.provider": input.model.providerID,
            "llm.model": input.model.id,
            "llm.native_unsupported_reason": native.reason,
          }),
        )
        l.info("native runtime unavailable; falling back to ai-sdk", { reason: native.reason })
      }

      yield* Effect.logInfo("llm runtime selected").pipe(
        Effect.annotateLogs({
          "llm.runtime": "ai-sdk",
          "llm.provider": input.model.providerID,
          "llm.model": input.model.id,
        }),
      )
      // Default runtime path: AI SDK owns provider execution and tool dispatch;
      // LLMAISDK.toLLMEvents below normalizes fullStream parts for the processor.
      return {
        type: "ai-sdk" as const,
        metadata: prepared.metadata,
        result: streamText({
          // Copilot returns the authoritative billed amount only in provider-specific response fields.
          includeRawChunks: input.model.providerID.includes("github-copilot"),
          onError({ error }) {
            // AI SDK's APICallError carries `requestBodyValues` = the ENTIRE request body (system
            // prompt + every message). Logging the raw error JSON.stringifies that into a single
            // multi-hundred-KB line. Log only the salient fields (and a truncated responseBody) so a
            // provider error — e.g. a 429 "insufficient balance" — stays a readable one-liner.
            if (APICallError.isInstance(error)) {
              const body = typeof error.responseBody === "string" ? error.responseBody : undefined
              l.error("stream error", {
                name: error.name,
                url: error.url,
                statusCode: error.statusCode,
                isRetryable: error.isRetryable,
                message: error.message,
                responseBody: body && body.length > 1000 ? body.slice(0, 1000) + "…[truncated]" : body,
              })
              return
            }
            l.error("stream error", {
              error: error instanceof Error ? error.message : String(error),
            })
          },
          async experimental_repairToolCall(failed) {
            // (a) Tool name case fix only — keep failed.toolCall.input exactly as-is.
            const lower = failed.toolCall.toolName.toLowerCase()
            if (lower !== failed.toolCall.toolName && runtimeTools[lower]) {
              l.info("tool call repair: name case fix", {
                tool: failed.toolCall.toolName,
                repaired: lower,
              })
              return {
                ...failed.toolCall,
                toolName: lower,
              }
            }

            // Log bounded diagnostics — do NOT echo the full input (may contain file content).
            const rawInput: string = failed.toolCall.input
            const inputPreview = rawInput.length > 200 ? rawInput.slice(0, 200) + "…[truncated]" : rawInput

            // (b/c) Classify by error type and return null.
            // Returning null lets AI SDK propagate the original error as a tool result,
            // giving the model actionable feedback to resend with correct parameters.
            // We never attempt to repair JSON syntax (no bracket filling, no quote fixing,
            // no control-char stripping) — write/edit content must stay intact.
            if (NoSuchToolError.isInstance(failed.error)) {
              l.warn("tool call repair skipped: unknown tool", {
                tool: failed.toolCall.toolName,
                errorType: "unknown_tool",
                errorMessage: failed.error.message.slice(0, 300),
              })
              return null
            }

            if (InvalidToolInputError.isInstance(failed.error)) {
              // SyntaxError cause → invalid JSON; otherwise → schema mismatch.
              const isSyntaxError = failed.error.cause instanceof SyntaxError
              const errorType = isSyntaxError ? "invalid_json" : "schema_mismatch"
              l.warn("tool call repair skipped", {
                tool: failed.toolCall.toolName,
                errorType,
                errorMessage: failed.error.message.slice(0, 300),
                inputPreview,
              })
              return null
            }

            // Unrecognized error type — return null rather than guessing.
            // Cast to unknown: TypeScript narrows failed.error to never after the two
            // isInstance guards above (the union is exhausted), but we keep this block
            // as a runtime safety net in case AI SDK adds new error subtypes.
            const unknownErr = failed.error as unknown
            l.warn("tool call repair skipped: unrecognized error", {
              tool: failed.toolCall.toolName,
              errorMessage: (unknownErr instanceof Error ? unknownErr.message : String(unknownErr)).slice(0, 300),
              inputPreview,
            })
            return null
          },
          temperature: prepared.params.temperature,
          topP: prepared.params.topP,
          topK: prepared.params.topK,
          providerOptions: physicalProviderOptions,
          activeTools: Object.keys(runtimeTools).filter((x) => x !== "invalid"),
          tools: runtimeTools,
          toolChoice: effectiveToolChoice,
          maxOutputTokens: prepared.params.maxOutputTokens,
          abortSignal: input.abort,
          headers: prepared.headers,
          maxRetries: input.durableAttempt ? 0 : (providerMaxRetries ?? input.retries ?? 0),
          messages: prepared.messages,
          model: wrapLanguageModel({
            model: language,
            middleware: [
              {
                specificationVersion: "v3" as const,
                async transformParams(args) {
                  if (args.type === "stream") {
                    // @ts-expect-error
                    args.params.prompt = ProviderTransform.message(
                      args.params.prompt,
                      input.model,
                      prepared.messageTransformOptions,
                    )
                  }
                  return args.params
                },
                async wrapStream({ doStream, params }) {
                  const requestReceipt = input.requestReceipt
                  if (!requestReceipt) return doStream()
                  const physicalTools = physicalToolDefinitions(params.tools)
                  return ProviderWireSeal.run(
                    ({ wireHash }) =>
                      Effect.gen(function* () {
                        const preparedTurn = prepareProviderTurn({
                          stream: input,
                          prepared,
                          owner: "legacy_aisdk",
                          budget,
                          permissionFilteredToolIDs,
                          finalOfferedToolIDs: physicalTools.ids,
                          toolDefinitions: physicalTools.definitions,
                          toolCapability,
                          toolLoweringOutcome,
                          toolChoice: effectiveToolChoice,
                          wireRequestHash: wireHash,
                        })
                        if (!preparedTurn) return yield* Effect.die("provider receipt identity is missing")
                        yield* requestReceipt.adapterPrepared({
                          finalRequestHash: wireHash,
                          promptCacheKey: physicalPromptCacheKey(params.providerOptions),
                          finalOfferedToolIds: physicalTools.ids,
                          toolDefinitionHash: Hash.sha256(stableReceiptJson(physicalTools.definitions)),
                          preparedTurn,
                        })
                        yield* requestReceipt.dispatched()
                      }),
                    doStream,
                  )
                },
              },
            ],
          }),
          experimental_telemetry: {
            isEnabled: cfg.experimental?.openTelemetry,
            functionId: "session.llm",
            tracer: telemetryTracer,
            metadata: {
              userId: cfg.username ?? "unknown",
              sessionId: input.sessionID,
            },
          },
        }),
      }
    })

    const stream: Interface["stream"] = (input) =>
      Stream.scoped(
        Stream.unwrap(
          Effect.gen(function* () {
            const ctrl = yield* Effect.acquireRelease(
              Effect.sync(() => new AbortController()),
              (ctrl) => Effect.sync(() => ctrl.abort()),
            )

            const result = yield* run({ ...input, abort: ctrl.signal })

            if (result.type === "native") {
              let adapterOrdinal = 0
              const validatedCallIDs = new Set<string>()
              return result.stream.pipe(
                Stream.tap((event) => {
                  if (!input.requestReceipt) return Effect.void
                  const details = adapterReceiptDetails(event)
                  if (!details) return Effect.void
                  return input.requestReceipt.adapterAssembly({
                    ordinal: adapterOrdinal++,
                    eventType: event.type,
                    callID: details.callID,
                    toolName: details.toolName,
                    validationOutcome: adapterValidationOutcome(event, validatedCallIDs),
                    ...(details.payload === undefined
                      ? {
                          payloadHash: undefined,
                          payloadLength: undefined,
                          payloadKeys: [],
                          unavailableReason: details.unavailableReason,
                        }
                      : boundedReceiptPayload(details.payload)),
                  })
                }),
                Stream.ensuring(
                  input.requestReceipt
                    ? input.requestReceipt.rawFrame({
                        ordinal: 0,
                        eventType: "native-runtime",
                        payloadKeys: [],
                        unavailableReason: "native_runtime_did_not_expose_raw_frame",
                        validationOutcome: "not_evaluated",
                      })
                    : Effect.void,
                ),
              )
            }

            // Adapter seam: both runtimes expose the same LLMEvent stream. Native
            // already returns one; AI SDK streams are converted here.
            const state = LLMAISDK.adapterState()
            const aiSdkCallIDs = new Set<string>()
            const validatedCallIDs = new Set<string>()
            let aiSdkOrdinal = 0
            let adapterOrdinal = 0
            return Stream.fromAsyncIterable(result.result.fullStream, (e) =>
              e instanceof Error ? e : new Error(String(e)),
            ).pipe(
              Stream.mapEffect((event) =>
                Effect.gen(function* () {
                  const receipt = input.requestReceipt
                  if (
                    receipt &&
                    (event.type === "tool-call" || event.type === "tool-error") &&
                    !aiSdkCallIDs.has(event.toolCallId)
                  ) {
                    aiSdkCallIDs.add(event.toolCallId)
                    yield* receipt.aiSdkInput({
                      ordinal: aiSdkOrdinal++,
                      eventType: event.type,
                      callID: event.toolCallId,
                      toolName: event.toolName,
                      validationOutcome:
                        event.type === "tool-error" ? "schema_invalid" : LLMAISDK.toolCallInputValidation(event),
                      ...boundedReceiptPayload(event.input),
                    })
                  }
                  const events = yield* LLMAISDK.toLLMEvents(state, event)
                  if (receipt) {
                    yield* Effect.forEach(events, (mapped) => {
                      const details = adapterReceiptDetails(mapped)
                      if (!details) return Effect.void
                      return receipt.adapterAssembly({
                        ordinal: adapterOrdinal++,
                        eventType: mapped.type,
                        callID: details.callID,
                        toolName: details.toolName,
                        validationOutcome: adapterValidationOutcome(mapped, validatedCallIDs),
                        ...(details.payload === undefined
                          ? {
                              payloadHash: undefined,
                              payloadLength: undefined,
                              payloadKeys: [],
                              unavailableReason: details.unavailableReason,
                            }
                          : boundedReceiptPayload(details.payload)),
                      })
                    })
                  }
                  return events
                }),
              ),
              Stream.flatMap((events) => Stream.fromIterable(events)),
              (events) =>
                AgentGateway.manageStream(
                  {
                    callKind: "session_turn",
                    feature: input.small ? "session_small_model" : "session_chat",
                    providerID: input.model.providerID,
                    modelID: input.model.id,
                    sessionID: input.sessionID,
                    messageID: input.user.id,
                    parentSessionID: input.parentSessionID,
                    agent: input.agent.name,
                    metadata: result.metadata,
                    releasedKnowledgeSelection: input.releasedKnowledgeSelection,
                  },
                  events,
                ).pipe(
                  Stream.ensuring(
                    Effect.suspend(() =>
                      input.requestReceipt
                        ? input.requestReceipt.rawFrame({
                            ordinal: 0,
                            eventType: "ai-sdk-runtime",
                            payloadKeys: [],
                            unavailableReason: "provider_transport_did_not_expose_raw_frame",
                            validationOutcome: "not_evaluated",
                          })
                        : Effect.void,
                    ),
                  ),
                ),
            )
          }),
        ),
      )

    return Service.of({ stream })
  }),
)

export const layer = live

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(Auth.defaultLayer),
    Layer.provide(Config.defaultLayer),
    Layer.provide(Provider.defaultLayer),
    Layer.provide(Plugin.defaultLayer),
    Layer.provide(
      Layer.mergeAll(
        AgentGateway.layer({ enabled: true, runsDir: Global.Path.agent.runs }),
        LLMClient.layer.pipe(Layer.provide(Layer.mergeAll(RequestExecutor.defaultLayer, WebSocketExecutor.layer))),
      ),
    ),
    Layer.provide(RuntimeFlags.defaultLayer),
  ),
)

export const hasToolCalls = LLMRequestPrep.hasToolCalls

export * as LLM from "./llm"
