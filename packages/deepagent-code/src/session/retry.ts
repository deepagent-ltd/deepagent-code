import type { NamedError } from "@deepagent-code/core/util/error"
import { SessionV1 } from "@deepagent-code/core/v1/session"
import { Cause, Clock, Duration, Effect, Schedule } from "effect"
import { MessageV2 } from "./message-v2"
import { iife } from "@/util/iife"
import { isRecord } from "@/util/record"

export type Err = ReturnType<NamedError["toObject"]>

export type RetryReason = string & {}

export type Retryable = {
  message: string
  action?: {
    reason: RetryReason
    provider: string
    title: string
    message: string
    label: string
    link?: string
  }
}

export const RETRY_INITIAL_DELAY = 2000
export const RETRY_BACKOFF_FACTOR = 2
export const RETRY_MAX_DELAY_NO_HEADERS = 30_000 // 30 seconds
export const RETRY_MAX_DELAY = 2_147_483_647 // max 32-bit signed integer for setTimeout

function cap(ms: number) {
  return Math.min(ms, RETRY_MAX_DELAY)
}

export function delay(attempt: number, error?: SessionV1.APIError) {
  if (error) {
    const headers = error.data.responseHeaders
    if (headers) {
      const retryAfterMs = headers["retry-after-ms"]
      if (retryAfterMs) {
        const parsedMs = Number.parseFloat(retryAfterMs)
        if (!Number.isNaN(parsedMs)) {
          return cap(parsedMs)
        }
      }

      const retryAfter = headers["retry-after"]
      if (retryAfter) {
        const parsedSeconds = Number.parseFloat(retryAfter)
        if (!Number.isNaN(parsedSeconds)) {
          // convert seconds to milliseconds
          return cap(Math.ceil(parsedSeconds * 1000))
        }
        // Try parsing as HTTP date format
        const parsed = Date.parse(retryAfter) - Date.now()
        if (!Number.isNaN(parsed) && parsed > 0) {
          return cap(Math.ceil(parsed))
        }
      }

      return cap(RETRY_INITIAL_DELAY * Math.pow(RETRY_BACKOFF_FACTOR, attempt - 1))
    }
  }

  return cap(Math.min(RETRY_INITIAL_DELAY * Math.pow(RETRY_BACKOFF_FACTOR, attempt - 1), RETRY_MAX_DELAY_NO_HEADERS))
}

export function retryable(error: Err, provider: string): Retryable | undefined {
  // Plan protocol violations are activity-level terminal states. Retrying the
  // provider stream would replay the same malformed/stale plan payload and can
  // consume an unrelated activity's budget after the original activity settled.
  if (SessionV1.PlanProtocolViolationError.isInstance(error)) return undefined
  // context overflow errors should not be retried
  if (SessionV1.ContextOverflowError.isInstance(error)) return undefined
  if (SessionV1.OutputDegenerationError.isInstance(error)) return undefined
  if (SessionV1.APIError.isInstance(error)) {
    const status = error.data.statusCode
    // 5xx errors are transient server failures and should always be retried,
    // even when the provider SDK doesn't explicitly mark them as retryable.
    if (!error.data.isRetryable && !(status !== undefined && status >= 500)) return undefined
    if (error.data.responseBody?.includes("FreeUsageLimitError")) {
      void provider
      return { message: error.data.message }
    }
    if (error.data.responseBody?.includes("GoUsageLimitError")) {
      const body = parseJSON(error.data.responseBody)
      const limitName = str(body?.metadata?.limitName)
      const retryAfter = num(error.data.responseHeaders?.["retry-after"])
      const resetIn = iife(() => {
        if (retryAfter === undefined) return ""
        const seconds = Math.max(0, Math.ceil(retryAfter))
        const days = Math.floor(seconds / 86_400)
        const hours = Math.floor((seconds % 86_400) / 3_600)
        const minutes = Math.ceil((seconds % 3_600) / 60)
        const unit = (value: number, name: string) => `${value} ${name}${value === 1 ? "" : "s"}`

        if (days > 0) return hours > 0 ? `${unit(days, "day")} ${unit(hours, "hour")}` : unit(days, "day")
        if (hours > 0) return minutes > 0 ? `${unit(hours, "hour")} ${unit(minutes, "minute")}` : unit(hours, "hour")
        return minutes > 0 ? unit(minutes, "minute") : "less than a minute"
      })

      const message = `${limitName ? `${limitName} usage limit` : "Usage limit"} reached. It will reset in ${resetIn}. To continue using this model now, enable usage from your available balance`
      return { message }
    }
    return { message: error.data.message.includes("Overloaded") ? "Provider is overloaded" : error.data.message }
  }

  // Check for rate limit patterns in plain text error messages
  const msg = isRecord(error.data) ? error.data.message : undefined
  if (typeof msg === "string") {
    const lower = msg.toLowerCase()
    if (
      lower.includes("rate increased too quickly") ||
      lower.includes("rate limit") ||
      lower.includes("too many requests")
    ) {
      return { message: msg }
    }
  }

  const json = parseJSON(msg)
  if (!json || typeof json !== "object") return undefined
  const code = typeof json.code === "string" ? json.code : ""

  if (json.type === "error" && json.error?.type === "too_many_requests") {
    return { message: "Too Many Requests" }
  }
  if (code.includes("exhausted") || code.includes("unavailable")) {
    return { message: "Provider is overloaded" }
  }
  if (json.type === "error" && typeof json.error?.code === "string" && json.error.code.includes("rate_limit")) {
    return { message: "Rate Limited" }
  }
  return undefined
}

