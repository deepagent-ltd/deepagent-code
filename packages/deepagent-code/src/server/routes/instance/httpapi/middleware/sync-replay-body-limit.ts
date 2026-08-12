import { Effect, FileSystem, Stream } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { SyncPaths, SyncReplayLimits } from "../groups/sync"

const bodyLimitExceeded = Symbol("sync-replay-body-limit-exceeded")

export const syncReplayBodyLimitLayer = HttpRouter.middleware<{ handles: unknown }>()((effect) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    if (request.method !== "POST" || pathOf(request.url) !== SyncPaths.replay) return yield* effect

    const contentLength = Number(request.headers["content-length"])
    if (Number.isFinite(contentLength) && contentLength > SyncReplayLimits.requestBytes)
      return HttpServerResponse.empty({ status: 413 })

    const buffered = yield* (
      request.source instanceof Request
        ? bufferWebBody(request.source)
        : request.text.pipe(
            Effect.provideService(HttpServerRequest.MaxBodySize, FileSystem.Size(SyncReplayLimits.requestBytes)),
            Effect.map((body) => new TextEncoder().encode(body)),
            Effect.catch(() => Effect.succeed(undefined)),
          )
    )
    if (!buffered) return HttpServerResponse.empty({ status: 413 })
    return yield* effect.pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromWeb(
          new Request(new URL(request.url, "http://localhost"), {
            method: request.method,
            headers: request.headers,
            body: buffered,
          }),
        ),
      ),
    )
  }),
).layer

function pathOf(url: string) {
  const queryIndex = url.indexOf("?")
  const hashIndex = url.indexOf("#")
  const end = queryIndex === -1 ? hashIndex : hashIndex === -1 ? queryIndex : Math.min(queryIndex, hashIndex)
  return end === -1 ? url : url.slice(0, end)
}

function bufferWebBody(request: Request) {
  if (!request.body) return Effect.succeed(new Uint8Array())
  return Stream.fromReadableStream({
    evaluate: () => request.body!,
    onError: (cause) => cause,
  }).pipe(
    Stream.runFoldEffect(
      () => ({ chunks: [] as Uint8Array[], bytes: 0 }),
      (result, chunk) => {
        const bytes = result.bytes + chunk.byteLength
        if (bytes > SyncReplayLimits.requestBytes) return Effect.fail(bodyLimitExceeded)
        result.chunks.push(chunk)
        return Effect.succeed({ chunks: result.chunks, bytes })
      },
    ),
    Effect.map((result) => Buffer.concat(result.chunks, result.bytes)),
    Effect.catch((error) => (error === bodyLimitExceeded ? Effect.succeed(undefined) : Effect.die(error))),
  )
}
