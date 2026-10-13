import { Cause, Context, Effect, Layer, Option, Random, Redacted, Schema } from "effect"
import { createHash, createHmac, randomBytes } from "node:crypto"
import {
  FetchHttpClient,
  Headers,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http"
import {
  AuthenticationReason,
  ContentPolicyReason,
  HttpContext,
  HttpRateLimitDetails,
  HttpRequestDetails,
  HttpResponseDetails,
  InvalidRequestReason,
  LLMError,
  ProviderInternalReason,
  QuotaExceededReason,
  RateLimitReason,
  TransportPhase,
  TransportReason,
  UnknownProviderReason,
} from "../schema"
import { isContextOverflow } from "../provider-error"
import { BuiltinNode } from "./builtin-node"
import { VendorContextBound } from "./vendor-context-bound"

export interface Interface {
  readonly execute: (
    request: HttpClientRequest.HttpClientRequest,
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse, LLMError>
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/LLM/RequestExecutor") {}

export interface RequestSealInput {
  /** Present at the actual HTTP boundary; synthetic legacy seals may omit these. */
  readonly method?: string
  readonly url?: string
  /** Internal validation only: the final encoded body after protocol and HTTP overlays. */
  readonly bodyText?: string
  /** Ephemeral native application headers. Never persist, serialize, or log the revealed value. */
  readonly headers?: Redacted.Redacted<Readonly<Headers.Headers>>
  readonly wireHash: string
  readonly bodyHash: string
  readonly bodyLength: number
  readonly contentType: string | undefined
}

export interface RequestSeal {
  readonly seal: (input: RequestSealInput) => Effect.Effect<void>
}

/** Seals a durable attempt against the exact HTTP body before transport begins. */
export const CurrentRequestSeal = Context.Reference<RequestSeal | undefined>(
  "@deepagent-code/LLM/RequestExecutor/CurrentRequestSeal",
  { defaultValue: () => undefined },
)

export function wireRequestHash(input: {
  readonly method: string
  readonly url: string
  readonly contentType: string | undefined
  readonly bodyText: string
}) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        method: input.method,
        url: input.url,
        contentType: input.contentType,
        bodyText: input.bodyText,
      }),
    )
    .digest("hex")
}

const BODY_LIMIT = 16_384
const TRANSPORT_RETRY_LIMIT = 2
const STATUS_RETRY_LIMIT = 2
const BASE_DELAY_MS = 500
const MAX_DELAY_MS = 10_000
const REDACTED = "<redacted>"

/**
 * Per-request transport retry budget for pre-dispatch connection failures.
 * Post-dispatch transport errors are never retried (double-billing risk), so
 * this budget only ever applies to `TransportReason.phase === "pre-dispatch"`.
 */
export const CurrentTransportRetryLimit = Context.Reference<number>(
  "@deepagent-code/LLM/RequestExecutor/CurrentTransportRetryLimit",
  { defaultValue: () => TRANSPORT_RETRY_LIMIT },
)

/** Per-request retry budget for retryable HTTP status failures (429 / 5xx). */
export const CurrentStatusRetryLimit = Context.Reference<number>(
  "@deepagent-code/LLM/RequestExecutor/CurrentStatusRetryLimit",
  { defaultValue: () => STATUS_RETRY_LIMIT },
)

/**
 * Umbrella override for BOTH retry budgets. Durable provider attempts provide
 * `0` here (the seal is recomputed before every attempt, so executor-internal
 * retries would only multiply sealed physical requests). When unset
 * (`undefined`), the per-class limits above apply independently.
 */
export const CurrentRetryLimit = Context.Reference<number | undefined>(
  "@deepagent-code/LLM/RequestExecutor/CurrentRetryLimit",
  { defaultValue: () => undefined },
)

/** Restricted callers select manual redirects before sealing the physical request. */
export const CurrentRedirectPolicy = Context.Reference<"follow" | "manual">(
  "@deepagent-code/LLM/RequestExecutor/CurrentRedirectPolicy",
  { defaultValue: () => "follow" },
)

// One source of truth for what counts as a sensitive name across headers,
// URL query keys, and field names embedded inside request/response bodies.
//
// `SENSITIVE_NAME` is used as both a substring matcher (for free-form header
// names like `Authorization` / `X-API-Key`) and as the body-field alternation
// list. `SHORT_QUERY_NAME` covers anchored short keys like `?key=…` / `?sig=…`
// that are too generic to redact substring-style without false positives.
const SENSITIVE_NAME_SOURCE =
  "authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|token|secret|credential|signature|x-amz-signature"
const SENSITIVE_NAME = new RegExp(SENSITIVE_NAME_SOURCE, "i")
const SHORT_QUERY_NAME = /^(key|sig)$/i
const SENSITIVE_BODY_FIELD = new RegExp(`(?:${SENSITIVE_NAME_SOURCE}|key)`, "i")
const REDACT_JSON_FIELD = new RegExp(`("(?:${SENSITIVE_BODY_FIELD.source})"\\s*:\\s*)"[^"]*"`, "gi")
const REDACT_QUERY_FIELD = new RegExp(`((?:${SENSITIVE_BODY_FIELD.source})=)[^&\\s"]+`, "gi")

