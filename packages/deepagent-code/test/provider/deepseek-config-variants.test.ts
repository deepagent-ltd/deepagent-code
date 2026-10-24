import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { generateText } from "ai"
import { Auth } from "../../src/auth"
import { Env } from "../../src/env"
import { Plugin } from "../../src/plugin"
import { Provider } from "../../src/provider/provider"
import { ProviderTransform } from "../../src/provider/transform"
import { ProviderV2 } from "@deepagent-code/core/provider"
import { ModelV2 } from "@deepagent-code/core/model"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(Provider.defaultLayer, Env.defaultLayer, Plugin.defaultLayer, Auth.defaultLayer))
const providerID = ProviderV2.ID.make("deepseek-explicit-fixture")

for (const fixture of [
  { id: "high", body: { thinking: { type: "disabled" } }, effort: "none", thinking: "disabled" },
  { id: "none", body: { reasoningEffort: "low" }, effort: "low", thinking: "enabled" },
  {
    id: "high",
    body: { thinking: { type: "disabled" }, reasoningEffort: "max" },
    effort: "none",
    thinking: "disabled",
  },
]) {
  it.instance(
    `configured DeepSeek ${fixture.id}/${fixture.effort} reaches the SDK wire consistently`,
    () =>
      Effect.gen(function* () {
        const provider = yield* Provider.Service
        const model = yield* provider.getModel(providerID, ModelV2.ID.make("deepseek-flash"))
        const variant = model.variants?.[fixture.id]
        expect(variant?.reasoningEffort).toBe(fixture.effort)
        expect(variant?.thinking).toEqual({ type: fixture.thinking })
        expect(model.variants?.low).toBeUndefined()
        const bodies: Record<string, unknown>[] = []
        const server = Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          async fetch(request) {
            bodies.push(await request.json())
            return Response.json({
              id: "chatcmpl-config",
              object: "chat.completion",
              created: 0,
              model: "deepseek-flash",
              choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            })
          },
        })
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            server.stop(true)
          }),
        )
        const sdk = createOpenAICompatible({ name: providerID, baseURL: `${server.url}v1`, apiKey: "fixture-only" })
        yield* Effect.promise(() =>
          generateText({
            model: sdk(model.api.id),
            prompt: "fixture",
            maxRetries: 0,
            providerOptions: ProviderTransform.providerOptions(model, variant ?? {}),
          }),
        )
        expect(bodies).toHaveLength(1)
        expect(bodies[0]).toMatchObject({ reasoning_effort: fixture.effort, thinking: { type: fixture.thinking } })
        expect(bodies[0]).not.toHaveProperty("disabled")
      }),
    {
      config: {
        provider: {
          [providerID]: {
            name: "DeepSeek explicit fixture",
            npm: "@ai-sdk/openai-compatible",
            env: [],
            options: { apiKey: "fixture-only", baseURL: "https://fixture.invalid/v1" },
            models: {
              "deepseek-flash": {
                name: "DeepSeek Flash",
                reasoning: true,
                tool_call: true,
                limit: { context: 1048576, output: 393216 },
                variants: { [fixture.id]: fixture.body, low: { disabled: true } },
              },
            },
          },
        },
      },
    },
  )
}
