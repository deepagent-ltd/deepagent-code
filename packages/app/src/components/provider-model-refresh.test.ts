import { describe, expect, test } from "bun:test"
import { canRefreshProviderModels } from "./provider-model-refresh"

describe("provider model refresh", () => {
  test("allows official, discovery, and legacy imported providers", () => {
    expect(canRefreshProviderModels("openai", undefined)).toBe(true)
    expect(canRefreshProviderModels("custom", { discovery: true })).toBe(true)
    expect(
      canRefreshProviderModels("mistral", {
        options: { baseURL: "https://api.mistral.ai/v1" },
        models: { mistral: { name: "Mistral" } },
      }),
    ).toBe(true)
    expect(
      canRefreshProviderModels("manual", {
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: "https://manual.example/v1" },
      }),
    ).toBe(false)
  })
})