const isSensitiveHeaderName = (name: string) => SENSITIVE_NAME.test(name)

const isSensitiveQueryName = (name: string) => isSensitiveHeaderName(name) || SHORT_QUERY_NAME.test(name)

const redactHeaders = (headers: Headers.Headers, redactedNames: ReadonlyArray<string | RegExp>) =>
  Object.fromEntries(
    Object.entries(Headers.redact(headers, [...redactedNames, SENSITIVE_NAME])).map(([name, value]) => [
      name,
      String(value),
    ]),
  )

const redactUrl = (value: string) => {
  if (!URL.canParse(value)) return REDACTED
  const url = new URL(value)
  url.searchParams.forEach((_, key) => {
    if (isSensitiveQueryName(key)) url.searchParams.set(key, REDACTED)
  })
  return url.toString()
}

const normalizedHeaders = (headers: Headers.Headers) =>
  Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]))

const requestId = (headers: Record<string, string>) => {
  return (
    headers["x-request-id"] ??
    headers["request-id"] ??
    headers["x-amzn-requestid"] ??
    headers["x-amz-request-id"] ??
    headers["x-goog-request-id"] ??
    headers["cf-ray"]
  )
}

const retryableStatus = (status: number) => status === 429 || status === 503 || status === 504 || status === 529

const retryAfterMs = (headers: Record<string, string>) => {
  const millis = Number(headers["retry-after-ms"])
  if (Number.isFinite(millis)) return Math.max(0, millis)

  const value = headers["retry-after"]
  if (!value) return undefined

  const seconds = Number(value)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)

  const date = Date.parse(value)
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now())
  return undefined
}

const addRateLimitValue = (target: Record<string, string>, key: string, value: string) => {
  if (key.length > 0) target[key] = value
}

const rateLimitDetails = (headers: Record<string, string>, retryAfter: number | undefined) => {
  const limit: Record<string, string> = {}
  const remaining: Record<string, string> = {}
  const reset: Record<string, string> = {}

  Object.entries(headers).forEach(([name, value]) => {
    const openaiLimit = /^x-ratelimit-limit-(.+)$/.exec(name)?.[1]
    if (openaiLimit) return addRateLimitValue(limit, openaiLimit, value)

    const openaiRemaining = /^x-ratelimit-remaining-(.+)$/.exec(name)?.[1]
    if (openaiRemaining) return addRateLimitValue(remaining, openaiRemaining, value)

    const openaiReset = /^x-ratelimit-reset-(.+)$/.exec(name)?.[1]
    if (openaiReset) return addRateLimitValue(reset, openaiReset, value)

    const anthropic = /^anthropic-ratelimit-(.+)-(limit|remaining|reset)$/.exec(name)
    if (!anthropic) return
    if (anthropic[2] === "limit") return addRateLimitValue(limit, anthropic[1], value)
    if (anthropic[2] === "remaining") return addRateLimitValue(remaining, anthropic[1], value)
    return addRateLimitValue(reset, anthropic[1], value)
  })

  if (
    retryAfter === undefined &&
    Object.keys(limit).length === 0 &&
    Object.keys(remaining).length === 0 &&
    Object.keys(reset).length === 0
  )
    return undefined

  return new HttpRateLimitDetails({
    retryAfterMs: retryAfter,
    limit: Object.keys(limit).length === 0 ? undefined : limit,
    remaining: Object.keys(remaining).length === 0 ? undefined : remaining,
    reset: Object.keys(reset).length === 0 ? undefined : reset,
  })
}

const requestDetails = (request: HttpClientRequest.HttpClientRequest, redactedNames: ReadonlyArray<string | RegExp>) =>
  new HttpRequestDetails({
    method: request.method,
    url: redactUrl(request.url),
    headers: redactHeaders(request.headers, redactedNames),
  })

const responseDetails = (
  response: HttpClientResponse.HttpClientResponse,
  redactedNames: ReadonlyArray<string | RegExp>,
) =>
  new HttpResponseDetails({
    status: response.status,
    headers: redactHeaders(response.headers, redactedNames),
  })

const secretValues = (request: HttpClientRequest.HttpClientRequest) => {
  const values = new Set<string>()
  const add = (value: string) => {
    if (value.length < 4) return
    values.add(value)
    values.add(encodeURIComponent(value))
  }

  Object.entries(request.headers).forEach(([name, value]) => {
    if (!isSensitiveHeaderName(name)) return
    add(value)
    const bearer = /^Bearer\s+(.+)$/i.exec(value)?.[1]
    if (bearer) add(bearer)
  })

  if (!URL.canParse(request.url)) return values
  new URL(request.url).searchParams.forEach((value, key) => {
    if (isSensitiveQueryName(key)) add(value)
  })
  return values
}

// Two passes: structural (redact `"name": "value"` and `name=value` patterns
// for any field name that looks sensitive) plus literal (replace any actual
// secret values we sent in the request, in case the response echoes one back).
const redactBody = (body: string, request: HttpClientRequest.HttpClientRequest) =>
  Array.from(secretValues(request)).reduce(
    (text, secret) => text.split(secret).join(REDACTED),
    body.replace(REDACT_JSON_FIELD, `$1"${REDACTED}"`).replace(REDACT_QUERY_FIELD, `$1${REDACTED}`),
  )

