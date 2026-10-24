import { expect, test } from "bun:test"
import { Schema } from "effect"
import { ModelsDev } from "../src/models-dev"
import { OFFICIAL_PROVIDER_IDS, isOfficialProvider } from "../src/provider-official"
import { PROVIDER_BRANDS, PROVIDER_PRESETS, PROVIDER_BOOTSTRAP_CATALOG, providerPreset } from "../src/provider-presets"

test("small offline bootstrap covers ten brands with schema-valid identities and no fabricated models or prices", () => {
  const entries = Schema.decodeUnknownSync(Schema.Record(Schema.String, ModelsDev.Provider))(PROVIDER_BOOTSTRAP_CATALOG)
  expect(PROVIDER_BRANDS).toHaveLength(10)
  expect(new Set(PROVIDER_PRESETS.map((preset) => preset.id)).size).toBe(PROVIDER_PRESETS.length)
  for (const brand of PROVIDER_BRANDS) expect(PROVIDER_PRESETS.some((preset) => preset.brand === brand.id)).toBe(true)
  for (const preset of PROVIDER_PRESETS) {
    expect(entries[preset.id]?.models).toEqual({})
    expect(entries[preset.id]?.api).toBe(preset.api)
    expect(entries[preset.id]?.npm).toBe(preset.npm)
  }
  expect(JSON.stringify(entries).length).toBeLessThan(10_000)
})

test("recommendation does not change reserved credentials or redefinition boundaries", () => {
  expect(OFFICIAL_PROVIDER_IDS).toHaveLength(12)
  for (const id of ["alibaba", "alibaba-cn", "alibaba-coding-plan", "alibaba-coding-plan-cn", "openrouter"]) {
    expect(providerPreset(id)).toBeDefined()
    expect(isOfficialProvider(id)).toBe(false)
  }
  expect(providerPreset("a-user-gateway")).toBeUndefined()
})

test("billing and region preserve distinct provider identities, credentials and real protocols", () => {
  expect(providerPreset("deepagent")?.api).toBe("https://api.deepagent.ltd/v1")
  expect(providerPreset("kimi-for-coding")?.npm).toBe("@ai-sdk/anthropic")
  expect(providerPreset("moonshotai-cn")?.npm).toBe("@ai-sdk/openai-compatible")
  expect(providerPreset("zhipuai")?.api).not.toBe(providerPreset("zhipuai-coding-plan")?.api)
  expect(providerPreset("zai")?.api).not.toBe(providerPreset("zhipuai")?.api)
  expect(providerPreset("alibaba")?.api).not.toBe(providerPreset("alibaba-cn")?.api)
  expect(providerPreset("alibaba-coding-plan-cn")?.env).not.toEqual(providerPreset("alibaba-cn")?.env)
  expect(providerPreset("openrouter")?.npm).toBe("@openrouter/ai-sdk-provider")
})
