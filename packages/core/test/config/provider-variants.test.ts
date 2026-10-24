import { describe, expect } from "bun:test"
import { Effect, Schema } from "effect"
import { Catalog } from "../../src/catalog"
import { Config } from "../../src/config"
import { ConfigProviderPlugin } from "../../src/config/plugin/provider"
import { ModelV2 } from "../../src/model"
import { ModelRequest } from "../../src/model-request"
import { ProviderV2 } from "../../src/provider"
import { ProviderVariants } from "../../src/provider-variants"
import { ConfigMigrateV1 } from "../../src/v1/config/migrate"
import { it } from "../plugin/provider-helper"

const providerID = ProviderV2.ID.make("deepseek")
const modelID = ModelV2.ID.make("deepseek-flash")
const generated = ProviderVariants.variants({
  id: modelID,
  providerID,
  api: { id: modelID, npm: "@ai-sdk/openai-compatible" },
  capabilities: { reasoning: true },
  limit: { output: 393216 },
  release_date: "2026-10-17",
})

const apply = (documents: unknown[]) =>
  Effect.gen(function* () {
    const catalog = yield* Catalog.Service
    const seed = yield* catalog.transform()
    yield* seed((editor) => {
      editor.provider.update(providerID, (provider) => {
        provider.api = { type: "aisdk", package: "@ai-sdk/openai-compatible", url: "https://fixture.invalid/v1" }
      })
      editor.model.update(providerID, modelID, (model) => {
        model.api = {
          id: modelID,
          type: "aisdk",
          package: "@ai-sdk/openai-compatible",
          url: "https://fixture.invalid/v1",
        }
        model.variants = Object.entries(generated).map(([id, options]) => ({
          id: ModelV2.VariantID.make(id),
          headers: {},
          ...ModelRequest.normalizeAiSdkOptions("@ai-sdk/openai-compatible", options),
        }))
      })
    })
    yield* ConfigProviderPlugin.Plugin.effect.pipe(
      Effect.provideService(
        Config.Service,
        Config.Service.of({
          entries: () =>
            Effect.succeed(
              documents.map(
                (document) =>
                  new Config.Document({
                    type: "document",
                    info: Schema.decodeUnknownSync(Config.Info)(document),
                  }),
              ),
            ),
        }),
      ),
    )
    return yield* catalog.model.get(providerID, modelID)
  })

const document = (variants: unknown[]) => ({ providers: { deepseek: { models: { "deepseek-flash": { variants } } } } })

describe("configured provider variants", () => {
  it.effect("migrates a legacy disabled marker as metadata instead of a provider request field", () =>
    Effect.gen(function* () {
      const migrated = ConfigMigrateV1.migrate({
        provider: {
          deepseek: {
            npm: "@ai-sdk/openai-compatible",
            models: { "deepseek-flash": { variants: { low: { disabled: true } } } },
          },
        },
      })
      expect(migrated.providers?.deepseek?.models?.["deepseek-flash"]?.variants).toEqual([
        { id: "low", disabled: true, body: {} },
      ])
    }),
  )

  it.effect("removes a disabled variant from the actual runtime catalog", () =>
    Effect.gen(function* () {
      const model = yield* apply([document([{ id: "low", disabled: true }])])
      expect(model.variants.map((variant) => String(variant.id))).toEqual(["none", "high", "max"])
      const catalog = yield* Catalog.Service
      expect((yield* catalog.provider.get(providerID)).enabled).toBe(false)
    }),
  )

  it.effect("a later project enable keeps the original generated request options", () =>
    Effect.gen(function* () {
      const model = yield* apply([
        document([{ id: "low", disabled: true }]),
        document([{ id: "low", disabled: false }]),
      ])
      const low = model.variants.find((variant) => variant.id === "low")
      expect(low?.options).toEqual({ reasoningEffort: "low", thinking: { type: "enabled" } })
      expect(low?.body).toEqual({})
    }),
  )

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
    it.effect(`normalizes only the explicit ${fixture.id} config layer before merging`, () =>
      Effect.gen(function* () {
        const model = yield* apply([document([{ id: fixture.id, body: fixture.body }])])
        const variant = model.variants.find((variant) => variant.id === fixture.id)
        expect(variant?.options).toEqual({
          reasoningEffort: fixture.effort,
          thinking: { type: fixture.thinking },
        })
        expect(variant?.body).toEqual({})
      }),
    )
  }
})