const responseBody = (body: string | void, request: HttpClientRequest.HttpClientRequest) => {
  if (body === undefined) return {}
  const redacted = redactBody(body, request)
  if (redacted.length <= BODY_LIMIT) return { body: redacted }
  return { body: redacted.slice(0, BODY_LIMIT), bodyTruncated: true }
}

const sealRequest = (request: HttpClientRequest.HttpClientRequest) =>
  Effect.gen(function* () {
    const seal = yield* CurrentRequestSeal
    if (!seal) return
    if (request.body._tag !== "Uint8Array") return yield* Effect.die("Durable provider request body is not sealable")
    const url = Option.getOrUndefined(HttpClientRequest.toUrl(request))
    if (!url) return yield* Effect.die("Durable provider request URL is not sealable")
    // Fragments do not travel over HTTP. Query parameters do, including structured urlParams.
    url.hash = ""
    const bodyText = new TextDecoder().decode(request.body.body)
    yield* seal.seal({
      method: request.method,
      url: url.href,
      bodyText,
      wireHash: wireRequestHash({
        method: request.method,
        url: url.href,
        contentType: request.body.contentType,
        bodyText,
      }),
      bodyHash: createHash("sha256").update(request.body.body).digest("hex"),
      bodyLength: request.body.body.length,
      contentType: request.body.contentType,
    })
  })

// Surface the endpoint host + requestId alongside the upstream body so logs can identify *which*
// gateway failed and how — many users point baseURL at OpenAI-compatible relays whose error bodies
// (e.g. "服务暂时繁忙") are otherwise indistinguishable from one another. The url is already redacted
// by redactUrl (sensitive query stripped) and the body by redactBody, so no new secret surface.
const endpointHost = (url: string) => {
  if (!URL.canParse(url)) return undefined
  return new URL(url).host || undefined
}

const providerMessage = (input: {
  readonly status: number
  readonly body: { readonly body?: string }
  readonly host?: string | undefined
  readonly requestId?: string | undefined
}) => {
  const context = [
    input.host ? `host=${input.host}` : undefined,
    input.requestId ? `requestId=${input.requestId}` : undefined,
  ].filter(Boolean)
  const suffix = context.length > 0 ? ` (${context.join(", ")})` : ""
  const body = input.body.body && input.body.body.length <= 500 ? `: ${input.body.body}` : ""
  return `Provider request failed with HTTP ${input.status}${suffix}${body}`
}

const responseHttp = (input: {
  readonly request: HttpClientRequest.HttpClientRequest
  readonly response: HttpClientResponse.HttpClientResponse
  readonly redactedNames: ReadonlyArray<string | RegExp>
  readonly body: ReturnType<typeof responseBody>
  readonly requestId?: string | undefined
  readonly rateLimit?: HttpRateLimitDetails | undefined
}) =>
  new HttpContext({
    request: requestDetails(input.request, input.redactedNames),
    response: responseDetails(input.response, input.redactedNames),
    ...input.body,
    requestId: input.requestId,
    rateLimit: input.rateLimit,
  })

const statusReason = (input: {
  readonly status: number
  readonly message: string
  readonly retryAfterMs?: number | undefined
  readonly rateLimit?: HttpRateLimitDetails | undefined
  readonly http: HttpContext
}) => {
  const body = input.http.body ?? ""
  if (/content[-_\s]?policy|content_filter|safety/i.test(body)) {
    return new ContentPolicyReason({ message: input.message, http: input.http })
  }
  if (input.status === 401) {
    return new AuthenticationReason({ message: input.message, kind: "invalid", http: input.http })
  }
  if (input.status === 403) {
    return new AuthenticationReason({ message: input.message, kind: "insufficient-permissions", http: input.http })
  }
  if (input.status === 429) {
    if (/insufficient[-_\s]?quota|quota[-_\s]?exceeded/i.test(body)) {
      return new QuotaExceededReason({ message: input.message, http: input.http })
    }
    return new RateLimitReason({
      message: input.message,
      retryAfterMs: input.retryAfterMs,
      rateLimit: input.rateLimit,
      http: input.http,
    })
  }
  if (
    input.status === 400 ||
    input.status === 404 ||
    input.status === 409 ||
    input.status === 413 ||
    input.status === 422
  ) {
    return new InvalidRequestReason({
      message: input.message,
      classification: isContextOverflow(body) ? "context-overflow" : undefined,
      http: input.http,
    })
  }
  if (input.status >= 500 || retryableStatus(input.status)) {
    return new ProviderInternalReason({
      message: input.message,
      status: input.status,
      retryAfterMs: input.retryAfterMs,
      http: input.http,
    })
  }
  return new UnknownProviderReason({ message: input.message, status: input.status, http: input.http })
}

