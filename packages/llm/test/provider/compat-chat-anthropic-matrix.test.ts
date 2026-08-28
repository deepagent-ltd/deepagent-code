import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { HttpClientRequest } from "effect/unstable/http"
import { LLM, Message, ToolCallPart } from "../../src"
import { Auth, LLMClient } from "../../src/route"
import * as AnthropicMessages from "../../src/protocols/anthropic-messages"
import * as OpenAICompatibleChat from "../../src/protocols/openai-compatible-chat"
import { it } from "../lib/effect"
import { dynamicResponse } from "../lib/http"
import { sseEvents } from "../lib/sse"

/**
 * C2-08 — Chat-only compatible + Anthropic Messages non-regression matrix.
 *
 * A chat-only compatible provider must NEVER send a `/responses` request (it is
 * the Chat wire only); an Anthropic Messages model must post to `/v1/messages`
 * with tool_use/tool_result and usage, and never `/responses`. Every assertion
 * here fails on a wire-split (a chat-only route leaking to Responses, or a
 * Messages route doing Chat) — the resolver + transport split C2-02 guarantees
 * this at the routing level, this matrix locks it at the wire level.
 */

const chatModel = OpenAICompatibleChat.route
  .with({
    provider: "groq",
    endpoint: { baseURL: "https://compat.example/v1/" },
    auth: Auth.bearer("test-key"),
  })
  .model({ id: "llama-3.3-70b" })

const anthropicModel = AnthropicMessages.route
  .with({
    endpoint: { baseURL: "https://api.anthropic.test/v1/" },
    auth: Auth.header("x-api-key", "test-key"),
  })
  .model({ id: "claude-sonnet-4" })

describe("C2-08 Chat-only compatible + Anthropic Messages non-regression matrix", () => {
  it.effect("chat-only compatible never sends a /responses request (Chat wire only)", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(
        LLM.request({
          id: "req_chat_only",
          model: chatModel,
          messages: [
            Message.user("What is the weather?"),
            Message.assistant([ToolCallPart.make({ id: "call_1", name: "lookup", input: { query: "weather" } })]),
            Message.tool({ id: "call_1", name: "lookup", result: { forecast: "sunny" } }),
          ],
          tools: [{ name: "lookup", description: "Lookup data", inputSchema: { type: "object" } }],
        }),
      ).pipe(
        Effect.provide(
          dynamicResponse((input) =>
            Effect.gen(function* () {
              const web = yield* HttpClientRequest.toWeb(input.request).pipe(Effect.orDie)
              expect(web.url).toBe("https://compat.example/v1/chat/completions")
              expect(web.url).not.toContain("/responses")
              const body = (yield* Effect.promise(() => web.json())) as Record<string, unknown>
              expect(body.messages).toMatchObject([
                { role: "user", content: "What is the weather?" },
                {
                  role: "assistant",
                  tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: '{"query":"weather"}' } }],
                },
                { role: "tool", tool_call_id: "call_1", content: '{"forecast":"sunny"}' },
              ])
              expect(body.tools).toEqual([
                {
                  type: "function",
                  function: { name: "lookup", description: "Lookup data", parameters: { type: "object" } },
                },
              ])
              return input.respond(
                sseEvents(
                  { id: "c", choices: [{ delta: { content: "Sunny" }, finish_reason: null }], usage: null },
                  { id: "c", choices: [{ delta: {}, finish_reason: "stop" }], usage: null },
                  { id: "c", choices: [], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } },
                ),
                { headers: { "content-type": "text/event-stream" } },
              )
            }),
          ),
        ),
      )
      expect(response.text).toBe("Sunny")
      expect(response.usage).toMatchObject({ inputTokens: 5, outputTokens: 2, totalTokens: 7 })
    }),
  )

  it.effect("anthropic messages posts to /v1/messages with tool_use/tool_result and usage, never /responses", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(
        LLM.request({
          id: "req_anthropic",
          model: anthropicModel,
          messages: [
            Message.user("What is the weather?"),
            Message.assistant([ToolCallPart.make({ id: "call_1", name: "lookup", input: { query: "weather" } })]),
            Message.tool({ id: "call_1", name: "lookup", result: { forecast: "sunny" } }),
          ],
          tools: [{ name: "lookup", description: "Lookup data", inputSchema: { type: "object" } }],
          generation: { maxTokens: 20 },
        }),
      ).pipe(
        Effect.provide(
          dynamicResponse((input) =>
            Effect.gen(function* () {
              const web = yield* HttpClientRequest.toWeb(input.request).pipe(Effect.orDie)
              expect(web.url).toBe("https://api.anthropic.test/v1/messages")
              expect(web.url).not.toContain("/responses")
              const body = (yield* Effect.promise(() => web.json())) as Record<string, unknown>
              expect(body.messages).toMatchObject([
                { role: "user", content: [{ type: "text", text: "What is the weather?" }] },
                {
                  role: "assistant",
                  content: [{ type: "tool_use", id: "call_1", name: "lookup", input: { query: "weather" } }],
                },
                {
                  role: "user",
                  content: [{ type: "tool_result", tool_use_id: "call_1", content: '{"forecast":"sunny"}' }],
                },
              ])
              expect(body.tools).toMatchObject([
                {
                  name: "lookup",
                  description: "Lookup data",
                  input_schema: { type: "object" },
                },
              ])
              return input.respond(
                sseEvents(
                  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
                  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Sunny" } },
                  { type: "content_block_stop", index: 0 },
                  {
                    type: "message_delta",
                    delta: { stop_reason: "end_turn" },
                    usage: { input_tokens: 5, output_tokens: 2 },
                  },
                  { type: "message_stop" },
                ),
                { headers: { "content-type": "text/event-stream" } },
              )
            }),
          ),
        ),
      )
      expect(response.text).toBe("Sunny")
      expect(response.usage).toMatchObject({ inputTokens: 5, outputTokens: 2 })
    }),
  )

  it.effect("a chat-only compatible model is NOT routable to the Responses adapter", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(LLM.request({ id: "req_chat", model: chatModel, prompt: "hi" }))
      expect(prepared.route).toBe("openai-compatible-chat")
      expect(prepared.body).not.toHaveProperty("input")
    }),
  )
})
