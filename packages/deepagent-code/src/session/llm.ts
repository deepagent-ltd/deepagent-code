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
} from "ai"
import { type LLMEvent } from "@deepagent-code/llm"
import { AgentGateway } from "@deepagent-code/core/agent-gateway"
import { LLMClient, RequestExecutor, WebSocketExecutor } from "@deepagent-code/llm/route"
import type { LLMClientService } from "@deepagent-code/llm/route"
import { GitLabWorkflowLanguageModel } from "gitlab-ai-provider"
import { ProviderTransform } from "@/provider/transform"
import { Config } from "@/config/config"
import type { Agent } from "@/agent/agent"
import type { MessageV2 } from "./message-v2"
import { Plugin } from "@/plugin"
import { Permission } from "@/permission"
import { EventV2Bridge } from "@/event-v2-bridge"
import { EventV2 } from "@deepagent-code/core/event"
import { Wildcard } from "@/util/wildcard"
import { SessionID } from "@/session/schema"
import { Auth } from "@/auth"
import { EffectBridge } from "@/effect/bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import * as Option from "effect/Option"
import * as OtelTracer from "@effect/opentelemetry/Tracer"
import { LLMAISDK } from "./llm/ai-sdk"
import { LLMNativeRuntime } from "./llm/native-runtime"
import { LLMRequestPrep } from "./llm/request"
import { FreeformTools } from "./llm/freeform-tools"
import { configureGateway } from "@/deepagent/config"