const statusError =
  (request: HttpClientRequest.HttpClientRequest, redactedNames: ReadonlyArray<string | RegExp>) =>
  (response: HttpClientResponse.HttpClientResponse) =>
    Effect.gen(function* () {
      if (response.status < 400) return response
      const body = yield* response.text.pipe(Effect.catch(() => Effect.void))
      const headers = normalizedHeaders(response.headers)
      const retryAfter = retryAfterMs(headers)
      const rateLimit = rateLimitDetails(headers, retryAfter)
      const details = responseBody(body, request)
      const id = requestId(headers)
      return yield* new LLMError({
        module: "RequestExecutor",
        method: "execute",
        reason: statusReason({
          status: response.status,
          message: providerMessage({
            status: response.status,
            body: details,
            host: endpointHost(request.url),
            requestId: id,
          }),
          retryAfterMs: retryAfter,
          rateLimit,
          http: responseHttp({
            request,
            response,
            redactedNames,
            body: details,
            requestId: id,
            rateLimit,
          }),
        }),
      })
    })

// Error codes that prove the request never reached the provider: DNS/TCP
// connect failures, connection-phase timeouts, and TLS handshake rejections.
// Anything else (ECONNRESET mid-exchange, header/body timeouts, unknown
// errors) is ambiguous-or-delivered and classified post-dispatch.
const PRE_DISPATCH_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "EADDRNOTAVAIL",
  "UND_ERR_CONNECT_TIMEOUT",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "ERR_TLS_CERT_ALTNAME_INVALID",
])

const hasPreDispatchCode = (error: unknown, seen: Set<unknown> = new Set()): boolean => {
  if (!error || typeof error !== "object" || seen.has(error)) return false
  seen.add(error)
  const code = "code" in error ? (error as { readonly code?: unknown }).code : undefined
  if (typeof code === "string" && PRE_DISPATCH_ERROR_CODES.has(code)) return true
  const cause = "cause" in error ? (error as { readonly cause?: unknown }).cause : undefined
  return hasPreDispatchCode(cause, seen)
}

/**
 * Classifies a raw transport failure by dispatch phase. The executor only
 * ever sees failures from `http.execute`, i.e. before response headers, but
 * fetch cannot tell "connection refused" (nothing sent) from "connection
 * dropped while awaiting headers" (request possibly delivered and billed).
 * So pre-dispatch requires positive evidence from the underlying error codes;
 * every ambiguous case degrades to post-dispatch, which is never retried.
 */
const transportPhase = (error: unknown): TransportPhase => {
  // Effect timeouts carry no dispatch information; the request may already
  // have been on the wire when the deadline fired.
  if (!HttpClientError.isHttpClientError(error)) return "post-dispatch"
  switch (error.reason._tag) {
    // The request body/URL failed before anything was written to the wire.
    case "EncodeError":
    case "InvalidUrlError":
      return "pre-dispatch"
    case "TransportError":
      return hasPreDispatchCode(error.reason.cause) ? "pre-dispatch" : "post-dispatch"
    default:
      return "post-dispatch"
  }
}

const toHttpError = (redactedNames: ReadonlyArray<string | RegExp>) => (error: unknown) => {
  const phase = transportPhase(error)
  const transportError = (input: {
    readonly message: string
    readonly kind?: string | undefined
    readonly request?: HttpClientRequest.HttpClientRequest | undefined
  }) =>
    new LLMError({
      module: "RequestExecutor",
      method: "execute",
      reason: new TransportReason({
        message: input.message,
        kind: input.kind,
        phase,
        url: input.request ? redactUrl(input.request.url) : undefined,
        http: input.request ? new HttpContext({ request: requestDetails(input.request, redactedNames) }) : undefined,
      }),
    })

  if (Cause.isTimeoutError(error)) {
    return transportError({ message: error.message, kind: "Timeout" })
  }
  if (!HttpClientError.isHttpClientError(error)) {
    return transportError({ message: "HTTP transport failed" })
  }
  const request = "request" in error ? error.request : undefined
  if (error.reason._tag === "TransportError") {
    return transportError({
      message: error.reason.description ?? "HTTP transport failed",
      kind: error.reason._tag,
      request,
    })
  }
  return transportError({
    message: `HTTP transport failed: ${error.reason._tag}`,
    kind: error.reason._tag,
    request,
  })
}

const retryDelay = (error: LLMError, attempt: number) => {
  if (error.retryAfterMs !== undefined) return Effect.succeed(Math.min(error.retryAfterMs, MAX_DELAY_MS))
  return Random.nextBetween(
    Math.min(BASE_DELAY_MS * 2 ** attempt * 0.8, MAX_DELAY_MS),
    Math.min(BASE_DELAY_MS * 2 ** attempt * 1.2, MAX_DELAY_MS),
  ).pipe(Effect.map((delay) => Math.round(delay)))
}

const retryFailures = <A, R>(
  effect: Effect.Effect<A, LLMError, R>,
  limits: { readonly transport: number; readonly status: number },
  used: { readonly transport: number; readonly status: number } = { transport: 0, status: 0 },
  attempt = 0,
): Effect.Effect<A, LLMError, R> =>
  Effect.catchTag(effect, "LLM.Error", (error): Effect.Effect<A, LLMError, R> => {
    // Transport and status failures consume independent budgets: a flapping
    // connection must not eat the 429/5xx budget and vice versa. Only
    // pre-dispatch transport errors are retryable (see TransportReason).
    const isTransport = error.reason._tag === "Transport"
    const spent = isTransport ? used.transport : used.status
    const limit = isTransport ? limits.transport : limits.status
    if (!error.retryable || spent >= limit) return Effect.fail(error)
    return retryDelay(error, attempt).pipe(
      Effect.flatMap((delay) => Effect.sleep(delay)),
      Effect.flatMap(() =>
        retryFailures(
          effect,
          limits,
          isTransport
            ? { transport: spent + 1, status: used.status }
            : { transport: used.transport, status: spent + 1 },
          attempt + 1,
        ),
      ),
    )
  })

