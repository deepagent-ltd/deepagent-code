import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { HttpClientRequest } from "effect/unstable/http"
import { LLM, Message, ToolCallPart } from "../../src"
import { Auth, LLMClient } from "../../src/route"
import { byProvider } from "../../src/providers/openai-compatible-profile"
import * as OpenAICompatibleResponses from "../../src/protocols/openai-compatible-responses"
import { it } from "../lib/effect"
import { dynamicResponse } from "../lib/http"
import { sseEvents } from "../lib/sse"

/**
 * C2-07 — DeepSeek compatible Responses matrix. A DeepSeek model whose config
 * declares the compatible Responses protocol must be routed to the compatible
 * `/responses` adapter (never a silent Chat fallback) and must carry tool calls,
 * tool results and reasoning items on the compatible wire.
 */

const model = OpenAICompatibleResponses.route
  .with({
    provider: "deepseek",
    endpoint: { baseURL: "https://api.deepseek.test/v1/" },
    auth: Auth.bearer("test-key"),
  })
  .model({ id: "deepseek-reasoner" })

describe("C2-07 DeepSeek compatible Responses matrix", () => {
  test("declares DeepSeek as the sole opt-in compatible Responses family", () => {
    expect(byProvider["deepseek"]?.supportsResponses).toBe(true)
    expect(byProvider["deepseek"]?.supportsResponsesCompact).toBe(true)
  })

  it.effect("posts tool calls + tool results to the compatible /responses endpoint (no Chat fallback)", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(
        LLM.request({
          id: "req_deepseek_tool",
          model,
          messages: [
            Message.user("What is the weather?"),
            Message.assistant([ToolCallPart.make({ id: "call_1", name: "lookup", input: { query: "weather" } })]),
            Message.tool({ id: "call_1", name: "lookup", result: { forecast: "sunny" } }),
          ],
        }),
      ).pipe(
        Effect.provide(
          dynamicResponse((input) =>
            Effect.gen(function* () {
              const web = yield* HttpClientRequest.toWeb(input.request).pipe(Effect.orDie)
              expect(web.url).toBe("https://api.deepseek.test/v1/responses")
              expect(web.method).toBe("POST")
              const body = (yield* Effect.promise(() => web.json())) as {
                input: ReadonlyArray<Record<string, unknown>>
              }
              // Compatible Responses wire: function_call / function_call_output items, never Chat.
              expect(body.input).toEqual([
                { role: "user", content: [{ type: "input_text", text: "What is the weather?" }] },
                { type: "function_call", call_id: "call_1", name: "lookup", arguments: '{"query":"weather"}' },
                { type: "function_call_output", call_id: "call_1", output: '{"forecast":"sunny"}' },
              ])
              return input.respond(
                sseEvents(
                  {
                    type: "response.output_item.added",
                    item: { type: "function_call", id: "item_1", call_id: "call_1", name: "lookup", arguments: "" },
                  },
                  { type: "response.function_call_arguments.delta", item_id: "item_1", delta: '{"query"' },
                  { type: "response.function_call_arguments.delta", item_id: "item_1", delta: ':"weather"}' },
                  {
                    type: "response.output_item.done",
                    item: {
                      type: "function_call",
                      id: "item_1",
                      call_id: "call_1",
                      name: "lookup",
                      arguments: '{"query":"weather"}',
                    },
                  },
                  { type: "response.completed", response: { id: "resp_1" } },
                ),
                { headers: { "content-type": "text/event-stream" } },
              )
            }),
          ),
        ),
      )

      expect(response.events).toContainEqual(expect.objectContaining({ type: "tool-call", id: "call_1", name: "lookup" }))
    }),
  )

  it.effect("streams reasoning summary items on the compatible Responses wire", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(request()).pipe(
        Effect.provide(
          dynamicResponse((input) =>
            Effect.gen(function* () {
              const web = yield* HttpClientRequest.toWeb(input.request).pipe(Effect.orDie)
              expect(web.url).toBe("https://api.deepseek.test/v1/responses")
              return input.respond(
                sseEvents(
                  { type: "response.reasoning_summary_text.delta", item_id: "rs_1", delta: "thinking" },
                  { type: "response.output_text.delta", item_id: "msg_1", delta: "Hello" },
                  { type: "response.completed", response: { id: "resp_1" } },
                ),
                { headers: { "content-type": "text/event-stream" } },
              )
            }),
          ),
        ),
      )
      expect(response.reasoning).toBe("thinking")
      expect(response.text).toBe("Hello")
    }),
  )
})

const request = () =>
  LLM.request({
    id: "req_deepseek_reasoning",
    model,
    prompt: "Say hello.",
    generation: { maxTokens: 20, temperature: 0 },
  })
