import { describe, expect, test } from "bun:test"
import {
  AuthenticationReason,
  HttpContext,
  HttpRequestDetails,
  HttpResponseDetails,
  InvalidRequestReason,
  LLMError,
  ProviderInternalReason,
  RateLimitReason,
  TransportReason,
} from "../src/schema"
import {
  decodeProviderRefusal,
  encodeProviderRefusal,
  isTerminalProviderFailure,
  retryableProviderRefusal,
  type ProviderRefusal,
} from "../src/provider-error"

const http = (status: number, body: string | undefined, bodyTruncated?: boolean) =>
  new HttpContext({
    request: new HttpRequestDetails({
      method: "POST",
      url: "https://fixture.invalid/chat/completions",
      headers: {},
    }),
    response: new HttpResponseDetails({ status, headers: {} }),
    body,
    bodyTruncated,
  })

describe("isTerminalProviderFailure", () => {
  test("a rejected API key is a definite failure", () => {
    expect(
      isTerminalProviderFailure(
        new LLMError({
          module: "provider",
          method: "stream",
          reason: new AuthenticationReason({ kind: "invalid", message: "HTTP 401" }),
        }),
      ),
    ).toBe(true)
  })

  test("an unknown stream failure stays indeterminate", () => {
    expect(isTerminalProviderFailure(new Error("stream disconnected"))).toBe(false)
  })

  test("a complete structured request refusal is terminal only before any provider event", () => {
    const failure = new LLMError({
      module: "RequestExecutor",
      method: "execute",
      reason: new InvalidRequestReason({
        message: "Provider request rejected",
        http: new HttpContext({
          request: new HttpRequestDetails({
            method: "POST",
            url: "https://fixture.invalid/chat/completions",
            headers: {},
          }),
          response: new HttpResponseDetails({ status: 400, headers: {} }),
          body: JSON.stringify({ error: { type: "invalid_request_error", code: "invalid_request_error" } }),
        }),
      }),
    })
    expect(isTerminalProviderFailure(failure, { providerEventsStarted: false })).toBe(true)
    expect(isTerminalProviderFailure(failure, { providerEventsStarted: true })).toBe(false)
    expect(isTerminalProviderFailure(failure)).toBe(false)
    expect(
      isTerminalProviderFailure(
        new LLMError({
          module: "provider",
          method: "stream",
          reason: new AuthenticationReason({ kind: "invalid", message: "HTTP 401" }),
        }),
        { providerEventsStarted: true },
      ),
    ).toBe(true)
  })

  test("unproven refusals, server errors and transport failures stay indeterminate", () => {
    const body = JSON.stringify({ error: { type: "invalid_request_error", code: "invalid_request_error" } })
    for (const input of [
      { status: 400, body: undefined },
      { status: 400, body: "invalid_request_error" },
      { status: 400, body: "{" },
      { status: 400, body, bodyTruncated: true },
      { status: 400, body: JSON.stringify({ error: { type: "invalid_request_error" } }) },
      { status: 400, body: JSON.stringify({ error: { type: "server_error", code: "invalid_request_error" } }) },
      { status: 503, body },
    ]) {
      expect(
        isTerminalProviderFailure(
          new LLMError({
            module: "RequestExecutor",
            method: "execute",
            reason: new InvalidRequestReason({
              message: "HTTP 400 invalid_request_error",
              http: new HttpContext({
                request: new HttpRequestDetails({
                  method: "POST",
                  url: "https://fixture.invalid/chat/completions",
                  headers: {},
                }),
                response: new HttpResponseDetails({ status: input.status, headers: {} }),
                body: input.body,
                bodyTruncated: input.bodyTruncated,
              }),
            }),
          }),
          { providerEventsStarted: false },
        ),
      ).toBe(false)
    }
    expect(
      isTerminalProviderFailure(
        new LLMError({
          module: "RequestExecutor",
          method: "execute",
          reason: new TransportReason({ message: body, phase: "post-dispatch" }),
        }),
      ),
    ).toBe(false)
  })
})

