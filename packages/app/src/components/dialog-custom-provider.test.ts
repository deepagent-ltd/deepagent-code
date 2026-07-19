import { describe, expect, test } from "bun:test"
import {
  deriveProviderIdentity,
  formStateFromProvider,
  modelRow,
  validateCustomProvider,
} from "./dialog-custom-provider-form"

const t = (key: string) => key

describe("validateCustomProvider", () => {
  test("builds trimmed config payload", () => {
    const result = validateCustomProvider({
      form: {
        providerID: "custom-provider",
        name: " Custom Provider ",
        baseURL: "https://api.example.com ",
        apiKey: " {env: CUSTOM_PROVIDER_KEY} ",
        models: [modelRow({ id: " model-a ", name: " Model A " })],
        headers: [
          { row: "h0", key: " X-Test ", value: " enabled ", err: {} },
          { row: "h1", key: "", value: "", err: {} },
        ],
        err: {},
      },
      t,
      disabledProviders: [],
      existingProviderIDs: new Set(),
    })

    expect(result.result).toEqual({
      providerID: "custom-provider",
      name: "Custom Provider",
      key: undefined,
      config: {
        npm: "@ai-sdk/openai-compatible",
        name: "Custom Provider",
        env: ["CUSTOM_PROVIDER_KEY"],
        options: {
          baseURL: "https://api.example.com",
          headers: {
            "X-Test": "enabled",
          },
        },
        models: {
          "model-a": { name: "Model A" },
        },
      },
    })
  })

  test("flags duplicate rows and allows reconnecting disabled providers", () => {
    const result = validateCustomProvider({
      form: {
        providerID: "custom-provider",
        name: "Provider",
        baseURL: "https://api.example.com",
        apiKey: "secret",
        models: [modelRow({ id: "model-a", name: "Model A" }), modelRow({ id: "model-a", name: "Model A 2" })],
        headers: [
          { row: "h0", key: "Authorization", value: "one", err: {} },
          { row: "h1", key: "authorization", value: "two", err: {} },
        ],
        err: {},
      },
      t,
      disabledProviders: ["custom-provider"],
      existingProviderIDs: new Set(["custom-provider"]),
    })

    expect(result.result).toBeUndefined()
    expect(result.err.providerID).toBeUndefined()
    expect(result.models[1]).toEqual({
      id: "provider.custom.error.duplicate",
      name: undefined,
      context: undefined,
    })
    expect(result.headers[1]).toEqual({
      key: "provider.custom.error.duplicate",
      value: undefined,
    })
  })

  test("derives provider id and name from the URL when left blank", () => {
    const result = validateCustomProvider({
      form: {
        providerID: "",
        name: "",
        baseURL: "https://api.moonshot.cn/v1",
        apiKey: "secret",
        // No manual models: discovery would fill these; validation must not require them here since
        // the dialog auto-fills discovered models before calling validate. Simulate a filled row.
        models: [modelRow({ id: "kimi", name: "Kimi" })],
        headers: [{ row: "h0", key: "", value: "", err: {} }],
        err: {},
      },
      t,
      disabledProviders: [],
      existingProviderIDs: new Set(),
    })

    expect(result.err.providerID).toBeUndefined()
    expect(result.err.name).toBeUndefined()
    expect(result.result?.providerID).toBe("moonshot")
    expect(result.result?.name).toBe("Moonshot")
  })

  test("persists anthropic npm when protocol is anthropic", () => {
    const result = validateCustomProvider({
      form: {
        providerID: "claude-relay",
        name: "Claude Relay",
        baseURL: "https://relay.example.com",
        apiKey: "secret",
        models: [modelRow({ id: "claude-x", name: "Claude X" })],
        headers: [{ row: "h0", key: "", value: "", err: {} }],
        err: {},
      },
      t,
      disabledProviders: [],
      existingProviderIDs: new Set(),
      protocol: "anthropic",
    })

    expect(result.result?.config.npm).toBe("@ai-sdk/anthropic")
  })

  test("defaults to openai-compatible npm when protocol omitted", () => {
    const result = validateCustomProvider({
      form: {
        providerID: "relay",
        name: "Relay",
        baseURL: "https://relay.example.com",
        apiKey: "secret",
        models: [modelRow({ id: "m", name: "M" })],
        headers: [{ row: "h0", key: "", value: "", err: {} }],
        err: {},
      },
      t,
      disabledProviders: [],
      existingProviderIDs: new Set(),
    })

    expect(result.result?.config.npm).toBe("@ai-sdk/openai-compatible")
  })

  test("discovery mode persists discovery flag and empty models when no manual models", () => {
    const result = validateCustomProvider({
      form: {
        providerID: "",
        name: "",
        baseURL: "https://api.moonshot.cn/v1",
        apiKey: "secret",
        // No manual models: the backend owns the list at runtime.
        models: [modelRow()],
        headers: [{ row: "h0", key: "", value: "", err: {} }],
        err: {},
      },
      t,
      disabledProviders: [],
      existingProviderIDs: new Set(),
      discovery: true,
    })

    expect(result.err.providerID).toBeUndefined()
    expect(result.result?.providerID).toBe("moonshot")
    expect(result.result?.config.discovery).toBe(true)
    expect(result.result?.config.models).toEqual({})
  })

  test("explicit anthropic protocol choice persists the anthropic npm even without detection", () => {
    // Simulates the user picking Anthropic in the protocol selector: the dialog passes protocol
    // "anthropic" to the form, which must win regardless of any auto-detection.
    const result = validateCustomProvider({
      form: {
        providerID: "relay",
        name: "Relay",
        baseURL: "https://relay.example.com",
        apiKey: "secret",
        models: [modelRow({ id: "m", name: "M" })],
        headers: [{ row: "h0", key: "", value: "", err: {} }],
        err: {},
      },
      t,
      disabledProviders: [],
      existingProviderIDs: new Set(),
      protocol: "anthropic",
    })

    expect(result.result?.config.npm).toBe("@ai-sdk/anthropic")
  })

  test("manual models override discovery mode: freeze models, no discovery flag", () => {
    const result = validateCustomProvider({
      form: {
        providerID: "relay",
        name: "Relay",
        baseURL: "https://relay.example.com",
        apiKey: "secret",
        models: [modelRow({ id: "custom-model", name: "Custom Model" })],
        headers: [{ row: "h0", key: "", value: "", err: {} }],
        err: {},
      },
      t,
      disabledProviders: [],
      existingProviderIDs: new Set(),
      // Even with discovery requested, a hand-listed model wins and turns discovery off.
      discovery: true,
    })

    expect(result.result?.config.discovery).toBeUndefined()
    expect(result.result?.config.models).toEqual({ "custom-model": { name: "Custom Model" } })
  })

  test("emits spec overrides only for fields the user set", () => {
    const result = validateCustomProvider({
      form: {
        providerID: "relay",
        name: "Relay",
        baseURL: "https://relay.example.com",
        apiKey: "secret",
        models: [
          modelRow({ id: "with-specs", name: "With Specs", context: "128000", reasoning: true, temperature: true }),
          modelRow({ id: "bare", name: "Bare" }),
        ],
        headers: [{ row: "h0", key: "", value: "", err: {} }],
        err: {},
      },
      t,
      disabledProviders: [],
      existingProviderIDs: new Set(),
    })

    expect(result.result?.config.models).toEqual({
      "with-specs": { name: "With Specs", reasoning: true, temperature: true, limit: { context: 128000 } },
      bare: { name: "Bare" },
    })
  })

  test("rejects a non-numeric context and produces no result", () => {
    const result = validateCustomProvider({
      form: {
        providerID: "relay",
        name: "Relay",
        baseURL: "https://relay.example.com",
        apiKey: "secret",
        models: [modelRow({ id: "m", name: "M", context: "12x" })],
        headers: [{ row: "h0", key: "", value: "", err: {} }],
        err: {},
      },
      t,
      disabledProviders: [],
      existingProviderIDs: new Set(),
    })

    expect(result.result).toBeUndefined()
    expect(result.models[0].context).toBe("provider.custom.error.context")
  })

  test("edit mode keeps discovery on and layers spec overrides", () => {
    const result = validateCustomProvider({
      form: {
        providerID: "relay",
        name: "Relay",
        baseURL: "https://relay.example.com",
        apiKey: "secret",
        models: [modelRow({ id: "gpt-4o", name: "GPT-4o", context: "200000" })],
        headers: [{ row: "h0", key: "", value: "", err: {} }],
        err: {},
      },
      t,
      disabledProviders: [],
      // Its own id is "already in use" but must not be flagged when editing it.
      existingProviderIDs: new Set(["relay"]),
      editDiscovery: true,
      editingProviderID: "relay",
    })

    expect(result.err.providerID).toBeUndefined()
    expect(result.result?.config.discovery).toBe(true)
    expect(result.result?.config.models).toEqual({ "gpt-4o": { name: "GPT-4o", limit: { context: 200000 } } })
  })
})

