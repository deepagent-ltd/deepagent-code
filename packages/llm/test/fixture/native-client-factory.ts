import { expect } from "bun:test"
import { Context, Effect, Exit, Layer, Redacted, Scope } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { LLM } from "../../src"
import { Auth } from "../../src/route/auth"
import { LLMClient } from "../../src/route/client"
import { RequestExecutor } from "../../src/route/executor"
import { OpenAIResponses } from "../../src/protocols/openai-responses"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const cases = new Map<string, () => Effect.Effect<unknown, unknown, Scope.Scope>>()

const factory = LLMClient.nativeManagedLayer.pipe(
  Layer.provide(RequestExecutor.defaultLayer),
  Layer.provide(Layer.succeed(LLMClient.Middleware, () => ({ prepare: (next) => next, stream: (next) => next }))),
)
const body = 'data: {"type":"response.completed","response":{"id":"fixture"}}\n\n'
const policy = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provideService(RequestExecutor.CurrentRetryLimit, 0),
    Effect.provideService(RequestExecutor.CurrentRedirectPolicy, "manual"),
  )
const model = (url: string) =>
  OpenAIResponses.route
    .with({
      endpoint: { baseURL: url.slice(0, -1) },
      auth: Auth.value("fixture-only-key").bearer(),
    })
    .model({ id: "fixture-snapshot" })

cases.set(
  "builtin factory crosses a real pre-existing global wrapper and binds final auth/body to exact client/request",
  () =>
    Effect.gen(function* () {
      const original = globalThis.fetch
      const hits: { body: string; auth: string | null }[] = []
      const calls = { wrapper: 0 }
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: async (request) => {
          hits.push({ body: await request.text(), auth: request.headers.get("authorization") })
          return new Response(body, { headers: { "content-type": "text/event-stream" } })
        },
      })
      globalThis.fetch = Object.assign(
        (input: string | Request | URL, init?: RequestInit) => {
          calls.wrapper++
          return original(input, init)
        },
        { preconnect: original.preconnect },
      )
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          globalThis.fetch = original
          await server.stop(true)
        }),
      )
      yield* Effect.gen(function* () {
        const client = yield* LLMClient.Service
        const request = LLM.request({
          model: model(server.url.href),
          prompt: "实际中文",
          generation: { maxTokens: 16 },
          http: { body: { store: false } },
        })
        yield* LLMClient.bindNativeRequest(client, request)
        const observations: RequestExecutor.RequestSealInput[] = []
        yield* client.generate(request).pipe(
          Effect.provideService(RequestExecutor.CurrentRequestSeal, {
            seal: (input) =>
              Effect.sync(() => {
                expect(LLMClient.observesNative(client, request, input)).toBe(true)
                expect(LLMClient.observesNative({ ...client }, request, input)).toBe(false)
                expect(LLMClient.observesNative(client, request, { ...input })).toBe(false)
                observations.push(input)
              }),
          }),
        )
        expect(calls.wrapper).toBe(0)
        expect(hits).toHaveLength(1)
        expect(hits[0]?.body ?? "").toBe(observations[0]?.bodyText ?? "")
        expect(hits[0]?.auth).toBe("Bearer fixture-only-key")
        expect(Redacted.value(observations[0]!.headers!).authorization ?? "").toBe(hits[0]!.auth ?? "")
        expect(JSON.parse(hits[0]!.body).store).toBe(false)
        expect((yield* client.generate(request).pipe(Effect.exit))._tag).toBe("Failure")
        expect(hits).toHaveLength(1)
        const ordinary = LLM.request({ model: request.model, prompt: "ordinary" })
        yield* client.generate(ordinary)
        expect(calls.wrapper).toBe(1)
        expect(hits).toHaveLength(2)
      }).pipe(Effect.provide(factory), policy)
    }),
)

cases.set("request capacity is bounded and scope close releases capacity without making an old request ordinary", () =>
  Effect.gen(function* () {
    const context = yield* Layer.build(factory)
    const client = Context.get(context, LLMClient.Service)
    const scope = yield* Scope.make()
    const requests = Array.from({ length: 32 }, () =>
      LLM.request({ model: model("http://127.0.0.1:1/"), prompt: "scope" }),
    )
    for (const request of requests)
      yield* LLMClient.bindNativeRequest(client, request).pipe(Effect.provideService(Scope.Scope, scope))
    expect(LLMClient.nativeDescription(client)?.liveRequests).toBe(32)
    expect(
      (yield* LLMClient.bindNativeRequest(client, LLM.request({ model: requests[0]!.model, prompt: "full" })).pipe(
        Effect.exit,
      ))._tag,
    ).toBe("Failure")
    yield* Scope.close(scope, Exit.void)
    expect(LLMClient.nativeDescription(client)?.liveRequests).toBe(0)
    expect((yield* client.generate(requests[0]!).pipe(Effect.exit))._tag).toBe("Failure")
    yield* LLMClient.bindNativeRequest(client, LLM.request({ model: requests[0]!.model, prompt: "released" }))
    expect(LLMClient.nativeDescription(client)?.liveRequests).toBe(1)
  }),
)

