import { describe, expect } from "bun:test"
import { Cause, ConfigProvider, Deferred, Effect, Fiber, Layer, Redacted } from "effect"
import { createServer } from "node:http"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { RequestExecutor } from "../src/route/executor"
import { LLM, LLMError } from "../src"
import { LLMClient } from "../src/route/client"
import { Auth } from "../src/route/auth"
import { OpenAIResponses } from "../src/protocols/openai-responses"
import { it } from "./lib/effect"

const boundaryLayer = RequestExecutor.nativeSealedLayer
const native = <A, E, R>(effect: Effect.Effect<A, E, R | RequestExecutor.Service>) =>
  effect.pipe(
    Effect.provideService(RequestExecutor.CurrentRetryLimit, 0),
    Effect.provideService(RequestExecutor.CurrentRedirectPolicy, "manual"),
    Effect.provide(boundaryLayer),
  )
const listener = (fetch: (request: Request) => Response | Promise<Response>) =>
  Effect.acquireRelease(
    Effect.sync(() => Bun.serve({ hostname: "127.0.0.1", port: 0, fetch })),
    (server) => Effect.promise(() => server.stop(true)),
  )

describe("native HTTP observation boundary", () => {
  it.live("rejects post-seal RequestInit headers before any HTTP body", () =>
    Effect.gen(function* () {
      const hits: string[] = []
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: async (request) => {
          hits.push(request.headers.get("openai-project") ?? "")
          await request.text()
          return new Response("ok")
        },
      })
      yield* Effect.addFinalizer(() => Effect.promise(() => server.stop(true)))
      yield* Effect.gen(function* () {
        const executor = yield* RequestExecutor.Service
        yield* executor
          .execute(HttpClientRequest.post(server.url.href).pipe(HttpClientRequest.bodyText("audit", "text/plain")))
          .pipe(Effect.exit)
      }).pipe(
        Effect.provideService(RequestExecutor.CurrentRequestSeal, { seal: () => Effect.void }),
        Effect.provideService(RequestExecutor.CurrentRetryLimit, 0),
        Effect.provideService(RequestExecutor.CurrentRedirectPolicy, "manual"),
        Effect.provideService(FetchHttpClient.RequestInit, { headers: { "openai-project": "unapproved-project" } }),
        Effect.provide(boundaryLayer),
      )
      expect(hits).toEqual([])
    }),
  )

  it.live("rejects an injected Fetch implementation before the alternate target", () =>
    Effect.gen(function* () {
      const hits: string[] = []
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: async (request) => {
          hits.push(await request.text())
          return new Response("ok")
        },
      })
      yield* Effect.addFinalizer(() => Effect.promise(() => server.stop(true)))
      const nativeFetch = globalThis.fetch
      yield* Effect.gen(function* () {
        const executor = yield* RequestExecutor.Service
        yield* executor
          .execute(HttpClientRequest.post("http://127.0.0.1:1/unreachable").pipe(HttpClientRequest.bodyText("audit")))
          .pipe(Effect.exit)
      }).pipe(
        Effect.provideService(RequestExecutor.CurrentRequestSeal, { seal: () => Effect.void }),
        Effect.provideService(RequestExecutor.CurrentRetryLimit, 0),
        Effect.provideService(RequestExecutor.CurrentRedirectPolicy, "manual"),
        Effect.provideService(
          FetchHttpClient.Fetch,
          Object.assign((_input: string | URL | Request, options?: RequestInit) => nativeFetch(server.url, options), {
            preconnect: nativeFetch.preconnect,
          }),
        ),
        Effect.provide(boundaryLayer),
      )
      expect(hits).toEqual([])
    }),
  )

  it.live("observes actual Auth and HTTP overlays, but exposes no structural native credential", () =>
    Effect.gen(function* () {
      const received: { body: string; auth: string | null; project: string | null; extra: string | null }[] = []
      const observed: RequestExecutor.RequestSealInput[] = []
      const server = yield* listener(async (request) => {
        received.push({
          body: await request.text(),
          auth: request.headers.get("authorization"),
          project: request.headers.get("openai-project"),
          extra: request.headers.get("x-audit"),
        })
        return new Response('data: {"type":"response.completed","response":{"id":"fixture"}}\n\n', {
          headers: { "content-type": "text/event-stream" },
        })
      })
      const model = OpenAIResponses.route
        .with({
          endpoint: { baseURL: server.url.href.slice(0, -1) },
          auth: Auth.config("FIXTURE_NATIVE_KEY").bearer(),
          headers: { "openai-project": "initial-project" },
        })
        .model({ id: "fixture-model" })
      yield* LLMClient.generate(
        LLM.request({
          model,
          system: "Static instructions",
          prompt: "Audited text",
          generation: { maxTokens: 16 },
          http: { headers: { "openai-project": "approved-project", "x-audit": "  visible\t" }, body: { store: false } },
        }),
      ).pipe(
        Effect.provideService(RequestExecutor.CurrentRequestSeal, {
          seal: (input) =>
            Effect.sync(() => {
              observed.push(input)
            }),
        }),
        Effect.provide(LLMClient.layer),
        native,
        Effect.provide(
          ConfigProvider.layer(ConfigProvider.fromEnv({ env: { FIXTURE_NATIVE_KEY: "fixture-native-secret" } })),
        ),
      )
      expect(received).toHaveLength(1)
      expect(observed).toHaveLength(1)
      const observation = observed[0]!
      expect(RequestExecutor.isNativeObservation(observation)).toBe(true)
      expect(RequestExecutor.isNativeObservation({ ...observation })).toBe(false)
      expect(RequestExecutor.isNativeObservation(JSON.parse(JSON.stringify(observation)))).toBe(false)
      expect(Object.isFrozen(observation)).toBe(true)
      expect(observation.headers).toBeDefined()
      if (!observation.headers) return yield* Effect.die("Missing native headers")
      if (observation.bodyText === undefined) return yield* Effect.die("Missing native body")
      const headers = Redacted.value(observation.headers)
      expect(Object.isFrozen(headers)).toBe(true)
      expect(headers.authorization).toBe("Bearer fixture-native-secret")
      expect(headers["openai-project"]).toBe("approved-project")
      expect(headers["x-audit"]).toBe("visible")
      expect(headers["content-length"]).toBeUndefined()
      expect(headers.host).toBeUndefined()
      expect(headers["user-agent"]).toBeUndefined()
      expect(received[0]).toEqual({
        body: observation.bodyText,
        auth: headers.authorization ?? null,
        project: headers["openai-project"] ?? null,
        extra: headers["x-audit"] ?? null,
      })
      expect(JSON.parse(received[0]!.body).store).toBe(false)
      expect(JSON.stringify(observation)).not.toContain("fixture-native-secret")
      expect(Bun.inspect(observation)).not.toContain("fixture-native-secret")
    }),
  )

  it.live("sends an immutable snapshot when the caller mutates its byte and header aliases during seal", () =>
    Effect.gen(function* () {
      const received: { body: string; auth: string | null }[] = []
      const server = yield* listener(async (request) => {
        received.push({ body: await request.text(), auth: request.headers.get("authorization") })
        return new Response("ok")
      })
      const bytes = new TextEncoder().encode('{"audit":"原始"}')
      const request = HttpClientRequest.post(server.url.href).pipe(
        HttpClientRequest.bodyUint8Array(bytes, "application/json"),
        HttpClientRequest.setHeader("authorization", "Bearer original-fixture-secret"),
      )
      yield* Effect.gen(function* () {
        const executor = yield* RequestExecutor.Service
        expect((yield* executor.execute(request)).status).toBe(200)
      }).pipe(
        Effect.provideService(RequestExecutor.CurrentRequestSeal, {
          seal: (input) =>
            Effect.gen(function* () {
              if (!input.headers) return yield* Effect.die("Missing native headers")
              expect(Reflect.set(Redacted.value(input.headers), "authorization", "mutated")).toBe(false)
              expect(Reflect.set(input, "bodyText", "mutated")).toBe(false)
              bytes.fill(88)
              Reflect.set(request.headers, "authorization", "Bearer mutated")
              yield* Effect.yieldNow
              expect(input.bodyText).toBe('{"audit":"原始"}')
            }),
        }),
        native,
      )
      expect(received).toEqual([{ body: '{"audit":"原始"}', auth: "Bearer original-fixture-secret" }])
    }),
  )

  it.live("ordinary injection still works; native execution never uses the injected HttpClient", () =>
    Effect.gen(function* () {
      const hits = { original: 0, alternate: 0 }
      const observations: boolean[] = []
      const original = yield* listener(() => {
        hits.original++
        return new Response("original")
      })
      const alternate = yield* listener(() => {
        hits.alternate++
        return new Response("alternate")
      })
      const injected = Layer.effect(
        HttpClient.HttpClient,
        Effect.gen(function* () {
          return (yield* HttpClient.HttpClient).pipe(
            HttpClient.mapRequest((request) => HttpClientRequest.setUrl(request, alternate.url.href)),
          )
        }),
      ).pipe(Layer.provide(FetchHttpClient.layer))
      const execute = Effect.gen(function* () {
        return yield* (yield* RequestExecutor.Service).execute(
          HttpClientRequest.post(original.url.href).pipe(HttpClientRequest.bodyText("audit")),
        )
      }).pipe(
        Effect.provideService(RequestExecutor.CurrentRequestSeal, {
          seal: (input) =>
            Effect.sync(() => {
              expect(input.url).toBe(original.url.href)
              observations.push(RequestExecutor.isNativeObservation(input))
            }),
        }),
      )
      yield* execute.pipe(Effect.provide(RequestExecutor.layer.pipe(Layer.provide(injected))))
      expect(hits).toEqual({ original: 0, alternate: 1 })
      yield* execute.pipe(native, Effect.provide(injected))
      expect(hits).toEqual({ original: 1, alternate: 1 })
      expect(observations).toEqual([false, true])
    }),
  )

  it.live("fails closed without seal, retry zero, or manual redirects", () =>
    Effect.gen(function* () {
      const hits: string[] = []
      const server = yield* listener(async (request) => {
        hits.push(await request.text())
        return new Response("ok")
      })
      const execute = Effect.gen(function* () {
        return yield* (yield* RequestExecutor.Service)
          .execute(HttpClientRequest.post(server.url.href).pipe(HttpClientRequest.bodyText("audit")))
          .pipe(Effect.exit)
      })
      expect((yield* execute.pipe(native))._tag).toBe("Failure")
      expect(
        (yield* execute.pipe(
          Effect.provideService(RequestExecutor.CurrentRequestSeal, { seal: () => Effect.void }),
          Effect.provideService(RequestExecutor.CurrentRedirectPolicy, "manual"),
          Effect.provide(boundaryLayer),
        ))._tag,
      ).toBe("Failure")
      expect(
        (yield* execute.pipe(
          Effect.provideService(RequestExecutor.CurrentRequestSeal, { seal: () => Effect.void }),
          Effect.provideService(RequestExecutor.CurrentRetryLimit, 0),
          Effect.provide(boundaryLayer),
        ))._tag,
      ).toBe("Failure")
      expect(hits).toEqual([])
    }),
  )

  it.live("cancels a suspended seal in its owning fiber without dispatch", () =>
    Effect.gen(function* () {
      const hits: string[] = []
      const entered = yield* Deferred.make<void>()
      const server = yield* listener(async (request) => {
        hits.push(await request.text())
        return new Response("ok")
      })
      yield* Effect.gen(function* () {
        const executor = yield* RequestExecutor.Service
        const fiber = yield* executor
          .execute(HttpClientRequest.post(server.url.href).pipe(HttpClientRequest.bodyText("audit")))
          .pipe(Effect.forkChild)
        yield* Deferred.await(entered)
        yield* Fiber.interrupt(fiber)
      }).pipe(
        Effect.provideService(RequestExecutor.CurrentRequestSeal, {
          seal: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
        }),
        native,
      )
      expect(hits).toEqual([])
    }),
  )

  it.live("seal rejection has no physical request", () =>
    Effect.gen(function* () {
      const hits: string[] = []
      const server = yield* listener(async (request) => {
        hits.push(await request.text())
        return new Response("ok")
      })
      const exit = yield* Effect.gen(function* () {
        return yield* (yield* RequestExecutor.Service).execute(
          HttpClientRequest.post(server.url.href).pipe(HttpClientRequest.bodyText("audit")),
        )
      }).pipe(
        Effect.provideService(RequestExecutor.CurrentRequestSeal, {
          seal: () => Effect.die("fixture seal refused"),
        }),
        native,
        Effect.exit,
      )
      expect(exit._tag).toBe("Failure")
      expect(hits).toEqual([])
    }),
  )

  it.live("does not follow a real 307", () =>
    Effect.gen(function* () {
      const hits = { origin: 0, sink: 0 }
      const sink = yield* listener(() => {
        hits.sink++
        return new Response("sink")
      })
      const origin = yield* listener(() => {
        hits.origin++
        return new Response("redirect", { status: 307, headers: { location: sink.url.href } })
      })
      yield* Effect.gen(function* () {
        const response = yield* (yield* RequestExecutor.Service).execute(
          HttpClientRequest.post(origin.url.href).pipe(HttpClientRequest.bodyText("audit")),
        )
        expect(response.status).toBe(307)
      }).pipe(Effect.provideService(RequestExecutor.CurrentRequestSeal, { seal: () => Effect.void }), native)
      expect(hits).toEqual({ origin: 1, sink: 0 })
    }),
  )
  ;[429, 500].forEach((status) =>
    it.live(`does not retry ${status} or reflect credential echoes in error/Cause`, () =>
      Effect.gen(function* () {
        const hits: string[] = []
        const server = yield* listener(async (request) => {
          hits.push(await request.text())
          return new Response(request.headers.get("authorization"), {
            status,
            headers: {
              "x-request-id": "fixture-secret-echo",
              "x-echo": "Bearer fixture-secret-echo",
              "retry-after-ms": "0",
            },
          })
        })
        const exit = yield* Effect.gen(function* () {
          return yield* (yield* RequestExecutor.Service).execute(
            HttpClientRequest.post(server.url.href).pipe(
              HttpClientRequest.bodyText("audit"),
              HttpClientRequest.setHeader("authorization", "Bearer fixture-secret-echo"),
            ),
          )
        }).pipe(
          Effect.provideService(RequestExecutor.CurrentRequestSeal, { seal: () => Effect.void }),
          native,
          Effect.exit,
        )
        expect(hits).toEqual(["audit"])
        expect(exit._tag).toBe("Failure")
        if (exit._tag !== "Failure") return yield* Effect.die("Expected failure")
        expect(Cause.pretty(exit.cause)).not.toContain("fixture-secret-echo")
        expect(JSON.stringify(exit)).not.toContain("fixture-secret-echo")
        expect(Bun.inspect(exit)).not.toContain("fixture-secret-echo")
        const errors = exit.cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error)
        expect(errors[0]).toBeInstanceOf(LLMError)
      }),
    ),
  )

  it.live("does not retry a real connection drop or expose the original request in Cause", () =>
    Effect.gen(function* () {
      const hits: string[] = []
      const server = createServer((request, response) => {
        const chunks: Buffer[] = []
        request.on("data", (chunk: Buffer) => chunks.push(chunk))
        request.on("end", () => {
          hits.push(Buffer.concat(chunks).toString())
          response.destroy()
        })
      })
      yield* Effect.promise(() => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)))
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
      )
      const address = server.address()
      if (!address || typeof address === "string") return yield* Effect.die("No fixture socket")
      const exit = yield* Effect.gen(function* () {
        return yield* (yield* RequestExecutor.Service).execute(
          HttpClientRequest.post(`http://127.0.0.1:${address.port}`).pipe(
            HttpClientRequest.bodyText("audit"),
            HttpClientRequest.setHeader("authorization", "Bearer fixture-drop-secret"),
          ),
        )
      }).pipe(
        Effect.provideService(RequestExecutor.CurrentRequestSeal, { seal: () => Effect.void }),
        native,
        Effect.exit,
      )
      expect(exit._tag).toBe("Failure")
      expect(hits).toEqual(["audit"])
      if (exit._tag !== "Failure") return yield* Effect.die("Expected failure")
      expect(Cause.pretty(exit.cause)).not.toContain("fixture-drop-secret")
      expect(JSON.stringify(exit)).not.toContain("fixture-drop-secret")
      expect(Bun.inspect(exit)).not.toContain("fixture-drop-secret")
    }),
  )

  it.live("rejects non-round-trippable bytes, missing bodies and invalid headers before seal or HTTP", () =>
    Effect.gen(function* () {
      const hits: string[] = []
      const seals: string[] = []
      const server = yield* listener(async (request) => {
        hits.push(await request.text())
        return new Response("ok")
      })
      yield* Effect.gen(function* () {
        const executor = yield* RequestExecutor.Service
        expect(
          (yield* executor
            .execute(
              HttpClientRequest.post(server.url.href).pipe(HttpClientRequest.bodyUint8Array(new Uint8Array([0xff]))),
            )
            .pipe(Effect.exit))._tag,
        ).toBe("Failure")
        expect((yield* executor.execute(HttpClientRequest.post(server.url.href)).pipe(Effect.exit))._tag).toBe(
          "Failure",
        )
        expect(
          (yield* executor
            .execute(
              HttpClientRequest.post(server.url.href).pipe(
                HttpClientRequest.bodyUint8Array(new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d])),
              ),
            )
            .pipe(Effect.exit))._tag,
        ).toBe("Failure")
        const invalid = yield* executor
          .execute(
            HttpClientRequest.post(server.url.href).pipe(
              HttpClientRequest.bodyText("audit"),
              HttpClientRequest.setHeader("x-invalid", "fixture-invalid-header-secret\r\nInjected: value"),
            ),
          )
          .pipe(Effect.exit)
        expect(invalid._tag).toBe("Failure")
        expect(JSON.stringify(invalid)).not.toContain("fixture-invalid-header-secret")
      }).pipe(
        Effect.provideService(RequestExecutor.CurrentRequestSeal, {
          seal: () =>
            Effect.sync(() => {
              seals.push("seal")
            }),
        }),
        native,
      )
      expect(hits).toEqual([])
      expect(seals).toEqual([])
    }),
  )
})
