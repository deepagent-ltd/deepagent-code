import { Effect, Layer, Stream } from "effect"
import { Auth, LLMClient, RequestExecutor, WebSocketExecutor } from "../src/route"
import { LLM, Message } from "../src"
import { route as OpenAIChatRoute } from "../src/protocols/openai-compatible-chat"

// C7-03/C2-09 LIVE provider sentinel (user-authorized pause point, bounded): one turn = one
// physical call. The provider runtime (RequestExecutor.defaultLayer) issues REAL requests through
// the platform fetch; the sentinel counts wire requests at the fetch boundary (the runtime's own
// retry machinery would create additional requests — the count is the wire truth). Evidence:
// turn1_requests (must be 1 — a success turn never issues a hidden retry) and
// stream_abort_requests (an interrupted stream must not re-fire).
// Target: the user's LAN vLLM (http://10.17.28.98:8000/v1, apiKey EMPTY, openai-compatible Chat)
// — the same model family the harness runs on; no external paid key, nothing leaves the LAN.

import type { Service as LLMClientService } from "../src/route/client"

const runtimeLayer: Layer.Layer<LLMClientService> = LLMClient.layer.pipe(
  Layer.provide(Layer.mergeAll(RequestExecutor.defaultLayer, WebSocketExecutor.layer)),
)

const model = () =>
  OpenAIChatRoute.with({
    provider: "vllm-dcu",
    endpoint: { baseURL: "http://10.17.28.98:8000/v1" },
    auth: Auth.bearer("EMPTY"),
  }).model({ id: "deepseek-v4-flash-0731" })

let count = 0

const withCountingFetch = async <A>(body: () => Promise<A>): Promise<A> => {
  const original = globalThis.fetch
  globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
    count += 1
    return original(...args)
  }) as typeof fetch
  try {
    return await body()
  } finally {
    globalThis.fetch = original
  }
}

const sentinel: unknown = await withCountingFetch(async () => {
  const response = await Effect.runPromise(
    LLMClient.generate(
      LLM.request({ id: "req_live_sentinel_turn", model: model(), messages: [Message.user("Reply with exactly: OK")] }),
    ).pipe(Effect.provide(runtimeLayer)),
  )
  const turn1Requests = count
  count = 0

  await Effect.runPromise(
    LLMClient.stream(
      LLM.request({ id: "req_live_sentinel_stream", model: model(), messages: [Message.user("Count from 1 to 20, one number per line.")] }),
    )
      .pipe(Stream.runHead)
      .pipe(Effect.provide(runtimeLayer))
      .pipe(Effect.timeout("500 millis"))
      .pipe(Effect.ignore),
  )
  const streamAbortRequests = count

  return {
    target: "http://10.17.28.98:8000/v1 (vLLM DCU, openai-compatible Chat, apiKey EMPTY)",
    turn1_requests: turn1Requests,
    stream_abort_requests: streamAbortRequests,
    output_length: response.text?.length ?? 0,
    output_sample: (response.text ?? "").slice(0, 80),
  }
}).catch((error: unknown) => ({ error: String(error) }))

console.log(JSON.stringify({ sentinel: "C7-03 live one-turn-one-physical-call", ...(sentinel as object) }, null, 2))
if (sentinel !== null && typeof sentinel === "object" && "turn1_requests" in sentinel) {
  const evidence = sentinel as { turn1_requests: number; stream_abort_requests: number; output_length: number }
  const valid = evidence.turn1_requests === 1 && evidence.stream_abort_requests <= 1 && evidence.output_length > 0
  console.log(valid ? "SENTINEL OK: one turn = one physical call; interrupted stream did not re-fire." : "SENTINEL FAIL")
  process.exit(valid ? 0 : 1)
}
console.error("SENTINEL ERROR")
process.exit(1)
