import { afterEach, expect, test } from "bun:test"
import { mkdir, unlink } from "fs/promises"
import path from "path"
import { pathToFileURL } from "url"
import { Effect, Layer } from "effect"
import { ModelsDev } from "@deepagent-code/core/models-dev"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { CrossSpawnSpawner } from "@deepagent-code/core/cross-spawn-spawner"
import { Global } from "@deepagent-code/core/global"
import { disposeAllInstances, provideInstanceEffect, tmpdirScoped, TestInstance } from "../fixture/fixture"
import { markPluginDependenciesReady } from "../fixture/plugin"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { Env } from "../../src/env"
import { Plugin } from "../../src/plugin/index"
import { Provider } from "@/provider/provider"

import { RuntimeFlags } from "@/effect/runtime-flags"
import { Filesystem } from "@/util/filesystem"
import { InstanceLayer } from "@/project/instance-layer"
import { testEffect } from "../lib/effect"
import { ProviderV2 } from "@deepagent-code/core/provider"
import { ModelV2 } from "@deepagent-code/core/model"

const originalEnv = new Map<string, string | undefined>()

const rememberEnv = (k: string) => {
  if (!originalEnv.has(k)) originalEnv.set(k, process.env[k])
}

const setProcessEnv = (k: string, v: string) =>
  Effect.sync(() => {
    rememberEnv(k)
    process.env[k] = v
  })

const removeProcessEnv = (k: string) =>
  Effect.sync(() => {
    rememberEnv(k)
    delete process.env[k]
  })

const set = (k: string, v: string) =>
  Effect.gen(function* () {
    rememberEnv(k)
    process.env[k] = v
    yield* Env.use.set(k, v)
  })

const remove = (k: string) =>
  Effect.gen(function* () {
    rememberEnv(k)
    delete process.env[k]
    yield* Env.use.remove(k)
  })

afterEach(async () => {
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  originalEnv.clear()
  await disposeAllInstances()
})

const providerLayer = (flags: Partial<RuntimeFlags.Info> = {}) =>
  Provider.layer.pipe(
    Layer.provide(FSUtil.defaultLayer),
    Layer.provide(Env.defaultLayer),
    Layer.provide(Config.defaultLayer),
    Layer.provide(Auth.defaultLayer),
    Layer.provide(Plugin.defaultLayer),
    Layer.provide(ModelsDev.defaultLayer),
    Layer.provide(RuntimeFlags.layer(flags)),
  )

const list = Provider.use.list()

const paid = (providers: Record<string, { models: Record<string, { cost: { input: number } }> }>) => {
  const item = providers[ProviderV2.ID.make("deepagent-code")]
  expect(item).toBeDefined()
  return Object.values(item.models).filter((model) => model.cost.input > 0).length
}

const languageBaseURL = (language: unknown) => (language as { config: { baseURL: string } }).config.baseURL
const deepagentAuthProviderFixture = pathToFileURL(
  path.join(import.meta.dir, "../fixture/deepagent-auth-provider.js"),
).href

const it = testEffect(Layer.mergeAll(Provider.defaultLayer, Env.defaultLayer, Plugin.defaultLayer, Auth.defaultLayer))
const itWithAuth = testEffect(
  Layer.mergeAll(Provider.defaultLayer, Env.defaultLayer, Plugin.defaultLayer, Auth.defaultLayer),
)
const experimentalModels = testEffect(providerLayer({ enableExperimentalModels: true }))

const connect = (providerID: ProviderV2.ID, key: string) =>
  Effect.gen(function* () {
    const auth = yield* Auth.Service
    yield* auth.set(providerID, {
      type: "api",
      key,
    })
  })

const alphaProviderConfig = {
  provider: {
    "custom-provider": {
      name: "Custom Provider",
      npm: "@ai-sdk/openai-compatible",
      api: "https://api.custom.com/v1",
      models: {
        "active-model": {
          name: "Active Model",
        },
        "alpha-model": {
          name: "Alpha Model",
          status: "alpha" as const,
        },
      },
      options: {
        apiKey: "custom-key",
      },
    },
  },
}

it.instance("official provider loaded from auth key store", () =>
  Effect.gen(function* () {
    yield* connect(ProviderV2.ID.anthropic, "test-api-key")
    const providers = yield* list
    expect(providers[ProviderV2.ID.anthropic]).toBeDefined()
    expect(providers[ProviderV2.ID.anthropic].source).toBe("api")
    expect(providers[ProviderV2.ID.anthropic].options.headers["anthropic-beta"]).toBeDefined()
  }),
)

it.instance(
  "third-party provider loaded from config with apiKey option",
  Effect.gen(function* () {
    const providers = yield* list
    const provider = providers[ProviderV2.ID.make("custom-anthropic")]
    expect(provider).toBeDefined()
    expect(provider.source).toBe("custom")
    expect(provider.options.apiKey).toBe("config-api-key")
  }),
  {
    config: {
      provider: {
        "custom-anthropic": {
          name: "Custom Anthropic",
          npm: "@ai-sdk/anthropic",
          options: { apiKey: "config-api-key" },
          models: { "custom-model": { name: "Custom Model" } },
        },
      },
    },
  },
)

it.instance(
  "config provider with official id reports duplicate provider error",
  Effect.gen(function* () {
    const providers = yield* list
    expect(providers[ProviderV2.ID.make("zhipuai")]).toBeUndefined()
    const errors = yield* Provider.use.errors()
    expect(errors).toEqual([
      {
        source: "provider.zhipuai",
        kind: "schema",
        message: "Provider id conflicts with an official provider. Rename this third-party provider in your config.",
      },
    ])
  }),
  {
    config: {
      provider: {
        zhipuai: {
          name: "Custom Zhipu Endpoint",
          api: "https://open.bigmodel.cn/api/coding/paas/v4",
          options: { apiKey: "config-api-key", baseURL: "https://open.bigmodel.cn/api/coding/paas/v4" },
          models: { "custom-only": { name: "Custom Only", limit: { context: 128_000, output: 8192 } } },
        },
      },
    },
  },
)

it.instance(
  "official provider ignores duplicate third-party config and loads from auth key store",
  Effect.gen(function* () {
    yield* connect(ProviderV2.ID.make("zhipuai"), "test-api-key")
    const providers = yield* list
    const provider = providers[ProviderV2.ID.make("zhipuai")]
    expect(provider).toBeDefined()
    expect(provider.source).toBe("api")
    expect(provider.options.baseURL).toBeUndefined()
    expect(provider.models["custom-only"]).toBeUndefined()
    expect(provider.models["glm-5"].api.url).toBe("https://open.bigmodel.cn/api/paas/v4")
  }),
  {
    config: {
      provider: {
        zhipuai: {
          name: "Custom Zhipu Endpoint",
          api: "https://open.bigmodel.cn/api/coding/paas/v4",
          options: { baseURL: "https://open.bigmodel.cn/api/coding/paas/v4" },
          models: { "custom-only": { name: "Custom Only", limit: { context: 128_000, output: 8192 } } },
        },
      },
    },
  },
)

it.instance(
  "non-official catalog id is a third-party provider from config",
  Effect.gen(function* () {
    const providers = yield* list
    // mistral is in the models.dev catalog but is NOT official, so a config block owns it as a
    // third-party provider: the config baseURL/apiKey/models apply and no conflict error is raised.
    const provider = providers[ProviderV2.ID.make("mistral")]
    expect(provider).toBeDefined()
    expect(provider.source).toBe("custom")
    expect(provider.options.apiKey).toBe("mistral-config-key")
    expect(provider.models["my-mistral"]).toBeDefined()
    const errors = yield* Provider.use.errors()
    expect(errors.find((e) => e.source === "provider.mistral")).toBeUndefined()
  }),
  {
    config: {
      provider: {
        mistral: {
          name: "My Mistral",
          npm: "@ai-sdk/openai-compatible",
          options: { apiKey: "mistral-config-key", baseURL: "https://api.mistral.ai/v1" },
          models: { "my-mistral": { name: "My Mistral Model" } },
        },
      },
    },
  },
)

it.instance(
  "legacy key-store entry for a non-official provider reports a warning",
  Effect.gen(function* () {
    // Old flow wrote third-party keys to the auth store; those are no longer read for non-official
    // ids. The provider must not appear, and the user gets a migration warning.
    yield* connect(ProviderV2.ID.make("groq"), "legacy-key")
    const providers = yield* list
    expect(providers[ProviderV2.ID.make("groq")]).toBeUndefined()
    const errors = yield* Provider.use.errors()
    const warning = errors.find((e) => e.source === "auth.groq")
    expect(warning).toBeDefined()
    expect(warning!.message).toContain("no longer used")
  }),
)