export const layer: Layer.Layer<Service, never, HttpClient.HttpClient> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    const executeOnce = (request: HttpClientRequest.HttpClientRequest) =>
      Effect.gen(function* () {
        const redactedNames = yield* Headers.CurrentRedactedNames
        yield* sealRequest(request)
        const redirectPolicy = yield* CurrentRedirectPolicy
        const options = Option.getOrUndefined(yield* Effect.serviceOption(FetchHttpClient.RequestInit))
        return yield* http
          .execute(request)
          .pipe(
            redirectPolicy === "manual"
              ? Effect.provideService(FetchHttpClient.RequestInit, { ...options, redirect: "manual" })
              : (effect) => effect,
            Effect.mapError(toHttpError(redactedNames)),
            Effect.flatMap(statusError(request, redactedNames)),
          )
      })
    return Service.of({
      execute: (request) =>
        Effect.gen(function* () {
          const override = yield* CurrentRetryLimit
          const transportLimit = override ?? (yield* CurrentTransportRetryLimit)
          const statusLimit = override ?? (yield* CurrentStatusRetryLimit)
          return yield* retryFailures(executeOnce(request), { transport: transportLimit, status: statusLimit })
        }),
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(FetchHttpClient.layer))

const nativeFetch = globalThis.fetch
const nativeObservations = new WeakSet<RequestSealInput>()
const builtinExecutors = new WeakMap<Interface, BuiltinBoundary>()
const builtinObservations = new WeakMap<RequestSealInput, { boundary: BuiltinBoundary; request: object }>()

// This describes the environment actually captured by a native runtime, not a route approval.
// Bun versions differ in when they read these variables; changing one invalidates the boundary.
const nativeEnvironmentKeys = [
  "HTTP_PROXY",
  "http_proxy",
  "HTTPS_PROXY",
  "https_proxy",
  "ALL_PROXY",
  "all_proxy",
  "NO_PROXY",
  "no_proxy",
  "NODE_TLS_REJECT_UNAUTHORIZED",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "BUN_CA_FILE",
  "NODE_OPTIONS",
  "BUN_OPTIONS",
] as const
const nativeEnvironment = () => JSON.stringify(nativeEnvironmentKeys.map((key) => [key, process.env[key] ?? null]))

type BuiltinBoundary = {
  active: boolean
  readonly fetch: typeof globalThis.fetch
  readonly globalFetch: typeof globalThis.fetch
  readonly environment: string
  readonly current?: () => boolean
  readonly description: Readonly<{ runtime: string; proxyPolicy: "startup-environment"; configurationHash: string }>
}

/** Read-only construction evidence. It cannot be supplied by an injected executor or copied handle. */
export const builtinDescription = (executor: Interface) => {
  const boundary = builtinExecutors.get(executor)
  return boundary && builtinCurrent(boundary) ? boundary.description : undefined
}

export const observesBuiltin = (executor: Interface, request: object, observation: RequestSealInput) => {
  const boundary = builtinExecutors.get(executor)
  const observed = builtinObservations.get(observation)
  return !!boundary && builtinCurrent(boundary) && observed?.boundary === boundary && observed.request === request
}

/** The request identity is process-local and must be tied to the actual client/model by the host.
 * This only chooses an executor constructed here; it grants no business execution authority. */
export const forBuiltinRequest = (executor: Interface, request: object): Interface | undefined => {
  const boundary = builtinExecutors.get(executor)
  if (!boundary || !builtinCurrent(boundary)) return undefined
  return nativeBoundary(boundary.fetch, boundary, request)
}

const countedObservations = new WeakSet<RequestSealInput>()

/** One local certificate from the same native final request lease. No HTTP request, tokenizer
 * estimate, or fake provider response is involved; generation must fit the vendor context cap. */
export const boundBuiltinDeepSeekResponses = Effect.fn("RequestExecutor.boundBuiltinDeepSeekResponses")(function* (
  executor: Interface, request: object, observation: RequestSealInput, deadline: number,
) {
  const boundary = builtinExecutors.get(executor)
  const context = yield* Effect.context<never>()
  if (!boundary || !observesBuiltin(executor, request, observation) || countedObservations.has(observation) ||
    Context.getOrUndefined(context, FetchHttpClient.RequestInit) !== undefined ||
    Context.getOrUndefined(context, FetchHttpClient.Fetch) !== undefined || (yield* CurrentRetryLimit) !== 0 ||
    (yield* CurrentRedirectPolicy) !== "manual" || observation.method !== "POST" ||
    observation.url !== VendorContextBound.DEEPSEEK_FLASH.endpoint || !observation.bodyText || !observation.headers ||
    !Number.isSafeInteger(deadline) || deadline <= Date.now() || deadline > Date.now() + 10_000)
    return yield* nativeRefusal("Native context-bound observation is unavailable")
  const input = responsesCountInput(observation.bodyText)
  if (Option.isNone(input) || input.value.model !== VendorContextBound.DEEPSEEK_FLASH.modelID || !builtinCurrent(boundary))
    return yield* nativeRefusal("Native context-bound request is unavailable")
  const countBodyHash = createHash("sha256").update(JSON.stringify(input.value)).digest("hex")
  const responseHash = createHash("sha256").update(JSON.stringify([
    "dac.vendor-context-input-upper-bound.v1", VendorContextBound.DEEPSEEK_FLASH,
    countBodyHash, observation.bodyHash, observation.wireHash,
  ])).digest("hex")
  if (!builtinCurrent(boundary) || Date.now() >= deadline)
    return yield* nativeRefusal("Native context-bound configuration changed")
  countedObservations.add(observation)
  return Object.freeze({ inputTokens: VendorContextBound.DEEPSEEK_FLASH.inputUpperBound,
    countBodyHash, responseHash, countedAt: Date.now() })
})
const CountResponse = Schema.Struct({ object: Schema.Literal("response.input_tokens"), input_tokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)) })
const ResponsesCountBody = Schema.Struct({
  model: Schema.String,
  input: Schema.Array(Schema.Unknown),
  instructions: Schema.optional(Schema.String),
  tools: Schema.optional(Schema.Array(Schema.Record(Schema.String, Schema.Unknown))),
  tool_choice: Schema.optional(Schema.Union([
    Schema.Literals(["auto", "none", "required"]),
    Schema.Struct({ type: Schema.Literal("function"), name: Schema.String }),
  ])),
  parallel_tool_calls: Schema.optional(Schema.Boolean),
  reasoning: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  text: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  truncation: Schema.optional(Schema.Literal("disabled")),
  stream: Schema.Literal(true),
  store: Schema.Literal(false),
  max_output_tokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(16), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)),
  temperature: Schema.optional(Schema.Number.check(Schema.isFinite())),
  top_p: Schema.optional(Schema.Number.check(Schema.isFinite())),
})

