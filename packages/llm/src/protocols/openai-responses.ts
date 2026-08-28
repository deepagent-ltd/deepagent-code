import { Effect, Schema } from "effect"
import { Route } from "../route/client"
import { Auth } from "../route/auth"
import { Endpoint } from "../route/endpoint"
import { RequestExecutor } from "../route/executor"
import { HttpTransport, WebSocketTransport } from "../route/transport"
import { Protocol } from "../route/protocol"
import {
  LLMEvent,
  ToolDefinition,
  Usage,
  type FinishReason,
  type LLMError,
  type LLMRequest,
  type ProviderMetadata,
  type ReasoningPart,
  type TextPart,
  type ToolCallPart,
  type ToolResultContentPart,
  type ToolResultPart,
} from "../schema"
import { JsonObject, optionalArray, optionalNull, ProviderShared } from "./shared"
import { isContextOverflow } from "../provider-error"
import { OpenAIOptions } from "./utils/openai-options"
import { Lifecycle } from "./utils/lifecycle"
import { ToolStream } from "./utils/tool-stream"

const ADAPTER = "openai-responses"
export const DEFAULT_BASE_URL = "https://api.openai.com/v1"
export const PATH = "/responses"

// UPD-005 (/responses/compact): OpenAI-specific UNARY endpoint that compacts
// conversation history server-side and returns a new item list. Served from
// the same base URL as `/responses`. The Protocol/Route abstraction is
// streaming-only (SSE state machine), so compact is deliberately implemented
// as a standalone unary client below instead of extending Protocol.make —
// that keeps the blast radius inside this single file.
export const COMPACT_PATH = "/responses/compact"

/**
 * UPD-005: whether this protocol's canonical provider serves `/responses/compact`.
 * True only for the OpenAI Responses route; OpenAI-compatible families must
 * opt in per profile (`supportsResponsesCompact`) and are NOT assumed to.
 */
export const supportsRemoteCompaction = true

// =============================================================================
// Request Body Schema
// =============================================================================
const OpenAIResponsesInputText = Schema.Struct({
  type: Schema.tag("input_text"),
  text: Schema.String,
})
const OpenAIResponsesInputImage = Schema.Struct({
  type: Schema.tag("input_image"),
  image_url: Schema.String,
})
const OpenAIResponsesInputContent = Schema.Union([OpenAIResponsesInputText, OpenAIResponsesInputImage])
type OpenAIResponsesInputContent = Schema.Schema.Type<typeof OpenAIResponsesInputContent>

const OpenAIResponsesOutputText = Schema.Struct({
  type: Schema.tag("output_text"),
  text: Schema.String,
})

const OpenAIResponsesReasoningSummaryText = Schema.Struct({
  type: Schema.tag("summary_text"),
  text: Schema.String,
})

const OpenAIResponsesReasoningItem = Schema.Struct({
  type: Schema.tag("reasoning"),
  id: Schema.String,
  summary: Schema.Array(OpenAIResponsesReasoningSummaryText),
  encrypted_content: optionalNull(Schema.String),
})

const OpenAIResponsesItemReference = Schema.Struct({
  type: Schema.tag("item_reference"),
  id: Schema.String,
})

// UPD-005 (/responses/compact): a prior server-side compaction's opaque
// encrypted context. Sent ahead of the new messages so the provider can
// expand it during the next compaction. Never interpreted client-side.
const OpenAIResponsesCompactionItem = Schema.Struct({
  type: Schema.tag("compaction"),
  encrypted_content: Schema.String,
})
type OpenAIResponsesCompactionItem = Schema.Schema.Type<typeof OpenAIResponsesCompactionItem>

// `function_call_output.output` accepts either a plain string or an ordered
// array of content items so tools can return images in addition to text.
// https://platform.openai.com/docs/api-reference/responses/object
const OpenAIResponsesFunctionCallOutputContent = Schema.Union([OpenAIResponsesInputText, OpenAIResponsesInputImage])

const OpenAIResponsesFunctionCallOutput = Schema.Union([
  Schema.String,
  Schema.Array(OpenAIResponsesFunctionCallOutputContent),
])

const OpenAIResponsesInputItem = Schema.Union([
  Schema.Struct({ role: Schema.tag("system"), content: Schema.String }),
  OpenAIResponsesCompactionItem,
  Schema.Struct({ role: Schema.tag("user"), content: Schema.Array(OpenAIResponsesInputContent) }),
  Schema.Struct({ role: Schema.tag("assistant"), content: Schema.Array(OpenAIResponsesOutputText) }),
  OpenAIResponsesReasoningItem,
  OpenAIResponsesItemReference,
  Schema.Struct({
    type: Schema.tag("function_call"),
    call_id: Schema.String,
    name: Schema.String,
    arguments: Schema.String,
  }),
  Schema.Struct({
    type: Schema.tag("custom_tool_call"),
    call_id: Schema.String,
    name: Schema.String,
    input: Schema.String,
  }),
  Schema.Struct({
    type: Schema.tag("function_call_output"),
    call_id: Schema.String,
    output: OpenAIResponsesFunctionCallOutput,
  }),
  Schema.Struct({
    type: Schema.tag("custom_tool_call_output"),
    call_id: Schema.String,
    output: OpenAIResponsesFunctionCallOutput,
  }),
])
type OpenAIResponsesInputItem = Schema.Schema.Type<typeof OpenAIResponsesInputItem>

// Mutable counterpart of the schema reasoning item so `lowerMessages` can fold
// multiple streamed summary parts into the same item before flushing.
type OpenAIResponsesReasoningInput = {
  type: "reasoning"
  id: string
  summary: Array<{ type: "summary_text"; text: string }>
  encrypted_content?: string | null
}

const OpenAIResponsesTool = Schema.Union([
  Schema.Struct({
    type: Schema.tag("function"),
    name: Schema.String,
    description: Schema.String,
    parameters: JsonObject,
    strict: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    type: Schema.tag("custom"),
    name: Schema.String,
    description: Schema.optional(Schema.String),
    format: Schema.optional(
      Schema.Union([
        Schema.Struct({
          type: Schema.Literal("grammar"),
          syntax: Schema.Literals(["regex", "lark"]),
          definition: Schema.String,
        }),
        Schema.Struct({ type: Schema.Literal("text") }),
      ]),
    ),
  }),
])
type OpenAIResponsesTool = Schema.Schema.Type<typeof OpenAIResponsesTool>

const OpenAIResponsesToolChoice = Schema.Union([
  Schema.Literals(["auto", "none", "required"]),
  Schema.Struct({ type: Schema.tag("function"), name: Schema.String }),
  Schema.Struct({ type: Schema.tag("custom"), name: Schema.String }),
])