it.instance(
  "disabled_providers excludes provider",
  Effect.gen(function* () {
    yield* connect(ProviderV2.ID.anthropic, "test-api-key")
    const providers = yield* list
    expect(providers[ProviderV2.ID.anthropic]).toBeUndefined()
  }),
  { config: { disabled_providers: ["anthropic"] } },
)

it.instance(
  "enabled_providers restricts to only listed providers",
  Effect.gen(function* () {
    yield* connect(ProviderV2.ID.anthropic, "test-api-key")
    yield* connect(ProviderV2.ID.openai, "test-openai-key")
    const providers = yield* list
    expect(providers[ProviderV2.ID.anthropic]).toBeDefined()
    expect(providers[ProviderV2.ID.openai]).toBeUndefined()
  }),
  { config: { enabled_providers: ["anthropic"] } },
)

it.instance(
  "official provider config whitelist is ignored",
  Effect.gen(function* () {
    yield* connect(ProviderV2.ID.anthropic, "test-api-key")
    const providers = yield* list
    expect(providers[ProviderV2.ID.anthropic]).toBeDefined()
    const models = Object.keys(providers[ProviderV2.ID.anthropic].models)
    expect(models).toContain("claude-sonnet-4-20250514")
    expect(models.length).toBeGreaterThan(1)
  }),
  { config: { provider: { anthropic: { whitelist: ["claude-sonnet-4-20250514"] } } } },
)

it.instance(
  "official provider config blacklist is ignored",
  Effect.gen(function* () {
    yield* connect(ProviderV2.ID.anthropic, "test-api-key")
    const providers = yield* list
    expect(providers[ProviderV2.ID.anthropic]).toBeDefined()
    const models = Object.keys(providers[ProviderV2.ID.anthropic].models)
    expect(models).toContain("claude-sonnet-4-20250514")
  }),
  { config: { provider: { anthropic: { blacklist: ["claude-sonnet-4-20250514"] } } } },
)

it.instance(
  "official provider config model alias is ignored",
  Effect.gen(function* () {
    yield* connect(ProviderV2.ID.anthropic, "test-api-key")
    const providers = yield* list
    expect(providers[ProviderV2.ID.anthropic]).toBeDefined()
    expect(providers[ProviderV2.ID.anthropic].models["my-alias"]).toBeUndefined()
  }),
  {
    config: {
      provider: {
        anthropic: { models: { "my-alias": { id: "claude-sonnet-4-20250514", name: "My Custom Alias" } } },
      },
    },
  },
)

it.instance(
  "custom provider with npm package",
  Effect.gen(function* () {
    const providers = yield* list
    expect(providers[ProviderV2.ID.make("custom-provider")]).toBeDefined()
    expect(providers[ProviderV2.ID.make("custom-provider")].name).toBe("Custom Provider")
    expect(providers[ProviderV2.ID.make("custom-provider")].models["custom-model"]).toBeDefined()
  }),
  {
    config: {
      provider: {
        "custom-provider": {
          name: "Custom Provider",
          npm: "@ai-sdk/openai-compatible",
          api: "https://api.custom.com/v1",
          env: ["CUSTOM_API_KEY"],
          models: {
            "custom-model": {
              name: "Custom Model",
              tool_call: true,
              limit: { context: 128000, output: 4096 },
            },
          },
          options: { apiKey: "custom-key" },
        },
      },
    },
  },
)

it.instance(
  "filters alpha provider models by default",
  Effect.gen(function* () {
    const providers = yield* list
    expect(providers[ProviderV2.ID.make("custom-provider")].models["active-model"]).toBeDefined()
    expect(providers[ProviderV2.ID.make("custom-provider")].models["alpha-model"]).toBeUndefined()
  }),
  { config: alphaProviderConfig },
)

experimentalModels.instance(
  "includes alpha provider models when experimental models are enabled",
  Effect.gen(function* () {
    const providers = yield* list
    expect(providers[ProviderV2.ID.make("custom-provider")].models["active-model"]).toBeDefined()
    expect(providers[ProviderV2.ID.make("custom-provider")].models["alpha-model"]).toBeDefined()
  }),
  { config: alphaProviderConfig },
)

it.instance(
  "custom DeepSeek openai-compatible model defaults interleaved reasoning field",
  Effect.gen(function* () {
    const providers = yield* list
    const provider = providers[ProviderV2.ID.make("custom-provider")]
    expect(provider.models["deepseek-r1"].capabilities.interleaved).toEqual({ field: "reasoning_content" })
    expect(provider.models["deepseek-details"].capabilities.interleaved).toEqual({ field: "reasoning_details" })
    expect(provider.models["custom-model"].capabilities.interleaved).toBe(false)
    expect(
      providers[ProviderV2.ID.make("custom-anthropic-provider")].models["deepseek-r1"].capabilities.interleaved,
    ).toBe(false)
  }),
  {
    config: {
      provider: {
        "custom-provider": {
          name: "Custom Provider",
          npm: "@ai-sdk/openai-compatible",
          api: "https://api.custom.com/v1",
          models: {
            "deepseek-r1": { name: "DeepSeek R1" },
            "deepseek-details": { name: "DeepSeek Details", interleaved: { field: "reasoning_details" } },
            "custom-model": { name: "Custom Model" },
          },
          options: { apiKey: "custom-key" },
        },
        "custom-anthropic-provider": {
          name: "Custom Anthropic Provider",
          npm: "@ai-sdk/anthropic",
          api: "https://api.custom.com/v1",
          models: { "deepseek-r1": { name: "DeepSeek R1" } },
          options: { apiKey: "custom-key" },
        },
      },
    },
  },
)

it.instance(
  "official provider auth ignores duplicate config options",
  Effect.gen(function* () {
    yield* connect(ProviderV2.ID.anthropic, "env-api-key")
    const providers = yield* list
    expect(providers[ProviderV2.ID.anthropic]).toBeDefined()
    expect(providers[ProviderV2.ID.anthropic].options.timeout).toBeUndefined()
    expect(providers[ProviderV2.ID.anthropic].options.headerTimeout).toBeUndefined()
    expect(providers[ProviderV2.ID.anthropic].options.chunkTimeout).toBeUndefined()
  }),
  { config: { provider: { anthropic: { options: { timeout: 60000, headerTimeout: 10000, chunkTimeout: 15000 } } } } },
)

it.instance("getModel returns model for valid provider/model", () =>
  Effect.gen(function* () {
    yield* connect(ProviderV2.ID.anthropic, "test-api-key")
    const provider = yield* Provider.Service
    const model = yield* provider.getModel(ProviderV2.ID.anthropic, ModelV2.ID.make("claude-sonnet-4-20250514"))
    expect(model).toBeDefined()
    expect(String(model.providerID)).toBe("anthropic")
    expect(String(model.id)).toBe("claude-sonnet-4-20250514")
    const language = yield* provider.getLanguage(model)
    expect(language).toBeDefined()
  }),
)

itWithAuth.instance(
  "DeepAgent model-scoped auth uses deepagent auth entry without exposing key",
  Effect.gen(function* () {
    const auth = yield* Auth.Service
    yield* auth.set("deepagent:deepseek-v4-flash", { type: "api", key: "deepagent-model-key" })

    const providers = yield* list
    const deepagent = providers[ProviderV2.ID.make("deepagent")]
    expect(deepagent).toBeDefined()
    expect(JSON.stringify(deepagent)).not.toContain("deepagent-model-key")

    const provider = yield* Provider.Service
    const model = yield* provider.getModel(ProviderV2.ID.make("deepagent"), ModelV2.ID.make("deepseek-v4-flash"))
    expect(model.api.url).toBe("https://api.deepagent.test/v1")
    const language = yield* provider.getLanguage(model)
    expect(language).toBeDefined()
    expect((globalThis as any).__deepagentAuthProviderOptions).toMatchObject({
      name: "deepagent",
      apiKey: "deepagent-model-key",
      baseURL: "https://api.deepagent.test/v1",
    })
    expect((globalThis as any).__deepagentAuthProviderModelID).toBe("deepseek-v4-flash")
  }),
  {
    config: {
      provider: {
        deepagent: {
          name: "DeepAgent",
          options: { enabled: true },
          models: {
            "deepseek-v4-flash": {
              id: "deepseek-v4-flash",
              name: "DeepSeek V4 Flash",
              reasoning: true,
              interleaved: { field: "reasoning_content" },
              provider: {
                npm: deepagentAuthProviderFixture,
                api: "https://api.deepagent.test/v1",
              },
              options: {
                authProviderID: "deepagent:deepseek-v4-flash",
                upstreamProviderID: "deepseek",
              },
              tool_call: true,
              limit: { context: 128000, output: 8000 },
            },
          },
        },
      },
    },
  },
)