describe("formStateFromProvider", () => {
  test("prefills fields from config and specs from the resolved provider", () => {
    const form = formStateFromProvider({
      config: {
        name: "My Relay",
        npm: "@ai-sdk/openai-compatible",
        discovery: true,
        options: { baseURL: "https://relay.example.com", apiKey: "secret", headers: { "X-Env": "prod" } },
      },
      resolved: {
        id: "relay",
        name: "My Relay",
        source: "custom",
        env: [],
        options: {},
        models: {
          "gpt-4o": {
            id: "gpt-4o",
            providerID: "relay",
            api: { id: "gpt-4o", url: "", npm: "@ai-sdk/openai-compatible" },
            name: "GPT-4o",
            capabilities: {
              temperature: true,
              reasoning: false,
              attachment: false,
              toolcall: true,
              input: { text: true, audio: false, image: false, video: false, pdf: false },
              output: { text: true, audio: false, image: false, video: false, pdf: false },
              interleaved: false,
            },
            cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
            limit: { context: 128000, output: 16384 },
            status: "active",
            options: {},
            headers: {},
            release_date: "",
          },
        },
      },
    })

    expect(form.providerID).toBe("relay")
    expect(form.name).toBe("My Relay")
    expect(form.baseURL).toBe("https://relay.example.com")
    expect(form.apiKey).toBe("secret")
    expect(form.headers[0]).toMatchObject({ key: "X-Env", value: "prod" })
    expect(form.models).toHaveLength(1)
    expect(form.models[0]).toMatchObject({
      id: "gpt-4o",
      name: "GPT-4o",
      context: "128000",
      reasoning: false,
      temperature: true,
    })
  })
})