// Fields shared between the HTTP body and the WebSocket `response.create`
// message. The HTTP body adds `stream: true`; the WebSocket message adds
// `type: "response.create"`. Defining the shared shape once keeps the two
// transports in sync without a destructure-and-strip dance.
const OpenAIResponsesCoreFields = {
  model: Schema.String,
  input: Schema.Array(OpenAIResponsesInputItem),
  instructions: Schema.optional(Schema.String),
  tools: optionalArray(OpenAIResponsesTool),
  tool_choice: Schema.optional(OpenAIResponsesToolChoice),
  store: Schema.optional(Schema.Boolean),
  service_tier: Schema.optional(OpenAIOptions.OpenAIServiceTier),
  prompt_cache_key: Schema.optional(Schema.String),
  include: optionalArray(OpenAIOptions.OpenAIResponseIncludable),
  reasoning: Schema.optional(
    Schema.Struct({
      effort: Schema.optional(OpenAIOptions.OpenAIReasoningEffort),
      summary: Schema.optional(Schema.Literal("auto")),
    }),
  ),
  text: Schema.optional(
    Schema.Struct({
      verbosity: Schema.optional(OpenAIOptions.OpenAITextVerbosity),
      // UPD-002: wire-level structured output (json_schema constrained text).
      format: Schema.optional(
        Schema.Struct({
          type: Schema.Literal("json_schema"),
          name: Schema.String,
          schema: Schema.Record(Schema.String, Schema.Unknown),
          strict: Schema.optional(Schema.Boolean),
        }),
      ),
    }),
  ),
  max_output_tokens: Schema.optional(Schema.Number),
  temperature: Schema.optional(Schema.Number),
  top_p: Schema.optional(Schema.Number),
}

const OpenAIResponsesBody = Schema.Struct({
  ...OpenAIResponsesCoreFields,
  stream: Schema.Literal(true),
})
export type OpenAIResponsesBody = Schema.Schema.Type<typeof OpenAIResponsesBody>

