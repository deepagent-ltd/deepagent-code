import { describe, expect, test } from "bun:test"
import type { ModelsDev } from "@deepagent-code/core/models-dev"
import {
  buildCatalogIndex,
  catalogSpecFor,
  normalizeModelID,
  projectSpec,
  specMatchFor,
  stripDateSuffix,
} from "@/provider/catalog-spec"

const model = (id: string, over: Partial<ModelsDev.Model> = {}): ModelsDev.Model => ({
  id,
  name: id,
  release_date: "",
  attachment: false,
  reasoning: false,
  temperature: false,
  tool_call: true,
  limit: { context: 0, output: 0 },
  ...over,
})

const catalog = (providers: Record<string, ModelsDev.Model[]>): Record<string, ModelsDev.Provider> =>
  Object.fromEntries(
    Object.entries(providers).map(([id, models]) => [
      id,
      { id, name: id, env: [], models: Object.fromEntries(models.map((m) => [m.id, m])) },
    ]),
  )

describe("normalizeModelID", () => {
  test("lowercases, drops vendor prefixes, collapses separators", () => {
    expect(normalizeModelID("openai/GPT-4o")).toBe("gpt-4o")
    expect(normalizeModelID("gpt-4o")).toBe("gpt-4o")
    expect(normalizeModelID("anthropic.claude-3-5-sonnet")).toBe("claude-3-5-sonnet")
    expect(normalizeModelID("glm-4.6")).toBe("glm-4-6")
    expect(normalizeModelID("deepseek_chat")).toBe("deepseek-chat")
  })

  test("some-router/ style prefixes are stripped", () => {
    expect(normalizeModelID("some-router/claude-3")).toBe("claude-3")
  })
})

describe("stripDateSuffix", () => {
  test("removes trailing date/version stamps", () => {
    expect(stripDateSuffix("claude-3-5-sonnet-20241022")).toBe("claude-3-5-sonnet")
    expect(stripDateSuffix("gpt-4o-latest")).toBe("gpt-4o")
    expect(stripDateSuffix("model-preview")).toBe("model")
    expect(stripDateSuffix("gpt-4o")).toBe("gpt-4o")
  })
})

describe("catalogSpecFor", () => {
  test("matches a bare id against a different provider (exact-normalized)", () => {
    const index = buildCatalogIndex(
      catalog({
        openai: [model("gpt-4o", { limit: { context: 128000, output: 16384 }, temperature: true })],
      }),
    )
    // A gateway forwards "openai/gpt-4o" under its own provider id.
    const spec = catalogSpecFor("openai/gpt-4o", "gpt-4o-alias", index)
    expect(spec?.limit.context).toBe(128000)
    expect(spec?.temperature).toBe(true)
  })

  test("falls back to the date-stripped loose map", () => {
    const index = buildCatalogIndex(
      catalog({ anthropic: [model("claude-3-5-sonnet", { limit: { context: 200000, output: 8192 }, reasoning: true })] }),
    )
    const spec = catalogSpecFor("claude-3-5-sonnet-20241022", "claude-3-5-sonnet-20241022", index)
    expect(spec?.limit.context).toBe(200000)
    expect(spec?.reasoning).toBe(true)
  })

  test("returns undefined for an unknown id", () => {
    const index = buildCatalogIndex(catalog({ openai: [model("gpt-4o")] }))
    expect(catalogSpecFor("totally-unknown", "totally-unknown", index)).toBeUndefined()
  })

  test("tolerates an empty catalog", () => {
    const index = buildCatalogIndex({})
    expect(catalogSpecFor("gpt-4o", "gpt-4o", index)).toBeUndefined()
  })
})

describe("collision disambiguation", () => {
  test("prefers an official provider over a third-party one", () => {
    const index = buildCatalogIndex(
      catalog({
        // aggregator has a bigger context but openai is official → official wins.
        aggregator: [model("gpt-4o", { limit: { context: 999999, output: 0 } })],
        openai: [model("gpt-4o", { limit: { context: 128000, output: 16384 } })],
      }),
    )
    const match = specMatchFor("gpt-4o", "gpt-4o", index)
    expect(match?.providerID).toBe("openai")
    expect(match?.model.limit.context).toBe(128000)
  })

  test("among non-official ties, prefers the largest context", () => {
    const index = buildCatalogIndex(
      catalog({
        small: [model("llama-3", { limit: { context: 8000, output: 0 } })],
        big: [model("llama-3", { limit: { context: 128000, output: 0 } })],
      }),
    )
    const match = specMatchFor("llama-3", "llama-3", index)
    expect(match?.providerID).toBe("big")
  })
})

describe("projectSpec", () => {
  test("projects the surfaced fields", () => {
    const m = model("gpt-4o", { limit: { context: 128000, output: 16384 }, temperature: true, reasoning: true })
    expect(projectSpec({ providerID: "openai", model: m })).toEqual({
      context: 128000,
      output: 16384,
      reasoning: true,
      temperature: true,
      toolcall: true,
      matchedFrom: "openai",
    })
  })
})