describe("deriveProviderIdentity", () => {
  test("strips generic service labels and uses the brand label", () => {
    expect(deriveProviderIdentity({ baseURL: "https://api.moonshot.cn/v1", existingProviderIDs: new Set() })).toEqual({
      providerID: "moonshot",
      name: "Moonshot",
    })
    expect(
      deriveProviderIdentity({ baseURL: "https://open.bigmodel.cn/api/paas/v4", existingProviderIDs: new Set() }),
    ).toEqual({ providerID: "bigmodel", name: "Bigmodel" })
  })

  test("avoids reserved official provider ids by suffixing", () => {
    // openai is a reserved official id; a third-party endpoint must not claim it.
    const result = deriveProviderIdentity({ baseURL: "https://api.openai.com/v1", existingProviderIDs: new Set() })
    expect(result.providerID).toBe("openai-2")
  })

  test("avoids ids already in use", () => {
    const result = deriveProviderIdentity({
      baseURL: "https://api.moonshot.cn/v1",
      existingProviderIDs: new Set(["moonshot", "moonshot-2"]),
    })
    expect(result.providerID).toBe("moonshot-3")
  })

  test("lets a disabled provider reclaim its id", () => {
    const result = deriveProviderIdentity({
      baseURL: "https://api.moonshot.cn/v1",
      existingProviderIDs: new Set(["moonshot"]),
      disabledProviders: ["moonshot"],
    })
    expect(result.providerID).toBe("moonshot")
  })

  test("falls back to a safe id for an unparseable URL", () => {
    const result = deriveProviderIdentity({ baseURL: "not a url", existingProviderIDs: new Set() })
    expect(result.providerID).toBe("custom-provider")
  })
})