it.instance("getModel throws ModelNotFoundError for invalid model", () =>
  Effect.gen(function* () {
    yield* connect(ProviderV2.ID.anthropic, "test-api-key")
    const exit = yield* Provider.use
      .getModel(ProviderV2.ID.anthropic, ModelV2.ID.make("nonexistent-model"))
      .pipe(Effect.exit)
    expect(exit._tag).toBe("Failure")
  }),
)

it.instance("getModel throws ModelNotFoundError for invalid provider", () =>
  Effect.gen(function* () {
    const exit = yield* Provider.use
      .getModel(ProviderV2.ID.make("nonexistent-provider"), ModelV2.ID.make("some-model"))
      .pipe(Effect.exit)
    expect(exit._tag).toBe("Failure")
  }),
)

// Pure synchronous unit tests — no Effect runtime needed.

test("parseModel correctly parses provider/model string", () => {
  const result = Provider.parseModel("anthropic/claude-sonnet-4")
  expect(String(result.providerID)).toBe("anthropic")
  expect(String(result.modelID)).toBe("claude-sonnet-4")
})

test("parseModel handles model IDs with slashes", () => {
  const result = Provider.parseModel("openrouter/anthropic/claude-3-opus")
  expect(String(result.providerID)).toBe("openrouter")
  expect(String(result.modelID)).toBe("anthropic/claude-3-opus")
})

it.instance("defaultModel returns first available model when no config set", () =>
  Effect.gen(function* () {
    yield* connect(ProviderV2.ID.anthropic, "test-api-key")
    const model = yield* Provider.use.defaultModel()
    expect(model.providerID).toBeDefined()
    expect(model.modelID).toBeDefined()
  }),
)

it.instance(
  "defaultModel respects config model setting",
  Effect.gen(function* () {
    yield* connect(ProviderV2.ID.anthropic, "test-api-key")
    const model = yield* Provider.use.defaultModel()
    expect(String(model.providerID)).toBe("anthropic")
    expect(String(model.modelID)).toBe("claude-sonnet-4-20250514")
  }),
  { config: { model: "anthropic/claude-sonnet-4-20250514" } },
)

it.instance(
  "defaultModel returns a typed error when config excludes every provider",
  Effect.gen(function* () {
    const error = yield* Provider.use.defaultModel().pipe(Effect.flip)
    expect(error).toBeInstanceOf(Provider.NoProvidersError)
    expect(error._tag).toBe("ProviderNoProvidersError")
  }),
  { config: { enabled_providers: [] } },
)

it.instance(
  "provider with baseURL from config",
  Effect.gen(function* () {
    const providers = yield* list
    expect(providers[ProviderV2.ID.make("custom-openai")]).toBeDefined()
    expect(providers[ProviderV2.ID.make("custom-openai")].options.baseURL).toBe("https://custom.openai.com/v1")
  }),
  {
    config: {
      provider: {
        "custom-openai": {
          name: "Custom OpenAI",
          npm: "@ai-sdk/openai-compatible",
          env: [],
          models: { "gpt-4": { name: "GPT-4", tool_call: true, limit: { context: 128000, output: 4096 } } },
          options: { apiKey: "test-key", baseURL: "https://custom.openai.com/v1" },
        },
      },
    },
  },
)

it.instance(
  "model cost defaults to zero when not specified",
  Effect.gen(function* () {
    const providers = yield* list
    const model = providers[ProviderV2.ID.make("test-provider")].models["test-model"]
    expect(model.cost.input).toBe(0)
    expect(model.cost.output).toBe(0)
    expect(model.cost.cache.read).toBe(0)
    expect(model.cost.cache.write).toBe(0)
  }),
  {
    config: {
      provider: {
        "test-provider": {
          name: "Test Provider",
          npm: "@ai-sdk/openai-compatible",
          env: [],
          models: { "test-model": { name: "Test Model", tool_call: true, limit: { context: 128000, output: 4096 } } },
          options: { apiKey: "test-key" },
        },
      },
    },
  },
)

it.instance(
  "official provider model options from config are ignored",
  Effect.gen(function* () {
    yield* connect(ProviderV2.ID.anthropic, "test-api-key")
    const providers = yield* list
    const model = providers[ProviderV2.ID.anthropic].models["claude-sonnet-4-20250514"]
    expect(model.options.customOption).toBeUndefined()
  }),
  {
    config: {
      provider: {
        anthropic: {
          options: { apiKey: "test-api-key" },
          models: { "claude-sonnet-4-20250514": { options: { customOption: "custom-value" } } },
        },
      },
    },
  },
)

it.instance(
  "official provider whitelist cannot remove provider",
  Effect.gen(function* () {
    yield* connect(ProviderV2.ID.anthropic, "test-api-key")
    const providers = yield* list
    expect(providers[ProviderV2.ID.anthropic]).toBeDefined()
  }),
  { config: { provider: { anthropic: { options: { apiKey: "test-api-key" }, whitelist: ["nonexistent-model"] } } } },
)

it.instance("closest finds model by partial match", () =>
  Effect.gen(function* () {
    yield* connect(ProviderV2.ID.anthropic, "test-api-key")
    const result = yield* Provider.use.closest(ProviderV2.ID.anthropic, ["sonnet-4"])
    expect(result).toBeDefined()
    expect(String(result?.providerID)).toBe("anthropic")
    expect(String(result?.modelID)).toContain("sonnet-4")
  }),
)

it.instance("closest returns undefined for nonexistent provider", () =>
  Effect.gen(function* () {
    const result = yield* Provider.use.closest(ProviderV2.ID.make("nonexistent"), ["model"])
    expect(result).toBeUndefined()
  }),
)

it.instance(
  "official provider alias config is not added to getModel",
  Effect.gen(function* () {
    yield* connect(ProviderV2.ID.anthropic, "test-api-key")
    const providers = yield* list
    expect(providers[ProviderV2.ID.anthropic].models["my-sonnet"]).toBeUndefined()
    const exit = yield* Provider.use.getModel(ProviderV2.ID.anthropic, ModelV2.ID.make("my-sonnet")).pipe(Effect.exit)
    expect(exit._tag).toBe("Failure")
  }),
  {
    config: {
      provider: {
        anthropic: {
          models: { "my-sonnet": { id: "claude-sonnet-4-20250514", name: "My Sonnet Alias" } },
        },
      },
    },
  },
)

it.instance(
  "provider api field sets model api.url",
  Effect.gen(function* () {
    const providers = yield* list
    // api field is stored on model.api.url, used by getSDK to set baseURL
    expect(providers[ProviderV2.ID.make("custom-api")].models["model-1"].api.url).toBe("https://api.example.com/v1")
  }),
  {
    config: {
      provider: {
        "custom-api": {
          name: "Custom API",
          npm: "@ai-sdk/openai-compatible",
          api: "https://api.example.com/v1",
          env: [],
          models: { "model-1": { name: "Model 1", tool_call: true, limit: { context: 8000, output: 2000 } } },
          options: { apiKey: "test-key" },
        },
      },
    },
  },
)

it.instance(
  "explicit baseURL overrides api field",
  Effect.gen(function* () {
    const providers = yield* list
    expect(providers[ProviderV2.ID.make("custom-api")].options.baseURL).toBe("https://custom.override.com/v1")
  }),
  {
    config: {
      provider: {
        "custom-api": {
          name: "Custom API",
          npm: "@ai-sdk/openai-compatible",
          api: "https://api.example.com/v1",
          env: [],
          models: { "model-1": { name: "Model 1", tool_call: true, limit: { context: 8000, output: 2000 } } },
          options: { apiKey: "test-key", baseURL: "https://custom.override.com/v1" },
        },
      },
    },
  },
)

it.instance(
  "official provider model name from config is ignored",
  Effect.gen(function* () {
    yield* connect(ProviderV2.ID.anthropic, "test-api-key")
    const providers = yield* list
    const model = providers[ProviderV2.ID.anthropic].models["claude-sonnet-4-20250514"]
    expect(model.name).not.toBe("Custom Name for Sonnet")
    expect(model.capabilities.toolcall).toBe(true)
    expect(model.capabilities.attachment).toBe(true)
    expect(model.limit.context).toBeGreaterThan(0)
  }),
  {
    config: {
      provider: { anthropic: { models: { "claude-sonnet-4-20250514": { name: "Custom Name for Sonnet" } } } },
    },
  },
)

