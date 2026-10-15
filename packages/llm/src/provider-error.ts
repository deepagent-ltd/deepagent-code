import { Option, Schema } from "effect"
import { LLMError, ProviderErrorEvent } from "./schema"

const patterns = [
  /prompt is too long/i,
  /input is too long for requested model/i,
  /exceeds the context window/i,
  /input token count.*exceeds the maximum/i,
  /maximum prompt length is \d+/i,
  /reduce the length of the messages/i,
  /maximum context length is \d+ tokens/i,
  /exceeds the limit of \d+/i,
  /exceeds the available context size/i,
  /greater than the context length/i,
  /context window exceeds limit/i,
  /exceeded model token limit/i,
  /context[_ ]length[_ ]exceeded/i,
  /request entity too large/i,
  /context length is only \d+ tokens/i,
  /input length.*exceeds.*context length/i,
  /prompt too long; exceeded (?:max )?context length/i,
  /too large for model with \d+ maximum context length/i,
  /model_context_window_exceeded/i,
]

export const isContextOverflow = (message: string) =>
  patterns.some((pattern) => pattern.test(message)) || /^4(00|13)\s*(status code)?\s*\(no body\)/i.test(message)

export const isContextOverflowFailure = (failure: unknown) =>
  failure instanceof LLMError
    ? failure.reason._tag === "InvalidRequest" && failure.reason.classification === "context-overflow"
    : Schema.is(ProviderErrorEvent)(failure) && failure.classification === "context-overflow"

const requestRejection = Schema.fromJsonString(
  Schema.Struct({
    error: Schema.Struct({
      type: Schema.Literal("invalid_request_error"),
      code: Schema.Literal("invalid_request_error"),
    }),
  }),
)

// A complete structured HTTP refusal before the first provider event proves the
// request was rejected. A bare status/message or a failure after output does not.
export const isTerminalProviderFailure = (failure: unknown, input?: { readonly providerEventsStarted: boolean }) => {
  if (isContextOverflowFailure(failure)) return true
  if (!(failure instanceof LLMError)) return false
  if (failure.reason._tag === "Authentication") return true
  if (failure.reason._tag !== "InvalidRequest" || input?.providerEventsStarted !== false) return false
  const http = failure.reason.http
  return (
    http?.response?.status === 400 &&
    http.bodyTruncated !== true &&
    http.body !== undefined &&
    Option.isSome(Schema.decodeUnknownOption(requestRejection)(http.body))
  )
}
