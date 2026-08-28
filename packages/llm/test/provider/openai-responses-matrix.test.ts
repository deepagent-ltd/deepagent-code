import { describe, expect } from "bun:test"
import { Effect, Layer, Ref } from "effect"
import { HttpClientRequest } from "effect/unstable/http"
import { LLM, LLMError, Message, ToolCallPart } from "../../src"
import { Auth, LLMClient, RequestExecutor } from "../../src/route"
import * as OpenAIResponses from "../../src/protocols/openai-responses"
import { it } from "../lib/effect"
import { dynamicResponse } from "../lib/http"
import { sseEvents, sseRaw } from "../lib/sse"

/**
 * C2-06 — canonical OpenAI Responses deterministic matrix. A fake server asserts
 * the real wire behavior of the Responses adapter: exactly one physical request
 * per turn (no duplicate dispatch), the /responses route + method + payload
 * shape, structured-output / tool lowering, and the typed outcomes for a
 * malformed payload and a mid-stream interruption (断流). No network, no keys.
 */

const model = OpenAIResponses.route
  .with({ endpoint: { baseURL: "https://api.openai.test/v1/" }, auth: Auth.bearer("test") })
  .model({ id: "gpt-4.1-mini" })

const request = LLM.request({
  id: "req_matrix",
  model,
  system: "You are concise.",
  prompt: "Say hello.",
  generation: { maxTokens: 20, temperature: 0 },
})

const count = () => Ref.make(0)

const noRetry = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.provideService(effect, RequestExecutor.CurrentRetryLimit, 0)

describe("C2-06 canonical OpenAI Responses deterministic matrix", () => {
  it.effect("dispatches exactly one physical request through the /responses route", () =>
    Effect.gen(function* () {
      const calls = yield* count()
      const outcome = yield* noRetry(
        LLMClient.generate(request).pipe(
          Effect.provide(
            dynamicResponse((input) =>
              Effect.gen(function* () {
                const n = yield* Ref.getAndUpdate(calls, (c) => c + 1)
                // First (and only) request: zero prior calls.
                expect(n).toBe(0)
                const web = yield* HttpClientRequest.toWeb(input.request).pipe(Effect.orDie)
                expect(web.method).toBe("POST")
                expect(web.url).toBe("https://api.openai.test/v1/responses")
                const body = (yield* Effect.promise(() => web.json())) as Record<string, unknown>
                expect(body.model).toBe("gpt-4.1-mini")
                expect(body.stream).toBe(true)
                expect(body.input).toEqual([
                  { role: "system", content: "You are concise." },
                  { role: "user", content: [{ type: "input_text", text: "Say hello." }] },
                ])
                return input.respond(
                  sseEvents(
                    { type: "response.output_text.delta", item_id: "msg_1", delta: "Hello" },
                    { type: "response.completed", response: { id: "resp_1" } },
                  ),
                  { headers: { "content-type": "text/event-stream" } },
                )
              }),
            ),
          ),
        ),
      )
      expect(outcome.text).toBe("Hello")
      expect(yield* Ref.get(calls)).toBe(1)
    }),
  )

  it.effect("lowers wire-level json_schema structured output on the request", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.updateRequest(request, {
          responseFormat: {
            type: "json",
            name: "answer_format",
            schema: { type: "object", properties: { ok: { type: "boolean" } } },
          },
        }),
      )
      expect(prepared.body.text?.format).toEqual({
        type: "json_schema",
        name: "answer_format",
        schema: { type: "object", properties: { ok: { type: "boolean" } } },
      })
    }),
  )

  it.effect("assembles function calls and tool results as Responses items on the wire", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIResponses.OpenAIResponsesBody>(
        LLM.request({
          model,
          messages: [
            Message.user("What is the weather?"),
            Message.assistant([ToolCallPart.make({ id: "call_1", name: "lookup", input: { query: "weather" } })]),
            Message.tool({ id: "call_1", name: "lookup", result: { forecast: "sunny" } }),
          ],
        }),
      )
      expect(prepared.body.input).toEqual([
        { role: "user", content: [{ type: "input_text", text: "What is the weather?" }] },
        { type: "function_call", call_id: "call_1", name: "lookup", arguments: '{"query":"weather"}' },
        { type: "function_call_output", call_id: "call_1", output: '{"forecast":"sunny"}' },
      ])
    }),
  )

  it.effect("maps a malformed provider payload to a typed InvalidProviderOutput with no retry storm", () =>
    Effect.gen(function* () {
      const calls = yield* count()
      const failure = yield* noRetry(
        LLMClient.generate(request).pipe(
          Effect.provide(
            dynamicResponse((input) =>
              Effect.gen(function* () {
                const n = yield* Ref.getAndUpdate(calls, (c) => c + 1)
                expect(n).toBe(0)
                // Malformed SSE: a data line the parser cannot decode into a known event.
                return input.respond(sseRaw("data: not-a-known-event"), {
                  headers: { "content-type": "text/event-stream" },
                })
              }),
            ),
          ),
        ),
      ).pipe(Effect.flip)
      expect(failure).toBeInstanceOf(LLMError)
      expect((failure as LLMError).reason._tag).toBe("InvalidProviderOutput")
      expect(yield* Ref.get(calls)).toBe(1)
    }),
  )

  it.effect("maps a mid-stream reset (断流) to a typed non-retryable failure, never a success receipt", () =>
    Effect.gen(function* () {
      const failure = yield* noRetry(
        LLMClient.generate(request).pipe(
          Effect.provide(
            dynamicResponse((input) =>
              Effect.sync(() => {
                const encoder = new TextEncoder()
                const stream = new ReadableStream({
                  start(controller) {
                    controller.enqueue(
                      encoder.encode(
                        `data: ${JSON.stringify({ type: "response.output_text.delta", item_id: "msg_1", delta: "Part" })}\n\n`,
                      ),
                    )
                    controller.error(new Error("connection reset"))
                  },
                })
                return input.respond(stream, { headers: { "content-type": "text/event-stream" } })
              }),
            ),
          ),
        ),
      ).pipe(Effect.flip)
      expect(failure).toBeInstanceOf(LLMError)
      // A mid-stream reset is post-dispatch: never auto-retried, surfaced as a failure — the caller
      // must decide (the runner quarantines as indeterminate_after_crash), never a fabricated finish.
      expect((failure as LLMError).retryable).toBe(false)
    }),
  )
})