it.instance(
  "disabled_providers prevents loading even with env var",
  Effect.gen(function* () {
    yield* connect(ProviderV2.ID.openai, "test-openai-key")
    const providers = yield* list
    expect(providers[ProviderV2.ID.openai]).toBeUndefined()
  }),
  { config: { disabled_providers: ["openai"] } },
)

it.instance(
  "enabled_providers with empty array allows no providers",
  Effect.gen(function* () {
    yield* connect(ProviderV2.ID.anthropic, "test-api-key")
    yield* connect(ProviderV2.ID.openai, "test-openai-key")
    const providers = yield* list
    expect(Object.keys(providers).length).toBe(0)
  }),
  { config: { enabled_providers: [] } },
)

it.instance(
  "official provider whitelist and blacklist config is ignored",
  Effect.gen(function* () {
    yield* connect(ProviderV2.ID.anthropic, "test-api-key")
    const providers = yield* list
    expect(providers[ProviderV2.ID.anthropic]).toBeDefined()
    const models = Object.keys(providers[ProviderV2.ID.anthropic].models)
    expect(models).toContain("claude-sonnet-4-20250514")
    expect(models).toContain("claude-opus-4-20250514")
    expect(models.length).toBeGreaterThan(1)
  }),
  {
    config: {
      provider: {
        anthropic: {
          whitelist: ["claude-sonnet-4-20250514", "claude-opus-4-20250514"],
          blacklist: ["claude-opus-4-20250514"],
        },
      },
    },
  },
)

it.instance(
  "model modalities default correctly",
  Effect.gen(function* () {
    const providers = yield* list
    const model = providers[ProviderV2.ID.make("test-provider")].models["test-model"]
    expect(model.capabilities.input.text).toBe(true)
    expect(model.capabilities.output.text).toBe(true)
  }),
  {
    config: {
      provider: {
        "test-provider": {
          name: "Test",
          npm: "@ai-sdk/openai-compatible",
          env: [],
          models: { "test-model": { name: "Test Model", tool_call: true, limit: { context: 8000, output: 2000 } } },
          options: { apiKey: "test" },
        },
      },
    },
  },
)

it.instance(
  "model with custom cost values",
  Effect.gen(function* () {
    const providers = yield* list
    const model = providers[ProviderV2.ID.make("test-provider")].models["test-model"]
    expect(model.cost.input).toBe(5)
    expect(model.cost.output).toBe(15)
    expect(model.cost.cache.read).toBe(2.5)
    expect(model.cost.cache.write).toBe(7.5)
  }),
  {
    config: {
      provider: {
        "test-provider": {
          name: "Test",
          npm: "@ai-sdk/openai-compatible",
          env: [],
          models: {
            "test-model": {
              name: "Test Model",
              tool_call: true,
              limit: { context: 8000, output: 2000 },
              cost: { input: 5, output: 15, cache_read: 2.5, cache_write: 7.5 },
            },
          },
          options: { apiKey: "test" },
        },
      },
    },
  },
)

it.instance("getSmallModel returns appropriate small model", () =>
  Effect.gen(function* () {
    yield* connect(ProviderV2.ID.anthropic, "test-api-key")
    const model = yield* Provider.use.getSmallModel(ProviderV2.ID.anthropic)
    expect(model).toBeDefined()
    expect(model?.id).toContain("haiku")
  }),
)

it.instance(
  "getSmallModel respects config small_model override",
  Effect.gen(function* () {
    yield* connect(ProviderV2.ID.anthropic, "test-api-key")
    const model = yield* Provider.use.getSmallModel(ProviderV2.ID.anthropic)
    expect(model).toBeDefined()
    expect(String(model?.providerID)).toBe("anthropic")
    expect(String(model?.id)).toBe("claude-sonnet-4-20250514")
  }),
  { config: { small_model: "anthropic/claude-sonnet-4-20250514" } },
)

it.instance(
  "getSmallModel ignores invalid config small_model",
  Effect.gen(function* () {
    yield* connect(ProviderV2.ID.anthropic, "test-api-key")
    const model = yield* Provider.use.getSmallModel(ProviderV2.ID.anthropic)
    expect(model).toBeUndefined()
  }),
  { config: { small_model: "anthropic/not-a-real-model" } },
)

test("provider.sort prioritizes preferred models", () => {
  const models = [
    { id: "random-model", name: "Random" },
    { id: "claude-sonnet-4-latest", name: "Claude Sonnet 4" },
    { id: "gpt-5-turbo", name: "GPT-5 Turbo" },
    { id: "other-model", name: "Other" },
  ] as any[]

  const sorted = Provider.sort(models)
  expect(sorted[0].id).toContain("sonnet-4")
  expect(sorted[0].id).toContain("latest")
  expect(sorted[sorted.length - 1].id).not.toContain("gpt-5")
  expect(sorted[sorted.length - 1].id).not.toContain("sonnet-4")
})

it.instance(
  "official providers can be connected simultaneously without config overrides",
  Effect.gen(function* () {
    yield* connect(ProviderV2.ID.anthropic, "test-anthropic-key")
    yield* connect(ProviderV2.ID.openai, "test-openai-key")
    const providers = yield* list
    expect(providers[ProviderV2.ID.anthropic]).toBeDefined()
    expect(providers[ProviderV2.ID.openai]).toBeDefined()
    expect(providers[ProviderV2.ID.anthropic].options.timeout).toBeUndefined()
    expect(providers[ProviderV2.ID.openai].options.timeout).toBeUndefined()
  }),
  {
    config: {
      provider: {
        anthropic: { options: { timeout: 30000 } },
        openai: { options: { timeout: 60000 } },
      },
    },
  },
)

it.instance(
  "provider with custom npm package",
  Effect.gen(function* () {
    const providers = yield* list
    expect(providers[ProviderV2.ID.make("local-llm")]).toBeDefined()
    expect(providers[ProviderV2.ID.make("local-llm")].models["llama-3"].api.npm).toBe("@ai-sdk/openai-compatible")
    expect(providers[ProviderV2.ID.make("local-llm")].options.baseURL).toBe("http://localhost:11434/v1")
  }),
  {
    config: {
      provider: {
        "local-llm": {
          name: "Local LLM",
          npm: "@ai-sdk/openai-compatible",
          env: [],
          models: { "llama-3": { name: "Llama 3", tool_call: true, limit: { context: 8192, output: 2048 } } },
          options: { apiKey: "not-needed", baseURL: "http://localhost:11434/v1" },
        },
      },
    },
  },
)

// Edge cases for model configuration

it.instance(
  "official provider alias key is ignored",
  Effect.gen(function* () {
    yield* connect(ProviderV2.ID.anthropic, "test-api-key")
    const providers = yield* list
    expect(providers[ProviderV2.ID.anthropic].models["sonnet"]).toBeUndefined()
  }),
  {
    config: {
      provider: {
        anthropic: {
          models: { sonnet: { id: "claude-sonnet-4-20250514" } },
        },
      },
    },
  },
)

it.instance(
  "provider with multiple env var options only includes apiKey when single env",
  Effect.gen(function* () {
    yield* set("MULTI_ENV_KEY_1", "test-key")
    const providers = yield* list
    expect(providers[ProviderV2.ID.make("multi-env")]).toBeDefined()
    // When multiple env options exist, key should NOT be auto-set
    expect(providers[ProviderV2.ID.make("multi-env")].key).toBeUndefined()
  }),
  {
    config: {
      provider: {
        "multi-env": {
          name: "Multi Env Provider",
          npm: "@ai-sdk/openai-compatible",
          env: ["MULTI_ENV_KEY_1", "MULTI_ENV_KEY_2"],
          models: { "model-1": { name: "Model 1", tool_call: true, limit: { context: 8000, output: 2000 } } },
          options: { baseURL: "https://api.example.com/v1" },
        },
      },
    },
  },
)

it.instance(
  "provider with single env var includes apiKey automatically",
  Effect.gen(function* () {
    yield* set("SINGLE_ENV_KEY", "my-api-key")
    const providers = yield* list
    expect(providers[ProviderV2.ID.make("single-env")]).toBeDefined()
    // Single env option should auto-set key
    expect(providers[ProviderV2.ID.make("single-env")].key).toBe("my-api-key")
  }),
  {
    config: {
      provider: {
        "single-env": {
          name: "Single Env Provider",
          npm: "@ai-sdk/openai-compatible",
          env: ["SINGLE_ENV_KEY"],
          models: { "model-1": { name: "Model 1", tool_call: true, limit: { context: 8000, output: 2000 } } },
          options: { baseURL: "https://api.example.com/v1" },
        },
      },
    },
  },
)

