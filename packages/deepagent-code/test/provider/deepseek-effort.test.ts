import { expect, test } from "bun:test"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { generateText } from "ai"
import { mergeDeep } from "remeda"
import { ProviderTransform } from "../../src/provider/transform"
import type { Provider } from "../../src/provider/provider"
import { ProviderV2 } from "@deepagent-code/core/provider"
import { ModelV2 } from "@deepagent-code/core/model"
import { applyCompatibilityProviderOptions } from "../../src/provider/compatibility"

const model = (id: string): Provider.Model => ({
  id: ModelV2.ID.make(id),
  providerID: ProviderV2.ID.make("deepseek"),
  name: id,
  api: { id, url: "https://api.deepseek.com", npm: "@ai-sdk/openai-compatible" },
  capabilities: {
    reasoning: true,
    temperature: false,
    attachment: false,
    toolcall: true,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: { field: "reasoning_content" },
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 1_048_576, output: 393_216 },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-10-17",
})

test.each(["deepseek-flash", "deepseek-v4-flash", "deepseek-v4.1-flash", "deepseek-v4-pro"])(
  "%s exposes the official thinking modes without an invented medium tier",
  (id) => {
    expect(ProviderTransform.variants(model(id))).toEqual({
      none: { reasoningEffort: "none", thinking: { type: "disabled" } },
      low: { reasoningEffort: "low", thinking: { type: "enabled" } },
      high: { reasoningEffort: "high", thinking: { type: "enabled" } },
      max: { reasoningEffort: "max", thinking: { type: "enabled" } },
    })
  },
)

test.each(["none", "low", "high", "max"])(
  "DeepSeek %s reaches the actual OpenAI-compatible SDK request with consistent thinking state",
  async (effort) => {
    const bodies: Record<string, unknown>[] = []
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        bodies.push(await request.json())
        return Response.json({
          id: "chatcmpl-deepseek-effort",
          object: "chat.completion",
          created: 0,
          model: "deepseek-flash",
          choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        })
      },
    })
    try {
      const item = model("deepseek-flash")
      const defaults = ProviderTransform.options({ model: item, sessionID: "deepseek-effort-fixture" })
      expect(defaults.thinking).toEqual({ type: "enabled" })
      const provider = createOpenAICompatible({
        name: item.providerID,
        baseURL: `${server.url}v1`,
        apiKey: "fixture-only",
      })
      await generateText({
        model: provider(item.api.id),
        prompt: "fixture",
        maxRetries: 0,
        providerOptions: ProviderTransform.providerOptions(
          item,
          mergeDeep(defaults, ProviderTransform.variants(item)[effort] ?? {}),
        ),
      })
      expect(bodies).toHaveLength(1)
      expect(bodies[0].reasoning_effort).toBe(effort)
      expect(bodies[0].thinking).toEqual({ type: effort === "none" ? "disabled" : "enabled" })
    } finally {
      server.stop(true)
    }
  },
)

test("DeepSeek effort changes leave older aliases and unrelated compatible models unchanged", () => {
  expect(ProviderTransform.variants(model("deepseek-chat"))).toEqual({})
  expect(ProviderTransform.variants(model("deepseek-reasoner"))).toEqual({})
  expect(ProviderTransform.variants(model("unrelated-reasoning-model"))).toEqual({
    low: { reasoningEffort: "low" },
    medium: { reasoningEffort: "medium" },
    high: { reasoningEffort: "high" },
  })
  const disabled = model("deepseek-flash")
  disabled.capabilities.reasoning = false
  expect(ProviderTransform.variants(disabled)).toEqual({})
})

test.each(["deepseek-flash", "deepseek-v4.1-flash"])(
  "%s forced tool choices reach the SDK wire with thinking disabled and effort none",
  async (id) => {
    const bodies: Record<string, unknown>[] = []
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        bodies.push(await request.json())
        return Response.json({
          id: "chatcmpl-deepseek-forced-tool",
          object: "chat.completion",
          created: 0,
          model: id,
          choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        })
      },
    })
    try {
      const item = model(id)
      const options: Parameters<typeof createOpenAICompatible>[0] = {
        name: item.providerID,
        baseURL: `${server.url}v1`,
        apiKey: "fixture-only",
      }
      applyCompatibilityProviderOptions(item, options)
      const provider = createOpenAICompatible(options)
      for (const toolChoice of [{ type: "required" }, { type: "tool", toolName: "target" }] as const) {
        await provider(item.api.id).doGenerate({
          prompt: [{ role: "user", content: [{ type: "text", text: "fixture" }] }],
          tools: [{ type: "function", name: "target", inputSchema: { type: "object", properties: {} } }],
          toolChoice,
          providerOptions: ProviderTransform.providerOptions(item, ProviderTransform.variants(item).max),
        })
      }
      expect(bodies).toHaveLength(2)
      expect(bodies.map((body) => body.tool_choice)).toEqual([
        "required",
        { type: "function", function: { name: "target" } },
      ])
      expect(bodies.map((body) => body.thinking)).toEqual([{ type: "disabled" }, { type: "disabled" }])
      expect(bodies.map((body) => body.reasoning_effort)).toEqual(["none", "none"])
    } finally {
      server.stop(true)
    }
  },
)
