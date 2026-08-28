import { describe, expect } from "bun:test"
import { DateTime, Effect, Layer, Option } from "effect"
import { Catalog } from "@deepagent-code/core/catalog"
import { EventV2 } from "@deepagent-code/core/event"
import { Location } from "@deepagent-code/core/location"
import { ModelV2 } from "@deepagent-code/core/model"
import { PluginV2 } from "@deepagent-code/core/plugin"
import { OpencodePlugin } from "@deepagent-code/core/plugin/provider/deepagent-code"
import { ProviderV2 } from "@deepagent-code/core/provider"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { location } from "../fixture/location"
import { it, model, provider, withEnv } from "./provider-helper"

const cost = (input: number, output = 0) => [{ input, output, cache: { read: 0, write: 0 } }]
const locationLayer = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make("test") })),
)

describe("OpencodePlugin", () => {
  it.effect("uses a public key and disables paid models without credentials", () =>
    withEnv({ DEEPAGENT_CODE_API_KEY: undefined }, () =>
      Effect.gen(function* () {
        const plugin = yield* PluginV2.Service
        const catalog = yield* Catalog.Service
        yield* plugin.add(OpencodePlugin)
        const transform = yield* catalog.transform()
        yield* transform((catalog) => {
          const item = provider("deepagent-code")
          catalog.provider.update(item.id, () => {})
          const paid = model("deepagent-code", "paid", { cost: cost(1) })
          catalog.model.update(item.id, paid.id, (draft) => {
            draft.cost = [...paid.cost]
          })
        })
        expect((yield* catalog.provider.get(ProviderV2.ID.make("deepagent-code"))).request.body.apiKey).toBe("public")
        expect((yield* catalog.model.get(ProviderV2.ID.make("deepagent-code"), ModelV2.ID.make("paid"))).enabled).toBe(
          false,
        )
      }),
    ),
  )

  it.effect("keeps free models without credentials", () =>
    withEnv({ DEEPAGENT_CODE_API_KEY: undefined }, () =>
      Effect.gen(function* () {
        const plugin = yield* PluginV2.Service
        const catalog = yield* Catalog.Service
        yield* plugin.add(OpencodePlugin)
        const transform = yield* catalog.transform()
        yield* transform((catalog) => {
          const item = provider("deepagent-code")
          catalog.provider.update(item.id, () => {})
          const free = model("deepagent-code", "free", { cost: cost(0) })
          catalog.model.update(item.id, free.id, (draft) => {
            draft.cost = [...free.cost]
          })
        })
        expect((yield* catalog.provider.get(ProviderV2.ID.make("deepagent-code"))).request.body.apiKey).toBe("public")
        expect((yield* catalog.model.get(ProviderV2.ID.make("deepagent-code"), ModelV2.ID.make("free"))).enabled).toBe(
          true,
        )
      }),
    ),
  )

  it.effect("treats output-only cost as free without credentials", () =>
    withEnv({ DEEPAGENT_CODE_API_KEY: undefined }, () =>
      Effect.gen(function* () {
        const plugin = yield* PluginV2.Service
        const catalog = yield* Catalog.Service
        yield* plugin.add(OpencodePlugin)
        const transform = yield* catalog.transform()
        yield* transform((catalog) => {
          const item = provider("deepagent-code")
          catalog.provider.update(item.id, () => {})
          const outputOnly = model("deepagent-code", "output-only", { cost: cost(0, 1) })
          catalog.model.update(item.id, outputOnly.id, (draft) => {
            draft.cost = [...outputOnly.cost]
          })
        })
        expect((yield* catalog.provider.get(ProviderV2.ID.make("deepagent-code"))).request.body.apiKey).toBe("public")
        expect(
          (yield* catalog.model.get(ProviderV2.ID.make("deepagent-code"), ModelV2.ID.make("output-only"))).enabled,
        ).toBe(true)
      }),
    ),
  )

  it.effect("uses DEEPAGENT_CODE_API_KEY as credentials", () =>
    withEnv({ DEEPAGENT_CODE_API_KEY: "secret" }, () =>
      Effect.gen(function* () {
        const plugin = yield* PluginV2.Service
        const catalog = yield* Catalog.Service
        yield* plugin.add(OpencodePlugin)
        const transform = yield* catalog.transform()
        yield* transform((catalog) => {
          const item = provider("deepagent-code")
          catalog.provider.update(item.id, () => {})
          const paid = model("deepagent-code", "paid", { cost: cost(1) })
          catalog.model.update(item.id, paid.id, (draft) => {
            draft.cost = [...paid.cost]
          })
        })
        expect((yield* catalog.provider.get(ProviderV2.ID.make("deepagent-code"))).request.body.apiKey).toBeUndefined()
        expect((yield* catalog.model.get(ProviderV2.ID.make("deepagent-code"), ModelV2.ID.make("paid"))).enabled).toBe(
          true,
        )
      }),
    ),
  )

  it.effect("uses configured provider env vars as credentials", () =>
    withEnv({ DEEPAGENT_CODE_API_KEY: undefined, CUSTOM_DEEPAGENT_CODE_API_KEY: "secret" }, () =>
      Effect.gen(function* () {
        const plugin = yield* PluginV2.Service
        const catalog = yield* Catalog.Service
        yield* plugin.add(OpencodePlugin)
        const transform = yield* catalog.transform()
        yield* transform((catalog) => {
          const item = provider("deepagent-code", { env: ["CUSTOM_DEEPAGENT_CODE_API_KEY"] })
          catalog.provider.update(item.id, (draft) => {
            draft.env = [...item.env]
          })
          const paid = model("deepagent-code", "paid", { cost: cost(1) })
          catalog.model.update(item.id, paid.id, (draft) => {
            draft.cost = [...paid.cost]
          })
        })
        expect((yield* catalog.provider.get(ProviderV2.ID.make("deepagent-code"))).request.body.apiKey).toBeUndefined()
        expect((yield* catalog.model.get(ProviderV2.ID.make("deepagent-code"), ModelV2.ID.make("paid"))).enabled).toBe(
          true,
        )
      }),
    ),
  )

  it.effect("uses configured apiKey as credentials", () =>
    withEnv({ DEEPAGENT_CODE_API_KEY: undefined }, () =>
      Effect.gen(function* () {
        const plugin = yield* PluginV2.Service
        const catalog = yield* Catalog.Service
        yield* plugin.add(OpencodePlugin)
        const transform = yield* catalog.transform()
        yield* transform((catalog) => {
          const item = provider("deepagent-code", {
            request: {
              headers: {},
              body: { apiKey: "configured" },
            },
          })
          catalog.provider.update(item.id, (draft) => {
            draft.request = item.request
          })
          const paid = model("deepagent-code", "paid", { cost: cost(1) })
          catalog.model.update(item.id, paid.id, (draft) => {
            draft.cost = [...paid.cost]
          })
        })
        expect((yield* catalog.provider.get(ProviderV2.ID.make("deepagent-code"))).request.body.apiKey).toBe(
          "configured",
        )
        expect((yield* catalog.model.get(ProviderV2.ID.make("deepagent-code"), ModelV2.ID.make("paid"))).enabled).toBe(
          true,
        )
      }),
    ),
  )

  it.effect("uses auth-enabled providers as credentials", () =>
    withEnv({ DEEPAGENT_CODE_API_KEY: undefined }, () =>
      Effect.gen(function* () {
        const plugin = yield* PluginV2.Service
        const catalog = yield* Catalog.Service
        yield* plugin.add(OpencodePlugin)
        const transform = yield* catalog.transform()
        yield* transform((catalog) => {
          const item = provider("deepagent-code", { enabled: { via: "account", service: "deepagent-code" } })
          catalog.provider.update(item.id, (draft) => {
            draft.enabled = item.enabled
          })
          const paid = model("deepagent-code", "paid", { cost: cost(1) })
          catalog.model.update(item.id, paid.id, (draft) => {
            draft.cost = [...paid.cost]
          })
        })
        expect((yield* catalog.provider.get(ProviderV2.ID.make("deepagent-code"))).request.body.apiKey).toBeUndefined()
        expect((yield* catalog.model.get(ProviderV2.ID.make("deepagent-code"), ModelV2.ID.make("paid"))).enabled).toBe(
          true,
        )
      }),
    ),
  )

  it.effect("ignores non-deepagent-code providers and models", () =>
    withEnv({ DEEPAGENT_CODE_API_KEY: undefined }, () =>
      Effect.gen(function* () {
        const plugin = yield* PluginV2.Service
        const catalog = yield* Catalog.Service
        yield* plugin.add(OpencodePlugin)
        const transform = yield* catalog.transform()
        yield* transform((catalog) => {
          const item = provider("openai")
          catalog.provider.update(item.id, () => {})
          const paid = model("openai", "paid", { cost: cost(1) })
          catalog.model.update(item.id, paid.id, (draft) => {
            draft.cost = [...paid.cost]
          })
        })
        expect((yield* catalog.provider.get(ProviderV2.ID.openai)).request.body.apiKey).toBeUndefined()
        expect((yield* catalog.model.get(ProviderV2.ID.openai, ModelV2.ID.make("paid"))).enabled).toBe(true)
      }),
    ),
  )

  it.effect("prefers gpt-5-nano as the deepagent-code small model", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const providerID = ProviderV2.ID.make("deepagent-code")

      const transform = yield* catalog.transform()
      yield* transform((catalog) => {
        catalog.provider.update(providerID, () => {})
        catalog.model.update(providerID, ModelV2.ID.make("cheap-mini"), (model) => {
          model.capabilities.input = ["text"]
          model.capabilities.output = ["text"]
          model.cost = [...cost(1, 1)]
          model.time.released = DateTime.makeUnsafe(Date.now())
        })
        catalog.model.update(providerID, ModelV2.ID.make("gpt-5-nano"), (model) => {
          model.capabilities.input = ["text"]
          model.capabilities.output = ["text"]
          model.cost = [...cost(10, 10)]
          model.time.released = DateTime.makeUnsafe(Date.now())
        })
      })

      const selected = yield* catalog.model.small(providerID)

      expect(Option.getOrUndefined(selected)?.id).toBe(ModelV2.ID.make("gpt-5-nano"))
    }).pipe(
      Effect.provide(Catalog.locationLayer.pipe(Layer.provide(EventV2.defaultLayer), Layer.provide(locationLayer))),
    ),
  )
})