it.instance(
  "official provider cost override from config is ignored",
  Effect.gen(function* () {
    yield* connect(ProviderV2.ID.anthropic, "test-api-key")
    const providers = yield* list
    const model = providers[ProviderV2.ID.anthropic].models["claude-sonnet-4-20250514"]
    expect(model.cost.input).not.toBe(999)
    expect(model.cost.output).not.toBe(888)
  }),
  {
    config: {
      provider: {
        anthropic: {
          models: { "claude-sonnet-4-20250514": { cost: { input: 999, output: 888 } } },
        },
      },
    },
  },
)

it.instance(
  "completely new provider not in database can be configured",
  Effect.gen(function* () {
    const providers = yield* list
    expect(providers[ProviderV2.ID.make("brand-new-provider")]).toBeDefined()
    expect(providers[ProviderV2.ID.make("brand-new-provider")].name).toBe("Brand New")
    const model = providers[ProviderV2.ID.make("brand-new-provider")].models["new-model"]
    expect(model.capabilities.reasoning).toBe(true)
    expect(model.capabilities.attachment).toBe(true)
    expect(model.capabilities.input.image).toBe(true)
  }),
  {
    config: {
      provider: {
        "brand-new-provider": {
          name: "Brand New",
          npm: "@ai-sdk/openai-compatible",
          env: [],
          api: "https://new-api.com/v1",
          models: {
            "new-model": {
              name: "New Model",
              tool_call: true,
              reasoning: true,
              attachment: true,
              temperature: true,
              limit: { context: 32000, output: 8000 },
              modalities: { input: ["text", "image"], output: ["text"] },
            },
          },
          options: { apiKey: "new-key" },
        },
      },
    },
  },
)

it.instance(
  "disabled_providers and enabled_providers interaction",
  Effect.gen(function* () {
    yield* connect(ProviderV2.ID.anthropic, "test-anthropic")
    yield* connect(ProviderV2.ID.openai, "test-openai")
    yield* connect(ProviderV2.ID.google, "test-google")
    const providers = yield* list
    // anthropic: in enabled, not in disabled = allowed
    expect(providers[ProviderV2.ID.anthropic]).toBeDefined()
    // openai: in enabled, but also in disabled = NOT allowed
    expect(providers[ProviderV2.ID.openai]).toBeUndefined()
    // google: not in enabled = NOT allowed (even though not disabled)
    expect(providers[ProviderV2.ID.google]).toBeUndefined()
  }),
  {
    // enabled_providers takes precedence — only these are considered
    // Then disabled_providers filters from the enabled set
    config: { enabled_providers: ["anthropic", "openai"], disabled_providers: ["openai"] },
  },
)

it.instance(
  "model with tool_call false",
  Effect.gen(function* () {
    const providers = yield* list
    expect(providers[ProviderV2.ID.make("no-tools")].models["basic-model"].capabilities.toolcall).toBe(false)
  }),
  {
    config: {
      provider: {
        "no-tools": {
          name: "No Tools Provider",
          npm: "@ai-sdk/openai-compatible",
          env: [],
          models: { "basic-model": { name: "Basic Model", tool_call: false, limit: { context: 4000, output: 1000 } } },
          options: { apiKey: "test" },
        },
      },
    },
  },
)

it.instance(
  "model defaults tool_call to true when not specified",
  Effect.gen(function* () {
    const providers = yield* list
    expect(providers[ProviderV2.ID.make("default-tools")].models["model"].capabilities.toolcall).toBe(true)
  }),
  {
    config: {
      provider: {
        "default-tools": {
          name: "Default Tools Provider",
          npm: "@ai-sdk/openai-compatible",
          env: [],
          models: { model: { name: "Model", limit: { context: 4000, output: 1000 } } },
          options: { apiKey: "test" },
        },
      },
    },
  },
)

it.instance(
  "model headers are preserved",
  Effect.gen(function* () {
    const providers = yield* list
    const model = providers[ProviderV2.ID.make("headers-provider")].models["model"]
    expect(model.headers).toEqual({
      "X-Custom-Header": "custom-value",
      Authorization: "Bearer special-token",
    })
  }),
  {
    config: {
      provider: {
        "headers-provider": {
          name: "Headers Provider",
          npm: "@ai-sdk/openai-compatible",
          env: [],
          models: {
            model: {
              name: "Model",
              tool_call: true,
              limit: { context: 4000, output: 1000 },
              headers: { "X-Custom-Header": "custom-value", Authorization: "Bearer special-token" },
            },
          },
          options: { apiKey: "test" },
        },
      },
    },
  },
)

it.instance(
  "provider env fallback - second env var used if first missing",
  Effect.gen(function* () {
    // Only set fallback, not primary
    yield* set("FALLBACK_KEY", "fallback-api-key")
    const providers = yield* list
    // Provider should load because fallback env var is set
    expect(providers[ProviderV2.ID.make("fallback-env")]).toBeDefined()
  }),
  {
    config: {
      provider: {
        "fallback-env": {
          name: "Fallback Env Provider",
          npm: "@ai-sdk/openai-compatible",
          env: ["PRIMARY_KEY", "FALLBACK_KEY"],
          models: { model: { name: "Model", tool_call: true, limit: { context: 4000, output: 1000 } } },
          options: { baseURL: "https://api.example.com" },
        },
      },
    },
  },
)

it.instance("getModel returns consistent results", () =>
  Effect.gen(function* () {
    yield* connect(ProviderV2.ID.anthropic, "test-api-key")
    const model1 = yield* Provider.use.getModel(ProviderV2.ID.anthropic, ModelV2.ID.make("claude-sonnet-4-20250514"))
    const model2 = yield* Provider.use.getModel(ProviderV2.ID.anthropic, ModelV2.ID.make("claude-sonnet-4-20250514"))
    expect(model1.providerID).toEqual(model2.providerID)
    expect(model1.id).toEqual(model2.id)
    expect(model1).toEqual(model2)
  }),
)

it.instance(
  "provider name defaults to id when not in database",
  Effect.gen(function* () {
    const providers = yield* list
    expect(providers[ProviderV2.ID.make("my-custom-id")].name).toBe("my-custom-id")
  }),
  {
    config: {
      provider: {
        "my-custom-id": {
          npm: "@ai-sdk/openai-compatible",
          env: [],
          models: { model: { name: "Model", tool_call: true, limit: { context: 4000, output: 1000 } } },
          options: { apiKey: "test" },
        },
      },
    },
  },
)

it.instance("ModelNotFoundError includes suggestions for typos", () =>
  Effect.gen(function* () {
    yield* connect(ProviderV2.ID.anthropic, "test-api-key")
    const error = yield* Provider.use
      .getModel(ProviderV2.ID.anthropic, ModelV2.ID.make("claude-sonet-4"))
      .pipe(Effect.flip)
    expect(error.suggestions).toBeDefined()
    expect((error.suggestions ?? []).length).toBeGreaterThan(0)
  }),
)

it.instance("ModelNotFoundError for provider includes suggestions", () =>
  Effect.gen(function* () {
    yield* connect(ProviderV2.ID.anthropic, "test-api-key")
    const error = yield* Provider.use
      .getModel(ProviderV2.ID.make("antropic"), ModelV2.ID.make("claude-sonnet-4"))
      .pipe(Effect.flip)
    expect(error.suggestions).toBeDefined()
    expect(error.suggestions).toContain("anthropic")
  }),
)

it.instance("ModelNotFoundError suggests catalog models for unloaded providers", () =>
  Effect.gen(function* () {
    yield* remove("DEEPAGENT_CODE_API_KEY")
    const error = yield* Provider.use
      .getModel(ProviderV2.ID.make("deepagent-code"), ModelV2.ID.make("claude-haiku-fake-model"))
      .pipe(Effect.flip)
    if (!Provider.ModelNotFoundError.isInstance(error)) throw error
    expect(error.suggestions ?? []).toContain("claude-haiku-4-5")
  }),
)

it.instance("getProvider returns undefined for nonexistent provider", () =>
  Effect.gen(function* () {
    const provider = yield* Provider.Service.use((svc) => svc.getProvider(ProviderV2.ID.make("nonexistent")))
    expect(provider).toBeUndefined()
  }),
)

it.instance("getProvider returns provider info", () =>
  Effect.gen(function* () {
    yield* connect(ProviderV2.ID.anthropic, "test-api-key")
    const provider = yield* Provider.use.getProvider(ProviderV2.ID.anthropic)
    expect(provider).toBeDefined()
    expect(String(provider?.id)).toBe("anthropic")
  }),
)

it.instance("closest returns undefined when no partial match found", () =>
  Effect.gen(function* () {
    yield* connect(ProviderV2.ID.anthropic, "test-api-key")
    const result = yield* Provider.use.closest(ProviderV2.ID.anthropic, ["nonexistent-xyz-model"])
    expect(result).toBeUndefined()
  }),
)

