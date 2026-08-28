import { describe, expect, test } from "bun:test"
import { DateTime, Effect } from "effect"
import type { ModelProtocol as ModelProtocolTag } from "@deepagent-code/core/contract/model-protocol"
import { ModelV2 } from "@deepagent-code/core/model"
import { ModelProtocol } from "@deepagent-code/core/model-protocol"
import { ProviderV2 } from "@deepagent-code/core/provider"
import { SessionRunnerModel } from "@deepagent-code/core/session/runner/model"
import { it } from "./lib/effect"

const mkModel = (api: ModelV2.Api, overrides: Partial<ModelV2.Info> = {}) =>
  new ModelV2.Info({
    id: ModelV2.ID.make("test-model"),
    providerID: ProviderV2.ID.make(api.type === "aisdk" && api.package === "@ai-sdk/google" ? "google" : "test-provider"),
    name: "Test model",
    api: { ...api },
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    request: { headers: {}, body: {}, generation: {}, options: {} },
    variants: [],
    time: { released: DateTime.makeUnsafe(0) },
    cost: [],
    status: "active",
    enabled: true,
    limit: { context: 100, input: 80, output: 20 },
    ...overrides,
  })

const mkProvider = (api: ProviderV2.Api, providerID = "test-provider") =>
  new ProviderV2.Info({
    id: ProviderV2.ID.make(providerID),
    name: "Test provider",
    enabled: { via: "env", name: "TEST_PROVIDER_API_KEY" },
    env: ["TEST_PROVIDER_API_KEY"],
    api,
    request: { headers: {}, body: {} },
  })

const openai: ModelV2.Api = { type: "aisdk", package: "@ai-sdk/openai", url: "https://openai.example/v1", id: ModelV2.ID.make("api-openai") }
const anthropic: ModelV2.Api = { type: "aisdk", package: "@ai-sdk/anthropic", url: "https://anthropic.example/v1", id: ModelV2.ID.make("api-anthropic") }
const compatible: ModelV2.Api = { type: "aisdk", package: "@ai-sdk/openai-compatible", url: "https://compat.example/v1", id: ModelV2.ID.make("api-compat") }

describe("ModelProtocol resolution (design §5.2, C2-01)", () => {
  test("classifies canonical OpenAI as openai.responses", () => {
    expect(ModelProtocol.classifySource(mkModel(openai))).toEqual({ kind: "canonical_openai", protocol: "openai.responses" })
  })

  test("classifies Anthropic as anthropic.messages", () => {
    expect(ModelProtocol.classifySource(mkModel(anthropic))).toEqual({ kind: "anthropic", protocol: "anthropic.messages" })
  })

  test("classifies generic OpenAI-compatible as openai-compatible.chat", () => {
    expect(ModelProtocol.classifySource(mkModel(compatible))).toEqual({
      kind: "openai_compatible",
      protocol: "openai-compatible.chat",
    })
  })

  test("classifies an unrecognized vendor SDK as unknown (no guessed Chat route)", () => {
    expect(
      ModelProtocol.classifySource(mkModel({ type: "aisdk", package: "@ai-sdk/google", url: "https://google.example/v1", id: ModelV2.ID.make("api-google") })),
    ).toEqual({ kind: "unknown", protocol: null })
  })

  test("resolves the default protocol from the source when no explicit protocol is set", () => {
    expect(ModelProtocol.resolveModelProtocol(mkModel(compatible))).toMatchObject({
      protocol: "openai-compatible.chat",
      selectionKind: "openai_compatible",
      selectionState: "selected",
    })
  })

  test("honors an explicit canonical OpenAI protocol", () => {
    expect(ModelProtocol.resolveModelProtocol(mkModel({ ...openai, protocol: "openai.responses" }))).toMatchObject({
      protocol: "openai.responses",
      selectionKind: "canonical_openai",
      selectionState: "selected",
    })
  })

  test("routes an allowlisted provider's explicit responses protocol to openai-compatible.responses", () => {
    const deepseek = mkProvider(
      { type: "aisdk", package: "@ai-sdk/openai-compatible", url: "https://api.deepseek.com/v1" },
      "deepseek",
    )
    expect(
      ModelProtocol.resolveModelProtocol(mkModel({ ...compatible, protocol: "openai-compatible.responses" }), deepseek),
    ).toMatchObject({
      protocol: "openai-compatible.responses",
      selectionKind: "allowlisted_provider",
      selectionState: "selected",
    })
  })

  test("resolves a non-allowlisted provider's explicit responses protocol without an allowlist claim", () => {
    const provider = mkProvider({ type: "aisdk", package: "@ai-sdk/openai-compatible", url: "https://compat.example/v1" })
    expect(
      ModelProtocol.resolveModelProtocol(mkModel({ ...compatible, protocol: "openai-compatible.responses" }), provider),
    ).toMatchObject({
      protocol: "openai-compatible.responses",
      selectionKind: "openai_compatible",
      selectionState: "selected",
    })
  })

  test("accepts an explicit protocol on an unattributed (custom) provider", () => {
    const provider = mkProvider({ type: "aisdk", package: "custom-sdk", url: "https://custom.example/v1" })
    const selection = ModelProtocol.resolveModelProtocol(
      mkModel({ type: "aisdk", package: "custom-sdk", url: "https://custom.example/v1", protocol: "openai-compatible.chat", id: ModelV2.ID.make("api-custom-chat") }),
      provider,
    )
    expect(selection).toMatchObject({ protocol: "openai-compatible.chat", selectionKind: "openai_compatible", selectionState: "selected" })
  })

  test("disables a protocol that contradicts the source family as a same-attempt conflict", () => {
    const provider = mkProvider(openai, "openai")
    const selection = ModelProtocol.resolveModelProtocol(mkModel({ ...compatible, protocol: "anthropic.messages" }), provider)
    expect(selection).toMatchObject({
      protocol: null,
      selectionKind: "conflict",
      selectionState: "disabled",
      disabledReason: "protocol_conflict",
    })
  })

  test("disables an unknown source with model_protocol_selection_required (no inferred fallback)", () => {
    const selection = ModelProtocol.resolveModelProtocol(
      mkModel({ type: "aisdk", package: "@ai-sdk/google", url: "https://google.example/v1", id: ModelV2.ID.make("api-google2") }),
    )
    expect(selection).toMatchObject({
      protocol: null,
      selectionKind: "unknown",
      selectionState: "disabled",
      disabledReason: "model_protocol_selection_required",
    })
  })

  test("maps responses protocols to the Responses capability set and chat to the Chat set", () => {
    const responses = ModelProtocol.defaultCapabilities("openai-compatible.responses")
    expect(responses.remoteCompaction).toBe(true)
    expect(responses.previousResponseId).toBe(true)
    expect(responses.reasoningItems).toBe(true)
    const chat = ModelProtocol.defaultCapabilities("openai-compatible.chat")
    expect(chat.remoteCompaction).toBe(false)
    expect(chat.previousResponseId).toBe(false)
    expect(chat.reasoningItems).toBe(false)
    expect(chat.streamTransport).toBe("http_sse")
  })
})