/** Pure projection, never authorization. Preserve every accepted input-bearing field from the
 * actual final encoded request, including tool schemas and output formatting. Provider-side
 * conversation references and unknown fields cannot be counted from these local bytes.
 * https://developers.openai.com/api/reference/python/resources/responses/subresources/input_tokens/methods/count
 * The Work profile separately validates exact history, tool identity, model and field ceilings. */
export function responsesCountInput(bodyText: string) {
  if (Buffer.byteLength(bodyText) > 524_288) return Option.none()
  const parsed = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(bodyText)
  if (Option.isNone(parsed) || JSON.stringify(parsed.value) !== bodyText) return Option.none()
  const decoded = Schema.decodeUnknownOption(ResponsesCountBody, { onExcessProperty: "error" })(parsed.value)
  if (Option.isNone(decoded)) return Option.none()
  const { stream, store, max_output_tokens, temperature, top_p, ...input } = decoded.value
  return Option.some(input)
}

/** Fixed Responses operation, only from this executor's actual final generation observation.
 * No caller body, headers, fetch function or endpoint is accepted. The host must authorize and
 * durably consume its count slot BEFORE calling. A failed disclosure is never replayed here. */
export const countBuiltinResponses = Effect.fn("RequestExecutor.countBuiltinResponses")(function* (
  executor: Interface,
  request: object,
  observation: RequestSealInput,
  deadline: number,
) {
  const boundary = builtinExecutors.get(executor)
  const context = yield* Effect.context<never>()
  if (
    !boundary || !observesBuiltin(executor, request, observation) || countedObservations.has(observation) ||
    Context.getOrUndefined(context, FetchHttpClient.RequestInit) !== undefined ||
    Context.getOrUndefined(context, FetchHttpClient.Fetch) !== undefined ||
    (yield* CurrentRetryLimit) !== 0 || (yield* CurrentRedirectPolicy) !== "manual" ||
    observation.method !== "POST" || !observation.url || !observation.bodyText || !observation.headers ||
    !Number.isSafeInteger(deadline) || deadline <= Date.now() || deadline > Date.now() + 10_000
  ) return yield* nativeRefusal("Native input-count observation is unavailable")
  const url = new URL(observation.url)
  if (url.pathname !== "/v1/responses" || url.search || url.hash || url.username || url.password)
    return yield* nativeRefusal("Native input-count endpoint is unavailable")
  const decoded = responsesCountInput(observation.bodyText)
  if (Option.isNone(decoded)) return yield* nativeRefusal("Native input-count body is unavailable")
  const body = JSON.stringify(decoded.value)
  const headers = Redacted.value(observation.headers)
  url.pathname += "/input_tokens"
  // The single-use marker is set synchronously with the final native boundary check.
  if (!builtinCurrent(boundary)) return yield* nativeRefusal("Native input-count configuration changed")
  countedObservations.add(observation)
  return yield* Effect.tryPromise({
    try: async (signal) => {
      const abort = new AbortController()
      const cancel = () => abort.abort()
      signal.addEventListener("abort", cancel, { once: true })
      if (signal.aborted) cancel()
      const timeout = setTimeout(cancel, Math.max(0, deadline - Date.now()))
      const response = await boundary.fetch(url.href, {
        method: "POST", headers, body, redirect: "manual", signal: abort.signal,
        keepalive: false, tls: { rejectUnauthorized: true },
      }).catch(() => undefined)
      try {
        if (!response || response.status !== 200 || !response.body || !builtinCurrent(boundary) || Date.now() >= deadline)
          throw nativeRefusal("Native input-count response is unavailable")
        const type = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase()
        if (type !== "application/json") throw nativeRefusal("Native input-count response type is invalid")
        const reader = response.body.getReader()
        const chunks: Uint8Array[] = []
        let bytes = 0
        try {
          while (true) {
            const part = await reader.read()
            if (part.done) break
            bytes += part.value.byteLength
            if (bytes > 16_384 || Date.now() >= deadline || !builtinCurrent(boundary))
              throw nativeRefusal("Native input-count response exceeds its bounds")
            chunks.push(part.value)
          }
        } finally { await reader.cancel().catch(() => undefined) }
        const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))
        const result = Schema.decodeUnknownOption(Schema.fromJsonString(CountResponse), { onExcessProperty: "error" })(text)
        if (Option.isNone(result) || Date.now() >= deadline || !builtinCurrent(boundary))
          throw nativeRefusal("Native input-count result is invalid")
        return Object.freeze({
          inputTokens: result.value.input_tokens,
          responseHash: createHash("sha256").update(text).digest("hex"),
          countBodyHash: createHash("sha256").update(body).digest("hex"),
          countedAt: Date.now(),
        })
      } finally {
        clearTimeout(timeout)
        signal.removeEventListener("abort", cancel)
        await response?.body?.cancel().catch(() => undefined)
      }
    },
    catch: () => nativeRefusal("Native input-count outcome is unavailable"),
  })
})