it.instance("closest checks multiple query terms in order", () =>
  Effect.gen(function* () {
    yield* connect(ProviderV2.ID.anthropic, "test-api-key")
    // First term won't match, second will
    const result = yield* Provider.use.closest(ProviderV2.ID.anthropic, ["nonexistent", "haiku"])
    expect(result).toBeDefined()
    expect(result?.modelID).toContain("haiku")
  }),
)

it.instance(
  "model limit defaults to zero when not specified",
  Effect.gen(function* () {
    const providers = yield* list
    const model = providers[ProviderV2.ID.make("no-limit")].models["model"]
    expect(model.limit.context).toBe(0)
    expect(model.limit.output).toBe(0)
  }),
  {
    config: {
      provider: {
        "no-limit": {
          name: "No Limit Provider",
          npm: "@ai-sdk/openai-compatible",
          env: [],
          models: { model: { name: "Model", tool_call: true } },
          options: { apiKey: "test" },
        },
      },
    },
  },
)

it.instance(
  "official provider options from config are ignored",
  Effect.gen(function* () {
    yield* connect(ProviderV2.ID.anthropic, "test-api-key")
    const providers = yield* list
    expect(providers[ProviderV2.ID.anthropic].options.timeout).toBeUndefined()
    expect(providers[ProviderV2.ID.anthropic].options.headers["X-Custom"]).toBeUndefined()
    expect(providers[ProviderV2.ID.anthropic].options.headers["anthropic-beta"]).toBeDefined()
  }),
  {
    config: {
      provider: { anthropic: { options: { headers: { "X-Custom": "custom-value" }, timeout: 30000 } } },
    },
  },
)

it.instance(
  "nvidia third-party config applies apiKey",
  Effect.gen(function* () {
    // nvidia is a catalog provider but NOT one of the 6 official ids, so config owns it as a
    // third-party provider: the catalog models survive and the config apiKey applies.
    const providers = yield* list
    const provider = providers[ProviderV2.ID.make("nvidia")]
    expect(provider).toBeDefined()
    expect(provider.source).toBe("custom")
    expect(provider.options.apiKey).toBe("test-api-key")
  }),
  { config: { provider: { nvidia: { options: { apiKey: "test-api-key" } } } } },
)

it.instance(
  "nvidia third-party config applies custom baseURL",
  Effect.gen(function* () {
    const providers = yield* list
    const provider = providers[ProviderV2.ID.make("nvidia")]
    expect(provider).toBeDefined()
    expect(provider.options.baseURL).toBe("http://localhost:8000/v1")
    expect(provider.options.apiKey).toBe("test-api-key")
  }),
  { config: { provider: { nvidia: { options: { apiKey: "test-api-key", baseURL: "http://localhost:8000/v1" } } } } },
)

it.instance(
  "nvidia third-party config applies custom headers",
  Effect.gen(function* () {
    const providers = yield* list
    const provider = providers[ProviderV2.ID.make("nvidia")]
    expect(provider).toBeDefined()
    expect(provider.options.baseURL).toBe("http://localhost:8000/v1")
  }),
  {
    config: {
      provider: {
        nvidia: {
          options: {
            apiKey: "test-api-key",
            baseURL: "http://localhost:8000/v1",
            headers: { "X-BILLING-INVOKE-ORIGIN": "CustomOrigin" },
          },
        },
      },
    },
  },
)

it.instance(
  "official provider custom model config is ignored",
  Effect.gen(function* () {
    yield* connect(ProviderV2.ID.openai, "test-api-key")
    const providers = yield* list
    const model = providers[ProviderV2.ID.openai].models["my-custom-model"]
    expect(model).toBeUndefined()
  }),
  {
    config: {
      provider: {
        openai: {
          models: {
            "my-custom-model": {
              name: "My Custom Model",
              tool_call: true,
              limit: { context: 8000, output: 2000 },
            },
          },
        },
      },
    },
  },
)

it.instance(
  "official provider custom api.url model config is ignored",
  Effect.gen(function* () {
    yield* connect(ProviderV2.ID.openai, "test-api-key")
    const providers = yield* list
    expect(providers[ProviderV2.ID.openai]).toBeDefined()

    expect(providers[ProviderV2.ID.openai].models["custom-only/model"]).toBeUndefined()
  }),
  {
    config: {
      provider: {
        openai: {
          models: {
            "custom-only/model": { name: "Custom Only" },
          },
        },
      },
    },
  },
)

test("mode cost preserves over-200k pricing from base model", () => {
  const provider = {
    id: "openai",
    name: "OpenAI",
    env: [],
    api: "https://api.openai.com/v1",
    models: {
      "gpt-5.4": {
        id: "gpt-5.4",
        name: "GPT-5.4",
        family: "gpt",
        release_date: "2026-03-05",
        attachment: true,
        reasoning: true,
        temperature: false,
        tool_call: true,
        cost: {
          input: 2.5,
          output: 15,
          cache_read: 0.25,
          context_over_200k: {
            input: 5,
            output: 22.5,
            cache_read: 0.5,
          },
        },
        limit: {
          context: 1_050_000,
          input: 922_000,
          output: 128_000,
        },
        experimental: {
          modes: {
            fast: {
              cost: {
                input: 5,
                output: 30,
                cache_read: 0.5,
              },
              provider: {
                body: {
                  service_tier: "priority",
                },
              },
            },
          },
        },
      },
    },
  } as unknown as ModelsDev.Provider

  const model = Provider.fromModelsDevProvider(provider).models["gpt-5.4-fast"]
  expect(model.cost.input).toEqual(5)
  expect(model.cost.output).toEqual(30)
  expect(model.cost.cache.read).toEqual(0.5)
  expect(model.cost.cache.write).toEqual(0)
  expect(model.options["serviceTier"]).toEqual("priority")
  expect(model.cost.experimentalOver200K).toEqual({
    input: 5,
    output: 22.5,
    cache: { read: 0.5, write: 0 },
  })
})

test("models.dev normalization fills required response fields", () => {
  const provider = {
    id: "gateway",
    name: "Gateway",
    env: [],
    models: {
      "gpt-5.4": {
        id: "gpt-5.4",
        name: "GPT-5.4",
        family: "gpt",
        cost: { input: 2.5, output: 15 },
        limit: { context: 1_050_000, input: 922_000, output: 128_000 },
      },
    },
  } as unknown as ModelsDev.Provider

  const model = Provider.fromModelsDevProvider(provider).models["gpt-5.4"]
  expect(model.api.url).toBe("")
  expect(model.capabilities.temperature).toBe(false)
  expect(model.capabilities.reasoning).toBe(false)
  expect(model.capabilities.attachment).toBe(false)
  expect(model.capabilities.toolcall).toBe(true)
  expect(model.release_date).toBe("")
})

test("models.dev normalization does not infer reasoning for generic zhipuai glm-5.2", () => {
  const provider = {
    id: "zhipuai",
    name: "Zhipu AI",
    env: [],
    api: "https://open.bigmodel.cn/api/paas/v4",
    npm: "@ai-sdk/openai-compatible",
    models: {
      "glm-5.2": {
        id: "glm-5.2",
        name: "GLM-5.2",
        family: "glm",
        reasoning: false,
        cost: { input: 0, output: 0 },
        limit: { context: 128_000, output: 8192 },
      },
    },
  } as unknown as ModelsDev.Provider

  const model = Provider.fromModelsDevProvider(provider).models["glm-5.2"]
  expect(model.capabilities.reasoning).toBe(false)
  expect(model.variants).toEqual({})
})

test("models.dev normalization infers reasoning for zhipuai coding-plan glm-5.2", () => {
  const provider = {
    id: "zhipuai-coding-plan",
    name: "Zhipu AI Coding Plan",
    env: [],
    api: "https://open.bigmodel.cn/api/coding/paas/v4",
    npm: "@ai-sdk/openai-compatible",
    models: {
      "glm-5.2": {
        id: "glm-5.2",
        name: "GLM-5.2",
        family: "glm",
        reasoning: false,
        cost: { input: 0, output: 0 },
        limit: { context: 128_000, output: 8192 },
      },
    },
  } as unknown as ModelsDev.Provider

  const model = Provider.fromModelsDevProvider(provider).models["glm-5.2"]
  expect(model.capabilities.reasoning).toBe(true)
  expect(model.variants).toEqual({
    high: { reasoningEffort: "high" },
    max: { reasoningEffort: "max" },
  })
})

