import { afterAll, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { IMKernelExchange } from "@/im/kernel/exchange"

// The disabled-token response shape was observed from the real Go TokenAuth
// middleware. This local listener exercises the actual HTTP decoder, without
// copying the platform DB or exposing its credential/error text.
const secret = "fixture-error-must-never-be-returned"
const payload = { kernel_token: "fixture-token", navigator_url: "http://127.0.0.1:1", appkey: "protected", identity: { uuid: "alice", name: "alice", org_id: 100, org_all_group_id: "org100" }, ttl: { msg_life_time_ms: 86400000 } }
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const label = request.headers.get("authorization")?.slice("Bearer ".length)
    if (label?.startsWith("429")) return new Response(label === "429-success" ? JSON.stringify({ success: true, data: payload }) : "", {
      status: 429,
      headers: label === "429-seconds" ? { "Retry-After": "2" }
        : label === "429-date" ? { "Retry-After": new Date(Date.now() + 120_000).toUTCString() }
        : label === "429-invalid" ? { "Retry-After": "not-a-delay" }
        : label === "429-large" ? { "Retry-After": "9999999999999999" } : {},
    })
    if (label === "business") return Response.json({ success: false, code: "im_cross_org", message: "Identity is outside this organization." }, { status: 403 })
    if (label === "success401") return Response.json({ success: true, data: payload }, { status: 401 })
    if (label === "plain401") return new Response(secret, { status: 401, headers: { "content-type": "text/html" } })
    if (label === "503") return Response.json({ error: secret }, { status: 503 })
    if (label === "envelope403") return Response.json({ success: false, message: secret }, { status: 403 })
    return Response.json({ error: secret }, { status: label === "403" ? 403 : 401 })
  },
})
afterAll(() => server.stop(true))
const run = (key: string) => Effect.runPromise(IMKernelExchange.exchange({ facadeURL: server.url.origin, key }).pipe(Effect.result, Effect.provide(FetchHttpClient.layer)))

describe("real HTTP facade authentication rejection", () => {
  for (const key of ["401", "403", "plain401", "envelope403", "success401"]) {
    test(`${key} stays a fixed non-retryable key rejection`, async () => {
      const result = await run(key)
      expect(result._tag).toBe("Failure")
      if (result._tag !== "Failure") return
      expect(result.failure).toBeInstanceOf(IMKernelExchange.ExchangeError)
      expect(result.failure.code).toBe("im_key_invalid")
      expect(result.failure.status).toBe(key.includes("403") ? 403 : 401)
      expect(result.failure.retryable).toBe(false)
      expect(result.failure.message).toBe("The configured IM key is invalid or no longer active.")
      expect(JSON.stringify(result.failure)).not.toContain(secret)
      expect(JSON.stringify(result.failure)).not.toContain(payload.kernel_token)
    })
  }
  test("valid facade business code and its safe message remain specific", async () => {
    const result = await run("business")
    expect(result._tag).toBe("Failure")
    if (result._tag !== "Failure") return
    expect(result.failure.code).toBe("im_cross_org")
    expect(result.failure.message).toBe("Identity is outside this organization.")
    expect(result.failure.status).toBe(403)
    expect(result.failure.retryable).toBe(false)
  })
  test("an invalid 503 remains an unavailable response rather than a key rejection", async () => {
    const result = await run("503")
    expect(result._tag).toBe("Failure")
    if (result._tag !== "Failure") return
    expect(result.failure.code).toBe("invalid_response")
    expect(result.failure.status).toBe(503)
    expect(result.failure.retryable).toBe(true)
    expect(result.failure.message).not.toContain(secret)
  })
  test("empty or forged-success 429 responses stay a known refusal without parsing a body", async () => {
    for (const key of ["429", "429-success", "429-invalid"]) {
      const result = await run(key)
      expect(result._tag).toBe("Failure")
      if (result._tag !== "Failure") return
      expect(result.failure.code).toBe("im_unavailable")
      expect(result.failure.status).toBe(429)
      expect(result.failure.retryable).toBe(false)
      expect(result.failure.retryAfterMs).toBeUndefined()
      expect(JSON.stringify(result.failure)).not.toContain(payload.kernel_token)
    }
  })
  test("the original HTTP Retry-After bounds seconds, date and overflow backoff", async () => {
    const seconds = await run("429-seconds")
    const date = await run("429-date")
    const large = await run("429-large")
    expect(seconds._tag).toBe("Failure")
    expect(date._tag).toBe("Failure")
    expect(large._tag).toBe("Failure")
    if (seconds._tag !== "Failure" || date._tag !== "Failure" || large._tag !== "Failure") return
    expect(seconds.failure.retryAfterMs).toBe(2000)
    expect(date.failure.retryAfterMs).toBeGreaterThan(118_000)
    expect(date.failure.retryAfterMs).toBeLessThanOrEqual(120_000)
    expect(large.failure.retryAfterMs).toBe(Number.MAX_SAFE_INTEGER)
  })
})
