import { describe, expect, test } from "bun:test"
import { describeSessionError } from "./session-turn-error"

describe("describeSessionError", () => {
  test("turns the DeepSeek 401 response into an actionable authentication error", () => {
    expect(
      describeSessionError({
        name: "ProviderAuthError",
        data: {
          message:
            'Error: {"error":{"type":"authentication_error","message":"Authentication Fails, Your api key: ****bb03 is invalid (request_id: 15d1c86f)"}}',
        },
      }),
    ).toEqual({
      kind: "authentication",
      detail: "Authentication Fails, Your api key: [redacted] is invalid (request_id: 15d1c86f)",
    })
  })

  test("keeps unfamiliar failures available for support", () => {
    expect(describeSessionError({ name: "UnexpectedFailure", data: { message: "Something unusual happened" } })).toEqual({
      kind: "unknown",
      detail: "Something unusual happened",
    })
  })
})