it.instance("model variants are generated for reasoning models", () =>
  Effect.gen(function* () {
    yield* connect(ProviderV2.ID.anthropic, "test-api-key")
    const providers = yield* list
    // Claude sonnet 4 has reasoning capability
    const model = providers[ProviderV2.ID.anthropic].models["claude-sonnet-4-20250514"]
    expect(model.capabilities.reasoning).toBe(true)
    expect(model.variants).toBeDefined()
    expect(Object.keys(model.variants!).length).toBeGreaterThan(0)
  }),
)

it.instance(
  "official provider variant disable config is ignored",
  Effect.gen(function* () {
    yield* connect(ProviderV2.ID.anthropic, "test-api-key")
    const providers = yield* list
    const model = providers[ProviderV2.ID.anthropic].models["claude-sonnet-4-20250514"]
    expect(model.variants).toBeDefined()
    expect(model.variants!["high"]).toBeDefined()
    expect(model.variants!["max"]).toBeDefined()
  }),
  {
    config: {
      provider: {
        anthropic: {
          models: { "claude-sonnet-4-20250514": { variants: { high: { disabled: true } } } },
        },
      },
    },
  },
)

it.instance(
  "official provider variant customization config is ignored",
  Effect.gen(function* () {
    yield* connect(ProviderV2.ID.anthropic, "test-api-key")
    const providers = yield* list
    const model = providers[ProviderV2.ID.anthropic].models["claude-sonnet-4-20250514"]
    expect(model.variants!["high"]).toBeDefined()
    expect(model.variants!["high"].thinking.budgetTokens).not.toBe(20000)
  }),
  {
    config: {
      provider: {
        anthropic: {
          models: {
            "claude-sonnet-4-20250514": {
              variants: { high: { thinking: { type: "enabled", budgetTokens: 20000 } } },
            },
          },
        },
      },
    },
  },
)

it.instance(
  "official provider variant custom field config is ignored",
  Effect.gen(function* () {
    yield* connect(ProviderV2.ID.anthropic, "test-api-key")
    const providers = yield* list
    const model = providers[ProviderV2.ID.anthropic].models["claude-sonnet-4-20250514"]
    expect(model.variants!["max"]).toBeDefined()
    expect(model.variants!["max"].disabled).toBeUndefined()
    expect(model.variants!["max"].customField).toBeUndefined()
  }),
  {
    config: {
      provider: {
        anthropic: {
          models: {
            "claude-sonnet-4-20250514": {
              variants: { max: { disabled: false, customField: "test" } },
            },
          },
        },
      },
    },
  },
)

it.instance(
  "official provider all-variant disable config is ignored",
  Effect.gen(function* () {
    yield* connect(ProviderV2.ID.anthropic, "test-api-key")
    const providers = yield* list
    const model = providers[ProviderV2.ID.anthropic].models["claude-sonnet-4-20250514"]
    expect(model.variants).toBeDefined()
    expect(Object.keys(model.variants!).length).toBeGreaterThan(0)
  }),
  {
    config: {
      provider: {
        anthropic: {
          models: {
            "claude-sonnet-4-20250514": {
              variants: { high: { disabled: true }, max: { disabled: true } },
            },
          },
        },
      },
    },
  },
)

it.instance(
  "official provider variant merge config is ignored",
  Effect.gen(function* () {
    yield* connect(ProviderV2.ID.anthropic, "test-api-key")
    const providers = yield* list
    const model = providers[ProviderV2.ID.anthropic].models["claude-sonnet-4-20250514"]
    expect(model.variants!["high"]).toBeDefined()
    expect(model.variants!["high"].thinking).toBeDefined()
    expect(model.variants!["high"].extraOption).toBeUndefined()
  }),
  {
    config: {
      provider: {
        anthropic: {
          models: {
            "claude-sonnet-4-20250514": { variants: { high: { extraOption: "custom-value" } } },
          },
        },
      },
    },
  },
)

it.instance(
  "official provider variant filter config is ignored",
  Effect.gen(function* () {
    yield* connect(ProviderV2.ID.openai, "test-api-key")
    const providers = yield* list
    const model = providers[ProviderV2.ID.openai].models["gpt-5"]
    expect(model.variants).toBeDefined()
    expect(model.variants!["high"]).toBeDefined()
    expect(model.variants!["medium"]).toBeDefined()
  }),
  {
    config: {
      provider: { openai: { models: { "gpt-5": { variants: { high: { disabled: true } } } } } },
    },
  },
)

it.instance(
  "custom model with variants enabled and disabled",
  Effect.gen(function* () {
    const providers = yield* list
    const model = providers[ProviderV2.ID.make("custom-reasoning")].models["reasoning-model"]
    expect(model.variants).toBeDefined()
    // Enabled variants should exist
    expect(model.variants!["low"]).toBeDefined()
    expect(model.variants!["low"].reasoningEffort).toBe("low")
    expect(model.variants!["medium"]).toBeDefined()
    expect(model.variants!["medium"].reasoningEffort).toBe("medium")
    expect(model.variants!["custom"]).toBeDefined()
    expect(model.variants!["custom"].reasoningEffort).toBe("custom")
    expect(model.variants!["custom"].budgetTokens).toBe(5000)
    // Disabled variant should not exist
    expect(model.variants!["high"]).toBeUndefined()
    // disabled key should be stripped from all variants
    expect(model.variants!["low"].disabled).toBeUndefined()
    expect(model.variants!["medium"].disabled).toBeUndefined()
    expect(model.variants!["custom"].disabled).toBeUndefined()
  }),
  {
    config: {
      provider: {
        "custom-reasoning": {
          name: "Custom Reasoning Provider",
          npm: "@ai-sdk/openai-compatible",
          env: [],
          models: {
            "reasoning-model": {
              name: "Reasoning Model",
              tool_call: true,
              reasoning: true,
              limit: { context: 128000, output: 16000 },
              variants: {
                low: { reasoningEffort: "low" },
                medium: { reasoningEffort: "medium" },
                high: { reasoningEffort: "high", disabled: true },
                custom: { reasoningEffort: "custom", budgetTokens: 5000 },
              },
            },
          },
          options: { apiKey: "test-key" },
        },
      },
    },
  },
)

it.instance(
  "Google Vertex: retains baseURL for custom proxy",
  Effect.gen(function* () {
    yield* set("GOOGLE_APPLICATION_CREDENTIALS", "test-creds")
    const providers = yield* list
    expect(providers[ProviderV2.ID.make("vertex-proxy")]).toBeDefined()
    expect(providers[ProviderV2.ID.make("vertex-proxy")].options.baseURL).toBe("https://my-proxy.com/v1")
  }),
  {
    config: {
      provider: {
        "vertex-proxy": {
          name: "Vertex Proxy",
          npm: "@ai-sdk/google-vertex",
          api: "https://my-proxy.com/v1",
          env: ["GOOGLE_APPLICATION_CREDENTIALS"],
          models: { "gemini-pro": { name: "Gemini Pro", tool_call: true } },
          options: {
            project: "test-project",
            location: "us-central1",
            baseURL: "https://my-proxy.com/v1",
          },
        },
      },
    },
  },
)

it.instance(
  "Google Vertex: supports OpenAI compatible models",
  Effect.gen(function* () {
    yield* set("GOOGLE_APPLICATION_CREDENTIALS", "test-creds")
    const providers = yield* list
    const model = providers[ProviderV2.ID.make("vertex-openai")].models["gpt-4"]
    expect(model).toBeDefined()
    expect(model.api.npm).toBe("@ai-sdk/openai-compatible")
  }),
  {
    config: {
      provider: {
        "vertex-openai": {
          name: "Vertex OpenAI",
          npm: "@ai-sdk/google-vertex",
          env: ["GOOGLE_APPLICATION_CREDENTIALS"],
          models: {
            "gpt-4": {
              name: "GPT-4",
              provider: { npm: "@ai-sdk/openai-compatible", api: "https://api.openai.com/v1" },
            },
          },
          options: { project: "test-project", location: "us-central1" },
        },
      },
    },
  },
)

it.instance(
  "Google Vertex: uses REP endpoint for Claude continental multi-regions",
  () =>
    Effect.gen(function* () {
      yield* set("GOOGLE_CLOUD_PROJECT", "test-project")
      yield* set("VERTEX_LOCATION", "eu")
      const provider = yield* Provider.Service
      const model = yield* provider.getModel(
        ProviderV2.ID.make("google-vertex"),
        ModelV2.ID.make("claude-sonnet-4-6@default"),
      )
      const language = yield* provider.getLanguage(model)
      expect(languageBaseURL(language)).toBe(
        "https://aiplatform.eu.rep.googleapis.com/v1/projects/test-project/locations/eu/publishers/anthropic/models",
      )
    }),
  { config: { enabled_providers: ["google-vertex"] } },
)

