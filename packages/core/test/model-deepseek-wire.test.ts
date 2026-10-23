import { afterAll, beforeAll, describe, expect } from "bun:test"
import { createServer } from "node:http"
import { Effect, Layer } from "effect"
import { LLM } from "@deepagent-code/llm"
import { LLMClient, RequestExecutor } from "@deepagent-code/llm/route"
import { ModelV2 } from "@deepagent-code/core/model"
import { ModelRequest } from "@deepagent-code/core/model-request"
import { ProviderV2 } from "@deepagent-code/core/provider"
import { SessionRunnerModel } from "@deepagent-code/core/session/runner/model"
import { it } from "./lib/effect"

const calls: { path: string | undefined; body: Record<string, unknown> }[] = []
const server = createServer(async (request, response) => {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  calls.push({ path: request.url, body: JSON.parse(Buffer.concat(chunks).toString()) })
  response.writeHead(200, { "content-type": "text/event-stream" })
  response.end('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
})
beforeAll(() => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)))
afterAll(
  () =>
    new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
      server.closeAllConnections()
    }),
)

describe("native DeepSeek tool-choice wire contract", () => {
  for (const sample of [
    { model: "deepseek-flash", choice: "required", disabled: true },
    { model: "deepseek-v4.1-pro", choice: "lookup", disabled: true },
    { model: "deepseek-ai/deepseek-v4-flash", choice: "required", disabled: true, overlay: true },
    { model: "deepseek-flash", choice: "auto", disabled: false },
    { model: "deepseek-v4-pro", choice: "none", disabled: false },
    { model: "ordinary-chat", choice: "required", disabled: false },
    { model: "deepseek-flash", choice: "required", disabled: false, overlayChoice: "auto" },
    { model: "deepseek-v4-pro", choice: "lookup", disabled: false, overlayChoice: "none" },
    { model: "deepseek-flash", choice: "auto", disabled: true, overlayChoice: "required" },
  ]) {
    it.live(
      `${sample.model} ${sample.choice} preserves the final HTTP contract${sample.overlay ? " after overlays" : ""}${sample.overlayChoice ? ` with final ${sample.overlayChoice}` : ""}`,
      () =>
        Effect.gen(function* () {
          const address = server.address()
          if (!address || typeof address === "string") return yield* Effect.die("Listener missing")
          const info = new ModelV2.Info({
            ...ModelV2.Info.empty(ProviderV2.ID.make("fixture"), ModelV2.ID.make(sample.model)),
            api: {
              id: ModelV2.ID.make(sample.model),
              type: "aisdk",
              package: "@ai-sdk/openai-compatible",
              protocol: "openai-compatible.chat",
              url: `http://127.0.0.1:${address.port}/v1`,
            },
            request: {
              headers: {},
              ...ModelRequest.normalizeAiSdkOptions("@ai-sdk/openai-compatible", {
                reasoningEffort: "high",
                thinking: { type: "enabled" },
              }),
            },
          })
          const model = yield* SessionRunnerModel.fromCatalogModel(info)
          const request = LLM.request({
            model,
            prompt: "Hello",
            tools: [{ name: "lookup", description: "Read fixture", inputSchema: { type: "object" } }],
            toolChoice: sample.choice,
            ...(sample.overlay || sample.overlayChoice
              ? {
                  http: {
                    body: {
                      ...(sample.overlay ? { reasoning_effort: "max", thinking: { type: "enabled" } } : {}),
                      ...(sample.overlayChoice ? { tool_choice: sample.overlayChoice } : {}),
                    },
                  },
                }
              : {}),
          })
          const before = JSON.stringify({ request, defaults: model.route.defaults })
          const start = calls.length
          const client = LLMClient.layer.pipe(Layer.provide(RequestExecutor.defaultLayer))
          const prepared = yield* LLMClient.prepare(request).pipe(Effect.provide(client))
          const result = yield* LLMClient.generate(request).pipe(Effect.provide(client))
          expect(result.text).toBe("ok")
          expect(calls).toHaveLength(start + 1)
          expect(calls[start].path).toBe("/v1/chat/completions")
          const expected = {
            model: sample.model,
            reasoning_effort: sample.disabled ? "none" : "high",
            thinking: { type: sample.disabled ? "disabled" : "enabled" },
          }
          expect(calls[start].body).toMatchObject(expected)
          const choice = sample.overlayChoice ?? sample.choice
          expect(calls[start].body.tool_choice).toEqual(
            ["auto", "none", "required"].includes(choice) ? choice : { type: "function", function: { name: choice } },
          )
          expect(prepared.body).toMatchObject(expected)
          expect(JSON.stringify({ request, defaults: model.route.defaults })).toBe(before)
        }),
    )
  }
})
