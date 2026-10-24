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

export type ProviderRefusal =
  | { readonly kind: "rate-limit"; readonly status: 429 }
  | { readonly kind: "provider-internal"; readonly status: number }
  | { readonly kind: "transport-pre-dispatch"; readonly status: null }

/** Classify only complete typed refusals before provider output, never a generic retry flag. */
export const retryableProviderRefusal = (
  failure: unknown,
  input: { readonly providerEventsStarted: boolean },
): ProviderRefusal | undefined => {
  if (input?.providerEventsStarted !== false || !(failure instanceof LLMError)) return undefined
  if (failure.reason._tag === "Transport")
    return failure.reason.phase === "pre-dispatch" && failure.reason.http?.response === undefined
      ? { kind: "transport-pre-dispatch", status: null }
      : undefined
  if (failure.reason._tag !== "RateLimit" && failure.reason._tag !== "ProviderInternal") return undefined
  const http = failure.reason.http
  if (typeof http?.body !== "string" || http.bodyTruncated === true || http.response === undefined) return undefined
  if (failure.reason._tag === "RateLimit")
    return http.response.status === 429 ? { kind: "rate-limit", status: 429 } : undefined
  return Number.isInteger(failure.reason.status) &&
    failure.reason.status >= 500 &&
    failure.reason.status <= 599 &&
    http.response.status === failure.reason.status
    ? { kind: "provider-internal", status: failure.reason.status }
    : undefined
}

export const encodeProviderRefusal = (refusal: ProviderRefusal, identityHash: string): string | undefined => {
  if (refusal.kind === "transport-pre-dispatch" && refusal.status !== null) return undefined
  const code = `provider-refusal.v1:${refusal.kind}:${refusal.status ?? 0}:${identityHash}`
  return decodeProviderRefusal(code) === undefined ? undefined : code
}

export const decodeProviderRefusal = (
  code: unknown,
): { readonly refusal: ProviderRefusal; readonly identityHash: string } | undefined => {
  if (typeof code !== "string") return undefined
  const match =
    /^provider-refusal\.v1:(rate-limit|provider-internal|transport-pre-dispatch):(0|429|5[0-9]{2}):([a-f0-9]{64})$/.exec(code)
  if (!match || match[0] !== code) return undefined
  if (match[1] === "rate-limit")
    return match[2] === "429" ? { refusal: { kind: "rate-limit", status: 429 }, identityHash: match[3] } : undefined
  if (match[1] === "transport-pre-dispatch")
    return match[2] === "0"
      ? { refusal: { kind: "transport-pre-dispatch", status: null }, identityHash: match[3] }
      : undefined
  return match[2].startsWith("5")
    ? { refusal: { kind: "provider-internal", status: Number(match[2]) }, identityHash: match[3] }
    : undefined
}

// A complete structured HTTP refusal before the first provider event proves the
// request was rejected. A bare status/message or a failure after output does not.
export const isTerminalProviderFailure = (failure: unknown, input?: { readonly providerEventsStarted: boolean }) => {
  if (isContextOverflowFailure(failure)) return true
  if (!(failure instanceof LLMError)) return false
  if (failure.reason._tag === "Authentication") return true
  if (input && retryableProviderRefusal(failure, input)) return true
  if (failure.reason._tag !== "InvalidRequest" || input?.providerEventsStarted !== false) return false
  const http = failure.reason.http
  return (
    http?.response?.status === 400 &&
    http.bodyTruncated !== true &&
    http.body !== undefined &&
    Option.isSome(Schema.decodeUnknownOption(requestRejection)(http.body))
  )
}
