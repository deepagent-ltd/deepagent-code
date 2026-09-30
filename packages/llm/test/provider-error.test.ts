import { describe, expect, test } from "bun:test"
import { AuthenticationReason, LLMError } from "../src/schema"
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
})
