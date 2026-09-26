import { Option, Schema } from "effect"
import { proxyError } from "../middleware/proxy-authorization"

const ChatInput = Schema.Struct({
  model: Schema.String,
  messages: Schema.Array(
    Schema.Struct({ role: Schema.Literals(["system", "user", "assistant"]), content: Schema.String }),
  ),
  stream: Schema.optional(Schema.Boolean),
  stream_options: Schema.optional(Schema.Struct({ include_usage: Schema.optional(Schema.Boolean) })),
  temperature: Schema.optional(Schema.Number),
  top_p: Schema.optional(Schema.Number),
  max_tokens: Schema.optional(Schema.Int),
  max_completion_tokens: Schema.optional(Schema.Int),
  user: Schema.optional(Schema.String),
})

const allowed = new Set(Object.keys(ChatInput.fields))

export function parseChatPayload(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    return { ok: false as const, response: proxyError(400, "invalid_request", "Invalid chat completion request") }
  if (Object.keys(input).some((key) => !allowed.has(key)))
    return {
      ok: false as const,
      response: proxyError(501, "model_not_supported", "This chat request contains unsupported fields"),
    }
  const raw = input as Record<string, unknown>
  if (
    Array.isArray(raw.messages) &&
    raw.messages.some(
      (message) =>
        message &&
        typeof message === "object" &&
        (Object.keys(message).some((key) => key !== "role" && key !== "content") ||
          ("content" in message && typeof message.content !== "string")),
    )
  )
    return {
      ok: false as const,
      response: proxyError(501, "model_not_supported", "This chat message shape is not supported"),
    }
  if (
    raw.stream_options &&
    typeof raw.stream_options === "object" &&
    Object.keys(raw.stream_options).some((key) => key !== "include_usage")
  )
    return {
      ok: false as const,
      response: proxyError(501, "model_not_supported", "This streaming option is not supported"),
    }
  const parsed = Schema.decodeUnknownOption(ChatInput)(input)
  if (Option.isNone(parsed) || parsed.value.messages.length === 0)
    return { ok: false as const, response: proxyError(400, "invalid_request", "Invalid chat completion request") }
  if (
    (parsed.value.max_tokens !== undefined && parsed.value.max_tokens <= 0) ||
    (parsed.value.max_completion_tokens !== undefined && parsed.value.max_completion_tokens <= 0)
  )
    return { ok: false as const, response: proxyError(400, "invalid_request", "max_tokens must be positive") }
  return { ok: true as const, value: parsed.value }
}

export type ChatPayload = typeof ChatInput.Type

const ResponseInput = Schema.Struct({
  model: Schema.String,
  input: Schema.Unknown,
  instructions: Schema.optional(Schema.String),
  max_output_tokens: Schema.optional(Schema.Int),
  temperature: Schema.optional(Schema.Number),
  top_p: Schema.optional(Schema.Number),
  user: Schema.optional(Schema.String),
  stream: Schema.optional(Schema.Boolean),
})

export function parseResponsesPayload(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    return { ok: false as const, response: proxyError(400, "invalid_request", "Invalid responses request") }
  const raw = input as Record<string, unknown>
  if (Object.keys(raw).some((key) => !(key in ResponseInput.fields)))
    return { ok: false as const, response: proxyError(501, "model_not_supported", "This responses request contains unsupported fields") }
  const parsed = Schema.decodeUnknownOption(ResponseInput)(input)
  if (Option.isNone(parsed))
    return { ok: false as const, response: proxyError(400, "invalid_request", "Invalid responses request") }
  if (parsed.value.stream === true)
    return { ok: false as const, response: proxyError(501, "model_not_supported", "Only non-streaming text responses are supported") }
  const messages = typeof parsed.value.input === "string"
    ? [{ role: "user" as const, content: parsed.value.input }]
    : Array.isArray(parsed.value.input)
      ? parsed.value.input.map((item) => {
          if (!item || typeof item !== "object" || Array.isArray(item)) return undefined
          const value = item as Record<string, unknown>
          if (Object.keys(value).some((key) => key !== "role" && key !== "content" && key !== "type")) return undefined
          if (value.type !== undefined && value.type !== "message") return undefined
          const role = value.role === "developer" ? "system" : value.role
          if (role !== "system" && role !== "user" && role !== "assistant") return undefined
          const content = typeof value.content === "string"
            ? value.content
            : Array.isArray(value.content) && value.content.every((part) =>
                part && typeof part === "object" && part.type === "input_text" && typeof part.text === "string" &&
                Object.keys(part).every((key) => key === "type" || key === "text"))
              ? value.content.map((part) => part.text).join("")
              : undefined
          return content === undefined ? undefined : { role, content }
        })
      : undefined
  if (!messages || messages.some((message) => message === undefined) || messages.length === 0)
    return { ok: false as const, response: proxyError(501, "model_not_supported", "This responses input shape is not supported") }
  const chat = parseChatPayload({
    model: parsed.value.model,
    messages: [...(parsed.value.instructions ? [{ role: "system", content: parsed.value.instructions }] : []), ...messages],
    max_completion_tokens: parsed.value.max_output_tokens,
    temperature: parsed.value.temperature,
    top_p: parsed.value.top_p,
    user: parsed.value.user,
    stream: false,
  })
  if (!chat.ok) return chat
  return { ok: true as const, value: chat.value }
}
