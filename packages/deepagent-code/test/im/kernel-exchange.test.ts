import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/unstable/http"
import { IMKernelExchange } from "@/im/kernel/exchange"
import { testEffect } from "../lib/effect"

// IMKernelExchange against a fake HttpClient (canned envelopes) plus one real-transport refused
// connection. Covers: request shape (path/method/Bearer header), the new-api success/error envelope
// unwrapping, business-code → typed error mapping with the retryable classification (5xx/transport
// retry, 4xx does not), malformed-payload fail-closed, and the payload → KernelConfig mapping
// (kernel user_id = identity uuid). The facade itself is exercised by the live script — never here.

const it = testEffect(Layer.empty)

const payload = {
  kernel_token: "kt_1",
  navigator_url: "http://127.0.0.1:9002",
  appkey: "appkey_1",
  identity: { uuid: "uuid-alice", name: "alice", org_id: 7, org_all_group_id: "org7" },
  ttl: { msg_life_time_ms: 259200000 },
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const stubHttp = (respond: (req: Parameters<typeof HttpClientResponse.fromWeb>[0]) => Response) =>
  HttpClient.make((req) => Effect.succeed(HttpClientResponse.fromWeb(req, respond(req))))

const run = <A>(effect: Effect.Effect<A, IMKernelExchange.ExchangeError, HttpClient.HttpClient>, http: HttpClient.HttpClient) =>
  effect.pipe(Effect.provideService(HttpClient.HttpClient, http))

describe("IMKernelExchange", () => {
  it.live("exchange posts to /api/im/exchange with the Bearer key and unwraps the success envelope", () =>
    Effect.gen(function* () {
      const seen: Array<{ method: string; url: string; authorization: string | undefined }> = []
      const http = HttpClient.make((req) =>
        Effect.sync(() => {
          seen.push({ method: req.method, url: req.url, authorization: req.headers["authorization"] })
          return HttpClientResponse.fromWeb(req, json({ success: true, message: "", data: payload }))
        }),
      )
      const result = yield* run(IMKernelExchange.exchange({ facadeURL: "http://facade.local:3100/", key: "sk-alice" }), http)

      expect(seen).toEqual([
        { method: "POST", url: "http://facade.local:3100/api/im/exchange", authorization: "Bearer sk-alice" },
      ])
      expect(result).toEqual(payload)
    }),
  )

  it.live("claim posts the name to /api/im/claim", () =>
    Effect.gen(function* () {
      const seen: string[] = []
      const http = stubHttp((req) => {
        seen.push(req.url)
        return new Response(JSON.stringify({ success: true, message: "", data: payload }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      })
      yield* run(IMKernelExchange.claim({ facadeURL: "http://facade.local", key: "sk-bob", name: "bob" }), http)
      expect(seen).toEqual(["http://facade.local/api/im/claim"])
    }),
  )

  it.live("an unclaimed key maps to im_not_claimed (409, not retryable)", () =>
    Effect.gen(function* () {
      const http = stubHttp((req) =>
        json({ success: false, code: "im_not_claimed", message: "im identity not claimed for this key" }, 409),
      )
      const error = yield* run(
        IMKernelExchange.exchange({ facadeURL: "http://facade.local", key: "sk-fresh" }),
        http,
      ).pipe(Effect.flip)
      expect(error).toBeInstanceOf(IMKernelExchange.ExchangeError)
      expect(error.code).toBe("im_not_claimed")
      expect(error.status).toBe(409)
      expect(error.retryable).toBe(false)
    }),
  )

  it.live("a kernel-down 503 maps to its business code and stays retryable", () =>
    Effect.gen(function* () {
      const http = stubHttp((req) =>
        json({ success: false, code: "im_unavailable", message: "im kernel not configured" }, 503),
      )
      const error = yield* run(
        IMKernelExchange.exchange({ facadeURL: "http://facade.local", key: "sk-alice" }),
        http,
      ).pipe(Effect.flip)
      expect(error.code).toBe("im_unavailable")
      expect(error.retryable).toBe(true)
    }),
  )

  it.live("a success envelope with a malformed payload fails closed as invalid_response", () =>
    Effect.gen(function* () {
      const http = stubHttp(() => json({ success: true, message: "", data: { kernel_token: 42 } }))
      const error = yield* run(
        IMKernelExchange.exchange({ facadeURL: "http://facade.local", key: "sk-alice" }),
        http,
      ).pipe(Effect.flip)
      expect(error.code).toBe("invalid_response")
      expect(error.retryable).toBe(false)
    }),
  )

  it.live("a refused connection maps to a retryable transport error (real transport)", () =>
    Effect.gen(function* () {
      const error = yield* IMKernelExchange.exchange({ facadeURL: "http://127.0.0.1:9", key: "sk-alice" }).pipe(
        Effect.flip,
        Effect.provide(FetchHttpClient.layer),
      )
      expect(error.code).toBe("transport_error")
      expect(error.retryable).toBe(true)
    }),
  )

  it.live("toKernelConfig maps the payload onto the kernel connection contract", () =>
    Effect.gen(function* () {
      const config = IMKernelExchange.toKernelConfig(payload)
      expect(config).toEqual({
        appkey: "appkey_1",
        navigator: "http://127.0.0.1:9002",
        token: "kt_1",
        userID: "uuid-alice",
        identity: { uuid: "uuid-alice", name: "alice", orgAllGroupID: "org7" },
      })
    }),
  )

  // ── B2 facade endpoints (rename/rebind/resolve/groups/invite) ────────────────────────────────

  it.live("rename posts the new name to /api/im/rename and unwraps the exchange payload", () =>
    Effect.gen(function* () {
      const seen: Array<{ url: string; body: unknown }> = []
      const http = HttpClient.make((req) =>
        Effect.gen(function* () {
          seen.push({ url: req.url, body: req.body as unknown })
          return HttpClientResponse.fromWeb(req, json({ success: true, message: "", data: payload }))
        }),
      )
      const result = yield* run(
        IMKernelExchange.rename({ facadeURL: "http://facade.local", key: "sk-alice", name: "alice2" }),
        http,
      )
      expect(seen[0].url).toBe("http://facade.local/api/im/rename")
      expect(result).toEqual(payload)
    }),
  )

  it.live("rebind posts new_key to /api/im/rebind", () =>
    Effect.gen(function* () {
      const seen: string[] = []
      const http = stubHttp((req) => {
        seen.push(req.url)
        return json({ success: true, message: "", data: payload })
      })
      yield* run(IMKernelExchange.rebind({ facadeURL: "http://facade.local", key: "sk-old", newKey: "sk-new" }), http)
      expect(seen).toEqual(["http://facade.local/api/im/rebind"])
    }),
  )

  it.live("resolve issues GET /api/im/resolve with the name as an encoded query param", () =>
    Effect.gen(function* () {
      const seen: Array<{ method: string; url: string }> = []
      const http = HttpClient.make((req) =>
        Effect.sync(() => {
          seen.push({ method: req.method, url: req.url })
          return HttpClientResponse.fromWeb(req, json({ success: true, message: "", data: { uuid: "uuid-bob", name: "bob" } }))
        }),
      )
      const result = yield* run(IMKernelExchange.resolve({ facadeURL: "http://facade.local", key: "sk-alice", name: "张伟" }), http)
      expect(seen).toEqual([{ method: "GET", url: `http://facade.local/api/im/resolve?name=${encodeURIComponent("张伟")}` }])
      expect(result).toEqual({ uuid: "uuid-bob", name: "bob" })
    }),
  )

  it.live("an unresolved name maps to im_not_found (404)", () =>
    Effect.gen(function* () {
      const http = stubHttp(() => json({ success: false, code: "im_not_found", message: "no such user" }, 404))
      const error = yield* run(IMKernelExchange.resolve({ facadeURL: "http://facade.local", key: "sk-alice", name: "nobody" }), http).pipe(
        Effect.flip,
      )
      expect(error.code).toBe("im_not_found")
      expect(error.status).toBe(404)
      expect(error.retryable).toBe(false)
    }),
  )

  it.live("createGroup posts member_names and decodes group_id + member_uuids", () =>
    Effect.gen(function* () {
      const seen: string[] = []
      const http = HttpClient.make((req) =>
        Effect.sync(() => {
          seen.push(req.url)
          // bodyJson 的请求体是 { _tag: "Uint8Array", body }——在假 client 边界直接解码断言。
          const body = req.body as { readonly body: Uint8Array }
          expect(JSON.parse(new TextDecoder().decode(body.body))).toEqual({ name: "设计群", member_names: ["bob", "carol"] })
          return HttpClientResponse.fromWeb(
            req,
            json({ success: true, message: "", data: { group_id: "g123", name: "设计群", member_uuids: ["u-bob", "u-carol"] } }),
          )
        }),
      )
      const result = yield* run(
        IMKernelExchange.createGroup({ facadeURL: "http://facade.local", key: "sk-alice", name: "设计群", memberNames: ["bob", "carol"] }),
        http,
      )
      expect(seen).toEqual(["http://facade.local/api/im/groups"])
      expect(result).toEqual({ group_id: "g123", name: "设计群", member_uuids: ["u-bob", "u-carol"] })
    }),
  )

  it.live("inviteToGroup posts group_id + name; an empty object payload decodes", () =>
    Effect.gen(function* () {
      const seen: string[] = []
      const http = stubHttp((req) => {
        seen.push(req.url)
        return json({ success: true, message: "", data: {} })
      })
      yield* run(IMKernelExchange.inviteToGroup({ facadeURL: "http://facade.local", key: "sk-alice", groupID: "g123", name: "bob" }), http)
      expect(seen).toEqual(["http://facade.local/api/im/groups/invite"])
    }),
  )

  it.live("a non-member invite maps to im_not_group_member (403)", () =>
    Effect.gen(function* () {
      const http = stubHttp(() => json({ success: false, code: "im_not_group_member", message: "not a group member" }, 403))
      const error = yield* run(
        IMKernelExchange.inviteToGroup({ facadeURL: "http://facade.local", key: "sk-alice", groupID: "g123", name: "bob" }),
        http,
      ).pipe(Effect.flip)
      expect(error.code).toBe("im_not_group_member")
      expect(error.status).toBe(403)
    }),
  )
})
