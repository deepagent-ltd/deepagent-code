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