const OpenAIResponsesWebSocketMessage = Schema.StructWithRest(
  Schema.Struct({
    type: Schema.tag("response.create"),
    ...OpenAIResponsesCoreFields,
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
)
type OpenAIResponsesWebSocketMessage = Schema.Schema.Type<typeof OpenAIResponsesWebSocketMessage>
const encodeWebSocketMessage = Schema.encodeSync(Schema.fromJsonString(OpenAIResponsesWebSocketMessage))

const OpenAIResponsesUsage = Schema.Struct({
  input_tokens: Schema.optional(Schema.Number),
  input_tokens_details: optionalNull(Schema.Struct({ cached_tokens: Schema.optional(Schema.Number) })),
  output_tokens: Schema.optional(Schema.Number),
  output_tokens_details: optionalNull(Schema.Struct({ reasoning_tokens: Schema.optional(Schema.Number) })),
  total_tokens: Schema.optional(Schema.Number),
})
type OpenAIResponsesUsage = Schema.Schema.Type<typeof OpenAIResponsesUsage>

const OpenAIResponsesStreamItem = Schema.Struct({
  type: Schema.String,
  id: Schema.optional(Schema.String),
  call_id: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  arguments: Schema.optional(Schema.String),
  input: Schema.optional(Schema.String),
  // Hosted (provider-executed) tool fields. Each hosted tool item carries its
  // own subset of these — we capture them generically so we can surface the
  // call's typed input portion and round-trip the full result payload without
  // hand-rolling a per-tool schema.
  status: Schema.optional(Schema.String),
  action: Schema.optional(Schema.Unknown),
  queries: Schema.optional(Schema.Unknown),
  results: Schema.optional(Schema.Unknown),
  code: Schema.optional(Schema.String),
  container_id: Schema.optional(Schema.String),
  outputs: Schema.optional(Schema.Unknown),
  server_label: Schema.optional(Schema.String),
  output: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.Unknown),
  encrypted_content: optionalNull(Schema.String),
})
type OpenAIResponsesStreamItem = Schema.Schema.Type<typeof OpenAIResponsesStreamItem>

// OpenAI Responses surfaces provider failures in two related shapes. The
// streaming `error` event carries the details at the top level
// (`{ type: "error", code, message, param, sequence_number }`), while
// `response.failed` carries them under `response.error`. We capture both so
// the parser can surface a useful provider-error message in either path.
const OpenAIResponsesErrorPayload = Schema.Struct({
  code: optionalNull(Schema.String),
  message: optionalNull(Schema.String),
  param: optionalNull(Schema.String),
})

const OpenAIResponsesEvent = Schema.Struct({
  type: Schema.String,
  delta: Schema.optional(Schema.String),
  item_id: Schema.optional(Schema.String),
  summary_index: Schema.optional(Schema.Number),
  item: Schema.optional(OpenAIResponsesStreamItem),
  response: Schema.optional(
    Schema.StructWithRest(
      Schema.Struct({
        id: Schema.optional(Schema.String),
        service_tier: optionalNull(Schema.String),
        incomplete_details: optionalNull(Schema.Struct({ reason: Schema.String })),
        usage: optionalNull(OpenAIResponsesUsage),
        error: optionalNull(OpenAIResponsesErrorPayload),
      }),
      [Schema.Record(Schema.String, Schema.Unknown)],
    ),
  ),
  code: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
  param: Schema.optional(Schema.String),
})
type OpenAIResponsesEvent = Schema.Schema.Type<typeof OpenAIResponsesEvent>

interface ParserState {
  readonly tools: ToolStream.State<string>
  readonly pendingToolEvents: ReadonlyArray<LLMEvent>
  readonly hasFunctionCall: boolean
  readonly lifecycle: Lifecycle.State
  readonly reasoningItems: Readonly<Record<string, ReasoningStreamItem>>
  readonly store: boolean | undefined
  // UPD-002: when the request asked for wire-level json_schema output, this
  // holds the requested format name and the parser accumulates the streamed
  // output text so `response.completed` can verify the provider actually
  // returned well-formed JSON (failure ⇒ InvalidProviderOutput).
  readonly jsonFormatName: string | undefined
  readonly accumulatedText: string
}

type ReasoningSummaryStatus = "active" | "can-conclude" | "concluded"

interface ReasoningStreamItem {
  readonly encryptedContent: string | null | undefined
  // Keyed by OpenAI's numeric `summary_index`. JS object keys coerce to
  // strings, but typing the map as `Record<number, ...>` documents intent
  // and matches the wire field.
  readonly summaryParts: Readonly<Record<number, ReasoningSummaryStatus>>
}

const invalid = ProviderShared.invalidRequest

// =============================================================================
// Request Lowering
// =============================================================================
const lowerTool = (tool: ToolDefinition): OpenAIResponsesTool =>
  ToolDefinition.isCustom(tool)
    ? {
        type: "custom",
        name: tool.name,
        description: tool.description || undefined,
        format: tool.format,
      }
    : {
        type: "function",
        name: tool.name,
        description: tool.description,
        parameters: ProviderShared.openAiToolInputSchema(tool.inputSchema),
      }

const lowerToolChoice = (toolChoice: NonNullable<LLMRequest["toolChoice"]>, tools: ReadonlyArray<ToolDefinition>) =>
  ProviderShared.matchToolChoice("OpenAI Responses", toolChoice, {
    auto: () => "auto" as const,
    none: () => "none" as const,
    required: () => "required" as const,
    tool: (name) => ({
      type: tools.some((tool) => tool.name === name && ToolDefinition.isCustom(tool))
        ? ("custom" as const)
        : ("function" as const),
      name,
    }),
  })

const rawCustomToolInput = (input: unknown) => {
  if (typeof input === "string") return input
  if (ProviderShared.isRecord(input) && typeof input.patchText === "string") return input.patchText
  if (ProviderShared.isRecord(input) && typeof input.value === "string") return input.value
  return ProviderShared.encodeJson(input)
}

const historicalToolType = (part: ToolCallPart | ToolResultPart): "custom" | "function" | undefined => {
  const marker = part.providerMetadata?.deepagent?.toolType
  return marker === "custom" || marker === "function" ? marker : undefined
}

const lowerToolCall = (part: ToolCallPart, custom: boolean): OpenAIResponsesInputItem =>
  custom
    ? {
        type: "custom_tool_call",
        call_id: part.id,
        name: part.name,
        input: rawCustomToolInput(part.input),
      }
    : {
        type: "function_call",
        call_id: part.id,
        name: part.name,
        arguments: ProviderShared.encodeJson(part.input),
      }

const lowerReasoning = (part: ReasoningPart): OpenAIResponsesReasoningInput | undefined => {
  const openai = part.providerMetadata?.openai
  if (!ProviderShared.isRecord(openai) || typeof openai.itemId !== "string" || openai.itemId.length === 0)
    return undefined
  const encryptedContent =
    typeof openai.reasoningEncryptedContent === "string"
      ? openai.reasoningEncryptedContent
      : openai.reasoningEncryptedContent === null
        ? null
        : undefined
  return {
    type: "reasoning",
    id: openai.itemId,
    summary: part.text.length > 0 ? [{ type: "summary_text", text: part.text }] : [],
    encrypted_content: encryptedContent,
  }
}

const hostedToolItemID = (part: ToolResultPart) => {
  const openai = part.providerMetadata?.openai
  return ProviderShared.isRecord(openai) && typeof openai.itemId === "string" && openai.itemId.length > 0
    ? openai.itemId
    : undefined
}

const lowerUserContent = Effect.fn("OpenAIResponses.lowerUserContent")(function* (
  part: LLMRequest["messages"][number]["content"][number],
) {
  if (part.type === "text") return { type: "input_text" as const, text: part.text }
  if (part.type === "media") {
    const media = yield* ProviderShared.validateMedia(
      "OpenAI Responses",
      part,
      new Set<string>(ProviderShared.IMAGE_MIMES),
    )
    return { type: "input_image" as const, image_url: media.dataUrl }
  }
  return yield* ProviderShared.unsupportedContent("OpenAI Responses", "user", ["text", "media"])
})

// Tool results may carry structured text/images. Keep media as provider-native
// content instead of JSON-stringifying base64 into a prompt string.
const lowerToolResultContentItem = Effect.fn("OpenAIResponses.lowerToolResultContentItem")(function* (
  item: ToolResultContentPart,
) {
  if (item.type === "text") return { type: "input_text" as const, text: item.text }
  const media = yield* ProviderShared.validateMedia(
    "OpenAI Responses",
    item,
    new Set<string>(ProviderShared.IMAGE_MIMES),
  )
  return { type: "input_image" as const, image_url: media.dataUrl }
})

const lowerToolResultOutput = Effect.fn("OpenAIResponses.lowerToolResultOutput")(function* (part: ToolResultPart) {
  // Text/json/error results are encoded as a plain string for backward
  // compatibility with existing cassettes and provider expectations.
  if (part.result.type !== "content") return ProviderShared.toolResultText(part)
  // Preserve the narrowed array element type when compiled through a consumer package.
  const content: ReadonlyArray<ToolResultContentPart> = part.result.value
  return yield* Effect.forEach(content, lowerToolResultContentItem)
})

const lowerMessages = Effect.fn("OpenAIResponses.lowerMessages")(function* (request: LLMRequest) {
  const customTools = new Set(request.tools.filter(ToolDefinition.isCustom).map((tool) => tool.name))
  const customToolCallIDs = new Set<string>()
  const functionToolCallIDs = new Set<string>()
  const system: OpenAIResponsesInputItem[] =
    request.system.length === 0 ? [] : [{ role: "system", content: ProviderShared.joinText(request.system) }]
  const input: OpenAIResponsesInputItem[] = [...system]
  const compactionEncryptedContent = OpenAIOptions.compactionEncryptedContent(request)
  if (compactionEncryptedContent)
    input.unshift({ type: "compaction", encrypted_content: compactionEncryptedContent })
  const store = OpenAIOptions.store(request)

  for (const message of request.messages) {
    if (message.role === "system") {
      const part = yield* ProviderShared.wrappedSystemUpdate("OpenAI Responses", message)
      const previous = input.at(-1)
      if (previous && "role" in previous && previous.role === "user")
        input[input.length - 1] = {
          role: "user",
          content: [...previous.content, { type: "input_text", text: part.text }],
        }
      else input.push({ role: "user", content: [{ type: "input_text", text: part.text }] })
      continue
    }

    if (message.role === "user") {
      input.push({ role: "user", content: yield* Effect.forEach(message.content, lowerUserContent) })
      continue
    }

    if (message.role === "assistant") {
      const content: TextPart[] = []
      const reasoningItems: Record<string, OpenAIResponsesReasoningInput> = {}
      const reasoningReferences = new Set<string>()
      const hostedToolReferences = new Set<string>()
      const flushText = () => {
        if (content.length === 0) return
        input.push({ role: "assistant", content: content.map((part) => ({ type: "output_text", text: part.text })) })
        content.splice(0, content.length)
      }
      for (const part of message.content) {
        if (part.type === "text") {
          content.push(part)
          continue
        }
        if (part.type === "reasoning") {
          flushText()
          const reasoning = lowerReasoning(part)
          if (!reasoning) continue
          if (store !== false && reasoning.id) {
            if (!reasoningReferences.has(reasoning.id)) input.push({ type: "item_reference", id: reasoning.id })
            reasoningReferences.add(reasoning.id)
            continue
          }
          const existing = reasoningItems[reasoning.id]
          if (existing) {
            existing.summary.push(...reasoning.summary)
            if (typeof reasoning.encrypted_content === "string")
              existing.encrypted_content = reasoning.encrypted_content
            continue
          }
          reasoningItems[reasoning.id] = reasoning
          input.push(reasoning)
          continue
        }
        if (part.type === "tool-call") {
          flushText()
          if (part.providerExecuted === true) continue
          const historicalType = historicalToolType(part)
          const isCustom = historicalType === "custom" || (historicalType === undefined && customTools.has(part.name))
          if (isCustom) customToolCallIDs.add(part.id)
          else functionToolCallIDs.add(part.id)
          input.push(lowerToolCall(part, isCustom))
          continue
        }
        if (part.type === "tool-result" && part.providerExecuted === true) {
          flushText()
          const itemID = hostedToolItemID(part)
          if (store !== false && itemID && !hostedToolReferences.has(itemID))
            input.push({ type: "item_reference", id: itemID })
          if (itemID) hostedToolReferences.add(itemID)
          continue
        }
        return yield* ProviderShared.unsupportedContent("OpenAI Responses", "assistant", [
          "text",
          "reasoning",
          "tool-call",
          "tool-result",
        ])
      }
      flushText()
      continue
    }

    for (const part of message.content) {
      if (!ProviderShared.supportsContent(part, ["tool-result"]))
        return yield* ProviderShared.unsupportedContent("OpenAI Responses", "tool", ["tool-result"])
      input.push(
        customToolCallIDs.has(part.id) ||
          (!functionToolCallIDs.has(part.id) &&
            (historicalToolType(part) === "custom" ||
              (historicalToolType(part) === undefined && customTools.has(part.name))))
          ? {
              type: "custom_tool_call_output",
              call_id: part.id,
              output: yield* lowerToolResultOutput(part),
            }
          : {
              type: "function_call_output",
              call_id: part.id,
              output: yield* lowerToolResultOutput(part),
            },
      )
    }
  }

  // With store:false, OpenAI only accepts previous reasoning items when the
  // complete item has encrypted state. Summary blocks for one item may carry
  // that state only on the last block, so filter after they have been joined.
  return store === false
    ? input.filter(
        (item) => !("type" in item) || item.type !== "reasoning" || typeof item.encrypted_content === "string",
      )
    : input
})

// UPD-002: lower the canonical `responseFormat` json variant onto OpenAI
// Responses' wire shape. `strict` stays opt-in: session schemas are not
// authored against OpenAI's strict-mode restrictions (additionalProperties,
// required-field enumeration), so defaulting to false keeps every schema valid.
const lowerTextFormat = (request: LLMRequest) => {
  const format = request.responseFormat
  if (!format || format.type !== "json") return undefined
  return {
    type: "json_schema" as const,
    name: format.name ?? "structured_output",
    schema: format.schema,
    ...(format.strict !== undefined ? { strict: format.strict } : {}),
  }
}

const lowerOptions = Effect.fn("OpenAIResponses.lowerOptions")(function* (request: LLMRequest) {
  const store = OpenAIOptions.store(request)
  const promptCacheKey = OpenAIOptions.promptCacheKey(request)
  const effort = OpenAIOptions.reasoningEffort(request)
  if (effort && !OpenAIOptions.isReasoningEffort(effort))
    return yield* invalid(`OpenAI Responses does not support reasoning effort ${effort}`)
  const summary = OpenAIOptions.reasoningSummary(request)
  const include = OpenAIOptions.include(request)
  const verbosity = OpenAIOptions.textVerbosity(request)
  const instructions = OpenAIOptions.instructions(request)
  const serviceTier = OpenAIOptions.serviceTier(request)
  const format = lowerTextFormat(request)
  const text =
    verbosity || format ? { ...(verbosity ? { verbosity } : {}), ...(format ? { format } : {}) } : undefined
  return {
    ...(instructions ? { instructions } : {}),
    ...(store !== undefined ? { store } : {}),
    ...(promptCacheKey ? { prompt_cache_key: promptCacheKey } : {}),
    ...(include ? { include } : {}),
    ...(effort || summary ? { reasoning: { effort, summary } } : {}),
    ...(text ? { text } : {}),
    ...(serviceTier ? { service_tier: serviceTier } : {}),
  }
})

const fromRequest = Effect.fn("OpenAIResponses.fromRequest")(function* (request: LLMRequest) {
  const generation = request.generation
  const options = yield* lowerOptions(request)
  return {
    model: request.model.id,
    input: yield* lowerMessages(request),
    tools: request.tools.length === 0 ? undefined : request.tools.map(lowerTool),
    tool_choice: request.toolChoice ? yield* lowerToolChoice(request.toolChoice, request.tools) : undefined,
    stream: true as const,
    max_output_tokens: generation?.maxTokens,
    temperature: generation?.temperature,
    top_p: generation?.topP,
    ...options,
  }
})

// =============================================================================
// Stream Parsing
// =============================================================================
// OpenAI Responses reports `input_tokens` (inclusive total) with a
// `cached_tokens` subset, and `output_tokens` (inclusive total) with a
// `reasoning_tokens` subset. Pass the totals through and derive the
// non-cached breakdown.
const mapUsage = (usage: OpenAIResponsesUsage | null | undefined) => {
  if (!usage) return undefined
  const cached = usage.input_tokens_details?.cached_tokens
  const reasoning = usage.output_tokens_details?.reasoning_tokens
  const nonCached = ProviderShared.subtractTokens(usage.input_tokens, cached)
  return new Usage({
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    nonCachedInputTokens: nonCached,
    cacheReadInputTokens: cached,
    reasoningTokens: reasoning,
    totalTokens: ProviderShared.totalTokens(usage.input_tokens, usage.output_tokens, usage.total_tokens),
    providerMetadata: { openai: usage },
  })
}

const mapFinishReason = (event: OpenAIResponsesEvent, hasFunctionCall: boolean): FinishReason => {
  const reason = event.response?.incomplete_details?.reason
  if (event.type === "response.incomplete" && (reason === undefined || reason === null)) return "unknown"
  if (reason === undefined || reason === null) return hasFunctionCall ? "tool-calls" : "stop"
  if (reason === "max_output_tokens") return "length"
  if (reason === "content_filter") return "content-filter"
  return hasFunctionCall ? "tool-calls" : "unknown"
}

const openaiMetadata = (metadata: Record<string, unknown>): ProviderMetadata => ({ openai: metadata })

const toolMetadata = (itemId: string, type: "custom" | "function"): ProviderMetadata =>
  type === "custom" ? { openai: { itemId }, deepagent: { toolType: type } } : { openai: { itemId } }

// Hosted tool items (provider-executed) ship their typed input + status +
// result fields all in one item. We expose them as a `tool-call` +
// `tool-result` pair so consumers can treat them uniformly with client tools,
// only differentiated by `providerExecuted: true`.
//
// One record per OpenAI Responses item type that represents a hosted
// (provider-executed) tool call: the common name we surface, plus an `input`
// extractor that picks the fields the model actually populated for that tool.
// Falling back to `{}` when an entry isn't fully typed keeps unknown tools
// observable without rolling a per-tool schema.
const HOSTED_TOOLS = {
  web_search_call: { name: "web_search", input: (item) => item.action ?? {} },
  web_search_preview_call: { name: "web_search_preview", input: (item) => item.action ?? {} },
  file_search_call: { name: "file_search", input: (item) => ({ queries: item.queries ?? [] }) },
  code_interpreter_call: {
    name: "code_interpreter",
    input: (item) => ({ code: item.code, container_id: item.container_id }),
  },
  computer_use_call: { name: "computer_use", input: (item) => item.action ?? {} },
  image_generation_call: { name: "image_generation", input: () => ({}) },
  mcp_call: {
    name: "mcp",
    input: (item) => ({ server_label: item.server_label, name: item.name, arguments: item.arguments }),
  },
  local_shell_call: { name: "local_shell", input: (item) => item.action ?? {} },
} as const satisfies Record<
  string,
  { readonly name: string; readonly input: (item: OpenAIResponsesStreamItem) => unknown }
>

type HostedToolType = keyof typeof HOSTED_TOOLS

const isHostedToolItem = (
  item: OpenAIResponsesStreamItem,
): item is OpenAIResponsesStreamItem & { type: HostedToolType; id: string } =>
  item.type in HOSTED_TOOLS && typeof item.id === "string" && item.id.length > 0

const isReasoningItem = (
  item: OpenAIResponsesStreamItem,
): item is OpenAIResponsesStreamItem & { type: "reasoning"; id: string } =>
  item.type === "reasoning" && typeof item.id === "string" && item.id.length > 0

// Round-trip the full item as the structured result so consumers can extract
// outputs / sources / status without re-decoding.
const hostedToolResult = (item: OpenAIResponsesStreamItem) => {
  const isError = typeof item.error !== "undefined" && item.error !== null
  return isError ? { type: "error" as const, value: item.error } : { type: "json" as const, value: item }
}

const hostedToolEvents = (
  item: OpenAIResponsesStreamItem & { type: HostedToolType; id: string },
): ReadonlyArray<LLMEvent> => {
  const tool = HOSTED_TOOLS[item.type]
  const providerMetadata = openaiMetadata({ itemId: item.id })
  return [
    LLMEvent.toolCall({
      id: item.id,
      name: tool.name,
      input: tool.input(item),
      providerExecuted: true,
      providerMetadata,
    }),
    LLMEvent.toolResult({
      id: item.id,
      name: tool.name,
      result: hostedToolResult(item),
      providerExecuted: true,
      providerMetadata,
    }),
  ]
}

type StepResult = readonly [ParserState, ReadonlyArray<LLMEvent>]

const NO_EVENTS: StepResult["1"] = []

// `response.completed` / `response.incomplete` are clean finishes that emit a
// `finish` event; `response.failed` is a hard failure that emits a
// `provider-error`. All three end the stream — kept in one set so `step` and
// the protocol's `terminal` predicate stay in sync.
const TERMINAL_TYPES = new Set(["response.completed", "response.incomplete", "response.failed"])

const onOutputTextDelta = (state: ParserState, event: OpenAIResponsesEvent): StepResult => {
  if (!event.delta) return [state, NO_EVENTS]
  const events: LLMEvent[] = []
  return [
    {
      ...state,
      lifecycle: Lifecycle.textDelta(state.lifecycle, events, event.item_id ?? "text-0", event.delta),
      // Only accumulate when a wire json_schema format was requested — keeps
      // the free-form path allocation-free.
      accumulatedText: state.jsonFormatName ? state.accumulatedText + event.delta : state.accumulatedText,
    },
    events,
  ]
}

const onReasoningDelta = (state: ParserState, event: OpenAIResponsesEvent): StepResult => {
  if (!event.delta) return [state, NO_EVENTS]
  const events: LLMEvent[] = []
  const itemID = event.item_id ?? "reasoning-0"
  const id =
    event.summary_index !== undefined || state.reasoningItems[itemID] ? `${itemID}:${event.summary_index ?? 0}` : itemID
  return [
    {
      ...state,
      lifecycle: Lifecycle.reasoningDelta(state.lifecycle, events, id, event.delta),
    },
    events,
  ]
}

const onReasoningDone = (state: ParserState, _event: OpenAIResponsesEvent): StepResult => [state, NO_EVENTS]

const reasoningMetadata = (item: OpenAIResponsesStreamItem & { id: string }) =>
  openaiMetadata({ itemId: item.id, reasoningEncryptedContent: item.encrypted_content ?? null })

// OpenAI Responses streams reasoning items in a stable order:
//   `output_item.added` (reasoning) →
//     `reasoning_summary_part.added` (index=0) →
//     `reasoning_summary_text.delta` →
//     `reasoning_summary_part.done` (index=0) →
//     (repeat for index>0) →
//   `output_item.done` (reasoning).
// The handlers below rely on this ordering: `onOutputItemAdded` seeds the
// per-item entry, `onReasoningSummaryPartAdded` for `summary_index === 0`
// short-circuits when the entry already exists, and higher-index handlers
// fold against the same entry. Behaviour for out-of-order events is
// best-effort, not guaranteed.
const onOutputItemAdded = (state: ParserState, event: OpenAIResponsesEvent): StepResult => {
  const item = event.item
  if (item && isReasoningItem(item)) {
    const events: LLMEvent[] = []
    return [
      {
        ...state,
        lifecycle: Lifecycle.reasoningStart(state.lifecycle, events, `${item.id}:0`, reasoningMetadata(item)),
        reasoningItems: {
          ...state.reasoningItems,
          [item.id]: { encryptedContent: item.encrypted_content, summaryParts: { 0: "active" } },
        },
      },
      events,
    ]
  }
  if ((item?.type !== "function_call" && item?.type !== "custom_tool_call") || !item.id) return [state, NO_EVENTS]
  const providerMetadata =
    item.type === "custom_tool_call"
      ? toolMetadata(item.id, "custom")
      : item.name === "apply_patch"
        ? toolMetadata(item.id, "function")
        : openaiMetadata({ itemId: item.id })
  const events: LLMEvent[] = []
  const lifecycle = Lifecycle.stepStart(state.lifecycle, events)
  return [
    {
      ...state,
      lifecycle,
      hasFunctionCall: state.hasFunctionCall,
      tools: ToolStream.start(state.tools, item.id, {
        id: item.call_id ?? item.id,
        name: item.name ?? "",
        input: item.type === "custom_tool_call" ? (item.input ?? "") : (item.arguments ?? ""),
        inputType: item.type === "custom_tool_call" ? "text" : "json",
        providerMetadata,
      }),
    },
    [...events, LLMEvent.toolInputStart({ id: item.call_id ?? item.id, name: item.name ?? "", providerMetadata })],
  ]
}

const onReasoningSummaryPartAdded = (state: ParserState, event: OpenAIResponsesEvent): StepResult => {
  if (!event.item_id || event.summary_index === undefined) return [state, NO_EVENTS]
  const item = state.reasoningItems[event.item_id] ?? { encryptedContent: undefined, summaryParts: {} }
  if (event.summary_index === 0) {
    if (state.reasoningItems[event.item_id]) return [state, NO_EVENTS]
    const events: LLMEvent[] = []
    return [
      {
        ...state,
        lifecycle: Lifecycle.reasoningStart(
          state.lifecycle,
          events,
          `${event.item_id}:0`,
          openaiMetadata({ itemId: event.item_id, reasoningEncryptedContent: null }),
        ),
        reasoningItems: {
          ...state.reasoningItems,
          [event.item_id]: { ...item, summaryParts: { 0: "active" } },
        },
      },
      events,
    ]
  }

  const events: LLMEvent[] = []
  const closed = Object.entries(item.summaryParts)
    .filter((entry) => entry[1] === "can-conclude")
    .reduce(
      (lifecycle, entry) =>
        Lifecycle.reasoningEnd(
          lifecycle,
          events,
          `${event.item_id}:${entry[0]}`,
          openaiMetadata({ itemId: event.item_id }),
        ),
      state.lifecycle,
    )
  return [
    {
      ...state,
      lifecycle: Lifecycle.reasoningStart(
        closed,
        events,
        `${event.item_id}:${event.summary_index}`,
        openaiMetadata({ itemId: event.item_id, reasoningEncryptedContent: item.encryptedContent ?? null }),
      ),
      reasoningItems: {
        ...state.reasoningItems,
        [event.item_id]: {
          ...item,
          summaryParts: {
            ...Object.fromEntries(
              Object.entries(item.summaryParts).map((entry) =>
                entry[1] === "can-conclude" ? [entry[0], "concluded" as const] : entry,
              ),
            ),
            [event.summary_index]: "active",
          },
        },
      },
    },
    events,
  ]
}

const onReasoningSummaryPartDone = (state: ParserState, event: OpenAIResponsesEvent): StepResult => {
  if (!event.item_id || event.summary_index === undefined) return [state, NO_EVENTS]
  const item = state.reasoningItems[event.item_id]
  if (!item) return [state, NO_EVENTS]
  const events: LLMEvent[] = []
  return [
    {
      ...state,
      lifecycle:
        state.store !== false
          ? Lifecycle.reasoningEnd(
              state.lifecycle,
              events,
              `${event.item_id}:${event.summary_index}`,
              openaiMetadata({ itemId: event.item_id }),
            )
          : state.lifecycle,
      reasoningItems: {
        ...state.reasoningItems,
        [event.item_id]: {
          ...item,
          summaryParts: {
            ...item.summaryParts,
            [event.summary_index]: state.store !== false ? "concluded" : "can-conclude",
          },
        },
      },
    },
    events,
  ]
}

const onFunctionCallArgumentsDelta = Effect.fn("OpenAIResponses.onFunctionCallArgumentsDelta")(function* (
  state: ParserState,
  event: OpenAIResponsesEvent,
) {
  if (!event.item_id || !event.delta) return [state, NO_EVENTS] satisfies StepResult
  const result = ToolStream.appendExisting(
    ADAPTER,
    state.tools,
    event.item_id,
    event.delta,
    "OpenAI Responses tool argument delta is missing its tool call",
  )
  if (ToolStream.isError(result)) return yield* result
  const events: LLMEvent[] = []
  const lifecycle = result.events.length ? Lifecycle.stepStart(state.lifecycle, events) : state.lifecycle
  events.push(...result.events)
  return [{ ...state, lifecycle, tools: result.tools }, events] satisfies StepResult
})

const onCustomToolCallInputDelta = Effect.fn("OpenAIResponses.onCustomToolCallInputDelta")(function* (
  state: ParserState,
  event: OpenAIResponsesEvent,
) {
  if (!event.item_id || !event.delta) return [state, NO_EVENTS] satisfies StepResult
  const result = ToolStream.appendExisting(
    ADAPTER,
    state.tools,
    event.item_id,
    event.delta,
    "OpenAI Responses custom tool input delta is missing its tool call",
  )
  if (ToolStream.isError(result)) return yield* result
  const events: LLMEvent[] = []
  const lifecycle = result.events.length ? Lifecycle.stepStart(state.lifecycle, events) : state.lifecycle
  events.push(...result.events)
  return [{ ...state, lifecycle, tools: result.tools }, events] satisfies StepResult
})

const onOutputItemDone = Effect.fn("OpenAIResponses.onOutputItemDone")(function* (
  state: ParserState,
  event: OpenAIResponsesEvent,
) {
  const item = event.item
  if (!item) return [state, NO_EVENTS] satisfies StepResult

  if (item.type === "function_call" || item.type === "custom_tool_call") {
    if (!item.id || !item.call_id || !item.name) return [state, NO_EVENTS] satisfies StepResult
    const tools = state.tools[item.id]
      ? state.tools
      : ToolStream.start(state.tools, item.id, {
          id: item.call_id,
          name: item.name,
          inputType: item.type === "custom_tool_call" ? "text" : "json",
          providerMetadata: toolMetadata(item.id, item.type === "custom_tool_call" ? "custom" : "function"),
        })
    const input = item.type === "custom_tool_call" ? item.input : item.arguments
    const result =
      input === undefined
        ? yield* ToolStream.finish(ADAPTER, tools, item.id)
        : yield* ToolStream.finishWithInput(ADAPTER, tools, item.id, input)
    const resultEvents = result.events ?? []
    return [
      {
        ...state,
        hasFunctionCall: resultEvents.some(LLMEvent.is.toolCall) ? true : state.hasFunctionCall,
        pendingToolEvents: [...state.pendingToolEvents, ...resultEvents],
        tools: result.tools,
      },
      NO_EVENTS,
    ] satisfies StepResult
  }

  if (isHostedToolItem(item)) {
    const events: LLMEvent[] = []
    const lifecycle = Lifecycle.stepStart(state.lifecycle, events)
    events.push(...hostedToolEvents(item))
    return [{ ...state, lifecycle }, events] satisfies StepResult
  }

  if (isReasoningItem(item)) {
    const events: LLMEvent[] = []
    const providerMetadata = reasoningMetadata(item)
    const reasoningItem = state.reasoningItems[item.id]
    if (reasoningItem) {
      const lifecycle = Object.entries(reasoningItem.summaryParts)
        .filter((entry) => entry[1] === "active" || entry[1] === "can-conclude")
        .reduce(
          (lifecycle, entry) => Lifecycle.reasoningEnd(lifecycle, events, `${item.id}:${entry[0]}`, providerMetadata),
          state.lifecycle,
        )
      const { [item.id]: _removed, ...reasoningItems } = state.reasoningItems
      return [{ ...state, lifecycle, reasoningItems }, events] satisfies StepResult
    }
    if (!state.lifecycle.reasoning.has(item.id)) {
      const lifecycle = Lifecycle.stepStart(state.lifecycle, events)
      events.push(LLMEvent.reasoningStart({ id: item.id, providerMetadata }))
      events.push(LLMEvent.reasoningEnd({ id: item.id, providerMetadata }))
      return [{ ...state, lifecycle }, events] satisfies StepResult
    }
    return [
      { ...state, lifecycle: Lifecycle.reasoningEnd(state.lifecycle, events, item.id, providerMetadata) },
      events,
    ] satisfies StepResult
  }

  return [state, NO_EVENTS] satisfies StepResult
})

const onResponseFinish = Effect.fn("OpenAIResponses.onResponseFinish")(function* (
  state: ParserState,
  event: OpenAIResponsesEvent,
) {
  // UPD-002: wire-level structured-output guarantee. When the request carried
  // a json_schema text format, the accumulated output text MUST parse as JSON;
  // a provider that ignored the format (or a truncated stream) surfaces here
  // as InvalidProviderOutput instead of leaking prose to the caller.
  if (state.jsonFormatName && !state.hasFunctionCall) {
    yield* ProviderShared.parseJson(
      ADAPTER,
      state.accumulatedText,
      `OpenAI Responses text.format json_schema output is not valid JSON (format: ${state.jsonFormatName})`,
    )
  }
  const reason = mapFinishReason(event, state.hasFunctionCall)
  const releaseTools = event.type === "response.completed" && reason !== "length" && reason !== "content-filter"
  const events: LLMEvent[] = releaseTools ? [...state.pendingToolEvents] : []
  const lifecycle = Lifecycle.finish(state.lifecycle, events, {
    reason: releaseTools && state.pendingToolEvents.some(LLMEvent.is.toolCall) ? "tool-calls" : reason,
    usage: mapUsage(event.response?.usage),
    providerMetadata:
      event.response?.id || event.response?.service_tier
        ? openaiMetadata({
            responseId: event.response.id,
            serviceTier: event.response.service_tier,
          })
        : undefined,
  })
  return [{ ...state, lifecycle, pendingToolEvents: [] }, events] satisfies StepResult
})

// Build a single human-readable message from whatever the provider supplied.
// When both code and message are present, prefix the code so consumers see
// the failure mode (e.g. `rate_limit_exceeded: Slow down`) instead of just
// the bare message — production rate limits and context-length failures used
// to be indistinguishable from generic stream drops.
const providerErrorMessage = (event: OpenAIResponsesEvent, fallback: string): string => {
  const nested = event.response?.error ?? undefined
  const message = event.message || nested?.message || undefined
  const code = event.code || nested?.code || undefined
  if (message && code) return `${code}: ${message}`
  return message || code || fallback
}

const providerError = (event: OpenAIResponsesEvent, fallback: string) => {
  const code = event.code || event.response?.error?.code || undefined
  const message = providerErrorMessage(event, fallback)
  return LLMEvent.providerError({
    message,
    classification: code === "context_length_exceeded" || isContextOverflow(message) ? "context-overflow" : undefined,
  })
}

const onResponseFailed = (state: ParserState, event: OpenAIResponsesEvent): StepResult => [
  state,
  [providerError(event, "OpenAI Responses response failed")],
]

const onError = (state: ParserState, event: OpenAIResponsesEvent): StepResult => [
  state,
  [providerError(event, "OpenAI Responses stream error")],
]

const step = (state: ParserState, event: OpenAIResponsesEvent) => {
  if (event.type === "response.output_text.delta") return Effect.succeed(onOutputTextDelta(state, event))
  if (
    event.type === "response.reasoning_text.delta" ||
    event.type === "response.reasoning_summary.delta" ||
    event.type === "response.reasoning_summary_text.delta"
  )
    return Effect.succeed(onReasoningDelta(state, event))
  if (
    event.type === "response.reasoning_text.done" ||
    event.type === "response.reasoning_summary.done" ||
    event.type === "response.reasoning_summary_text.done"
  )
    return Effect.succeed(onReasoningDone(state, event))
  if (event.type === "response.reasoning_summary_part.added")
    return Effect.succeed(onReasoningSummaryPartAdded(state, event))
  if (event.type === "response.reasoning_summary_part.done")
    return Effect.succeed(onReasoningSummaryPartDone(state, event))
  if (event.type === "response.output_item.added") return Effect.succeed(onOutputItemAdded(state, event))
  if (event.type === "response.function_call_arguments.delta") return onFunctionCallArgumentsDelta(state, event)
  if (event.type === "response.custom_tool_call_input.delta") return onCustomToolCallInputDelta(state, event)
  if (event.type === "response.output_item.done") return onOutputItemDone(state, event)
  if (event.type === "response.completed" || event.type === "response.incomplete")
    return onResponseFinish(state, event)
  if (event.type === "response.failed") return Effect.succeed(onResponseFailed(state, event))
  if (event.type === "error") return Effect.succeed(onError(state, event))
  return Effect.succeed<StepResult>([state, NO_EVENTS])
}

// =============================================================================
// Protocol And OpenAI Route
// =============================================================================
/**
 * The OpenAI Responses protocol — request body construction, body schema, and
 * the streaming-event state machine. Used by native OpenAI and (once
 * registered) Azure OpenAI Responses.
 */
export const protocol = Protocol.make({
  id: ADAPTER,
  body: {
    schema: OpenAIResponsesBody,
    from: fromRequest,
  },
  stream: {
    event: Protocol.jsonEvent(OpenAIResponsesEvent),
    initial: (request) => ({
      hasFunctionCall: false,
      tools: ToolStream.empty<string>(),
      pendingToolEvents: [],
      lifecycle: Lifecycle.initial(),
      reasoningItems: {},
      store: OpenAIOptions.store(request),
      jsonFormatName:
        request.responseFormat?.type === "json" ? (request.responseFormat.name ?? "structured_output") : undefined,
      accumulatedText: "",
    }),
    step,
    terminal: (event) => TERMINAL_TYPES.has(event.type),
  },
})

const endpoint = Endpoint.path<OpenAIResponsesBody>(PATH, { baseURL: DEFAULT_BASE_URL })
const auth = Auth.none

export const httpTransport = HttpTransport.sseJson.with<OpenAIResponsesBody>()

export const route = Route.make({
  id: ADAPTER,
  provider: "openai",
  protocol,
  endpoint,
  auth,
  transport: httpTransport,
})

const decodeWebSocketMessage = ProviderShared.validateWith(Schema.decodeUnknownEffect(OpenAIResponsesWebSocketMessage))

const webSocketMessage = (body: OpenAIResponsesBody | Record<string, unknown>) =>
  Effect.gen(function* () {
    if (!ProviderShared.isRecord(body))
      return yield* ProviderShared.invalidRequest("OpenAI Responses WebSocket body must be a JSON object")
    const { stream: _stream, ...message } = body
    return yield* decodeWebSocketMessage({ ...message, type: "response.create" })
  })

export const webSocketTransport = WebSocketTransport.jsonTransport.with<
  OpenAIResponsesBody,
  OpenAIResponsesWebSocketMessage
>({
  toMessage: webSocketMessage,
  encodeMessage: encodeWebSocketMessage,
})

export const webSocketRoute = Route.make({
  id: `${ADAPTER}-websocket`,
  provider: "openai",
  protocol,
  endpoint,
  auth,
  transport: webSocketTransport,
})

// =============================================================================
// UPD-005: Unary Remote Compaction Client (/responses/compact)
// =============================================================================
// OpenAI-only unary endpoint (reference: codex `compact_remote_v2`). The
// request body mirrors `/responses` minus `stream`; the response is a JSON
// object whose `output` is the compacted item list — a `compaction` item
// carries `encrypted_content`, an opaque server-encrypted context blob the
// caller stages in memory and sends back on the next compaction.
//
// This is deliberately NOT part of `Protocol.make`: the protocol abstraction
// models SSE streams (body → frames → event state machine) and adding a unary
// axis would ripple protocol.ts / client.ts / transport (>2 files). A local
// function reusing the existing lowering helpers confines the change here.
const OpenAIResponsesCompactOutputItem = Schema.Struct({
  type: Schema.String,
  id: Schema.optional(Schema.String),
  encrypted_content: optionalNull(Schema.String),
})

const OpenAIResponsesCompactResponse = Schema.Struct({
  output: Schema.Array(OpenAIResponsesCompactOutputItem),
})

const decodeCompactResponse = ProviderShared.validateWith(
  Schema.decodeUnknownEffect(Schema.fromJsonString(OpenAIResponsesCompactResponse)),
)

export interface CompactResult {
  /** Opaque server-encrypted compacted context from the `compaction` item. */
  readonly encryptedContent: string
  /** Full compacted output item list (loose shapes) for round-tripping. */
  readonly output: ReadonlyArray<{
    readonly type: string
    readonly id?: string
    readonly encrypted_content?: string | null
  }>
}

/**
 * Compact a conversation server-side via `POST /responses/compact`. Requires
 * `RequestExecutor.Service` in the environment. On success returns the
 * compaction item's `encrypted_content`; on any failure (transport, HTTP ≥
 * 400, malformed payload, missing compaction item) fails with `LLMError` so
 * callers can fail over to local summarization. Fails with InvalidRequest
 * when the request is not bound to this route.
 */
export const compactConversation = (
  input: {
    readonly request: LLMRequest
    /** Prior compaction's encrypted context; prepended as a compaction item. */
    readonly previousEncryptedContent?: string | undefined
  },
): Effect.Effect<CompactResult, LLMError, RequestExecutor.Service> =>
  Effect.gen(function* () {
  const request = input.request
  // The compatible-responses route reuses this protocol end-to-end (DeepSeek serves
  // /responses/compact, verified per UPD-005); capability gating stays in the caller's
  // per-profile supportsResponsesCompact probe, so both Responses routes are admissible here.
  if (request.model.route.id !== ADAPTER && request.model.route.id !== "openai-compatible-responses")
    return yield* invalid(`Remote compaction requires the ${ADAPTER} route (got ${request.model.route.id})`)

  const base = yield* fromRequest(request)
  // `/responses/compact` is unary: strip `stream`; the compact endpoint takes
  // no tool choice, and a json_schema text format is meaningless for a
  // compaction — both are dropped rather than forwarded.
  const { stream: _stream, tool_choice: _toolChoice, text: _text, ...core } = base
  const lowered = yield* lowerMessages(request)
  const compactItem: OpenAIResponsesCompactionItem | undefined = input.previousEncryptedContent
    ? { type: "compaction", encrypted_content: input.previousEncryptedContent }
    : undefined
  const body = {
    ...core,
    input: compactItem ? [compactItem, ...lowered] : lowered,
  }

  const compactEndpoint = Endpoint.merge(request.model.route.endpoint, { path: COMPACT_PATH })
  const parts = yield* HttpTransport.jsonRequestParts({
    request,
    body,
    endpoint: compactEndpoint,
    auth: request.model.route.auth,
    encodeBody: ProviderShared.encodeJson,
  })
  const httpRequest = ProviderShared.jsonPost({ url: parts.url, body: parts.bodyText, headers: parts.headers })
  const response = yield* (yield* RequestExecutor.Service).execute(httpRequest)
  const rawText = yield* response.text.pipe(
    Effect.mapError(() =>
      ProviderShared.eventError(ADAPTER, "Failed to read OpenAI Responses compact response body"),
    ),
  )
  const decoded = yield* decodeCompactResponse(rawText).pipe(
    Effect.mapError(() =>
      ProviderShared.eventError(ADAPTER, "OpenAI Responses compact response is not a valid compact payload", rawText),
    ),
  )
  const compaction = decoded.output.find(
    (item): item is typeof item & { readonly encrypted_content: string } =>
      item.type === "compaction" && typeof item.encrypted_content === "string" && item.encrypted_content.length > 0,
  )
  if (!compaction)
    return yield* ProviderShared.invalidRequest("OpenAI Responses compact response is missing a compaction item")
  return { encryptedContent: compaction.encrypted_content, output: decoded.output } satisfies CompactResult
  })

export * as OpenAIResponses from "./openai-responses"