describe("ModelProtocol schema digest (design §5.1 schema digest, C2-01)", () => {
  test("builds a frozen catalog entry with a byte-stable digest", () => {
    const model = mkModel(compatible)
    const selection = ModelProtocol.resolveModelProtocol(model)
    const entry = ModelProtocol.catalogEntryFor(model, undefined, selection)
    expect(entry.protocol).toBe("openai-compatible.chat")
    expect(entry.routeOrigin.routeId).toBe("openai-compatible-chat")
    expect(entry.capabilities.remoteCompaction).toBe(false)

    const digest = ModelProtocol.resolvedCatalogEntryDigest(model)
    expect(typeof digest).toBe("string")
    expect(digest.length).toBeGreaterThan(0)
    expect(ModelProtocol.resolvedCatalogEntryDigest(model)).toBe(digest)
  })

  test("changes the digest when the resolved protocol changes (config drift is detectable)", () => {
    const chat = ModelProtocol.resolvedCatalogEntryDigest(mkModel(compatible))
    const responses = ModelProtocol.resolvedCatalogEntryDigest(
      mkModel({ ...compatible, protocol: "openai-compatible.responses" }),
      mkProvider({ type: "aisdk", package: "@ai-sdk/openai-compatible", url: "https://compat.example/v1" }, "deepseek"),
    )
    expect(responses).not.toBe(chat)
  })
})

describe("SessionRunnerModel protocol routing (design §5.2, C2-02)", () => {
  it.effect("routes a generic OpenAI-compatible model to the Chat adapter (compatible default stays Chat)", () =>
    Effect.gen(function* () {
      const resolved = yield* SessionRunnerModel.fromCatalogModel(mkModel(compatible))
      expect(resolved.route.id).toBe("openai-compatible-chat")
    }))

  it.effect("routes an allowlisted provider's explicit responses protocol to the Responses adapter (compatible no longer uniformly Chat)", () =>
    Effect.gen(function* () {
      const resolved = yield* SessionRunnerModel.fromCatalogModel(
        mkModel({ ...compatible, protocol: "openai-compatible.responses" }),
        mkProvider({ type: "aisdk", package: "@ai-sdk/openai-compatible", url: "https://api.deepseek.com/v1" }, "deepseek"),
      )
      expect(resolved.route.id).toBe("openai-compatible-responses")
    }))

  it.effect("routes canonical OpenAI to the native Responses adapter", () =>
    Effect.gen(function* () {
      const resolved = yield* SessionRunnerModel.fromCatalogModel(mkModel(openai))
      expect(resolved.route.id).toBe("openai-responses")
    }))

  it.effect("routes Anthropic to the Messages adapter", () =>
    Effect.gen(function* () {
      const resolved = yield* SessionRunnerModel.fromCatalogModel(mkModel(anthropic))
      expect(resolved.route.id).toBe("anthropic-messages")
    }))

  it.effect("fails a disabled selection with a typed error, never a silent Chat fallback", () =>
    Effect.gen(function* () {
      const failure = yield* SessionRunnerModel.fromCatalogModel(
        mkModel({ type: "aisdk", package: "@ai-sdk/google", url: "https://google.example/v1", id: ModelV2.ID.make("api-google2") }),
      ).pipe(Effect.flip)
      expect(failure._tag).toBe("SessionRunnerModel.ModelProtocolDisabledError")
      expect((failure as { reason: string }).reason).toBe("model_protocol_selection_required")
    }))

  test("reports a model as supported only when the resolved protocol is routable", () => {
    expect(SessionRunnerModel.supported(mkModel(openai))).toBe(true)
    expect(SessionRunnerModel.supported(mkModel(anthropic))).toBe(true)
    expect(SessionRunnerModel.supported(mkModel(compatible))).toBe(true)
    expect(SessionRunnerModel.supported(mkModel({ type: "aisdk", package: "@ai-sdk/google", url: "https://google.example/v1", id: ModelV2.ID.make("api-google-x") }))).toBe(false)
    expect(SessionRunnerModel.supported(mkModel({ type: "native", settings: {}, id: ModelV2.ID.make("api-native") }))).toBe(false)
  })
})