it.instance(
  "Google Vertex Anthropic: uses REP endpoint for continental multi-regions",
  () =>
    Effect.gen(function* () {
      yield* set("GOOGLE_CLOUD_PROJECT", "test-project")
      yield* set("VERTEX_LOCATION", "us")
      const provider = yield* Provider.Service
      const model = yield* provider.getModel(
        ProviderV2.ID.make("google-vertex-anthropic"),
        ModelV2.ID.make("claude-sonnet-4-6@default"),
      )
      const language = yield* provider.getLanguage(model)
      expect(languageBaseURL(language)).toBe(
        "https://aiplatform.us.rep.googleapis.com/v1/projects/test-project/locations/us/publishers/anthropic/models",
      )
    }),
  { config: { enabled_providers: ["google-vertex-anthropic"] } },
)

it.instance(
  "Google Vertex: keeps regional Claude endpoints unchanged",
  () =>
    Effect.gen(function* () {
      yield* set("GOOGLE_CLOUD_PROJECT", "test-project")
      yield* set("VERTEX_LOCATION", "europe-west1")
      const provider = yield* Provider.Service
      const model = yield* provider.getModel(
        ProviderV2.ID.make("google-vertex"),
        ModelV2.ID.make("claude-sonnet-4-6@default"),
      )
      const language = yield* provider.getLanguage(model)
      expect(languageBaseURL(language)).toBe(
        "https://europe-west1-aiplatform.googleapis.com/v1/projects/test-project/locations/europe-west1/publishers/anthropic/models",
      )
    }),
  { config: { enabled_providers: ["google-vertex"] } },
)

it.instance("cloudflare-ai-gateway loads with env variables", () =>
  Effect.gen(function* () {
    yield* set("CLOUDFLARE_ACCOUNT_ID", "test-account")
    yield* set("CLOUDFLARE_GATEWAY_ID", "test-gateway")
    yield* set("CLOUDFLARE_API_TOKEN", "test-token")
    const providers = yield* list
    expect(providers[ProviderV2.ID.make("cloudflare-ai-gateway")]).toBeDefined()
  }),
)

it.instance(
  "cloudflare-ai-gateway third-party config applies metadata options",
  Effect.gen(function* () {
    yield* set("CLOUDFLARE_ACCOUNT_ID", "test-account")
    yield* set("CLOUDFLARE_GATEWAY_ID", "test-gateway")
    yield* set("CLOUDFLARE_API_TOKEN", "test-token")
    const providers = yield* list
    // cloudflare-ai-gateway is a catalog provider but not one of the 6 official ids, so it is a
    // third-party provider: catalog models + loader survive and config options merge in.
    const provider = providers[ProviderV2.ID.make("cloudflare-ai-gateway")]
    expect(provider).toBeDefined()
    expect(provider.options.metadata).toEqual({ invoked_by: "test", project: "deepagent-code" })
  }),
  {
    config: {
      provider: {
        "cloudflare-ai-gateway": { options: { metadata: { invoked_by: "test", project: "deepagent-code" } } },
      },
    },
  },
)

// Tests that need plugin file setup or multi-instance flows fall back to a
// scoped tmpdir + provideInstance pattern via it.effect.

const provideMultiInstance = <A, E, R>(eff: Effect.Effect<A, E, R>) =>
  eff.pipe(Effect.provide(InstanceLayer.layer), Effect.provide(CrossSpawnSpawner.defaultLayer))

it.effect("plugin config providers persist after instance dispose", () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    const configDir = path.join(dir, ".deepagent-code")
    const root = path.join(configDir, "plugin")
    yield* Effect.promise(() => mkdir(root, { recursive: true }))
    yield* Effect.promise(() => markPluginDependenciesReady(configDir))
    yield* Effect.promise(() => markPluginDependenciesReady(Global.Path.config))
    yield* Effect.promise(() =>
      Bun.write(
        path.join(root, "demo-provider.ts"),
        [
          "export default {",
          '  id: "demo.plugin-provider",',
          "  server: async () => ({",
          "    async config(cfg) {",
          "      cfg.provider ??= {}",
          "      cfg.provider.demo = {",
          '        name: "Demo Provider",',
          '        npm: "@ai-sdk/openai-compatible",',
          '        api: "https://example.com/v1",',
          "        models: {",
          "          chat: {",
          '            name: "Demo Chat",',
          "            tool_call: true,",
          "            limit: { context: 128000, output: 4096 },",
          "          },",
          "        },",
          "      }",
          "    },",
          "  }),",
          "}",
          "",
        ].join("\n"),
      ),
    )

    const loadAndList = Effect.gen(function* () {
      const plugin = yield* Plugin.Service
      const provider = yield* Provider.Service
      yield* plugin.init()
      return yield* provider.list()
    }).pipe(provideInstanceEffect(dir))

    const first = yield* loadAndList
    expect(first[ProviderV2.ID.make("demo")]).toBeDefined()
    expect(first[ProviderV2.ID.make("demo")].models[ModelV2.ID.make("chat")]).toBeDefined()

    yield* Effect.promise(() => disposeAllInstances())

    const second = yield* loadAndList
    expect(second[ProviderV2.ID.make("demo")]).toBeDefined()
    expect(second[ProviderV2.ID.make("demo")].models[ModelV2.ID.make("chat")]).toBeDefined()
  }).pipe(provideMultiInstance),
)

it.instance(
  "plugin config enabled and disabled providers are honored",
  Effect.gen(function* () {
    const instance = yield* TestInstance
    const configDir = path.join(instance.directory, ".deepagent-code")
    const root = path.join(configDir, "plugin")
    yield* Effect.promise(() => mkdir(root, { recursive: true }))
    yield* Effect.promise(() => markPluginDependenciesReady(configDir))
    yield* Effect.promise(() =>
      Bun.write(
        path.join(root, "provider-filter.ts"),
        [
          "export default {",
          '  id: "demo.provider-filter",',
          "  server: async () => ({",
          "    async config(cfg) {",
          '      cfg.enabled_providers = ["anthropic", "openai"]',
          '      cfg.disabled_providers = ["openai"]',
          "    },",
          "  }),",
          "}",
          "",
        ].join("\n"),
      ),
    )

    yield* connect(ProviderV2.ID.anthropic, "test-anthropic-key")
    yield* connect(ProviderV2.ID.openai, "test-openai-key")
    const providers = yield* list
    expect(providers[ProviderV2.ID.anthropic]).toBeDefined()
    expect(providers[ProviderV2.ID.openai]).toBeUndefined()
  }),
)

it.effect("deepagent-code loader keeps paid models when config apiKey is present", () =>
  Effect.gen(function* () {
    yield* removeProcessEnv("DEEPAGENT_CODE_API_KEY")
    const noneDir = yield* tmpdirScoped()
    const keyedDir = yield* tmpdirScoped({
      config: { provider: { "deepagent-code": { options: { apiKey: "test-key" } } } },
    })

    const listIn = (directory: string) =>
      Provider.use
        .list()
        .pipe(provideInstanceEffect(directory))
        .pipe(Effect.provide(InstanceLayer.layer), Effect.provide(CrossSpawnSpawner.defaultLayer))

    const none = paid(yield* listIn(noneDir))
    const keyedCount = paid(yield* listIn(keyedDir))

    expect(none).toBe(0)
    expect(keyedCount).toBeGreaterThan(0)
  }).pipe(provideMultiInstance),
)

it.effect("deepagent-code loader keeps paid models when auth exists", () =>
  Effect.gen(function* () {
    yield* removeProcessEnv("DEEPAGENT_CODE_API_KEY")
    const noneDir = yield* tmpdirScoped()
    const keyedDir = yield* tmpdirScoped()

    const listIn = (directory: string) =>
      Provider.use
        .list()
        .pipe(provideInstanceEffect(directory))
        .pipe(Effect.provide(InstanceLayer.layer), Effect.provide(CrossSpawnSpawner.defaultLayer))

    const none = paid(yield* listIn(noneDir))

    const authPath = path.join(Global.Path.data, "auth.json")
    const original = yield* Effect.promise(() => Filesystem.readText(authPath).catch(() => undefined))

    yield* Effect.acquireRelease(
      Effect.promise(() =>
        Filesystem.write(authPath, JSON.stringify({ "deepagent-code": { type: "api", key: "test-key" } })),
      ),
      () =>
        Effect.promise(async () => {
          if (original !== undefined) await Filesystem.write(authPath, original)
          else await unlink(authPath).catch(() => undefined)
        }),
    )

    const keyedCount = paid(yield* listIn(keyedDir))

    expect(none).toBe(0)
    expect(keyedCount).toBeGreaterThan(0)
  }).pipe(provideMultiInstance),
)