cases.set("real late environment drift and RequestInit override produce zero physical requests", () =>
  Effect.gen(function* () {
    const hits = { count: 0 }
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => {
        hits.count++
        return new Response(body)
      },
    })
    const prior = process.env.HTTPS_PROXY
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        if (prior === undefined) delete process.env.HTTPS_PROXY
        if (prior !== undefined) process.env.HTTPS_PROXY = prior
        await server.stop(true)
      }),
    )
    yield* Effect.gen(function* () {
      const client = yield* LLMClient.Service
      const request = LLM.request({ model: model(server.url.href), prompt: "guard" })
      yield* LLMClient.bindNativeRequest(client, request)
      expect(
        (yield* client.generate(request).pipe(
          Effect.provideService(RequestExecutor.CurrentRequestSeal, {
            seal: () =>
              Effect.sync(() => {
                process.env.HTTPS_PROXY = "http://127.0.0.1:1"
              }),
          }),
          Effect.exit,
        ))._tag,
      ).toBe("Failure")
      expect(hits.count).toBe(0)
    }).pipe(Effect.provide(factory), policy)
    if (prior === undefined) delete process.env.HTTPS_PROXY
    if (prior !== undefined) process.env.HTTPS_PROXY = prior
    yield* Effect.gen(function* () {
      const client = yield* LLMClient.Service
      const request = LLM.request({ model: model(server.url.href), prompt: "guard" })
      yield* LLMClient.bindNativeRequest(client, request)
      expect(
        (yield* client
          .generate(request)
          .pipe(
            Effect.provideService(RequestExecutor.CurrentRequestSeal, { seal: () => Effect.void }),
            Effect.provideService(FetchHttpClient.RequestInit, { headers: { authorization: "injected" } }),
            Effect.exit,
          ))._tag,
      ).toBe("Failure")
      expect(hits.count).toBe(0)
    }).pipe(Effect.provide(factory), policy)
  }),
)

cases.set(
  "builtin TLS verification rejects a real untrusted certificate with an insecure environment at factory construction",
  () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "dac-native-tls-")))
      const key = path.join(directory, "key.pem")
      const cert = path.join(directory, "cert.pem")
      const generated = Bun.spawnSync(
        [
          "openssl",
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-keyout",
          key,
          "-out",
          cert,
          "-days",
          "1",
          "-subj",
          "/CN=localhost",
          "-addext",
          "subjectAltName=DNS:localhost,IP:127.0.0.1",
        ],
        { stdout: "ignore", stderr: "pipe" },
      )
      expect(generated.exitCode).toBe(0)
      const hits = { count: 0 }
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        tls: { key: Bun.file(key), cert: Bun.file(cert) },
        fetch: () => {
          hits.count++
          return new Response(body, { headers: { "content-type": "text/event-stream" } })
        },
      })
      const prior = process.env.NODE_TLS_REJECT_UNAUTHORIZED
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          if (prior === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
          if (prior !== undefined) process.env.NODE_TLS_REJECT_UNAUTHORIZED = prior
          await server.stop(true)
          await fs.rm(directory, { recursive: true, force: true })
        }),
      )
      const ordinary = yield* Effect.promise(() => fetch(server.url, { tls: { rejectUnauthorized: false } }))
      yield* Effect.promise(() => ordinary.text())
      expect(hits.count).toBe(1)
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"
      yield* Effect.gen(function* () {
        const client = yield* LLMClient.Service
        const request = LLM.request({ model: model(server.url.href), prompt: "TLS" })
        yield* LLMClient.bindNativeRequest(client, request)
        const exit = yield* client
          .generate(request)
          .pipe(Effect.provideService(RequestExecutor.CurrentRequestSeal, { seal: () => Effect.void }), Effect.exit)
        expect(exit._tag).toBe("Failure")
        expect(hits.count).toBe(1)
      }).pipe(Effect.provide(factory), policy)
    }),
)

const selected = cases.get(process.argv[2] ?? "")
if (!selected) throw new Error("Unknown isolated native fixture")
await Effect.runPromise(selected().pipe(Effect.scoped))
console.info("NATIVE_FACTORY_ISOLATED_OK", process.argv[2])
