import { beforeEach, describe, expect, test } from "bun:test"
import { DateTime } from "effect"
import { ModelV2 } from "@deepagent-code/core/model"
import { ModelProtocol } from "@deepagent-code/core/model-protocol"
import { ProviderV2 } from "@deepagent-code/core/provider"

/**
 * C2-03 — side-effect-free capability probe + persistent config evidence.
 *
 * Oracle contract (design §5.2):
 *  - the probe is a pure, deterministic, side-effect-free configuration action;
 *    it is never invoked from inside a business turn;
 *  - the evidence is bound to endpoint/model/origin/version + protocol and is
 *    invalidated (evicted) on any config drift;
 *  - an unknown/disabled protocol resolves to an explicit `not_applicable`
 *    (`model_protocol_selection_required`) state — never a silent compatible.
 */

const mkModel = (api: ModelV2.Api, overrides: Partial<ModelV2.Info> = {}) =>
  new ModelV2.Info({
    id: ModelV2.ID.make("test-model"),
    providerID: ProviderV2.ID.make(api.type === "aisdk" && api.package === "@ai-sdk/openai" ? "openai" : "test-provider"),
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

const compatible: ModelV2.Api = {
  type: "aisdk",
  package: "@ai-sdk/openai-compatible",
  url: "https://compat.example/v1",
  id: ModelV2.ID.make("api-compat"),
}

describe("C2-03 capability probe: pure, side-effect-free derivation", () => {
  beforeEach(() => ModelProtocol.clearConfigEvidenceCache())

  test("derives the same deterministic result for the same resolved config (no network)", () => {
    const model = mkModel(compatible)
    const first = ModelProtocol.probeCapabilities(model)
    const second = ModelProtocol.probeCapabilities(model)
    expect(first.state).toBe("applicable")
    expect(first.protocol).toBe("openai-compatible.chat")
    expect(first.capabilities).not.toBeNull()
    expect(second).toEqual(first)
    expect(first.probeRef).toBe(second.probeRef)
    expect(first.probeResponseFingerprint).toBe(second.probeResponseFingerprint)
  })

  test("probeCapabilities performs no observable side effect (does not touch the evidence cache)", () => {
    const model = mkModel(compatible)
    const before = ModelProtocol.configEvidenceCount()
    ModelProtocol.probeCapabilities(model)
    expect(ModelProtocol.configEvidenceCount()).toBe(before)
  })

  test("an unknown source yields an explicit not_applicable selection_required state (never silent compatible)", () => {
    const result = ModelProtocol.probeCapabilities(
      mkModel({ type: "aisdk", package: "@ai-sdk/google", url: "https://google.example/v1", id: ModelV2.ID.make("api-google") }),
    )
    expect(result.state).toBe("not_applicable")
    expect(result.protocol).toBeNull()
    expect(result.capabilities).toBeNull()
    expect(result.disabledReason).toBe("model_protocol_selection_required")
  })

  test("an unattributed (custom) source with no explicit protocol is not_applicable (never a guessed Chat route)", () => {
    const result = ModelProtocol.probeCapabilities(
      mkModel({ type: "aisdk", package: "custom-sdk", url: "https://custom.example/v1", id: ModelV2.ID.make("api-custom") }),
    )
    expect(result.state).toBe("not_applicable")
    expect(result.protocol).toBeNull()
    expect(result.capabilities).toBeNull()
    expect(result.disabledReason).toBe("model_protocol_selection_required")
  })

  test("the module imports no network/fs/db runtime (side-effect-free boundary guard)", async () => {
    const source = await Bun.file(new URL("../src/model-protocol.ts", import.meta.url)).text()
    // The evidence/probe functions reach the provider only through in-memory config, never wire/fs/db.
    expect(source).not.toMatch(/\bfrom ["']\@deepagent-code\/llm\/route["']/)
    expect(source).not.toMatch(/\bfetch\s*\(/)
    expect(source).not.toMatch(/\bBun\.file\b/)
    expect(source).not.toMatch(/\bBun\.write\b/)
    expect(source).not.toMatch(/node:fs|node:http|node:net/)
  })
})

describe("C2-03 persistent config evidence: bind + refresh + invalidate", () => {
  beforeEach(() => ModelProtocol.clearConfigEvidenceCache())

  test("builds evidence bound to endpoint/model/origin/version + protocol with a computed identity hash", () => {
    const provider = mkProvider({ type: "aisdk", package: "@ai-sdk/openai-compatible", url: "https://compat.example/v1" })
    const evidence = ModelProtocol.buildCapabilityEvidence(mkModel(compatible), provider)
    expect(evidence.protocol).toBe("openai-compatible.chat")
    expect(evidence.routeId).toBe("openai-compatible-chat")
    expect(evidence.providerId).toBe("test-provider")
    expect(evidence.modelId).toBe("test-model")
    expect(evidence.capabilityFingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(evidence.configIdentityHash).toMatch(/^[0-9a-f]{64}$/)
    expect(evidence.loweringVersion).toBe(1)
  })

  test("a business turn consumes cached evidence and NEVER invokes the probe hook", () => {
    const provider = mkProvider({ type: "aisdk", package: "@ai-sdk/openai-compatible", url: "https://compat.example/v1" })
    const model = mkModel(compatible)
    let probeCalls = 0
    ModelProtocol.setProbeHook((m, p) => {
      probeCalls += 1
      return ModelProtocol.probeCapabilities(m, p)
    })
    try {
      // Explicit refresh is a configuration action: it runs the probe exactly once.
      const evidence = ModelProtocol.refreshConfigEvidence(model, provider)
      expect(ModelProtocol.configEvidenceCount()).toBe(1)
      expect(probeCalls).toBe(1)

      // Normal turn preparation consumes the cache; the probe is NOT invoked.
      const turnEvidence = ModelProtocol.configEvidenceForTurn(model, provider)
      expect(turnEvidence).toEqual(evidence)
      expect(probeCalls).toBe(1)
      expect(ModelProtocol.configEvidenceCount()).toBe(1)
    } finally {
      ModelProtocol.resetProbeHook()
    }
  })

  test("config drift (endpoint change) evicts the cached evidence (new identity hash)", () => {
    // The resolved endpoint comes from the model's own api.url (which dominates a provider url), so
    // vary the MODEL endpoint — the deepest config-bound field — to prove the evidence identity moves.
    const modelA = mkModel({ ...compatible, url: "https://a.example/v1", id: ModelV2.ID.make("api-a") })
    const modelB = mkModel({ ...compatible, url: "https://b.example/v1", id: ModelV2.ID.make("api-b") })
    ModelProtocol.refreshConfigEvidence(modelA)
    expect(ModelProtocol.configEvidenceCount()).toBe(1)

    expect(ModelProtocol.configEvidenceForTurn(modelB)).toBe("no_evidence")
  })

  test("explicit invalidation drops the evidence for a config identity", () => {
    const provider = mkProvider({ type: "aisdk", package: "@ai-sdk/openai-compatible", url: "https://compat.example/v1" })
    const model = mkModel(compatible)
    ModelProtocol.refreshConfigEvidence(model, provider)
    expect(ModelProtocol.configEvidenceCount()).toBe(1)
    expect(ModelProtocol.invalidateConfigEvidence(model, provider)).toBe(true)
    expect(ModelProtocol.configEvidenceCount()).toBe(0)
    expect(ModelProtocol.configEvidenceForTurn(model, provider)).toBe("no_evidence")
  })

  test("a refresh for a not_applicable protocol is rejected as a typed error (never caches a compatible guess)", () => {
    const google = mkModel({ type: "aisdk", package: "@ai-sdk/google", url: "https://google.example/v1", id: ModelV2.ID.make("api-google3") })
    let caught: unknown
    try {
      ModelProtocol.refreshConfigEvidence(google)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(ModelProtocol.CapabilityProbeNotApplicableError)
    expect((caught as { disabledReason?: string }).disabledReason).toBe("model_protocol_selection_required")
    expect(ModelProtocol.configEvidenceCount()).toBe(0)
  })
})