describe("retryableProviderRefusal", () => {
  test("complete rate-limit and server refusals, including empty HTTP bodies, are terminal before events", () => {
    for (const input of [
      {
        reason: new RateLimitReason({ message: "HTTP 429", http: http(429, "") }),
        refusal: { kind: "rate-limit", status: 429 } satisfies ProviderRefusal,
      },
      ...[500, 503, 599].map((status) => ({
        reason: new ProviderInternalReason({ message: "Provider unavailable", status, http: http(status, "{}") }),
        refusal: { kind: "provider-internal", status } satisfies ProviderRefusal,
      })),
    ]) {
      const failure = new LLMError({ module: "RequestExecutor", method: "execute", reason: input.reason })
      expect(retryableProviderRefusal(failure, { providerEventsStarted: false })).toEqual(input.refusal)
      expect(isTerminalProviderFailure(failure, { providerEventsStarted: false })).toBe(true)
      expect(retryableProviderRefusal(failure, { providerEventsStarted: true })).toBeUndefined()
      expect(isTerminalProviderFailure(failure, { providerEventsStarted: true })).toBe(false)
      expect(isTerminalProviderFailure(failure)).toBe(false)
    }
  })

  test("an explicit pre-dispatch transport failure is terminal only without an HTTP response or provider event", () => {
    const failure = new LLMError({
      module: "RequestExecutor",
      method: "execute",
      reason: new TransportReason({ message: "Connection refused", phase: "pre-dispatch" }),
    })
    expect(retryableProviderRefusal(failure, { providerEventsStarted: false })).toEqual({
      kind: "transport-pre-dispatch",
      status: null,
    })
    expect(isTerminalProviderFailure(failure, { providerEventsStarted: false })).toBe(true)
    expect(retryableProviderRefusal(failure, { providerEventsStarted: true })).toBeUndefined()
    expect(isTerminalProviderFailure(failure, { providerEventsStarted: true })).toBe(false)
    for (const reason of [
      new TransportReason({ message: "Connection lost", phase: "post-dispatch" }),
      new TransportReason({ message: "Unknown dispatch phase" }),
      new TransportReason({ message: "Response received", phase: "pre-dispatch", http: http(503, "") }),
    ])
      expect(
        retryableProviderRefusal(new LLMError({ module: "provider", method: "stream", reason }), {
          providerEventsStarted: false,
        }),
      ).toBeUndefined()
  })

  test("retry flags and HTTP messages cannot replace exact complete typed response evidence", () => {
    for (const reason of [
      new RateLimitReason({ message: "HTTP 429" }),
      new RateLimitReason({ message: "HTTP 429", http: http(429, undefined) }),
      new RateLimitReason({ message: "HTTP 429", http: http(429, "{}", true) }),
      new RateLimitReason({ message: "HTTP 429", http: http(503, "{}") }),
      new RateLimitReason({
        message: "Missing response",
        http: new HttpContext({
          request: new HttpRequestDetails({ method: "POST", url: "https://fixture.invalid", headers: {} }),
          body: "",
        }),
      }),
      new ProviderInternalReason({ message: "HTTP 503", status: 503 }),
      new ProviderInternalReason({ message: "HTTP 503", status: 503, http: http(503, undefined) }),
      new ProviderInternalReason({ message: "HTTP 503", status: 503, http: http(503, "{}", true) }),
      new ProviderInternalReason({ message: "HTTP 503", status: 503, http: http(500, "{}") }),
      new ProviderInternalReason({ message: "HTTP 503", status: 429, http: http(429, "{}") }),
      ...[499, 600, 500.5, Number.NaN, Number.POSITIVE_INFINITY].map(
        (status) => new ProviderInternalReason({ message: "Invalid status", status, http: http(status, "{}") }),
      ),
    ]) {
      const failure = new LLMError({ module: "RequestExecutor", method: "execute", reason })
      expect(retryableProviderRefusal(failure, { providerEventsStarted: false })).toBeUndefined()
      expect(isTerminalProviderFailure(failure, { providerEventsStarted: false })).toBe(false)
    }
    expect(retryableProviderRefusal(new Error("HTTP 503"), { providerEventsStarted: false })).toBeUndefined()
    expect(retryableProviderRefusal({ retryable: true }, { providerEventsStarted: false })).toBeUndefined()
  })
})

describe("provider refusal codes", () => {
  test("round-trips only versioned typed refusals with an exact identity hash", () => {
    const hash = "0123456789abcdef".repeat(4)
    const refusals: readonly ProviderRefusal[] = [
      { kind: "rate-limit", status: 429 },
      { kind: "provider-internal", status: 500 },
      { kind: "provider-internal", status: 503 },
      { kind: "provider-internal", status: 599 },
      { kind: "transport-pre-dispatch", status: null },
    ]
    for (const refusal of refusals) {
      const code = `provider-refusal.v1:${refusal.kind}:${refusal.status ?? 0}:${hash}`
      expect(encodeProviderRefusal(refusal, hash)).toBe(code)
      expect(decodeProviderRefusal(code)).toEqual({ refusal, identityHash: hash })
    }
  })

  test("rejects malformed, foreign, mismatched and noncanonical codes", () => {
    const hash = "a".repeat(64)
    for (const code of [
      undefined,
      null,
      {},
      503,
      "HTTP 503",
      `provider-refusal.v2:provider-internal:503:${hash}`,
      `provider-refusal.v1:provider-internal:503:${hash}\n`,
      `provider-refusal.v1:provider-internal:503:${hash}:extra`,
      `provider-refusal.v1:provider-internal:503:${hash.toUpperCase()}`,
      `provider-refusal.v1:provider-internal:503:${hash.slice(1)}`,
      `provider-refusal.v1:provider-internal:503:${hash}a`,
      `provider-refusal.v1:provider-internal:0503:${hash}`,
      `provider-refusal.v1:provider-internal:500.5:${hash}`,
      `provider-refusal.v1:provider-internal:600:${hash}`,
      `provider-refusal.v1:provider-internal:499:${hash}`,
      `provider-refusal.v1:provider-internal:429:${hash}`,
      `provider-refusal.v1:provider-internal:0:${hash}`,
      `provider-refusal.v1:rate-limit:503:${hash}`,
      `provider-refusal.v1:transport-pre-dispatch:429:${hash}`,
      `provider-refusal.v1:transport-post-dispatch:0:${hash}`,
    ])
      expect(decodeProviderRefusal(code)).toBeUndefined()
    for (const identityHash of ["", hash.slice(1), `${hash}a`, hash.toUpperCase(), `${hash}\n`])
      expect(encodeProviderRefusal({ kind: "rate-limit", status: 429 }, identityHash)).toBeUndefined()
    for (const status of [429, 499, 600, 500.5, Number.NaN, Number.POSITIVE_INFINITY])
      expect(encodeProviderRefusal({ kind: "provider-internal", status }, hash)).toBeUndefined()
  })
})
