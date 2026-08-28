import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { HttpClientRequest } from "effect/unstable/http"
import { LLM } from "../../src"
import { Auth, LLMClient } from "../../src/route"
import * as OpenAICompatible from "../../src/providers/openai-compatible"
import { byProvider, profiles } from "../../src/providers/openai-compatible-profile"
import * as OpenAICompatibleResponses from "../../src/protocols/openai-compatible-responses"
import { it } from "../lib/effect"
import { dynamicResponse } from "../lib/http"
import { sseEvents } from "../lib/sse"

const Json = Schema.fromJsonString(Schema.Unknown)
const decodeJson = Schema.decodeUnknownSync(Json)

const model = OpenAICompatibleResponses.route
  .with({
    provider: "deepseek",
    endpoint: { baseURL: "https://api.deepseek.test/v1/" },
    auth: Auth.bearer("test-key"),
  })
  .model({ id: "deepseek-reasoner" })

const request = LLM.request({
  id: "req_1",
  model,
  system: "You are concise.",
  prompt: "Say hello.",
  generation: { maxTokens: 20, temperature: 0 },
})

describe("OpenAI-compatible Responses route", () => {
  it.effect("prepares a Responses body owned by the deepseek route, not openai", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare(request)

      expect(prepared.route).toBe("openai-compatible-responses")
      expect(prepared.protocol).toBe("openai-responses")
      expect(prepared.model).toMatchObject({
        id: "deepseek-reasoner",
        provider: "deepseek",
        route: { id: "openai-compatible-responses" },
      })
      expect(prepared.model.provider).not.toBe("openai")
      expect(prepared.body).toEqual({
        model: "deepseek-reasoner",
        input: [
          { role: "system", content: "You are concise." },
          { role: "user", content: [{ type: "input_text", text: "Say hello." }] },
        ],
        stream: true,
        max_output_tokens: 20,
        temperature: 0,
      })
      expect(prepared.body).not.toHaveProperty("include")
      expect(prepared.body).not.toHaveProperty("store")
    }),
  )

  it.effect("never emits include/store for non-openai providerOptions keys", () =>
    Effect.gen(function* () {
      // DeepSeek's Responses compatibility set has not been proven to support
      // encrypted reasoning, so include/store must never reach the wire. The
      // shared protocol lowerOptions only reads `providerOptions.openai`, and
      // compatible families key their options under their own provider id.
      const prepared = yield* LLMClient.prepare(
        LLM.updateRequest(request, {
          providerOptions: { deepseek: { store: false, include: ["reasoning.encrypted_content"] } },
        }),
      )
      expect(prepared.body).not.toHaveProperty("include")
      expect(prepared.body).not.toHaveProperty("store")
      expect(prepared.body).not.toHaveProperty("reasoning")
    }),
  )

  it.effect("exposes chat and responses factories per compatible family", () =>
    Effect.gen(function* () {
      const deepseek = OpenAICompatible.deepseek.configure({ apiKey: "test-key" })
      expect(deepseek.responses("deepseek-reasoner")).toMatchObject({
        id: "deepseek-reasoner",
        provider: "deepseek",
        route: { id: "openai-compatible-responses" },
      })
      expect(deepseek.responses("deepseek-reasoner").route.endpoint.baseURL).toBe("https://api.deepseek.com/v1")
      expect(deepseek.chat("deepseek-chat").route.id).toBe("openai-compatible-chat")
      expect(deepseek.model("deepseek-chat").route.id).toBe("openai-compatible-chat")

      const groq = OpenAICompatible.groq.configure({ apiKey: "test-key" })
      expect(groq.model("llama-3.3-70b").route.id).toBe("openai-compatible-chat")

      const generic = OpenAICompatible.configure({
        provider: "custom",
        baseURL: "https://custom.example.test/v1",
        apiKey: "test-key",
      })
      expect(generic.responses("any-model")).toMatchObject({
        provider: "custom",
        route: { id: "openai-compatible-responses" },
      })
    }),
  )

  test("declares Responses capability only for deepseek profiles", () => {
    expect(profiles.deepseek.supportsResponses).toBe(true)
    for (const profile of Object.values(byProvider)) {
      if (profile.provider === "deepseek") continue
      expect(profile.supportsResponses ?? false).toBe(false)
    }
    expect(byProvider["deepseek"]?.supportsResponses).toBe(true)
    expect(byProvider["groq"]?.supportsResponses).toBeUndefined()
  })

  it.effect("posts to the configured /responses endpoint and parses the stream", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(request).pipe(
        Effect.provide(
          dynamicResponse((input) =>
            Effect.gen(function* () {
              const web = yield* HttpClientRequest.toWeb(input.request).pipe(Effect.orDie)
              expect(web.url).toBe("https://api.deepseek.test/v1/responses")
              expect(web.headers.get("authorization")).toBe("Bearer test-key")
              expect(decodeJson(input.text)).toMatchObject({ model: "deepseek-reasoner", stream: true })
              return input.respond(
                sseEvents(
                  { type: "response.output_text.delta", item_id: "msg_1", delta: "Hello" },
                  { type: "response.output_text.delta", item_id: "msg_1", delta: "!" },
                  {
                    type: "response.completed",
                    response: { id: "resp_1", usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 } },
                  },
                ),
                { headers: { "content-type": "text/event-stream" } },
              )
            }),
          ),
        ),
      )

      expect(response.text).toBe("Hello!")
      expect(response.usage).toMatchObject({ inputTokens: 5, outputTokens: 2, totalTokens: 7 })
      expect(response.events.at(-1)).toMatchObject({ type: "finish", reason: "stop" })
    }),
  )
})
