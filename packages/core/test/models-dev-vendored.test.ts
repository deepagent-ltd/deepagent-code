import { expect, test } from "bun:test"
import { Provider as ModelsDevProvider } from "../src/models-dev"
import { OFFICIAL_PROVIDER_IDS, isOfficialProvider } from "../src/provider-official"
import { DEEPAGENT_MODEL_PROTOCOL, OFFICIAL_VENDORED_CATALOG } from "../src/models-dev"
import { Schema } from "effect"
import { inputBudget, resolvedBuffer } from "../src/session/compaction"

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
  // Catalog ids are the WIRE ids (live-verified against /v1/models + engine matrix
  // 16/16): the platform routes families under FQN prefixes.
  expect(ids).toContain("openai/gpt-5.6-sol")
  expect(ids).toContain("openai/gpt-5.6-terra")
  expect(ids).toContain("openai/gpt-5.6-luna")
  expect(ids).toContain("anthropic/claude-opus-5")
  expect(ids).toContain("anthropic/claude-sonnet-5")
  expect(ids).toContain("anthropic/claude-fable-5")
  expect(ids).toContain("anthropic/claude-haiku-4.5")
  expect(ids).toContain("x-ai/grok-4.6")
  expect(ids).toContain("google/gemini-3.7-flash")
  expect(ids).toContain("deepseek-flash")
  expect(ids).toContain("deepseek-v4-pro")
  expect(ids).toContain("qwen3.8-flash")
  expect(ids).toContain("qwen3.8-max")
  expect(ids).toContain("glm-5.3")
  expect(ids).toContain("glm-5.3-flash")
  expect(ids).toContain("kimi-k3")
  expect(ids).toContain("k3-256k")
  expect(ids).toContain("kimi-for-coding")
  expect(ids).toContain("kimi-for-coding-highspeed")
  expect(ids.length).toBe(19)
})

test("GPT and DeepSeek families default to the Responses wire protocol", () => {
  for (const id of ["openai/gpt-5.6-sol", "openai/gpt-5.6-terra", "openai/gpt-5.6-luna"]) {
    expect(DEEPAGENT_MODEL_PROTOCOL[id]).toBe("openai-compatible.responses")
    expect(OFFICIAL_VENDORED_CATALOG["deepagent"]?.models[id]).toBeDefined()
  }
  for (const id of ["deepseek-flash", "deepseek-v4-pro"]) {
    expect(DEEPAGENT_MODEL_PROTOCOL[id]).toBe("openai-compatible.responses")
    expect(OFFICIAL_VENDORED_CATALOG["deepagent"]?.models[id]).toBeDefined()
  }
  // Non-OpenAI/DeepSeek families keep the Chat default (no overrides declared).
  expect(DEEPAGENT_MODEL_PROTOCOL["qwen3.8-max"]).toBeUndefined()
})

test("claude models route through the anthropic protocol against /v1", () => {
  const models = OFFICIAL_VENDORED_CATALOG["deepagent"]?.models ?? {}
  for (const id of [
    "anthropic/claude-opus-5",
    "anthropic/claude-sonnet-5",
    "anthropic/claude-fable-5",
    "anthropic/claude-haiku-4.5",
  ]) {
    expect(models[id]?.provider?.npm).toBe("@ai-sdk/anthropic")
    expect(models[id]?.provider?.api).toBe("https://api.deepagent.ltd/v1")
  }
  // The OpenAI-family default stays openai-compatible (no per-model override).
  expect(models["openai/gpt-5.6-sol"]?.provider).toBeUndefined()
  expect(models["google/gemini-3.7-flash"]?.attachment).toBe(true)
})

// The vendored window is not cosmetic: `session/compaction.ts` derives the auto-compaction trigger
// from it (`window - window*0.18`). Vendoring 128_000 for a 1M-window model put the trigger at
// 104,960 — 10% of the real window — so compaction would fire on runs that were nowhere near the
// limit. These values are the upstream models.dev ones; changing them changes when compaction runs.
test("vendored DeepSeek limits are the ones the provider enforces", () => {
  const models = OFFICIAL_VENDORED_CATALOG["deepagent"]?.models ?? {}
  for (const id of ["deepseek-flash", "deepseek-v4-pro"]) {
    expect(models[id]?.limit?.context).toBe(1_048_576)
    expect(models[id]?.limit?.output).toBe(393_216)
  }
})

// The window and the compaction trigger are ONE decision, and nothing connected them before: the
// vendored 128_000 put auto-compaction at 104,960 tokens, i.e. 10% of the real 1,048,576 window, so
// the mechanism would fire on runs nowhere near the limit — spending a summarization call and
// dropping history for no reason. This pins the trigger to the shipped window so a wrong vendored
// value fails here instead of silently changing when compaction runs.
test("auto-compaction triggers near the window limit, not at 10% of it", () => {
  const window = OFFICIAL_VENDORED_CATALOG["deepagent"]?.models["deepseek-flash"]?.limit?.context
  expect(window).toBe(1_048_576)
  const trigger = inputBudget(window!, resolvedBuffer(window!, { buffer: 20_000, bufferRatio: 0.18 }))
  expect(trigger).toBeGreaterThan(0.8 * window!)
  // The recorded ablation runs peak at ~193k prompt tokens; a run that size must NOT compact.
  expect(trigger).toBeGreaterThan(193_000)
})
