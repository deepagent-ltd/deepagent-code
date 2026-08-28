import { describe, expect, test } from "bun:test"
import { createDeepAgentCodeClient } from "../src/v2/client.js"

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
})