function builtinCurrent(boundary: BuiltinBoundary) {
  return boundary.active && (boundary.current ? boundary.current() :
    globalThis.fetch === boundary.globalFetch && nativeEnvironment() === boundary.environment)
}

/** Construction identity only; this is not an installed-build or route approval. Copies are not observations. */
export const isNativeObservation = (input: RequestSealInput) => nativeObservations.has(input)

const nativeRefusal = (message: string) =>
  new LLMError({
    module: "RequestExecutor",
    method: "execute",
    reason: new InvalidRequestReason({ message }),
  })

/** Opt-in boundary for sealed UTF-8 HTTP requests. The ordinary injectable executor is unchanged.
 * Application headers are observed; fetch/OS-generated Host, User-Agent and Content-Length are not.
 * The captured platform function is a local construction fact, not a signed runtime attestation. */
export const nativeSealedLayer = Layer.sync(Service, () => nativeBoundary(nativeFetch))

/** Literal guarded import keeps ordinary LLM clients usable in Node. No callback, fetch override,
 * registry registration, or caller hash can construct this builtin boundary. */
export const builtinBunLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    if (!process.versions.bun) return yield* Effect.die("Builtin Bun HTTP is unavailable")
    const builtin = yield* Effect.promise(() => import("bun"))
    const environment = nativeEnvironment()
    const boundary: BuiltinBoundary = {
      active: true,
      fetch: builtin.fetch,
      globalFetch: globalThis.fetch,
      environment,
      description: Object.freeze({
        runtime: `bun:${process.versions.bun}`,
        proxyPolicy: "startup-environment",
        // Local identity only, not a persistent configuration/credential authorization hash.
        configurationHash: createHmac("sha256", randomBytes(32))
          .update("dac.native-executor.configuration.v1\0")
          .update(environment)
          .digest("hex"),
      }),
    }
    const executor = nativeBoundary(builtin.fetch, boundary)
    builtinExecutors.set(executor, boundary)
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        boundary.active = false
        builtinExecutors.delete(executor)
      }),
    )
    return executor
  }),
)

/** The early executable prefix is mandatory for construction evidence. A library import
 * without that prefix keeps its ordinary client; it cannot acquire a native request lease. */
export const builtinNodeLayer = Layer.effect(Service, Effect.gen(function* () {
  const transport = BuiltinNode.create()
  if (!transport) return nativeBoundary(Object.assign(async () => {
    throw new Error("Builtin Node HTTP is unavailable")
  }, { preconnect: globalThis.fetch.preconnect }))
  const boundary: BuiltinBoundary = {
    active: true, fetch: transport.fetch, globalFetch: globalThis.fetch,
    environment: nativeEnvironment(), current: transport.current, description: transport.description,
  }
  const executor = nativeBoundary(transport.fetch, boundary)
  builtinExecutors.set(executor, boundary)
  yield* Effect.addFinalizer(() => Effect.promise(async () => {
    boundary.active = false
    builtinExecutors.delete(executor)
    await transport.close()
  }))
  return executor
}))