function str(value: unknown) {
  if (value === undefined || value === null) return ""
  return String(value)
}

function num(value: unknown) {
  const parsed = Number.parseFloat(str(value))
  if (Number.isNaN(parsed)) return undefined
  return parsed
}

function parseJSON(value: unknown) {
  return iife(() => {
    try {
      if (typeof value !== "string") return undefined
      return JSON.parse(value)
    } catch {
      return undefined
    }
  })
}

/**
 * Structural view of `@deepagent-code/llm` `LLMError` values. Detection is
 * structural (not instanceof) so the classification survives error wrapping
 * across stream/runtime boundaries; the llm schema classes satisfy it.
 */
export interface LLMErrorShape {
  readonly _tag: "LLM.Error"
  readonly reason: {
    readonly _tag: string
    readonly message?: string | undefined
    readonly phase?: "pre-dispatch" | "post-dispatch" | undefined
    readonly status?: number | undefined
  }
}

export function isLLMError(error: unknown): error is LLMErrorShape {
  if (!isRecord(error) || error._tag !== "LLM.Error") return false
  return isRecord(error.reason) && typeof error.reason._tag === "string"
}

/**
 * Classification-first retry decision based on the llm package's error
 * reason, used whenever a reason is available. The string heuristics in
 * `retryable` remain only as the fallback for errors without a reason.
 *
 * - `RateLimit` / `ProviderInternal` (429 / 5xx): transient, retry.
 * - `Transport`: retry ONLY for `phase: "pre-dispatch"` — the request never
 *   reached the provider. Post-dispatch transport failures may already have
 *   been billed, so re-sending them here would duplicate the physical
 *   request; recovery belongs to provider-attempt replay.
 * - Everything else (`InvalidRequest`, `Authentication`, `QuotaExceeded`,
 *   `ContentPolicy`, `NoRoute`, `InvalidProviderOutput`, `UnknownProvider`)
 *   is terminal: no retry, no fallback to message heuristics.
 */
export function retryableViaReason(error: LLMErrorShape): Retryable | undefined {
  const reason = error.reason
  switch (reason._tag) {
    case "RateLimit":
      return { message: reason.message ?? "Rate Limited" }
    case "ProviderInternal":
      return { message: reason.message ?? "Provider is overloaded" }
    case "Transport":
      return reason.phase === "pre-dispatch" ? { message: reason.message ?? "Provider connection failed" } : undefined
    default:
      return undefined
  }
}

/** Retry decision for a raw stream failure plus its parsed `Err` form. */
export function retryableFor(raw: unknown, parsed: Err, provider: string): Retryable | undefined {
  if (isLLMError(raw)) return retryableViaReason(raw)
  return retryable(parsed, provider)
}

export function policy(opts: {
  provider: string
  parse: (error: unknown) => Err
  set: (input: { attempt: number; message: string; action?: Retryable["action"]; next: number }) => Effect.Effect<void>
}) {
  return Schedule.fromStepWithMetadata(
    Effect.succeed((meta: Schedule.InputMetadata<unknown>) => {
      const error = opts.parse(meta.input)
      // Prefer the llm reason classification when the raw failure carries one;
      // fall back to the string heuristics for SDK/plain errors.
      const retry = retryableFor(meta.input, error, opts.provider)
      if (!retry) return Cause.done(meta.attempt)
      return Effect.gen(function* () {
        const wait = delay(meta.attempt, SessionV1.APIError.isInstance(error) ? error : undefined)
        const now = yield* Clock.currentTimeMillis
        const payload: { attempt: number; message: string; action?: Retryable["action"]; next: number } = {
          attempt: meta.attempt,
          message: retry.message,
          next: now + wait,
        }
        if ("action" in retry) payload.action = retry.action
        yield* opts.set(payload)
        return [meta.attempt, Duration.millis(wait)] as [number, Duration.Duration]
      })
    }),
  )
}

export * as SessionRetry from "./retry"
