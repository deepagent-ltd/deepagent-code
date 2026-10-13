import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { LLM } from "../src"
import { Auth } from "../src/route/auth"
import { LLMClient } from "../src/route/client"
import { RequestExecutor } from "../src/route/executor"
import { OpenAIResponses } from "../src/protocols/openai-responses"
import { testEffect } from "./lib/effect"

const it = testEffect(LLMClient.nativeManagedLayer.pipe(
  Layer.provide(RequestExecutor.defaultLayer),
  Layer.provide(Layer.succeed(LLMClient.Middleware, () => ({ prepare: (next) => next, stream: (next) => next }))),
))
for (const mode of ["success", "redirect", "429", "503", "partial", "oversize", "invalid", "copy", "replay", "cancel"] as const) {
  it.live(`real native count ${mode} retains one physical disclosure and gates generation`, () => Effect.gen(function* () {
    const client = yield* LLMClient.Service
    const seen: { path: string; body: string; authorization: string | null }[] = []
    const server = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch: async (request) => {
        const url = new URL(request.url)
        seen.push({ path: url.pathname, body: await request.text(), authorization: request.headers.get("authorization") })
        if (url.pathname === "/v1/responses") return new Response('data: {"type":"response.completed","response":{"id":"fixture"}}\n\n', { headers: { "content-type": "text/event-stream" } })
        if (mode === "redirect") return new Response(null, { status: 307, headers: { location: "/forbidden" } })
        if (mode === "429" || mode === "503") return new Response(null, { status: Number(mode) })
        if (mode === "cancel") return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"object":')); } }), { headers: { "content-type": "application/json" } })
        if (mode === "partial") return new Response('{"object":', { headers: { "content-type": "application/json" } })
        if (mode === "oversize") return new Response(" ".repeat(16_385), { headers: { "content-type": "application/json" } })
        return Response.json({ object: "response.input_tokens", input_tokens: mode === "invalid" ? 1.5 : 41 })
      },
    })
    yield* Effect.addFinalizer(() => Effect.promise(() => server.stop(true)))
    const request = LLM.request({
      model: OpenAIResponses.route.with({ endpoint: { baseURL: `${server.url.origin}/v1` }, auth: Auth.value("private-count-fixture").bearer() }).model({ id: "fixture-model" }),
      system: "fixed instructions", prompt: "有界正文", generation: { maxTokens: 16 }, providerOptions: { openai: { store: false } },
    })
    yield* LLMClient.bindNativeRequest(client, request)
    const result = yield* client.generate(request).pipe(
      Effect.provideService(RequestExecutor.CurrentRetryLimit, 0),
      Effect.provideService(RequestExecutor.CurrentRedirectPolicy, "manual"),
      Effect.provideService(RequestExecutor.CurrentRequestSeal, { seal: (observation) => Effect.gen(function* () {
        const count = yield* LLMClient.countNativeInput(client, request, mode === "copy" ? { ...observation } : observation, Date.now() + (mode === "cancel" ? 50 : 5_000))
        expect(count.inputTokens).toBe(41)
        expect(count.responseHash).toMatch(/^[0-9a-f]{64}$/)
        if (mode === "replay") yield* LLMClient.countNativeInput(client, request, observation, Date.now() + 5_000)
      }).pipe(Effect.orDie) }),
      Effect.exit,
    )
    expect(result._tag).toBe(mode === "success" ? "Success" : "Failure")
    expect(seen.map((entry) => entry.path)).toEqual(mode === "copy" ? [] : mode === "success" ? ["/v1/responses/input_tokens", "/v1/responses"] : ["/v1/responses/input_tokens"])
    if (mode === "success") {
      expect(JSON.parse(seen[0]!.body)).toEqual({ model: JSON.parse(seen[1]!.body).model, input: JSON.parse(seen[1]!.body).input })
      expect(seen[0]!.authorization).toBe(seen[1]!.authorization)
      expect(seen[0]!.authorization).toBe("Bearer private-count-fixture")
    }
  }))
}