function nativeBoundary(
  fetch: typeof globalThis.fetch,
  boundary?: BuiltinBoundary,
  requestIdentity?: object,
): Interface {
  // HttpClient.make retains Effect's response-stream cancellation, but no injected client, Fetch,
  // RequestInit or tracing-header transform can run between this callback and the platform call.
  const http = HttpClient.make((request, url, signal) =>
    Effect.gen(function* () {
      const seal = yield* CurrentRequestSeal
      if (!seal) return yield* Effect.die("Native HTTP request seal is unavailable")
      if (request.body._tag !== "Uint8Array") return yield* Effect.die("Native HTTP snapshot is unavailable")
      const bodyText = new TextDecoder("utf-8", { fatal: true }).decode(request.body.body)
      const headers = Object.freeze(Headers.remove(Headers.fromInput({ ...request.headers }), "content-length"))
      const observation: RequestSealInput = Object.freeze({
        method: request.method,
        url: url.href,
        bodyText,
        headers: Redacted.make(headers),
        wireHash: wireRequestHash({
          method: request.method,
          url: url.href,
          contentType: headers["content-type"],
          bodyText,
        }),
        bodyHash: createHash("sha256").update(bodyText).digest("hex"),
        bodyLength: Buffer.byteLength(bodyText, "utf8"),
        contentType: headers["content-type"],
      })
      nativeObservations.add(observation)
      if (boundary && requestIdentity) builtinObservations.set(observation, { boundary, request: requestIdentity })
      yield* seal.seal(observation)
      // A seal may suspend for durable authorization. Recheck after it, immediately before fetch.
      if (boundary && !builtinCurrent(boundary)) return yield* Effect.die("Builtin HTTP configuration changed")
      return yield* Effect.tryPromise({
        try: () =>
          fetch(url.href, {
            method: request.method,
            headers,
            body: bodyText,
            redirect: "manual",
            signal,
            ...(boundary ? { keepalive: false, tls: { rejectUnauthorized: true } } : {}),
          }),
        catch: (cause) =>
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({ request, cause }),
          }),
      }).pipe(
        Effect.flatMap((response) =>
          // Native diagnostics intentionally exclude response bodies and headers, which may echo credentials.
          (response.status >= (boundary ? 300 : 400) && response.body
            ? Effect.tryPromise({ try: () => response.body!.cancel(), catch: () => undefined }).pipe(
                Effect.catch(() => Effect.void),
              )
            : Effect.void
          ).pipe(Effect.as(HttpClientResponse.fromWeb(request, response))),
        ),
      )
    }),
  )
  return Service.of({
    execute: (request) =>
      Effect.gen(function* () {
        const context = yield* Effect.context<never>()
        if (
          Context.getOrUndefined(context, FetchHttpClient.RequestInit) !== undefined ||
          Context.getOrUndefined(context, FetchHttpClient.Fetch) !== undefined ||
          (boundary ? !builtinCurrent(boundary) : globalThis.fetch !== nativeFetch)
        )
          return yield* nativeRefusal("Native HTTP boundary does not allow Fetch or RequestInit overrides")
        if ((yield* CurrentRetryLimit) !== 0 || (yield* CurrentRedirectPolicy) !== "manual")
          return yield* nativeRefusal("Native HTTP boundary requires zero retries and manual redirects")
        if (!(yield* CurrentRequestSeal)) return yield* nativeRefusal("Native HTTP request seal is unavailable")
        if (request.body._tag !== "Uint8Array") return yield* nativeRefusal("Native HTTP requires a UTF-8 byte body")
        const url = Option.getOrUndefined(HttpClientRequest.toUrl(request))
        if (!url || !["http:", "https:"].includes(url.protocol))
          return yield* nativeRefusal("Native HTTP requires a valid HTTP URL")
        if (boundary && (url.username || url.password))
          return yield* nativeRefusal("Builtin HTTP does not allow URL credentials")
        url.hash = ""
        // Copy before yielding: the caller may still own the original mutable typed array and headers.
        const bytes = Uint8Array.from(request.body.body)
        const suppliedHeaders = { ...request.headers }
        const headers = yield* Effect.try({
          // Apply the platform's name/value normalization before observing the application headers.
          try: () =>
            Object.freeze(Headers.remove(Headers.fromInput(new globalThis.Headers(suppliedHeaders)), "content-length")),
          catch: () => nativeRefusal("Native HTTP application headers are invalid"),
        })
        const text = yield* Effect.try({
          try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
          catch: () => nativeRefusal("Native HTTP body is not valid UTF-8"),
        })
        if (!Buffer.from(text, "utf8").equals(bytes))
          return yield* nativeRefusal("Native HTTP body cannot round-trip as UTF-8")
        const snapshot = HttpClientRequest.make(request.method)(url.href).pipe(
          HttpClientRequest.bodyText(text, headers["content-type"]),
          HttpClientRequest.setHeaders(headers),
        )
        const response = yield* http.execute(snapshot).pipe(
          Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
          Effect.mapError(
            (error) =>
              new LLMError({
                module: "RequestExecutor",
                method: "execute",
                reason: new TransportReason({ message: "Native HTTP transport failed", phase: transportPhase(error) }),
              }),
          ),
        )
        if (response.status < (boundary ? 300 : 400)) return response
        return yield* new LLMError({
          module: "RequestExecutor",
          method: "execute",
          reason: statusReason({
            status: response.status,
            message: `Native HTTP request failed with status ${response.status}`,
            http: new HttpContext({
              request: new HttpRequestDetails({ method: snapshot.method, url: redactUrl(snapshot.url), headers: {} }),
              response: new HttpResponseDetails({ status: response.status, headers: {} }),
            }),
          }),
        })
      }),
  })
}

export * as RequestExecutor from "./executor"
