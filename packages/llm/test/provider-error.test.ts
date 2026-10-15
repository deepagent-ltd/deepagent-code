import { describe, expect, test } from "bun:test"
import {
  AuthenticationReason,
  HttpContext,
  HttpRequestDetails,
  HttpResponseDetails,
  InvalidRequestReason,
  LLMError,
  TransportReason,
} from "../src/schema"
import { isTerminalProviderFailure } from "../src/provider-error"

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
