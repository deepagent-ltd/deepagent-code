import { expect, test } from "bun:test"
import { Provider as ModelsDevProvider } from "../src/models-dev"
import { OFFICIAL_PROVIDER_IDS, isOfficialProvider } from "../src/provider-official"
import { DEEPAGENT_MODEL_PROTOCOL, OFFICIAL_VENDORED_CATALOG } from "../src/models-dev"
import { Schema } from "effect"

test("deepagent is the recommended-first official provider", () => {
  expect(OFFICIAL_PROVIDER_IDS[0]).toBe("deepagent")
  expect(isOfficialProvider("deepagent")).toBe(true)
})

test("vendored deepagent catalog entry is schema-valid and complete", () => {
  const entry = OFFICIAL_VENDORED_CATALOG["deepagent"]
  expect(entry).toBeDefined()
  // Re-decode through the catalog schema (module load already validated, but pin it).
  expect(() => Schema.decodeUnknownSync(ModelsDevProvider)(entry)).not.toThrow()
  expect(entry?.name).toBe("DeepAgent API")
  expect(entry?.api).toBe("https://api.deepagent.ltd/v1")
  expect(entry?.npm).toBe("@ai-sdk/openai-compatible")
  expect(entry?.env).toContain("DEEPAGENT_API_KEY")
})

test("vendored catalog exposes the documented model set", () => {
  const models = OFFICIAL_VENDORED_CATALOG["deepagent"]?.models ?? {}
  const ids = Object.keys(models)
  expect(ids).toContain("gpt-5.6-sol")
  expect(ids).toContain("gpt-5.6-terra")
  expect(ids).toContain("gpt-5.6-luna")
  expect(ids).toContain("claude-opus-5")
  expect(ids).toContain("claude-sonnet-5")
  expect(ids).toContain("claude-fable-5")
  expect(ids).toContain("claude-haiku-4.5")
  expect(ids).toContain("grok-4.6")
  expect(ids).toContain("gemini-3.7-flash")
  expect(ids).toContain("deepseek-v4-flash")
  expect(ids).toContain("deepseek-v4-pro")
  expect(ids).toContain("deepseek-v4-flash-vision-exp")
  expect(ids).toContain("qwen3.8-flash")
  expect(ids).toContain("qwen3.8-max")
  expect(ids).toContain("glm-5.3")
  expect(ids).toContain("glm-5.3-flash")
  expect(ids).toContain("kimi-k3")
  expect(ids).toContain("k3-256k")
  expect(ids).toContain("kimi-for-coding")
  expect(ids).toContain("kimi-for-coding-highspeed")
  expect(ids.length).toBe(20)
})

test("GPT and DeepSeek families default to the Responses wire protocol", () => {
  for (const id of ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]) {
    expect(DEEPAGENT_MODEL_PROTOCOL[id]).toBe("openai-compatible.responses")
    expect(OFFICIAL_VENDORED_CATALOG["deepagent"]?.models[id]).toBeDefined()
  }
  for (const id of ["deepseek-v4-flash", "deepseek-v4-pro", "deepseek-v4-flash-vision-exp"]) {
    expect(DEEPAGENT_MODEL_PROTOCOL[id]).toBe("openai-compatible.responses")
    expect(OFFICIAL_VENDORED_CATALOG["deepagent"]?.models[id]).toBeDefined()
  }
  // Non-OpenAI/DeepSeek families keep the Chat default (no overrides declared).
  expect(DEEPAGENT_MODEL_PROTOCOL["qwen3.8-max"]).toBeUndefined()
})

test("claude models route through the anthropic protocol against /v1", () => {
  const models = OFFICIAL_VENDORED_CATALOG["deepagent"]?.models ?? {}
  for (const id of ["claude-opus-5", "claude-sonnet-5", "claude-fable-5", "claude-haiku-4.5"]) {
    expect(models[id]?.provider?.npm).toBe("@ai-sdk/anthropic")
    expect(models[id]?.provider?.api).toBe("https://api.deepagent.ltd/v1")
  }
  // The OpenAI-family default stays openai-compatible (no per-model override).
  expect(models["gpt-5.6-sol"]?.provider).toBeUndefined()
  expect(models["gemini-3.7-flash"]?.attachment).toBe(true)
  expect(models["deepseek-v4-flash-vision-exp"]?.attachment).toBe(true)
})
