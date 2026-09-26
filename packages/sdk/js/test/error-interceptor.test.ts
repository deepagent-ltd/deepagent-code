import { describe, expect, test } from "bun:test"
import { createDeepAgentCodeClient } from "../src/client.js"

const response = () =>
  new Response(JSON.stringify({ name: "PtyNotFoundError", data: { message: "PTY session not found" } }), {
    status: 404,
    headers: { "content-type": "application/json" },
  })

describe("SDK error interceptor", () => {
  test("honors client-level throwOnError when wrapping decoded server errors", async () => {
    const client = createDeepAgentCodeClient({
      baseUrl: "http://localhost:4096",
      throwOnError: true,
      fetch: async () => response(),
    })

    const error = await client.global.health().catch((value: unknown) => value)
    if (!(error instanceof Error)) throw new Error("Expected an Error")
    expect(error.message).toBe("PTY session not found")
    expect(error.cause).toMatchObject({ status: 404 })
  })

  test("preserves structured errors on the non-throwing result path", async () => {
    const client = createDeepAgentCodeClient({
      baseUrl: "http://localhost:4096",
      throwOnError: true,
      fetch: async () => response(),
    })

    const result = await client.global.health({ throwOnError: false })
    expect(result.error).toEqual({ name: "PtyNotFoundError", data: { message: "PTY session not found" } })
  })

  test("share mutations can surface the historical-session 409 as a readable error", async () => {
    const body = {
      _tag: "ConflictError",
      message: "Historical session ses_archived requires explicit audited adoption",
      resource: "legacy_session_requires_adoption",
    }
    const client = createDeepAgentCodeClient({
      baseUrl: "http://localhost:4096",
      fetch: async () =>
        new Response(JSON.stringify(body), {
          status: 409,
          headers: { "content-type": "application/json" },
        }),
    })

    for (const mutation of ["share", "unshare"] as const) {
      const result = await client.session[mutation]({ sessionID: "ses_archived" })
      expect(result.error).toEqual(body)

      const error = await client.session[mutation]({ sessionID: "ses_archived" }, { throwOnError: true }).catch((value: unknown) => value)
      if (!(error instanceof Error)) throw new Error("Expected an Error")
      expect(error.message).toBe(body.message)
      expect(error.cause).toMatchObject({ status: 409, body })
    }
  })
})