const log = Log.create({ service: "llm" })
export const OUTPUT_TOKEN_MAX = ProviderTransform.OUTPUT_TOKEN_MAX

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
  /** A durable attempt owns retry safety for this request; provider-internal retries must stay disabled. */
  durableAttempt?: boolean
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
  | Auth.Service
  | Config.Service
  | Provider.Service
  | Plugin.Service
  | Permission.Service
  | EventV2Bridge.Service
  | LLMClientService
  | RuntimeFlags.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const auth = yield* Auth.Service
    const config = yield* Config.Service
    const provider = yield* Provider.Service
    const plugin = yield* Plugin.Service
    const perm = yield* Permission.Service
    const events = yield* EventV2Bridge.Service
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
      const prepared = yield* LLMRequestPrep.prepare({
        ...input,
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

      const effectiveOptions =
        input.reasoning === "disabled" ? disableThinking(prepared.params.options) : prepared.params.options
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
        const workflowModel = language as GitLabWorkflowLanguageModel & {
          sessionID?: string
          sessionPreapprovedTools?: string[]
          approvalHandler?: (approvalTools: { name: string; args: string }[]) => Promise<{ approved: boolean }>
        }
        workflowModel.sessionID = input.sessionID
        workflowModel.systemPrompt = prepared.system.join("\n")
        workflowModel.toolExecutor = async (toolName, argsJson, _requestID) => {
          // (1) Unknown tool — classify before attempting parse or execute.
          const t = prepared.tools[toolName]
          if (!t || !t.execute) {
            l.warn("workflow tool call: unknown tool", { tool: toolName, errorType: "unknown_tool" })
            return {
              result: "",
              error: `[unknown_tool] Tool "${toolName}" is not available. Resend the request using a valid tool name.`,
            }
          }

          // (2) JSON parse — separate from execution so we can classify invalid_json.
          // Do NOT attempt to repair or fill in missing brackets/quotes.
          let parsedArgs: unknown
          try {
            parsedArgs = JSON.parse(argsJson)
          } catch (parseErr: any) {
            const inputPreview = argsJson.length > 200 ? argsJson.slice(0, 200) + "…[truncated]" : argsJson
            l.warn("workflow tool call: invalid JSON", {
              tool: toolName,
              errorType: "invalid_json",
              errorMessage: (parseErr?.message ?? "parse error").slice(0, 200),
              inputPreview,
            })
            return {
              result: "",
              error: `[invalid_json] Arguments for tool "${toolName}" are not valid JSON (${(parseErr?.message ?? "parse error").slice(0, 200)}). Resend the request with complete, valid JSON arguments.`,
            }
          }

          // (3) Execute — classify schema_mismatch vs other runtime errors.
          try {
            const result = await t.execute!(parsedArgs, {
              toolCallId: _requestID,
              messages: input.messages,
              abortSignal: input.abort,
            })
            const output = typeof result === "string" ? result : (result?.output ?? JSON.stringify(result))
            return {
              result: output,
              metadata: typeof result === "object" ? result?.metadata : undefined,
              title: typeof result === "object" ? result?.title : undefined,
            }
          } catch (e: any) {
            // Effect Schema parse errors expose ._tag === "ParseError"; Zod errors expose .issues.
            const isSchemaError =
              Array.isArray(e?.issues) || e?._tag === "ParseError" || e?.cause?._tag === "ParseError"
            const errorType = isSchemaError ? "schema_mismatch" : "execution_error"
            l.warn("workflow tool call: execution error", {
              tool: toolName,
              errorType,
              errorMessage: (e?.message ?? String(e)).slice(0, 200),
            })
            if (isSchemaError) {
              return {
                result: "",
                error: `[schema_mismatch] Arguments for tool "${toolName}" do not match the expected schema. Resend the request with correctly structured arguments.`,
              }
            }
            return { result: "", error: (e?.message ?? String(e)).slice(0, 500) }
          }
        }

        const ruleset = Permission.merge(input.agent.permission ?? [], input.permission ?? [])
        workflowModel.sessionPreapprovedTools = Object.keys(prepared.tools).filter((name) => {
          const match = ruleset.findLast((rule) => Wildcard.match(name, rule.permission))
          return !match || match.action !== "ask"
        })

        const bridge = yield* EffectBridge.make()
        const approvedToolsForSession = new Set<string>()
        workflowModel.approvalHandler = bridge.bind(async (approvalTools) => {
          const uniqueNames = [...new Set(approvalTools.map((t: { name: string }) => t.name))] as string[]
          // Auto-approve tools that were already approved in this session
          // (prevents infinite approval loops for server-side MCP tools)
          if (uniqueNames.every((name) => approvedToolsForSession.has(name))) {
            return { approved: true }
          }

          const id = PermissionV1.ID.ascending()
          let unsub: EventV2.Unsubscribe | undefined
          try {
            unsub = await bridge.promise(
              events.listen((event) => {
                if (event.type !== Permission.Event.Replied.type) return Effect.void
                const data = event.data as EventV2.Data<typeof Permission.Event.Replied>
                if (data.requestID !== id) return Effect.void
                void data.reply
                return Effect.void
              }),
            )
            const toolPatterns = approvalTools.map((t: { name: string; args: string }) => {
              try {
                const parsed = JSON.parse(t.args) as Record<string, unknown>
                const title = (parsed?.title ?? parsed?.name ?? "") as string
                return title ? `${t.name}: ${title}` : t.name
              } catch {
                return t.name
              }
            })
            const uniquePatterns = [...new Set(toolPatterns)] as string[]
            await bridge.promise(
              perm.ask({
                id,
                sessionID: SessionID.make(input.sessionID),
                permission: "workflow_tool_approval",
                patterns: uniquePatterns,
                metadata: { tools: approvalTools },
                always: uniquePatterns,
                ruleset: [],
              }),
            )
            for (const name of uniqueNames) approvedToolsForSession.add(name)
            workflowModel.sessionPreapprovedTools = [...(workflowModel.sessionPreapprovedTools ?? []), ...uniqueNames]
            return { approved: true }
          } catch {
            return { approved: false }
          } finally {
            if (unsub) await bridge.promise(unsub)
          }
        })
      }

      const runtimeTools = prepared.tools

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
        })
        if (native.type === "supported") {
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
          onError(error) {
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
          providerOptions: ProviderTransform.providerOptions(input.model, effectiveOptions ?? {}),
          activeTools: Object.keys(runtimeTools).filter((x) => x !== "invalid"),
          tools: runtimeTools,
          toolChoice: effectiveToolChoice,
          maxOutputTokens: prepared.params.maxOutputTokens,
          abortSignal: input.abort,
          headers: prepared.headers,
          maxRetries: input.durableAttempt ? 0 : providerMaxRetries ?? input.retries ?? 0,
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

            if (result.type === "native") return result.stream

            // Adapter seam: both runtimes expose the same LLMEvent stream. Native
            // already returns one; AI SDK streams are converted here.
            const state = LLMAISDK.adapterState()
            return Stream.fromAsyncIterable(result.result.fullStream, (e) =>
              e instanceof Error ? e : new Error(String(e)),
            ).pipe(
              Stream.mapEffect((event) => LLMAISDK.toLLMEvents(state, event)),
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
                  },
                  events,
                ),
            )
          }),
        ),
      )

    return Service.of({ stream })
  }),
)

export const layer = live.pipe(Layer.provide(Permission.defaultLayer), Layer.provide(EventV2Bridge.defaultLayer))

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
