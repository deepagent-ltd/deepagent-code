import { Effect, Layer, Ref } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { LLMClient, RequestExecutor, WebSocketExecutor } from "@deepagent-code/llm/route"

// Ported from packages/llm/test/lib/http.ts for core's DeepAgent control-plane tests (the gateway
// now lives in core). Uses the public @deepagent-code/llm/route subpath instead of llm-internal
// paths; the runtime env type is derived from the layer to avoid deep type-only imports.

export type HandlerInput = {
  readonly request: HttpClientRequest.HttpClientRequest
  readonly text: string
  readonly respond: (
    body: ConstructorParameters<typeof Response>[0],
    init?: ResponseInit,
  ) => HttpClientResponse.HttpClientResponse
}

export type Handler = (input: HandlerInput) => Effect.Effect<HttpClientResponse.HttpClientResponse>

const handlerLayer = (handler: Handler): Layer.Layer<HttpClient.HttpClient> =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.gen(function* () {
        const web = yield* HttpClientRequest.toWeb(request).pipe(Effect.orDie)
        const text = yield* Effect.promise(() => web.text())
        return yield* handler({
          request,
          text,
          respond: (body, init) => HttpClientResponse.fromWeb(request, new Response(body, init)),
        })
      }),
    ),
  )

export const runtimeLayer = (layer: Layer.Layer<HttpClient.HttpClient>) => {
  const requestExecutorLayer = RequestExecutor.layer.pipe(Layer.provide(layer))
  const deps = Layer.mergeAll(requestExecutorLayer, WebSocketExecutor.layer)
  const llmClientLayer = LLMClient.layer.pipe(Layer.provide(deps))
  return Layer.mergeAll(deps, llmClientLayer)
}

const SSE_HEADERS = { "content-type": "text/event-stream" } as const

export const fixedResponse = (
  body: ConstructorParameters<typeof Response>[0],
  init: ResponseInit = { headers: SSE_HEADERS },
) => runtimeLayer(handlerLayer((input) => Effect.succeed(input.respond(body, init))))

export const dynamicResponse = (handler: Handler) => runtimeLayer(handlerLayer(handler))

export const truncatedStream = (chunks: ReadonlyArray<string>) =>
  dynamicResponse((input) =>
    Effect.sync(() => {
      const encoder = new TextEncoder()
      const stream = new ReadableStream({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
          controller.error(new Error("connection reset"))
        },
      })
      return input.respond(stream, { headers: SSE_HEADERS })
    }),
  )

export const scriptedResponses = (bodies: ReadonlyArray<string>, init: ResponseInit = { headers: SSE_HEADERS }) => {
  if (bodies.length === 0) throw new Error("scriptedResponses requires at least one body")
  return Layer.unwrap(
    Effect.gen(function* () {
      const cursor = yield* Ref.make(0)
      return dynamicResponse((input) =>
        Effect.gen(function* () {
          const index = yield* Ref.getAndUpdate(cursor, (n) => n + 1)
          return input.respond(bodies[index] ?? bodies[bodies.length - 1], init)
        }),
      )
    }),
  )
}
